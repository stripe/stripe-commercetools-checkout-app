# Multi-Capture & Multi-Refund

Multi-operations (partial captures and multiple refunds) are an opt-in feature controlled by
`STRIPE_ENABLE_MULTI_OPERATIONS`. When disabled, the connector assumes single capture and single refund
per payment. When enabled, it supports incremental captures and multiple partial refunds.

---

## Rule 1: Partial captures require the feature flag and pass a cart total comparison

**What:** `capturePayment()` determines whether a capture is partial by comparing
`stripePaymentIntent.amount_received + amountToBeCaptured < cartTotalAmount`, where `cartTotalAmount` is
the Payment's `amountPlanned`. If the result is partial:

- `STRIPE_ENABLE_MULTI_OPERATIONS=false` → the capture is rejected; `paymentIntents.capture` is not called
- `STRIPE_ENABLE_MULTI_OPERATIONS=true` → proceeds with `final_capture: false`

If `amountPlanned.centAmount` is missing from the CT payment, the capture is rejected before any capture call.

**Why:** Partial capture is a deliberate merchant choice, not a default behavior. Partial captures also need multicapture enabled on the Stripe account.

**Invariant:** `STRIPE_ENABLE_MULTI_OPERATIONS=false` means only full captures are allowed. Any request with a partial amount must be rejected — `paymentIntents.capture` is not called when `isPartialCapture` is true and the flag is off.

**Implementation:** `processor/src/services/stripe-payment.service.ts:323-378` → `capturePayment()` — partial test `:334-335`, early guard on `stripeEnableMultiOperations` `:338-348`. Operation route: `POST /operations/payment-intents/:id` (`processor/src/routes/operation.route.ts:84-90`).

---

## Rule 2: Non-final captures use `final_capture: false`

**What:** When capturing an amount less than the full authorized amount, `final_capture: false` is passed to Stripe. This signals that more captures will follow and keeps the authorization open.

**Invariant:** Any partial capture must set `final_capture: false`. Only the final capture in a sequence can omit this flag (or pass `true`).

**Implementation:** `processor/src/services/stripe-payment.service.ts:350-356` → `capturePayment()` — `final_capture: false` when partial and the flag is on; omitted otherwise.

---

## Rule 3: Multi-capture webhook uses the delta from `previous_attributes`, not the cumulative event amount

**What:** When `charge.updated` arrives (multi-capture event) and `STRIPE_ENABLE_MULTI_OPERATIONS=true`, `processStripeEventMultipleCaptured()`:

1. Skips processing (returns without updating CT) if `charge.captured === true` (already fully captured) or if `charge.amount_captured` did not increase vs `previous_attributes.amount_captured`.
2. Computes delta: `charge.amount_captured - previous_attributes.amount_captured`. That delta becomes the CT CHARGE transaction amount.
3. Records `charge.balance_transaction` as `interactionId` and `pspReference`.

With the flag off, `charge.updated` is logged and skipped at the route.

There is also a separate code path inside `processStripeEvent()` that calls `balanceTransactions.list({ source: latest_charge, limit: 10 })` when all three conditions hold: `capture_method === 'manual'`, `payment_method_options.card.request_multicapture === 'if_available'`, and `latest_charge` is a non-empty string. If the result has more than one balance transaction, `interactionId` and `amount` are overridden from `balanceTransactions.data[0]`.

**Why:** CT needs individual transaction records, not cumulative totals.

**Invariant:** For multi-capture, always compute the delta. Store that delta as the CT CHARGE transaction amount, and book nothing when it did not grow.

**Implementation:**

- `processor/src/routes/stripe-payment.route.ts:372-379` (dispatch only when the flag is on)
- `processor/src/services/stripe-payment.service.ts:2798-2850` → `processStripeEventMultipleCaptured()` (skips `:2803-2812`, delta `:2814-2821`)
- `processor/src/services/stripe-payment.service.ts:2164-2190` → `applyMulticaptureAdjustment()`, called from `processStripeEvent()` (`:2068`) — the balance-transactions branch for multicapture-flagged PIs

---

## Rule 4: Multi-refund per-refund amounts come from the webhook

**What:** Per-refund CT amounts come from the asynchronous `charge.refunded` webhook handled by `processStripeEventRefunded()`, which calls `stripe.refunds.list({ charge, created: { gte: charge.created }, limit: 2 })` and uses the most recent refund object. The dispatcher selects `processStripeEventRefunded` vs `processStripeEvent` based on `STRIPE_ENABLE_MULTI_OPERATIONS`.

**Implementation:**

- `processor/src/services/stripe-payment.service.ts:2741-2796` → `processStripeEventRefunded()` (per-refund amount via `stripe.refunds.list`)
- Dispatcher: `processor/src/routes/stripe-payment.route.ts:363-371` selects `processStripeEventRefunded` vs `processStripeEvent` based on `stripeEnableMultiOperations`.

---

## Rule 5: Multicapture is requested on the PaymentIntent only when multi-operations is enabled

**What:** `payment_method_options.card.request_multicapture: 'if_available'` is sent on the checkout
PaymentIntent only when `STRIPE_ENABLE_MULTI_OPERATIONS` is `true`.

**Why:** multicapture must be enabled on the Stripe account; the flag is the merchant's statement that it
is (`processor/src/config/config.ts:277-287`, the flag's documentation).

**Invariant:** `request_multicapture` is present iff the flag is true.

**Implementation:** `processor/src/services/stripe-payment.service.ts:1481-1486`; flag
`processor/src/config/config.ts:288`.
