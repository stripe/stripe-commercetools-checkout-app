# Refunds, Reversals & Payment Operations

Refunds and reversals are initiated via the CT Connect operation endpoint
(`POST /operations/payment-intents/:id`). The connector supports full refunds, partial refunds (with
feature flag), cancellation, and smart reversals that detect the correct operation automatically. This
file also holds the rules every operation on that endpoint shares (authentication, failure shape);
capture-specific rules are in `multi-operations.md`.

---

## Rule 1: Multiple refunds require the multi-operations feature flag

**What:** Multiple refunds on a single payment require `STRIPE_ENABLE_MULTI_OPERATIONS` to be enabled.

**Why:** By default, the connector is designed for single-refund scenarios. Multiple refunds on a single charge are an advanced use case that requires explicit opt-in.

**Invariant:** When multiple refunds are needed on a single payment, `STRIPE_ENABLE_MULTI_OPERATIONS` must be enabled.

**Implementation:** `processor/src/services/stripe-payment.service.ts:426-440` → `refundPayment()`.

---

## Rule 2: Reverse payment auto-detects the correct operation

**What:** `reversePayment()` inspects the CT payment's transaction history (via `ctPaymentService.hasTransactionInState`) to determine what to do:

- If a `Charge: Success` transaction exists and the payment has not already been reverted (no `Refund` or `CancelAuthorization` in `Success` **or `Pending`** state) → call `refundPayment()` with `request.payment.amountPlanned`.
- Else if an `Authorization: Success` transaction exists and the payment has not already been reverted (same `Success`/`Pending` check) → call `cancelPayment()`.
- Otherwise → throw `ErrorInvalidOperation('There is no successful payment transaction to reverse.')`.

Note: `Pending` state is included in the "already reverted" check — a refund or cancel that is still in-flight blocks a second reversal attempt.

**Why:** The caller of `reversePayment` shouldn't need to know whether a payment was captured or only authorized. A payment can be reversed once, by the operation its state allows.

**Invariant:** `reversePayment()` must never call both refund and cancel. It picks exactly one path based on transaction state, and calls neither on a reverted payment.

**Implementation:** `processor/src/services/stripe-payment.service.ts:580-617` → `reversePayment()` (revert check `:586-597`, refund `:599-605`, cancel `:607-614`, throw `:616`)

---

## Rule 3: Refund outcome is RECEIVED — final state comes via webhook

**What:** When `refundPayment()` succeeds, the function returns `{ outcome: PaymentModificationStatus.RECEIVED, pspReference: refund.id }`. The CT Refund transaction transitions to `Success` only when Stripe sends the `charge.refunded` webhook.

**Why:** Stripe refunds are processed asynchronously. The refund creation call returns a refund object that may still be pending settlement.

**Invariant:** Never mark a CT Refund transaction as `Success` synchronously in response to a refund API call. Always wait for the webhook.

**Implementation:** `processor/src/services/stripe-payment.service.ts:561` → `refundPayment()` returns `RECEIVED`; the Refund transition to `Success` is written on the `charge.refunded` webhook (`stripeEventConverter.ts:346-361`).

---

## Rule 4: Cancel operates on the PaymentIntent, not the Charge

**What:** `cancelPayment()` calls `paymentIntents.cancel()`. It does not call `refunds.create()`.

**Why:** Cancellation is only valid for PIs in `requires_capture` or `requires_confirmation` state. These have no charge yet.

**Invariant:** Use `paymentIntents.cancel()` for authorizations; use `refunds.create()` for captured charges. Never mix them.

**Implementation:** `processor/src/services/stripe-payment.service.ts:386-406` → `cancelPayment()` vs `:419-569` → `refundPayment()`

---

## Rule 5: Refund idempotency key

**What:** `refunds.create()` uses a stable, entity-derived idempotency key, `refund-{payment.id}-{amount}`, and stamps `metadata.ct_payment_id` on the Refund.

**Invariant:** the key passed to `refunds.create` is exactly `refund-{payment.id}-{amount}`, and a create that returns an already-recorded refund id yields `REJECTED`, never `RECEIVED`.

**Implementation:** `processor/src/services/stripe-payment.service.ts:488-495` (refund create, key `:494`, metadata `:492`).

---

## Rule 6: A refund is booked Success at creation and corrected only if it fails

**What:** `charge.refunded` writes `Refund/Success` when Stripe reports that a Refund was **created**. `refund.updated` and `refund.failed` act **only** when the refund's `status` is `failed` or `canceled`, writing `Refund/Failure` via `processStripeEventRefundFailed()`. A refund that succeeds produces no second write.

On cards, a refund's created and succeeded are effectively simultaneous. On a bank transfer the refund is created `pending` and resolves minutes to days later:

| Rail | Sequence |
|---|---|
| card | `refund.created(succeeded)` → `charge.refunded` → `refund.updated(succeeded)` |
| bank transfer | `refund.created(PENDING)` → `charge.refunded` → `refund.updated(succeeded)` |

**Invariant:** never write a `Refund` transaction from a refund event whose status is not `failed` or `canceled`. `processStripeEventRefundFailed()` rethrows on a failed write.

**Implementation:** `processor/src/routes/stripe-payment.route.ts:335-362` (the `REFUND__UPDATED`/`REFUND__FAILED` case and its status check, `:355`); `processor/src/services/stripe-payment.service.ts:2682-2739` → `processStripeEventRefundFailed()` (rethrow `:2737`); the `metadata` argument at the `refunds.create` call site (`:492`).

---

## Rule 7: Payment operations require an OAuth2 caller with a payment-intents authority

**What:** `POST /operations/payment-intents/:id` authenticates with OAuth2 and requires `manage_project`
or `manage_checkout_payment_intents`.

**Why:** these operations move money; they are not callable from a shopper session.

**Invariant:** the route's `preHandler` contains the OAuth2 hook and the authority hook.

**Implementation:** `processor/src/routes/operation.route.ts:84-90`.

---

## Rule 8: A failed capture, cancel or refund returns `REJECTED`, not an exception

**What:** errors from Stripe during capture, cancel and refund — and the connector's own guards inside
those methods — are caught and returned as `{ outcome: REJECTED, pspReference: payment.interfaceId }`.
`reversePayment` is the exception: with nothing to reverse it **throws** `ErrorInvalidOperation`.

**HTTP status:** `POST /operations/payment-intents/:id` answers **200** with the returned outcome,
`rejected` included (`processor/src/routes/operation.route.ts:107-112`). Only a throw reaches a non-2xx:
the global error handler (`processor/src/server/server.ts:37`;
`processor/src/libs/fastify/error-handler.ts:25-26,49-59`) answers with the error's own status, which for
`ErrorInvalidOperation` is **400** (`InvalidOperation`, connect-payments-sdk 1.2.2) — the reverse with nothing
to reverse, or an unsupported action (`processor/src/services/abstract-payment.service.ts:169`).

**Why:** the checkout payment-intents API expects an outcome for every operation.

**Invariant:** each of the three methods' `catch` returns a `REJECTED` response.

**Implementation:** `processor/src/services/stripe-payment.service.ts:371-377` (capture), `:399-405`
(cancel), `:562-568` (refund); reverse throw `:616`.

---

## Rule 9: A failed refund is booked at the refund's own amount

**What:** the `Refund/Failure` written by `processStripeEventRefundFailed()` carries `refund.amount` and
`refund.currency` verbatim — not the payment's planned amount — with the refund id as `interactionId`.

**Why:** a partial refund fails for its own amount (`processor/src/services/stripe-payment.service.ts:2705-2706`).

**Invariant:** the failure transaction's `centAmount` is `refund.amount`.

**Implementation:** `processor/src/services/stripe-payment.service.ts:2699-2712`.
