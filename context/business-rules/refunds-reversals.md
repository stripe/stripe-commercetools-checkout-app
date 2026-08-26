# Business Rule: Refunds & Reversals

## Overview

Refunds and reversals are initiated via the CT Connect operation endpoint (`POST /payment-intents/:id`). The connector supports full refunds, partial refunds (with feature flag), and smart reversals that detect the correct operation automatically.

---

## Rule 1: Multiple refunds require the multi-operations feature flag

**What:** If a refund is requested and the **CT payment** already has a successful Refund transaction, a warning is logged. Without `STRIPE_ENABLE_MULTI_OPERATIONS=true`, the operation still proceeds (Stripe `refunds.create` is called) but the warning signals an unexpected state.

**Why:** By default, the connector is designed for single-refund scenarios. Multiple refunds on a single charge are an advanced use case that requires explicit opt-in to avoid accidental partial refunds.

**Invariant:** When multiple refunds are needed on a single payment, `STRIPE_ENABLE_MULTI_OPERATIONS` must be enabled. Refunding without it is technically possible but unsupported.

**Implementation:** `processor/src/services/stripe-payment.service.ts` → `refundPayment()` — calls `ctPaymentService.hasTransactionInState({ payment, transactionType: 'Refund', states: ['Success'] })` (CT-side check, not Stripe `refunds.list`).

**What breaks if violated:** Partial refunds may succeed individually but the connector's CT state tracking may not correctly reflect cumulative refunded amounts.

---

## Rule 2: Reverse payment auto-detects the correct operation

**What:** `reversePayment()` inspects the CT payment's transaction history (via `ctPaymentService.hasTransactionInState`) to determine what to do:

- If a `Charge: Success` transaction exists and the payment has not already been reverted (no `Refund` or `CancelAuthorization` in `Success` **or `Pending`** state) → call `refundPayment()` with `request.payment.amountPlanned`.
- Else if an `Authorization: Success` transaction exists and the payment has not already been reverted (same `Success`/`Pending` check) → call `cancelPayment()`.
- Otherwise → throw `ErrorInvalidOperation('There is no successful payment transaction to reverse.')`.

Note: `Pending` state is included in the "already reverted" check — a refund or cancel that is still in-flight blocks a second reversal attempt.

**Why:** The caller of `reversePayment` shouldn't need to know whether a payment was captured or only authorized. The reversal logic handles both cases transparently.

**Invariant:** `reversePayment()` must never call both refund and cancel. It picks exactly one path based on transaction state.

**Implementation:** `processor/src/services/stripe-payment.service.ts` → `reversePayment()`

**What breaks if violated:** A payment that was already captured could be canceled (which would fail at Stripe), or a payment that was only authorized could be refunded (which would also fail — there's nothing to refund yet).

---

## Rule 3: Refund outcome is RECEIVED — final state comes via webhook

**What:** When `refundPayment()` succeeds, the function returns `{ outcome: PaymentModificationStatus.RECEIVED, pspReference: refund.id }`. The CT Refund transaction transitions to `Success` only when Stripe sends the `charge.refunded` webhook.

**Why:** Stripe refunds are processed asynchronously. The refund creation call returns a refund object that may still be pending settlement.

**Invariant:** Never mark a CT Refund transaction as `Success` synchronously in response to a refund API call. Always wait for the webhook.

**Implementation:** `processor/src/services/stripe-payment.service.ts` → `refundPayment()` returns `RECEIVED`; the webhook path uses `processStripeEventRefunded()` (multi-ops) or `processStripeEvent()` (default), which delegate to `stripeEventConverter.populateTransactions()` (`charge.refunded` → `REFUND: SUCCESS` + `CHARGE_BACK: SUCCESS`).

**What breaks if violated:** CT shows a successful refund that Stripe later fails.

**Correction available since 2026-08-13 (SB3-207):** this line used to end "…with no mechanism to correct it". There is one now — `refund.failed` / `refund.updated` write `Refund/Failure`. Read Rule 6 before relying on it: the correction is one-directional, it depends on a metadata stamp a Dashboard-issued refund does not carry, and the optimism this rule describes is otherwise unchanged.

---

## Rule 4: Cancel operates on the PaymentIntent, not the Charge

**What:** `cancelPayment()` calls `paymentIntents.cancel()`. It does not call `refunds.create()`.

**Why:** Cancellation is only valid for PIs in `requires_capture` or `requires_confirmation` state. These have no charge yet. Calling refund on them would fail because there is nothing to refund.

**Invariant:** Use `paymentIntents.cancel()` for authorizations; use `refunds.create()` for captured charges. Never mix them.

**Implementation:** `stripe-payment.service.ts` → `cancelPayment()` vs `refundPayment()`

**What breaks if violated:** Stripe returns an error trying to refund a PI that has no charge. The operation fails and CT state is not updated.

---

## Rule 5: Idempotency keys — partially closed

**What:** Idempotency keys are not consistently applied across all Stripe write operations. Current state:

- `refunds.create()` — **has a stable key**: `refund-{ctPaymentId}-{amount}`. Read "What the refund key does and does not do" below before treating refunds as idempotent.
- `paymentIntents.create()` — uses `crypto.randomUUID()` per call (non-deterministic; a retry generates a different key and Stripe treats it as a new request)
- `paymentIntents.update()` (metadata patch after PI creation) — uses a separate `crypto.randomUUID()`; same non-deterministic problem
- `paymentIntents.capture()` — no idempotency key
- `paymentIntents.cancel()` — no idempotency key

**Why this matters:** Network failures can cause the same request to arrive at Stripe twice. Without a stable idempotency key, Stripe processes it as a new request — risking double-charge or double-refund.

### What the refund key does and does not do

Do not read "it has a key now" as "refunds are solved".

**It does:** dedupe any repeat of the same refund — client retry, proxy replay, redelivery — for Stripe's full 24-hour key window. This is the protection that matters: before it, a retried `refundPayment` issued a second real refund.

**It deliberately has no sequence component,** and this is the part that is easy to get wrong on a second reading. A key of the form `refund-{id}-{amount}-{sequence}`, counting refunds already recorded, looks safer and is not: **any sequence derived from observed state increments once the first refund succeeds, so a retry can never reproduce the original key.** The response is lost, `charge.refunded` has meanwhile written the transaction, the retry computes `sequence + 1`, and a second real refund goes out — the exact failure the key exists to prevent. Counting from Stripe with `refunds.list` instead fails identically, because what moved is the observation, not where it is read from.

**The cost of that choice:** two *legitimate* partial refunds of the same amount inside 24 hours collapse into one. Stripe replays the first refund rather than creating a second. The connector detects this — a collapsed create returns the *same* refund id — logs an error and returns `REJECTED` with that id as `pspReference`, so the caller can reconcile instead of refunding by hand. Detection has two gaps, both failing safe (never a false rejection): it only arms once `charge.refunded` has been processed, and it cannot fire at all with `STRIPE_ENABLE_MULTI_OPERATIONS` disabled, where the handler records the PaymentIntent id rather than the refund id.

**The key is only partly entity-derived.** `ctPaymentId` is the platform-entity component. `amount` is a *discriminator*: it is caller-supplied, and the request schema validates neither positivity nor a ceiling against the captured amount, so varying it by one cent produces a fresh key and bypasses the dedupe.

**Intended design:** Every Stripe mutating call should carry an idempotency key derived from a stable identifier (CT payment ID + operation type). `refunds.create` now meets this; the other four call sites do not.

**What breaks:** On network timeout and retry, `paymentIntents.create` creates a duplicate PI (and a duplicate CT Payment if the first response was lost). Capture and cancel retries execute the operation twice.

**Status:** Partially closed. `refunds.create` is done. `capture`, `cancel`, and the two `crypto.randomUUID()` sites remain — do not document *those* operations as idempotent until keys are implemented.

---

## Rule 6: A refund is booked Success at creation and corrected only if it fails

> Added 2026-08-13 (SB3-207).

**What:** `charge.refunded` writes `Refund/Success` when Stripe reports that a Refund was **created**. `refund.updated` and `refund.failed` act **only** when the refund's `status` is `failed` or `canceled`, writing `Refund/Failure` via `processStripeEventRefundFailed()`. A refund that succeeds produces no second write.

**Why the asymmetry is deliberate and not half-finished work.** `charge.refunded` already owns the success side, so acting on a succeeded `refund.updated` too would book the same refund twice — the same duplication class this connector has been burned by before. Failure, by contrast, was written **nowhere**: a refund Stripe later rejected stayed recorded in commercetools as successful forever, and the merchant saw money returned that never left.

**Why this matters far more on a delayed rail.** On cards, created and succeeded are effectively simultaneous. On a bank transfer the refund is created `pending` and resolves minutes to days later, so the `Refund/Success` written at creation is optimistic for that entire window. Measured 2026-08-05 on both rails:

| Rail | Sequence |
|---|---|
| card | `refund.created(succeeded)` → `charge.refunded` → `refund.updated(succeeded)` |
| bank transfer | `refund.created(PENDING)` → `charge.refunded` → `refund.updated(succeeded)` |

**Invariant:** never write a `Refund` transaction from a refund event whose status is not `failed` or `canceled`. Never let a failed-refund write be swallowed into a 200 — `processStripeEventRefundFailed()` rethrows, unlike `processStripeEventRefunded()`.

**The stopgap, stated as a stopgap.** `refund.updated` fires with the terminal status on **every** rail and is therefore the natural single owner of the `Refund` transaction. `charge.refunded` cannot be, because its payload omits the refunds sublist entirely and so cannot distinguish pending from succeeded. Moving ownership is the real end state; it was not taken here because it changes card behaviour too and is a decision of its own.

**Correlation depends on a metadata stamp, and it has a hole.** `processStripeEventRefundFailed()` reads `ct_payment_id` from `refund.metadata`, stamped by this connector at `refunds.create`. A Stripe Refund does **not** inherit the PaymentIntent's metadata, and a Refund is neither PaymentIntent- nor Charge-shaped, so `getCtPaymentId()` cannot help. **A refund issued from the Stripe Dashboard carries no stamp and is therefore uncorrectable** — logged and skipped, never guessed.

**Implementation:** `stripe-payment.route.ts` (the `REFUND__UPDATED`/`REFUND__FAILED` case and its status check); `stripe-payment.service.ts` → `processStripeEventRefundFailed()`; the `metadata` argument at the `refunds.create` call site.

**Closure criterion:** `grep -n "refund.status !== 'failed'" processor/src/routes/stripe-payment.route.ts` — the status gate exists.

**What breaks if violated:** acting on a succeeded refund double-books it. Swallowing a failed-refund write leaves the payment permanently claiming a refund that never happened.
