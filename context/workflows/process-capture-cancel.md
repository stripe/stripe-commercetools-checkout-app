# Workflow: Capture & Cancel (Manual Capture)

**Trigger:** Merchant calls `POST /payment-intents/:id` with action `capturePayment` or `cancelPayment`. Only relevant when `STRIPE_CAPTURE_METHOD=manual`.
**Actors:** Merchant backend / CT dashboard, Processor, Stripe API, CT API.
**Outcome:** The handler calls Stripe and returns `{ outcome: APPROVED }` synchronously. The CT transaction (CHARGE on capture; AUTHORIZATION:FAILURE + CANCEL_AUTHORIZATION on cancel) is written **asynchronously by the corresponding Stripe webhook**, not by this call.

---

## Prerequisites

- `STRIPE_CAPTURE_METHOD=manual` must be configured
- CT Payment must have an AUTHORIZATION transaction in SUCCESS state
- For partial capture: `STRIPE_ENABLE_MULTI_OPERATIONS=true` must be configured

---

## Capture Flow

```
Merchant                  Processor                        Stripe          CT
  |                           |                                |              |
  | POST /payment-intents/:id |                                |              |
  | { action: capturePayment, |                                |              |
  |   amount? }               |                                |              |
  |-------------------------->|                                |              |
  |                           | getPayment() from CT           |              |
  |                           |---------------------------------------------->|
  |                           |                                |              |
  |                           | if partial amount:             |              |
  |                           |   check stripeEnableMultiOps   |              |
  |                           |   if false → reject 400        |              |
  |                           |                                |              |
  |                           | paymentIntents.capture(        |              |
  |                           |   piId,                        |              |
  |                           |   { amount_to_capture?,        |              |
  |                           |     final_capture: false })    |              |
  |                           |-------------------------------->|              |
  |                           |                                |              |
  |                           | (no synchronous CT write —     |              |
  |                           |  CHARGE:SUCCESS is written by  |              |
  |                           |  the payment_intent.succeeded  |              |
  |                           |  webhook, not here)            |              |
  |   { outcome: APPROVED }   |                                |              |
  |<--------------------------|                                |              |
```

---

## Cancel Flow

```
Merchant                  Processor                        Stripe          CT
  |                           |                                |              |
  | POST /payment-intents/:id |                                |              |
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

---

## Multi-Capture Sequence

When `STRIPE_ENABLE_MULTI_OPERATIONS=true` and the merchant wants to capture in increments:

```
1. POST /payment-intents/:id { action: capturePayment, amount: 5000 }
   → paymentIntents.capture(piId, { amount_to_capture: 5000, final_capture: false })
   → returns { outcome: APPROVED } (no synchronous CT write)
   → payment_intent.succeeded / charge webhook → CT: CHARGE SUCCESS, amount: 5000

2. (later) POST /payment-intents/:id { action: capturePayment, amount: 3000 }
   → paymentIntents.capture(piId, { amount_to_capture: 3000, final_capture: false })
   → returns { outcome: APPROVED } (no synchronous CT write)
   → charge.updated webhook arrives → processStripeEventMultipleCaptured() → CT: CHARGE SUCCESS delta, amount: 3000

3. (final) POST /payment-intents/:id { action: capturePayment, amount: 2000 }
   → paymentIntents.capture(piId, { amount_to_capture: 2000 })  ← no final_capture: false
   → returns { outcome: APPROVED } (no synchronous CT write)
   → webhook → CT: CHARGE SUCCESS, amount: 2000
```

---

## Decision Points

| Point | Condition | Path |
|---|---|---|
| Amount provided | `amount < total` | Partial capture path — check multiOps flag |
| Amount provided | `amount == total` or omitted | Full capture |
| Multi-ops flag | `STRIPE_ENABLE_MULTI_OPERATIONS=true` | Allow partial capture |
| Multi-ops flag | `STRIPE_ENABLE_MULTI_OPERATIONS=false` | Reject with 400 |
| Capture method | `STRIPE_CAPTURE_METHOD=automatic` | Capture already happened — this call is invalid |

---

## Error Paths

| Error | Cause | CT State |
|---|---|---|
| 400: partial capture rejected | Multi-ops disabled | CT unchanged |
| Stripe capture fails | PI already captured/canceled | CT not updated |
| Stripe cancel fails | PI already canceled or succeeded | CT not updated |
| CT update fails | API error | Stripe updated but CT diverges |

---

## Note on Automatic Capture

If `STRIPE_CAPTURE_METHOD=automatic` or `automatic_async`, the PI is charged at confirmation. Calling `capturePayment` in this case has no meaning and will fail at Stripe. The capture flow is only relevant for `manual` capture method.
