# Workflow: Async Settlement (crypto / stablecoin)

**Trigger:** A buyer pays with an asynchronous / redirect payment method (crypto/stablecoin — USDC; ACH `us_bank_account`; EU bank transfers) whose PaymentIntent confirms into `processing` (or, for a bank transfer, `requires_action` with transfer instructions) before settling.
**Modules involved:** enabler, processor (the order-subscriber also reads the result — `reflect-payment-state-on-order-created.md`).
**Actors:** Buyer, Stripe (redirect wallet page + webhooks), Processor, CT API.
**Outcome:** The CT Payment reflects the in-flight state as `Authorization/Pending`, then resolves to `Authorization/Success` + `Charge/Success` on settlement (with `Order.paymentState = Paid` when the connector owns the order and the amount covers it), or to `Authorization/Failure` on failure/cancellation.

## Happy Path

### Webhook-driven (crypto — redirect)

1. Buyer selects crypto; `stripe.confirmPayment` → PI `requires_action` (`redirect_to_url`); the buyer is redirected to the wallet page and deposits funds — Stripe-side
2. `payment_intent.processing`: the route first reflects `Order.paymentState → Pending` (best-effort, retried while the order does not exist yet), then dispatches to `processStripeEvent()` — `processor/src/routes/stripe-payment.route.ts:273-279`; `processor/src/services/stripe-payment.service.ts:2409-2449`
3. Converter maps it to a single `Authorization/Pending`; amount from `data.amount` (not `amount_received`, which is `0` while processing) — `processor/src/services/converters/stripeEventConverter.ts:289-302`
4. Dedup: `hasTransactionInState()` skips the write if a `Charge/Success` or `Authorization/Pending` already exists (the sync gate may have written it first for non-redirect methods) — `processor/src/services/stripe-payment.service.ts:2040-2045,2134-2157`
5. `payment_intent.succeeded` (+ `charge.succeeded`): the order axis runs first — ownership (order already `Pending`, or the Payment carries `Authorization/Pending`) and coverage (`amount_received` plus other payments' charges ≥ order gross) gate a `Paid` write — `processor/src/routes/stripe-payment.route.ts:258-272`; `processor/src/services/stripe-payment.service.ts:2307-2371`
6. Converter emits `Charge/Success` (amount from `amount_received`) — `processor/src/services/converters/stripeEventConverter.ts:280-288`
7. If an `Authorization/Pending` exists it is transitioned to `Success` (best-effort — a failure is logged and does not block). Log line: `Transitioned pending authorization to Success after payment_intent.succeeded` — `processor/src/services/stripe-payment.service.ts:2085-2087,2198-2228`

### Synchronous gate variant (non-redirect async methods)

8. For methods that confirm synchronously through `POST /confirmPayments/:id`, `updatePaymentIntentStripeSuccessful()` runs the validation (see `business-rules/payment-lifecycle.md` Rules 2 & 8, and `process-standard-payment.md` step 21) and, when the PI is `processing` — or `requires_action` with bank-transfer instructions — writes `Authorization/Pending` only (deduped) and returns `PENDING` (HTTP 202) — `processor/src/services/stripe-payment.service.ts:1596-1608,1653-1656,1755-1780`; `processor/src/routes/stripe-payment.route.ts:121-123`
9. The drop-in branches on the outcome — a `pending` result calls `onComplete({ isSuccess: false })`, not success (no premature fulfillment) — `enabler/src/dropin/dropin-embedded.ts:257-266`. Express treats the same 202 as success (`process-express-checkout.md`)

### Failure / cancellation

10. `payment_intent.payment_failed` → `Authorization/Failure`; `payment_intent.canceled` → `Authorization/Failure` + `CancelAuthorization/Success`. Expiration without a deposit surfaces as `payment_intent.canceled`. Both also drive `Order.paymentState → Failed` where the connector owns the order — `processor/src/services/converters/stripeEventConverter.ts:265-279,337-345`; `processor/src/utils.ts:117-123`

## Error Paths

| Condition | Behavior | File |
|---|---|---|
| CT update fails on `processing` | Rethrown → non-2xx → Stripe retries; dedup prevents a duplicate `Pending` on redelivery | `processor/src/services/stripe-payment.service.ts:2117-2119` |
| Order not yet created when `processing` / `requires_action` arrives | order lookup retried (500, 1500, 3000, 6000 ms); exhausted → warn, no `Pending` write; the settlement event can still write `Paid` through ownership signal 2 | `processor/src/services/stripe-payment.service.ts:131,2409-2449,2472-2483` |
| Settled amount does not cover the order gross | `Paid` not written; warn | `processor/src/services/stripe-payment.service.ts:2346-2369` |
| Pending → Success promotion fails | logged, non-blocking; `Authorization/Pending` remains next to `Charge/Success` | `processor/src/services/stripe-payment.service.ts:2222-2227` |
| Async ACH debit failure (`insufficient_funds`/`no_account`) | arrives *after* commercetools Checkout has created the order, so `payment_failed`/`canceled` also drives `Order.paymentState → Failed` (ownership-gated) | `processor/src/services/stripe-payment.service.ts:2266-2371` |
| Synchronous ACH rejection at confirm (`charge_exceeds_source_limit`) | the PI never confirms, so **no order is created** (cart stays `Active`) and only the Payment carries `Authorization/Failure` | — |

## Notes

### Flow (crypto — redirect, webhook-driven)

```
Buyer            Enabler           Stripe                     Processor                 CT
  |                 |                 |                           |                       |
  | select crypto   |                 |                           |                       |
  |---------------->| confirmPayment  |                           |                       |
  |                 |---------------->| PI: requires_action       |                       |
  |                 |                 | (redirect_to_url)         |                       |
  |   redirect to wallet page  <------|                           |                       |
  |   (crypto.stripe.com)             |                           |                       |
  |   ...deposit funds...             |                           |                       |
  |                 |                 | PI: processing            |                       |
  |                 |                 |--- payment_intent.processing ------------------->  |
  |                 |                 |                           | order axis: Pending   |
  |                 |                 |                           | processStripeEvent()  |
  |                 |                 |                           | dedup (hasTxnInState) |
  |                 |                 |                           |---- Authorization:PENDING -->|
  |                 |                 | PI: succeeded             |                       |
  |                 |                 |--- payment_intent.succeeded + charge.succeeded --> |
  |                 |                 |                           | order axis: Paid      |
  |                 |                 |                           |  (owned + covered)    |
  |                 |                 |                           | Charge:SUCCESS        |
  |                 |                 |                           | transition Pending    |
  |                 |                 |                           |   Authorization→SUCCESS|
  |                 |                 |                           |---------------------->|
```

**Note:** For crypto, the buyer is redirected away and the lifecycle is driven entirely by webhooks — the synchronous confirm gate (`/confirmPayments`) is **not** on this path. For non-redirect async methods (ACH / bank transfers), the gate DOES run and returns `PENDING` (202); see the "Synchronous gate variant" above.

### Configuration prerequisite

Crypto/stablecoin only appears in the Payment Element when it is enabled on the Stripe account **and** the connector uses automatic capture with saved payment methods NOT forced to `off_session` (`STRIPE_SAVED_PAYMENT_METHODS_CONFIG`). Otherwise Stripe filters non-savable methods and crypto is hidden. See `processor/README.md`.

### Other notes

- The connector does not create orders — commercetools Checkout creates the order. On `payment_intent.succeeded` the connector reflects `Order.paymentState → Paid` onto that order.
- `requires_action` is the **bank-transfer** entry into this same flow: for a PaymentIntent carrying `next_action.display_bank_transfer_instructions` it writes `Authorization/Pending` for `pi.amount`, exactly as `processing` does for crypto. Card 3DS, Boleto and redirect methods emit the same event and are filtered out at the route — they never reach the converter. See `business-rules/webhook-handling.md` Rule 6. (Anchors: `processor/src/routes/stripe-payment.route.ts:280-331`; `processor/src/services/converters/stripeEventConverter.ts:303-327`.)
- `payment_intent.partially_funded` (a bank transfer arriving in instalments) writes no transaction — `processor/src/services/stripe-payment.service.ts:84-98`.
- Order-state rules: `business-rules/order-payment-state.md` Rule 2 "The connector owns the order state only for asynchronous rails", Rule 4 "The webhook always precedes order creation — the lag is variable and the wait is bounded", Rule 5 "`Paid` is authoritative; the transition is monotonic".
