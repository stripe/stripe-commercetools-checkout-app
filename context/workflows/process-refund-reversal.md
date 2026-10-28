# Workflow: Refund & Reversal

**Trigger:** commercetools Checkout or the Merchant Center calls `POST /operations/payment-intents/:id` with action `refundPayment` or `reversePayment`.
**Modules involved:** processor.
**Actors:** Merchant backend / CT dashboard, Processor, Stripe API, CT API.
**Outcome:** the Stripe refund created (refund, or reversal of a charged payment) or the PI canceled (reversal of an authorization), and an outcome returned with HTTP 200 (`received`, `approved` or `rejected`). The CT transaction — `REFUND` or `CANCEL_AUTHORIZATION` — is written by the resulting webhook.

## Happy Path

### Refund

1. OAuth2 + authority, one action, `refundPayment` requires `amount` — `processor/src/routes/operation.route.ts:83-114`; `processor/src/dtos/operations/payment-intents.dto.ts:18-26,57-70`
2. `modifyPayment` reads the CT Payment and dispatches — `processor/src/services/abstract-payment.service.ts:136-161`
3. `hasTransactionInState(payment, 'Refund', ['Success'])` (CT-side); if a refund exists and multi-ops is disabled, log a warning and continue — `processor/src/services/stripe-payment.service.ts:425-440`
4. Collect refund ids already recorded on the payment (`Refund` transactions' `interactionId`), before the create — `processor/src/services/stripe-payment.service.ts:442-450`
5. `refunds.create({ payment_intent, amount, metadata: { ct_payment_id } }, { idempotencyKey: 'refund-{ctPaymentId}-{amount}' })` — `processor/src/services/stripe-payment.service.ts:488-495`
6. If Stripe returned a refund id already recorded on the payment (idempotent replay): error log, `{ outcome: rejected, pspReference: refundId }` — `processor/src/services/stripe-payment.service.ts:536-550`
7. Otherwise `{ outcome: received, pspReference: refundId }`; **no CT write** — `processor/src/services/stripe-payment.service.ts:552-561`
8. Async (seconds to days later): `charge.refunded` → `REFUND:SUCCESS`; if the refund later fails, `refund.updated` / `refund.failed` → `REFUND:FAILURE` — see `process-webhook.md`

### Reversal (auto-detect)

9. Reads the CT transactions: `Charge/Success`; `Refund` in `Success|Pending`; `CancelAuthorization` in `Success|Pending` — `processor/src/services/stripe-payment.service.ts:580-597`
10. CASE A — `Charge/Success` and nothing reverted yet → `refundPayment` for `amountPlanned` (refund flow above) — `processor/src/services/stripe-payment.service.ts:599-605`
11. CASE B — `Authorization/Success` and nothing reverted yet → `cancelPayment` (see `process-capture-cancel.md`) — `processor/src/services/stripe-payment.service.ts:607-614`
12. CASE C — neither applies → `ErrorInvalidOperation('There is no successful payment transaction to reverse.')` — `processor/src/services/stripe-payment.service.ts:616`

## Error Paths

| Condition | Behavior | File |
|---|---|---|
| Refund later fails at Stripe | `refund.updated`/`refund.failed` writes `REFUND:FAILURE` | `processor/src/services/stripe-payment.service.ts:2682-2739` |
| `reversePayment` with no valid state (already reversed or canceled, or nothing successful) | `ErrorInvalidOperation` thrown → global error handler → HTTP 400 `InvalidOperation` (unlike a `rejected` outcome, which is HTTP 200); CT unchanged | `processor/src/services/stripe-payment.service.ts:616` |

## Notes

### Refund flow

```
Merchant                  Processor                        Stripe          CT
  |                           |                                |              |
  | POST /operations/         |                                |              |
  |   payment-intents/:id     |                                |              |
  | { action: refundPayment,  |                                |              |
  |   amount }                |                                |              |
  |-------------------------->|                                |              |
  |                           | getPayment() from CT           |              |
  |                           |---------------------------------------------->|
  |                           |                                |              |
  |                           | hasTransactionInState(         |              |
  |                           |   payment, 'Refund', ['Success']) (CT-side)   |
  |                           |                                |              |
  |                           | if existing CT Refund &&       |              |
  |                           |   !stripeEnableMultiOps:       |              |
  |                           |   → log warning (but continue) |              |
  |                           |                                |              |
  |                           | refunds.create(                |              |
  |                           |   { payment_intent: piId,      |              |
  |                           |     amount,                    |              |
  |                           |     metadata.ct_payment_id },  |              |
  |                           |   key refund-{id}-{amount})    |              |
  |                           |-------------------------------->|              |
  |                           |                                |              |
  |                           | (no CT write — outcome only)   |              |
  |   { outcome: RECEIVED }   |                                |              |
  |<--------------------------|                                |              |
  |                           |                                |              |
  |             (async — minutes later)                        |              |
  |                           |                                |              |
  | POST /stripe/webhooks     |                                |              |
  | charge.refunded           |                                |              |
  |<----------------------------------------------------------Stripe           |
  |                           | processStripeEventRefunded()   |              |
  |                           | or processStripeEvent()        |              |
  |                           | updatePayment(REFUND: SUCCESS) |              |
  |                           |---------------------------------------------->|
```

### Reversal flow (auto-detect)

```
Merchant                  Processor                                        CT
  |                           |                                              |
  | POST /operations/         |                                              |
  |   payment-intents/:id     |                                              |
  | { action: reversePayment }|                                              |
  |-------------------------->|                                              |
  |                           | getPayment() from CT                         |
  |                           |--------------------------------------------->|
  |                           |                                              |
  |                           | Check CT transactions:                       |
  |                           |                                              |
  |                           | CASE A: CHARGE SUCCESS exists                |
  |                           |   && no REFUND/CANCEL_AUTHORIZATION yet      |
  |                           |   → refundPayment() (see refund flow above)  |
  |                           |                                              |
  |                           | CASE B: AUTHORIZATION SUCCESS exists         |
  |                           |   && no REFUND/CANCEL_AUTHORIZATION yet      |
  |                           |   → cancelPayment() (see capture/cancel flow)|
  |                           |                                              |
  |                           | CASE C: neither applies                      |
  |                           |   → throw error                              |
```

"Yet" means a `Refund` or `CancelAuthorization` in `Success` **or `Pending`**.

### Refund state machine

```
Connector outcome (HTTP response, not a CT transaction):
  received  ← refunds.create() succeeded
  rejected  ← Stripe error, or idempotent replay of a recorded refund

CT REFUND transaction (written by webhooks only):
  SUCCESS   ← charge.refunded
  FAILURE   ← refund.updated / refund.failed with status failed|canceled
```

The transition to SUCCESS always happens via webhook. It is never set synchronously. On a delayed rail (bank transfer) the refund is `pending` at Stripe while CT already shows `Success`; it is corrected only if it fails (`business-rules/refunds-reversals.md` Rule 6).

### Decision points

| Point | Condition | Path |
|---|---|---|
| Existing refunds | Refunds exist AND multi-ops disabled | Log warning; continue (not blocked) |
| Existing refunds | Refunds exist AND multi-ops enabled | Normal multi-refund path |
| Amount | Less than the remaining charged amount | Partial refund |
| Amount | `reversePayment` (no amount in the body) | Refund of `amountPlanned` |
| `reversePayment` | CHARGE transaction exists | Route to `refundPayment()` |
| `reversePayment` | AUTHORIZATION transaction exists (no charge) | Route to `cancelPayment()` |
| `reversePayment` | Payment already reversed | Throw error |

### Webhook handling for refunds

#### Standard path (`STRIPE_ENABLE_MULTI_OPERATIONS=false`)
- `charge.refunded` → `processStripeEvent()` → converter creates REFUND:SUCCESS
- Amount taken from `charge.amount_refunded` (cumulative)

#### Multi-operations path (`STRIPE_ENABLE_MULTI_OPERATIONS=true`)
- `charge.refunded` → `processStripeEventRefunded()` → `refunds.list({ charge, created ≥ charge.created, limit: 2 })` and takes the first (latest) refund
- Amount taken from the individual refund object (not cumulative); `interactionId` = refund id
- Allows multiple CT REFUND transactions on the same payment
- Anchors: `processor/src/services/stripe-payment.service.ts:2741-2796`

### Other notes

- `metadata.ct_payment_id` set on the Refund links it so that `refund.updated`/`refund.failed` can correct a failed refund (`processor/src/services/stripe-payment.service.ts:452-463`).
- See `business-rules/refunds-reversals.md` Rule 2 "Reverse payment auto-detects the correct operation", Rule 3 "Refund outcome is RECEIVED — final state comes via webhook", Rule 8 "A failed capture, cancel or refund returns `REJECTED`, not an exception" (the reverse throw is its stated exception).
