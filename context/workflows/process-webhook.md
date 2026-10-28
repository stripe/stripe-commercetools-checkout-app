# Workflow: Webhook Processing

**Trigger:** Stripe sends one of the 12 events post-deploy subscribes to `POST /stripe/webhooks` (`processor/src/connectors/actions.ts:65-86`).
**Modules involved:** processor (the order-subscriber reads its output — see `reflect-payment-state-on-order-created.md`).
**Actors:** Stripe (sender), Processor, CT API.
**Outcome:** CT Payment updated with the transaction state reflecting Stripe's event, and `Order.paymentState` updated where the event maps to a state and the connector owns it.

## Happy Path

1. Pre-handler `StripeHeaderAuthHook.authenticate` checks that the `stripe-signature` header is present — `processor/src/libs/fastify/hooks/stripe-header-auth.hook.ts:5-12`; `processor/src/routes/stripe-payment.route.ts:211`
2. The raw body is verified with `stripeApi().webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SIGNING_SECRET)` — `processor/src/routes/stripe-payment.route.ts:212,219-224`
3. Dispatch by event type (table in Notes) — `processor/src/routes/stripe-payment.route.ts:257-383`
4. **Order-payment-state axis first.** For `payment_intent.succeeded` / `charge.succeeded` / `payment_intent.processing` / `payment_intent.canceled` / `payment_intent.payment_failed` / `payment_intent.requires_action` / `payment_intent.partially_funded`, the route calls `reflectOrderPaymentStateBestEffort(event)` **before** the transaction axis — `processor/src/routes/stripe-payment.route.ts:268,277,322`. Events absent from `ORDER_PAYMENT_STATE_BY_EVENT` (`charge.succeeded`, `partially_funded`) no-op there — `processor/src/utils.ts:117-123`; `processor/src/services/stripe-payment.service.ts:2266-2387`
5. `processStripeEvent`: resolve the payment-method type (one Stripe read, never throws), convert, skip a foreign PI (no `ct_payment_id`), dedup the async-pending events, send `partially_funded` to `updatePayment` with no transaction, apply the multicapture adjustment, `updatePayment` once per transaction — `processor/src/services/stripe-payment.service.ts:1974-2084`
6. `payment_intent.succeeded`: promote a lingering `Authorization/Pending` to `Success` (best-effort) — `processor/src/services/stripe-payment.service.ts:2085-2087,2198-2228`; then `storePaymentMethod` for `payment_intent.succeeded` and `charge.succeeded` — `processor/src/routes/stripe-payment.route.ts:271`
7. `payment_intent.requires_action` / `partially_funded` reach `processStripeEvent` only for a bank transfer (`isBankTransferNextAction`); otherwise log-only — `processor/src/routes/stripe-payment.route.ts:324-330`; `processor/src/utils.ts:84-87`
8. `refund.updated` / `refund.failed` act only on status `failed` / `canceled` → `processStripeEventRefundFailed` — `processor/src/routes/stripe-payment.route.ts:335-362`; `processor/src/services/stripe-payment.service.ts:2682-2739`
9. `charge.refunded` → `processStripeEventRefunded` (multi-ops) or `processStripeEvent`; `charge.updated` → `processStripeEventMultipleCaptured` (multi-ops only) — `processor/src/routes/stripe-payment.route.ts:363-379`
10. The whole event is processed synchronously (`await`-ed); only then 200. The handler does not ack early — `processor/src/routes/stripe-payment.route.ts:385`

## Error Paths

| Condition | Behavior | File |
| --- | --- | --- |
| `stripe-signature` header absent | pre-handler rejects (`ErrorAuthErrorResponse`) | `processor/src/libs/fastify/hooks/stripe-header-auth.hook.ts:8-11` |
| Signature verification fails (wrong secret, tampered payload, clock skew, mangled raw body) | 400 `Webhook Error: <message>`; only `errorType`/`errorMessage` logged, never the payload; Stripe retries | `processor/src/routes/stripe-payment.route.ts:225-255` |
| `ct_payment_id` missing from PI metadata (`processStripeEvent`) | **warn** and return → 200; it belongs to another integration (`business-rules/webhook-handling.md` Rule 8) | `processor/src/services/stripe-payment.service.ts:2026-2032` |
| `ct_payment_id` missing on the order axis | warn, no order write | `processor/src/services/stripe-payment.service.ts:2284-2290` |
| CT write fails on `processing` / `requires_action` (`ASYNC_PENDING_EVENTS`) | scalar-only log, then **re-thrown** → non-2xx → Stripe retries; dedup prevents a duplicate Pending on redelivery | `processor/src/services/stripe-payment.service.ts:84-87,2117-2119` |
| Failed-refund write fails | re-thrown → Stripe retries | `processor/src/services/stripe-payment.service.ts:2720-2738` |
| No refund found for the charge (multi-ops) | warn, nothing written | `processor/src/services/stripe-payment.service.ts:2754-2758` |
| Failed refund without `ct_payment_id` (Dashboard refund) | warn and skip | `processor/src/services/stripe-payment.service.ts:2687-2697` |
| Order reflection failure (lookup, ownership read, coverage fetch, write) | does not fail the webhook — by contract | `processor/src/services/stripe-payment.service.ts:2372-2386` |
| Unsupported event type | logged, 200 | `processor/src/routes/stripe-payment.route.ts:380-382` |

## Notes

### Sequence

```text
Stripe                    Processor                               CT
  |                           |                                    |
  | POST /stripe/webhooks     |                                    |
  | (Stripe-Signature header) |                                    |
  |-------------------------->|                                    |
  |                           | webhooks.constructEvent()          |
  |                           | (verify signature)                 |
  |                           |                                    |
  |                           | if signature invalid → 400        |
  |                           |                                    |
  |                           | (process event based on type)      |
  |                           | reflectOrderPaymentStateBestEffort |
  |                           |   (payment_intent.* first)         |
  |                           |                                    |
  |                           |--- payment_intent.succeeded -----> |
  |                           |    charge.succeeded                |
  |                           |    → processStripeEvent()          |
  |                           |    → updatePayment(CHARGE:SUCCESS  |
  |                           |       or AUTHORIZATION:SUCCESS)    |
  |                           |    → storePaymentMethod()          |
  |                           |    → savePaymentMethodIfNew()  --->|
  |                           |    → createRecurringPaymentJob() ->|
  |                           |                                    |
  |                           |--- payment_intent.canceled ------> |
  |                           |    → processStripeEvent()          |
  |                           |    → updatePayment(AUTHORIZATION:FAILURE
  |                           |       + CANCEL_AUTHORIZATION:SUCCESS)
  |                           |                                    |
  |                           |--- payment_intent.payment_failed ->|
  |                           |    → processStripeEvent()          |
  |                           |    → updatePayment(AUTHORIZATION:FAILURE)
  |                           |                                    |
  |                           |--- payment_intent.processing -----> |
  |                           |    → processStripeEvent()          |
  |                           |    → updatePayment(AUTHORIZATION:PENDING, deduped)
  |                           |    → (write failure rethrows; Stripe retries)
  |                           |                                    |
  |                           |--- payment_intent.requires_action  |
  |                           |    gated by isBankTransferNextAction():
  |                           |    • bank transfer → processStripeEvent()
  |                           |      → converter: AUTHORIZATION:PENDING (pi.amount)
  |                           |    • card 3DS / Boleto / ACH microdeposit / redirect
  |                           |      → log-only, service NOT called
  |                           |    (order axis still runs first, see note below)
  |                           |                                    |
  |                           |--- charge.refunded --------------> |
  |                           |    if multiOps:                    |
  |                           |      → processStripeEventRefunded()|
  |                           |      → refunds.list() [Stripe]     |
  |                           |      → updatePayment(REFUND:SUCCESS|
  |                           |         + CHARGE_BACK:SUCCESS, per-refund amount)
  |                           |    else:                           |
  |                           |      → processStripeEvent()        |
  |                           |      → updatePayment(REFUND:SUCCESS|
  |                           |         + CHARGE_BACK:SUCCESS)     |
  |                           |                                    |
  |                           |--- refund.updated / refund.failed  |
  |                           |    (status failed|canceled only)   |
  |                           |      → updatePayment(REFUND:FAILURE)|
  |                           |                                    |
  |                           |--- charge.updated (multicapture) ->|
  |                           |    if multiOps:                    |
  |                           |      → processStripeEventMultipleCaptured()
  |                           |      → reads previous_attributes   |
  |                           |      → compute delta amount        |
  |                           |      → updatePayment(CHARGE:SUCCESS)|
  |                           |                                    |
  |   200 OK                  |                                    |
  |<--------------------------|                                    |
```

### Event routing

| Event | Handler | Additional Action | Notes |
|---|---|---|---|
| `payment_intent.succeeded` | `processStripeEvent()` | `storePaymentMethod()` | Converter emits `CHARGE: SUCCESS` (amount `amount_received`); then promotes a lingering `Authorization/Pending` |
| `charge.succeeded` | `processStripeEvent()` | `storePaymentMethod()` | Converter emits `AUTHORIZATION: SUCCESS` |
| `payment_intent.canceled` | `processStripeEvent()` | — | `AUTHORIZATION: FAILURE + CANCEL_AUTHORIZATION: SUCCESS` |
| `payment_intent.processing` | `processStripeEvent()` | — | `AUTHORIZATION: PENDING` (async settlement); deduped; resolved to SUCCESS on `payment_intent.succeeded`; write failure rethrows (Stripe retries). See `process-async-settlement.md` |
| `payment_intent.requires_action` | `processStripeEvent()` **only for bank transfers** | — | Gated by `isBankTransferNextAction()`. Bank transfer → `AUTHORIZATION: PENDING` for `pi.amount` (never `amount_received`, which is 0 until the wire lands). Card 3DS, Boleto, ACH microdeposits (`verify_with_microdeposits`) and redirect methods emit the same event and stay **log-only** on the transaction axis — they never reach the service (the order axis still runs; see `business-rules/order-payment-state.md` Rule 3). See `business-rules/webhook-handling.md` Rule 6 |
| `payment_intent.partially_funded` | `processStripeEvent()` (same gate) | — | No CT transaction. `ZERO_TRANSACTION_PERSIST_EVENTS` still sends it to `updatePayment` |
| `payment_intent.payment_failed` | `processStripeEvent()` | — | `AUTHORIZATION: FAILURE` |
| `customer_cash_balance_transaction.created` | **none** — `logCustomerCashBalanceTransaction()` | — | Observability only; never converted (`convert()` rejects it). `funding_reversed` / `adjusted_for_overdraft` log at error level. Payload carries `sender_name`, `iban_last4`, `sort_code` — never log the raw event |
| `charge.refunded` | `processStripeEventRefunded()` (multi-ops) or `processStripeEvent()` | — | Converter emits `REFUND: SUCCESS` + `CHARGE_BACK: SUCCESS`. Multi-ops overrides the amount with the latest refund from `refunds.list` |
| `refund.updated` / `refund.failed` | `processStripeEventRefundFailed()` | — | Acts **only** on `status` `failed` or `canceled` → `REFUND: FAILURE` at the refund's own amount. Does not use the converter; correlates via `refund.metadata.ct_payment_id`. See `business-rules/refunds-reversals.md` Rule 6 |
| `charge.updated` | `processStripeEventMultipleCaptured()` (multi-ops only) | — | Skipped entirely when multi-ops disabled |

Anchors: converter `processor/src/services/converters/stripeEventConverter.ts:263-386`; cash-balance log `processor/src/routes/stripe-payment.route.ts:179-205,332-334`.

> **Order-payment-state axis runs first.** The route calls `reflectOrderPaymentStateBestEffort(event)` **before** `processStripeEvent()` (`stripe-payment.route.ts:268, 277, 322`). This best-effort order-state reflection is load-bearing and independent of the transaction axis — ownership signal 2 reads the `Authorization/Pending` that `processStripeEvent` would flip to `Success` — see `business-rules/order-payment-state.md` Rule 3 and `processor/src/services/stripe-payment.service.ts:2451-2483`. For `Paid` it also requires the settled amount (`amount_received` plus the order's other payments' `Charge/Success`) to cover the order's gross total (`:2346-2369`).

> **Before any of the above runs:** an event whose PaymentIntent carries no `ct_payment_id` is skipped with a warning and a 200 — it belongs to another integration.

### CT Payment ID extraction
- `stripeEventConverter.getCtPaymentId()` reads `event.data.object.metadata.ct_payment_id` — `processor/src/services/converters/stripeEventConverter.ts:415-417`
- If missing: CT cannot be updated — `processStripeEvent` logs a warning and skips (Error Paths)

### Transaction mapping
- `stripeEventConverter.convert()` maps the event to CT transaction format — `processor/src/services/converters/stripeEventConverter.ts:22-65`:
  - Determines transaction types and states
  - Extracts PSP reference (charge's PI id, else charge id; or PI id)
  - Extracts amount from the appropriate field per event type
  - Takes the payment method type from the caller for `payment_intent.*` (resolved with one Stripe read), from `payment_method_details.type` for charges
  - Builds a redacted `pspInteraction`: `next_action` reduced to an allowlist and `client_secret` nulled on every PaymentIntent payload (`business-rules/webhook-handling.md` Rule 9) — `:86-261`

### CT Payment update
- `ctPaymentService.updatePayment()` applies the transactions, one call per transaction — `processor/src/services/stripe-payment.service.ts:2070-2083`
- On a `409 ConcurrentModification` the SDK retries by itself: each attempt re-reads the Payment and rebuilds the actions against the fresh version, up to 3 attempts with exponential backoff; only the third failure throws (installed SDK 1.2.2, `node_modules/@commercetools/connect-payments-sdk/dist/commercetools/services/ct-payment.service.js:27-60`). See `business-rules/payment-lifecycle.md` Rule 4. What happens after that throw depends on the event (Error Paths).

### Payment method storage (for `payment_intent.succeeded` and `charge.succeeded` only)

The dispatcher in `processor/src/routes/stripe-payment.route.ts` calls `storePaymentMethod(event)` after `processStripeEvent(event)` for both events — `processor/src/services/stripe-payment.service.ts:2606-2660`.

- `extractPaymentMethodDataFromEvent()` extracts the Stripe payment method ID, CT customer ID (`ct_customer_id`) and CT payment ID from event metadata; without a payment method or a `ct_customer_id` (guest) storage is skipped — `:3684-3714`
- The payment method is retrieved from Stripe (`paymentMethods.retrieve`); if it is not attached to a Stripe customer, storage is skipped — `:2619-2626`
- `savePaymentMethodIfNew()` calls `ctPaymentMethodService.getByTokenValue({ customerId, paymentInterface, tokenValue })` and skips the save if the token already exists; otherwise `ctPaymentMethodService.save({ customerId, paymentInterface, token, method })` — `:3726-3769`
- `updatePaymentWithToken()` writes `paymentMethodInfo.token.value` on the CT payment — only when `ctPaymentId` is present — `:2630-2635,3780-3795`
- `ctRecurringPaymentJobService.createRecurringPaymentJobIfApplicable()` is called only when `ctPaymentId` is present in the event metadata; when `ctPaymentId` is absent the recurring job step is skipped — `:2637-2654`

### Multi-capture webhook detail

When `charge.updated` arrives and `STRIPE_ENABLE_MULTI_OPERATIONS=true`, `processStripeEventMultipleCaptured()` — `processor/src/services/stripe-payment.service.ts:2798-2850`:

1. Reads `event.data.previous_attributes.amount_captured` and `charge.amount_captured`.
2. Skips processing if `charge.captured === true` or if the captured amount did not increase since `previous_attributes`.
3. Computes delta: `charge.amount_captured - previous.amount_captured`.
4. Sets `interactionId` and `pspReference` to `charge.balance_transaction`.
5. Calls `ctPaymentService.updatePayment` to record a `CHARGE: SUCCESS` transaction with the delta as the amount.

There is also a parallel path in `processStripeEvent()` (`payment_intent.*` events only) that calls `balanceTransactions.list({ source: latest_charge, limit: 10 })` when all three guards pass: `capture_method === 'manual'`, `payment_method_options.card.request_multicapture === 'if_available'`, and `latest_charge` is a non-empty string. If the result contains more than one balance transaction, `interactionId` and `amount` are overridden from `balanceTransactions.data[0]` — `:2164-2190`.

### Idempotency behavior

- Webhook events can be delivered more than once (Stripe at-least-once guarantee)
- Payment method storage is idempotent: checks existing token before save
- A redelivered webhook does not add a second CT transaction: the SDK's `updatePayment` matches a new transaction to an existing one of the same type and `interactionId` and changes only its state, or writes nothing (`ct-payment.service.js:234-283`, installed SDK 1.2.2), and every webhook write carries an `interactionId` (`processor/src/services/converters/stripeEventConverter.ts:263-386`; `processor/src/services/stripe-payment.service.ts:2214,2710,2762,2816`). On top of that, `processing` / `requires_action` are skipped when the payment already has `Authorization/Pending` or `Charge/Success` (`processor/src/services/stripe-payment.service.ts:2040-2045,2134-2157`)
- Stripe deduplicates events at the source and retries on non-200 responses

### Other notes

- Event → transaction table: also `feature-scope.md` ("Webhook Events"). Rules: `business-rules/webhook-handling.md` (Rules 1–10 — e.g. Rule 6 "Async-settlement events are deduped and never swallowed; `requires_action` is narrowed at the route", Rule 10 "`payment_intent.succeeded` promotes a lingering pending authorization, best-effort"), `business-rules/order-payment-state.md`.
