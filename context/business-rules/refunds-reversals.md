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

**What breaks if violated:** CT shows a successful refund that Stripe later fails, with no mechanism to correct it.

---

## Rule 4: Cancel operates on the PaymentIntent, not the Charge

**What:** `cancelPayment()` calls `paymentIntents.cancel()`. It does not call `refunds.create()`.

**Why:** Cancellation is only valid for PIs in `requires_capture` or `requires_confirmation` state. These have no charge yet. Calling refund on them would fail because there is nothing to refund.

**Invariant:** Use `paymentIntents.cancel()` for authorizations; use `refunds.create()` for captured charges. Never mix them.

**Implementation:** `stripe-payment.service.ts` → `cancelPayment()` vs `refundPayment()`

**What breaks if violated:** Stripe returns an error trying to refund a PI that has no charge. The operation fails and CT state is not updated.

---

## Rule 5: Idempotency keys — known gap

**What:** Idempotency keys are not consistently applied across all Stripe write operations. Current state:

- `paymentIntents.create()` — uses `crypto.randomUUID()` per call (non-deterministic; a retry generates a different key and Stripe treats it as a new request)
- `paymentIntents.update()` (metadata patch after PI creation) — uses a separate `crypto.randomUUID()`; same non-deterministic problem
- `paymentIntents.capture()` — no idempotency key
- `paymentIntents.cancel()` — no idempotency key
- `refunds.create()` — no idempotency key

**Why this matters:** Network failures can cause the same request to arrive at Stripe twice. Without a stable idempotency key, Stripe processes it as a new request — risking double-charge or double-refund.

**Intended design:** Every Stripe mutating call should carry an idempotency key derived from a stable identifier (CT payment ID + operation type). The current implementation does not meet this standard.

**What breaks:** On network timeout and retry, `paymentIntents.create` creates a duplicate PI (and a duplicate CT Payment if the first response was lost). Capture, cancel, and refund retries execute the operation twice.

**Status:** Known gap — tracked for remediation. Do not document these operations as idempotent until keys are implemented.
