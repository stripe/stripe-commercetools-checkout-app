# Business Rule: Multi-Capture & Multi-Refund

## Overview

Multi-operations (partial captures and multiple refunds) are an opt-in feature controlled by `STRIPE_ENABLE_MULTI_OPERATIONS`. When disabled, the connector assumes single capture and single refund per payment. When enabled, it supports incremental captures and multiple partial refunds.

---

## Rule 1: Partial captures require the feature flag and pass a cart total comparison

**What:** `capturePayment()` determines whether a capture is partial by comparing `stripePaymentIntent.amount_received + amountToBeCaptured < cartTotalAmount`. If the result is partial:

- `STRIPE_ENABLE_MULTI_OPERATIONS=false` → logs error and throws; operation rejected
- `STRIPE_ENABLE_MULTI_OPERATIONS=true` → proceeds with `final_capture: false`

If `amountPlanned.centAmount` is missing from the CT payment, an error is thrown before any Stripe call (guard against misconfigured CT data).

**Why:** Partial capture is a deliberate merchant choice, not a default behavior. Accidental partial captures leave money on the table and confuse order reconciliation.

**Invariant:** `STRIPE_ENABLE_MULTI_OPERATIONS=false` means only full captures are allowed. Any request with a partial amount must be rejected.

**Implementation:** `stripe-payment.service.ts` → `capturePayment()` — early guard on `stripeEnableMultiOperations`.

**What breaks if violated:** Partial amounts are captured without the merchant's explicit intention to use multi-capture. The remaining authorized amount is released by Stripe after its authorization window expires.

---

## Rule 2: Non-final captures use `final_capture: false`

**What:** When capturing an amount less than the full authorized amount, `final_capture: false` is passed to Stripe. This signals that more captures will follow and keeps the authorization open.

**Why:** Without `final_capture: false`, Stripe treats every capture as the last one and releases any remaining authorized amount.

**Invariant:** Any partial capture must set `final_capture: false`. Only the final capture in a sequence can omit this flag (or pass `true`).

**Implementation:** `stripe-payment.service.ts` → `capturePayment()` — `final_capture: false` when partial.

**What breaks if violated:** The first partial capture closes the authorization. Subsequent captures fail because there is nothing left to capture.

---

## Rule 3: Multi-capture webhook uses the delta from `previous_attributes`, not the cumulative event amount

**What:** When `charge.updated` arrives (multi-capture event) and `STRIPE_ENABLE_MULTI_OPERATIONS=true`, `processStripeEventMultipleCaptured()`:

1. Skips processing if `charge.captured === true` (already fully captured) or if `charge.amount_captured` did not increase vs `previous_attributes.amount_captured` — silent early return, CT not updated.
2. Computes delta: `charge.amount_captured - previous_attributes.amount_captured`. That delta becomes the CT CHARGE transaction amount.
3. Records `charge.balance_transaction` as `interactionId` and `pspReference`.

There is also a separate code path inside `processStripeEvent()` that calls `balanceTransactions.list({ source: latest_charge, limit: 10 })` when all three conditions hold: `capture_method === 'manual'`, `payment_method_options.card.request_multicapture === 'if_available'`, and `latest_charge` is a non-empty string. If the result has more than one balance transaction, `interactionId` and `amount` are overridden from `balanceTransactions.data[0]`.

**Why:** CT needs individual transaction records, not cumulative totals. If `amount_captured` is used directly, each new capture overstates the total by including previous captures.

**Invariant:** For multi-capture, always compute the delta. Store that delta as the CT CHARGE transaction amount.

**Implementation:**

- `processor/src/services/stripe-payment.service.ts` → `processStripeEventMultipleCaptured()` (delta from `previous_attributes`)
- `processor/src/services/stripe-payment.service.ts` → `processStripeEvent()` (balance-transactions branch for multicapture-flagged PIs)

**What breaks if violated:** CT shows inflated capture amounts. The total captured in CT far exceeds the actual charge, causing reconciliation failures.

---

## Rule 4: Multi-refund tracking warns on the second refund and per-refund amounts come from the webhook

**What:** When `refundPayment()` runs, it calls `ctPaymentService.hasTransactionInState({ payment, transactionType: 'Refund', states: ['Success'] })` against the **CT** payment (not Stripe's `refunds.list`). If a successful refund already exists **and** `STRIPE_ENABLE_MULTI_OPERATIONS` is **disabled**, it logs a warning and continues. Per-refund CT amounts come from the asynchronous `charge.refunded` webhook handled by `processStripeEventRefunded()`, which calls `stripe.refunds.list({ charge, created: { gte: charge.created }, limit: 2 })` and uses the most recent refund object.

**Why:** Each refund in a multi-refund sequence must be independently tracked. The warning surfaces unexpected multi-refund scenarios when the merchant has not enabled multi-operations.

**Invariant:** When `STRIPE_ENABLE_MULTI_OPERATIONS=true`, each refund is a distinct Stripe refund object with its own ID, and the webhook handler creates a separate REFUND transaction per event using the per-refund amount (not the cumulative `amount_refunded`).

**Implementation:**

- `processor/src/services/stripe-payment.service.ts` → `refundPayment()` (CT-side detection + warning)
- `processor/src/services/stripe-payment.service.ts` → `processStripeEventRefunded()` (per-refund amount via `stripe.refunds.list`)
- Dispatcher: `processor/src/routes/stripe-payment.route.ts` selects `processStripeEventRefunded` vs `processStripeEvent` based on `stripeEnableMultiOperations`.

**What breaks if violated:** Without individual refund tracking, the total refunded in CT is incorrect when multiple partial refunds exist.
