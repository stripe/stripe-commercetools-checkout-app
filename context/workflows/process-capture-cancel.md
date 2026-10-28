# Workflow: Capture & Cancel (Manual Capture)

**Trigger:** commercetools Checkout or the Merchant Center calls `POST /operations/payment-intents/:id` with action `capturePayment` or `cancelPayment`. Only relevant when `STRIPE_CAPTURE_METHOD=manual`.
**Modules involved:** processor.
**Actors:** Merchant backend / CT dashboard, Processor, Stripe API, CT API.
**Outcome:** The handler calls Stripe and returns `{ outcome: approved }` (or `rejected`) synchronously with HTTP 200. The connector writes **no** CT transaction in this call; the CT transaction (CHARGE on capture; AUTHORIZATION:FAILURE + CANCEL_AUTHORIZATION on cancel) is written **asynchronously by the corresponding Stripe webhook**.

Refund and reverse are in `process-refund-reversal.md`.

## Happy Path

1. OAuth2 authentication and authority `manage_project` / `manage_checkout_payment_intents`; body is one action (`maxItems: 1`); `capturePayment` requires `amount` — `processor/src/routes/operation.route.ts:83-114`; `processor/src/dtos/operations/payment-intents.dto.ts:8-16,28-33,57-70`; prefix `/operations` — `processor/src/server/plugins/operation.plugin.ts:7-8`
2. `modifyPayment` reads the CT Payment (`getPayment`) and dispatches the first action — `processor/src/services/abstract-payment.service.ts:136-172`
3. **Capture:** retrieves the PI from Stripe; requires `amountPlanned.centAmount`; `isPartialCapture = pi.amount_received + amount < amountPlanned` — `processor/src/services/stripe-payment.service.ts:323-335`
4. A partial capture without `STRIPE_ENABLE_MULTI_OPERATIONS` throws inside the `try` (→ `rejected`, see Error Paths) — `processor/src/services/stripe-payment.service.ts:337-348`
5. `paymentIntents.capture(piId, { amount_to_capture: amount, final_capture: false only when partial and multi-ops })` — `processor/src/services/stripe-payment.service.ts:350-356`
6. Returns `{ outcome: approved, pspReference: pi.id }` — `processor/src/services/stripe-payment.service.ts:358-370`
7. **Cancel:** `paymentIntents.cancel(piId)`; returns `approved` — `processor/src/services/stripe-payment.service.ts:386-398`
8. Later, the webhook writes the transaction: `payment_intent.succeeded` → `Charge/Success` (and `charge.updated` for incremental captures with multi-ops); `payment_intent.canceled` → `Authorization/Failure` + `CancelAuthorization/Success` — see `process-webhook.md`

## Error Paths

| Condition | Behavior | File |
|---|---|---|
| Partial capture with multi-ops disabled | error logged, **`{ outcome: rejected, pspReference: interfaceId }` with HTTP 200** — not a 400; CT unchanged | `processor/src/services/stripe-payment.service.ts:338-348,371-377` |
| `amountPlanned.centAmount` not set | throws inside `try` → `rejected` | `processor/src/services/stripe-payment.service.ts:330-332` |
| Stripe capture fails (PI already captured/canceled, amount too high) | caught, logged, `rejected` | `processor/src/services/stripe-payment.service.ts:371-377` |
| Stripe cancel fails (PI already canceled or succeeded) | caught, logged, `rejected` | `processor/src/services/stripe-payment.service.ts:399-405` |
| Body missing `amount` on capture, or more than one action | rejected by the route schema | `processor/src/dtos/operations/payment-intents.dto.ts:8-16,57-70` |
| Unknown action | `ErrorInvalidOperation('Operation not supported.')` | `processor/src/services/abstract-payment.service.ts:168-170` |

## Notes

### Prerequisites

- `STRIPE_CAPTURE_METHOD=manual` must be configured (or a behavior rule's `captureMethod` for the cart's market)
- CT Payment should have an AUTHORIZATION transaction in SUCCESS state — Stripe enforces this through the PI status (`requires_capture`)
- For partial capture: `STRIPE_ENABLE_MULTI_OPERATIONS=true` must be configured, and the Stripe account must support multicapture (the PI is created with `request_multicapture: 'if_available'` only under multi-ops — `processor/src/services/stripe-payment.service.ts:1481-1486`)

### Capture flow

```
Merchant                  Processor                        Stripe          CT
  |                           |                                |              |
  | POST /operations/         |                                |              |
  |   payment-intents/:id     |                                |              |
  | { action: capturePayment, |                                |              |
  |   amount }                |                                |              |
  |-------------------------->|                                |              |
  |                           | getPayment() from CT           |              |
  |                           |---------------------------------------------->|
  |                           | paymentIntents.retrieve()      |              |
  |                           |-------------------------------->|              |
  |                           |                                |              |
  |                           | if partial amount:             |              |
  |                           |   check stripeEnableMultiOps   |              |
  |                           |   if false → outcome REJECTED  |              |
  |                           |                                |              |
  |                           | paymentIntents.capture(        |              |
  |                           |   piId,                        |              |
  |                           |   { amount_to_capture,         |              |
  |                           |     final_capture: false       |              |
  |                           |       (partial + multi-ops) }) |              |
  |                           |-------------------------------->|              |
  |                           |                                |              |
  |                           | (no synchronous CT write —     |              |
  |                           |  CHARGE:SUCCESS is written by  |              |
  |                           |  the payment_intent.succeeded  |              |
  |                           |  webhook, not here)            |              |
  |   { outcome: APPROVED }   |                                |              |
  |<--------------------------|                                |              |
```

### Cancel flow

```
Merchant                  Processor                        Stripe          CT
  |                           |                                |              |
  | POST /operations/         |                                |              |
  |   payment-intents/:id     |                                |              |
  | { action: cancelPayment } |                                |              |
  |-------------------------->|                                |              |
  |                           | getPayment() from CT           |              |
  |                           |---------------------------------------------->|
  |                           |                                |              |
  |                           | paymentIntents.cancel(piId)    |              |
  |                           |-------------------------------->|              |
  |                           |                                |              |
  |                           | (no synchronous CT write —     |              |
  |                           |  AUTHORIZATION:FAILURE +       |              |
  |                           |  CANCEL_AUTHORIZATION:SUCCESS  |              |
  |                           |  come from the                 |              |
  |                           |  payment_intent.canceled       |              |
  |                           |  webhook, not here)            |              |
  |   { outcome: APPROVED }   |                                |              |
  |<--------------------------|                                |              |
```

### Multi-capture sequence

When `STRIPE_ENABLE_MULTI_OPERATIONS=true` and the merchant wants to capture in increments (example: `amountPlanned` 10000):

```
1. POST /operations/payment-intents/:id { action: capturePayment, amount: 5000 }
   → paymentIntents.capture(piId, { amount_to_capture: 5000, final_capture: false })
   → returns { outcome: APPROVED } (no synchronous CT write)
   → payment_intent.succeeded / charge webhook → CT: CHARGE SUCCESS, amount: 5000

2. (later) POST /operations/payment-intents/:id { action: capturePayment, amount: 3000 }
   → paymentIntents.capture(piId, { amount_to_capture: 3000, final_capture: false })
   → returns { outcome: APPROVED } (no synchronous CT write)
   → charge.updated webhook arrives → processStripeEventMultipleCaptured() → CT: CHARGE SUCCESS delta, amount: 3000

3. (final) POST /operations/payment-intents/:id { action: capturePayment, amount: 2000 }
   → paymentIntents.capture(piId, { amount_to_capture: 2000 })  ← no final_capture: false
     (amount_received 8000 + 2000 is not < 10000, so not partial)
   → returns { outcome: APPROVED } (no synchronous CT write)
   → webhook → CT: CHARGE SUCCESS, amount: 2000
```

### Decision points

| Point | Condition | Path |
|---|---|---|
| Amount provided | `amount_received + amount < amountPlanned` | Partial capture path — check multi-ops flag |
| Amount provided | `amount_received + amount >= amountPlanned` | Full / final capture |
| Multi-ops flag | `STRIPE_ENABLE_MULTI_OPERATIONS=true` | Allow partial capture (`final_capture: false`) |
| Multi-ops flag | `STRIPE_ENABLE_MULTI_OPERATIONS=false` | Outcome `rejected` (HTTP 200) |
| Capture method | `STRIPE_CAPTURE_METHOD=automatic` | Capture already happened — this call is invalid |

### Note on automatic capture

If `STRIPE_CAPTURE_METHOD=automatic` or `automatic_async`, the PI is charged at confirmation. Calling `capturePayment` in this case has no meaning and will fail at Stripe (→ `rejected`). The capture flow is only relevant for `manual` capture method.

### Other notes

- Multi-ops rules: `business-rules/multi-operations.md` Rule 1 "Partial captures require the feature flag and pass a cart total comparison", Rule 2 "Non-final captures use `final_capture: false`", Rule 3 "Multi-capture webhook uses the delta from `previous_attributes`…"; `business-rules/refunds-reversals.md` Rule 4 "Cancel operates on the PaymentIntent, not the Charge".
