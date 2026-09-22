# Workflow: Webhook Processing

**Trigger:** Stripe sends an event to `POST /stripe/webhooks`.
**Actors:** Stripe (sender), Processor, CT API.
**Outcome:** CT Payment updated with the correct transaction state reflecting Stripe's event.

---

## Flow

```
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
  |                           |      → updatePayment(REFUND:SUCCESS)|
  |                           |    else:                           |
  |                           |      → processStripeEvent()        |
  |                           |      → updatePayment(REFUND:SUCCESS|
  |                           |         + CHARGE_BACK:SUCCESS)     |
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

---

## Steps Detail

### 1. Signature Verification

- The pre-handler (`StripeHeaderAuthHook.authenticate`) only checks that the `stripe-signature` header is present.
- Inside the handler, the raw request body is passed to `stripeApi().webhooks.constructEvent()` with `STRIPE_WEBHOOK_SIGNING_SECRET`.
- If verification fails: respond 400, stop processing.
- If verification passes: process the event synchronously (`await`-ed), then respond 200. The handler does NOT ack early. See `business-rules/webhook-handling.md` Rule 2 for the limitation.

### 2. Event Routing

Events are routed to handlers based on type:

| Event | Handler | Additional Action | Notes |
|---|---|---|---|
| `payment_intent.succeeded` | `processStripeEvent()` | `storePaymentMethod()` | Converter emits `CHARGE: SUCCESS` |
| `charge.succeeded` | `processStripeEvent()` | `storePaymentMethod()` | Converter emits `AUTHORIZATION: SUCCESS` |
| `payment_intent.canceled` | `processStripeEvent()` | — | `AUTHORIZATION: FAILURE + CANCEL_AUTHORIZATION: SUCCESS` |
| `payment_intent.processing` | `processStripeEvent()` | — | `AUTHORIZATION: PENDING` (async settlement); deduped; resolved to SUCCESS on `payment_intent.succeeded`; write failure rethrows (Stripe retries). See `process-async-settlement.md` |
| `payment_intent.requires_action` | `processStripeEvent()` **only for bank transfers** | — | Gated by `isBankTransferNextAction()`. Bank transfer → `AUTHORIZATION: PENDING` for `pi.amount` (never `amount_received`, which is 0 until the wire lands). Card 3DS, Boleto, ACH microdeposits (`verify_with_microdeposits`) and redirect methods emit the same event and stay **log-only** on the transaction axis — they never reach the service (the order axis still runs; see `business-rules/order-payment-state.md` Rule 3). See `business-rules/webhook-handling.md` Rule 6 |
| `payment_intent.partially_funded` | `processStripeEvent()` (same gate) | — | No CT transaction; the interface interaction is still persisted via `ZERO_TRANSACTION_PERSIST_EVENTS`. Excluded from the rethrow set on purpose |
| `payment_intent.payment_failed` | `processStripeEvent()` | — | `AUTHORIZATION: FAILURE` |
| `customer_cash_balance_transaction.created` | **none** — `logCustomerCashBalanceTransaction()` | — | Observability only; never converted (`convert()` rejects it). `funding_reversed` / `adjusted_for_overdraft` log at error level. Payload carries `sender_name`, `iban_last4`, `sort_code` — never log the raw event |
| `charge.refunded` | `processStripeEventRefunded()` (multi-ops) or `processStripeEvent()` | — | Multi-ops uses per-refund amount via `refunds.list` |
| `refund.updated` / `refund.failed` | `processStripeEventRefundFailed()` | — | Acts **only** on `status` `failed` or `canceled` → `REFUND: FAILURE`. Does not use the converter; correlates via `refund.metadata.ct_payment_id`. See `business-rules/refunds-reversals.md` Rule 6 |
| `charge.updated` | `processStripeEventMultipleCaptured()` (multi-ops only) | — | Skipped entirely when multi-ops disabled |

> **Order-payment-state axis runs first.** For `payment_intent.succeeded` / `charge.succeeded` / `payment_intent.processing` / `payment_intent.canceled` / `payment_intent.payment_failed` / `payment_intent.requires_action`, the route calls `reflectOrderPaymentStateBestEffort(event)` **before** `processStripeEvent()` (`stripe-payment.route.ts:268, 277, 322`). This best-effort order-state reflection is load-bearing and independent of the transaction axis — see `business-rules/order-payment-state.md` Rule 3. (The webhook diagram above omits it for brevity.)

> **Before any of the above runs:** an event whose PaymentIntent carries no `ct_payment_id` is skipped
> with a warning and a 200 — it belongs to another integration. See `business-rules/webhook-handling.md`
> Rule 8 for why that 200 is not a KI-001 violation.

### 3. CT Payment ID Extraction
- `stripeEventConverter.getCtPaymentId()` reads `event.data.object.metadata.ct_payment_id`
- If missing: cannot update CT — logs error and skips

### 4. Transaction Mapping
- `stripeEventConverter.convert()` maps the event to CT transaction format:
  - Determines transaction types and states
  - Extracts PSP reference (charge ID or PI ID)
  - Extracts amount from appropriate field per event type
  - Extracts payment method type

### 5. CT Payment Update
- `ctPaymentService.updatePayment()` applies the transactions
- Does **not** automatically retry on `409 ConcurrentModification` — the Connect Payments SDK throws on version conflict; the connector logs the error and the transaction update is lost. See `business-rules/payment-lifecycle.md` Rule 4.

### 6. Payment Method Storage (for `payment_intent.succeeded` and `charge.succeeded` only)

The dispatcher in `processor/src/routes/stripe-payment.route.ts` calls `storePaymentMethod(event)` after `processStripeEvent(event)` for both events.

- `extractPaymentMethodDataFromEvent()` extracts the Stripe payment method ID, CT customer ID, and CT payment ID from event metadata.
- `savePaymentMethodIfNew()` calls `ctPaymentMethodService.getByTokenValue({ customerId, paymentInterface, tokenValue })` and skips the save if the token already exists.
- If new: retrieves the full payment method from Stripe (`paymentMethods.retrieve`), then `ctPaymentMethodService.save({ customerId, paymentInterface, token, method })`.
- `updatePaymentWithToken()` writes `paymentMethodInfo.token.value` on the CT payment.
- `ctRecurringPaymentJobService.createRecurringPaymentJobIfApplicable()` is called only when `ctPaymentId` is present in the event metadata. If `ctPaymentId` is missing, the recurring job step is silently skipped (no error thrown).

---

## Multi-Capture Webhook Detail

When `charge.updated` arrives and `STRIPE_ENABLE_MULTI_OPERATIONS=true`, `processStripeEventMultipleCaptured()`:

1. Reads `event.data.previous_attributes.amount_captured` and `charge.amount_captured`.
2. Skips processing if `charge.captured === true` or if the captured amount did not increase since `previous_attributes`.
3. Computes delta: `charge.amount_captured - previous.amount_captured`.
4. Sets `interactionId` and `pspReference` to `charge.balance_transaction`.
5. Calls `ctPaymentService.updatePayment` to record a `CHARGE: SUCCESS` transaction with the delta as the amount.

There is also a parallel path in `processStripeEvent()` that calls `balanceTransactions.list({ source: latest_charge, limit: 10 })` when all three guards pass: `capture_method === 'manual'`, `payment_method_options.card.request_multicapture === 'if_available'`, and `latest_charge` is a non-empty string. If the result contains more than one balance transaction, `interactionId` and `amount` are overridden from `balanceTransactions.data[0]`.

---

## Idempotency Behavior

- Webhook events can be delivered more than once (Stripe at-least-once guarantee)
- Payment method storage is idempotent: checks existing token before save
- CT transaction creation is **not** natively idempotent — duplicate webhooks can create duplicate CT transactions
- Stripe deduplicates events at the source but retries on non-200 responses — always return 200 quickly to prevent retries

---

## Error Paths

| Error | Cause | Behavior |
|---|---|---|
| Signature verification fails | Wrong secret or tampered payload | 400 response; Stripe retries |
| `ct_payment_id` missing from metadata | PI created without metadata | Logs error; CT not updated |
| CT update fails (version conflict) | Concurrent update | SDK throws; connector logs error and continues — transaction update is lost |
| CT update fails (other) | CT API error | Transaction lost; CT diverges from Stripe |
| Stripe refunds.list() fails | Stripe API error | Refund transaction not recorded in CT |
