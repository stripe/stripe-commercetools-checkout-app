# Workflow: Refund & Reversal

**Trigger:** Merchant calls `POST /payment-intents/:id` with action `refundPayment` or `reversePayment`.
**Actors:** Merchant backend / CT dashboard, Processor, Stripe API, CT API.
**Outcome:** CT Payment updated with REFUND (refund) or CANCEL_AUTHORIZATION (reversal of authorization).

---

## Refund Flow

```
Merchant                  Processor                        Stripe          CT
  |                           |                                |              |
  | POST /payment-intents/:id |                                |              |
  | { action: refundPayment,  |                                |              |
  |   amount? }               |                                |              |
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
  |                           |     amount? })                 |              |
  |                           |-------------------------------->|              |
  |                           |                                |              |
  |                           | updatePayment(                 |              |
  |                           |   REFUND: RECEIVED)            |              |
  |                           |---------------------------------------------->|
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

---

## Reversal Flow (Auto-Detect)

```
Merchant                  Processor                                        CT
  |                           |                                              |
  | POST /payment-intents/:id |                                              |
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

---

## Refund State Machine

```
CT REFUND transaction states:

  [Refund created]
       ↓
  RECEIVED  ← set synchronously when refunds.create() succeeds
       ↓
  SUCCESS   ← set when charge.refunded webhook arrives
```

The RECEIVED → SUCCESS transition always happens via webhook. It is never set synchronously.

---

## Decision Points

| Point | Condition | Path |
|---|---|---|
| Existing refunds | Refunds exist AND multi-ops disabled | Log warning; continue (not blocked) |
| Existing refunds | Refunds exist AND multi-ops enabled | Normal multi-refund path |
| Amount | Partial amount provided | Partial refund |
| Amount | No amount | Full refund of remaining amount |
| `reversePayment` | CHARGE transaction exists | Route to `refundPayment()` |
| `reversePayment` | AUTHORIZATION transaction exists (no charge) | Route to `cancelPayment()` |
| `reversePayment` | Payment already reversed | Throw error |

---

## Webhook Handling for Refunds

### Standard path (`STRIPE_ENABLE_MULTI_OPERATIONS=false`)
- `charge.refunded` → `processStripeEvent()` → converter creates REFUND:SUCCESS + CHARGE_BACK:SUCCESS
- Amount taken from `charge.amount_refunded` (cumulative)

### Multi-operations path (`STRIPE_ENABLE_MULTI_OPERATIONS=true`)
- `charge.refunded` → `processStripeEventRefunded()` → fetches specific refund object from Stripe
- Amount taken from the individual refund object (not cumulative)
- Allows multiple CT REFUND transactions on the same payment

---

## Error Paths

| Error | Cause | CT State |
|---|---|---|
| Stripe refund fails | PI not yet captured (only authorized) | CT stays at RECEIVED or unchanged |
| Stripe refund fails | Refund amount exceeds charged amount | CT not updated |
| Webhook never arrives | Stripe delivery failure | CT stuck at RECEIVED indefinitely |
| `reversePayment` with no valid state | Payment already reversed or canceled | Error returned; CT unchanged |
| CT update fails | API error | Stripe refund processed but CT not updated |
