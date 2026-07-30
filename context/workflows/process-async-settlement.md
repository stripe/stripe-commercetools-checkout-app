# Workflow: Async Settlement (crypto / stablecoin)

**Trigger:** A buyer pays with an asynchronous / redirect payment method (crypto/stablecoin — USDC — today; ACH / bank transfers in future) whose PaymentIntent confirms into `processing` before settling.
**Actors:** Buyer, Stripe (redirect wallet page + webhooks), Processor, CT API.
**Outcome:** The CT Payment reflects the in-flight state as `Authorization/Pending`, then resolves to `Authorization/Success` + `Charge/Success` (order created) on settlement, or to `Authorization/Failure` on failure/cancellation.

> Draft generated from the committed implementation and validated E2E (crypto). Sections marked `[HUMAN REVIEW]` need human confirmation.

---

## Flow (crypto — redirect, webhook-driven)

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
  |                 |                 |                           | processStripeEvent()  |
  |                 |                 |                           | dedup (hasTxnInState) |
  |                 |                 |                           |---- Authorization:PENDING -->|
  |                 |                 | PI: succeeded             |                       |
  |                 |                 |--- payment_intent.succeeded + charge.succeeded --> |
  |                 |                 |                           | Charge:SUCCESS        |
  |                 |                 |                           | transition Pending    |
  |                 |                 |                           |   Authorization→SUCCESS|
  |                 |                 |                           | Order created         |
  |                 |                 |                           |---------------------->|
```

**Note:** For crypto, the buyer is redirected away and the lifecycle is driven entirely by webhooks — the synchronous confirm gate (`/confirmPayments`) is **not** on this path (validated E2E). For non-redirect async methods (ACH / bank transfers), the gate DOES run and returns `PENDING` (202); see the "Synchronous gate variant" below.

---

## Steps Detail

### 1. `payment_intent.processing`
- Dispatched to `processStripeEvent()` (`stripe-payment.route.ts`).
- Converter (`stripeEventConverter.ts`) maps it to a single `Authorization/Pending` transaction; amount from `data.amount` (not `amount_received`, which is `0` while processing).
- Dedup: `hasTransactionInState()` skips the write if a `Charge/Success` or `Authorization/Pending` already exists (the sync gate may have written it first for non-redirect methods).
- Error handling: unlike other webhook events, a write failure on `processing` **rethrows** so Stripe retries (async settlement must not be lost). See `business-rules/webhook-handling.md` Rule 6.

### 2. `payment_intent.succeeded` (+ `charge.succeeded`)
- Converter emits `Charge/Success` (amount from `data.amount`).
- If an `Authorization/Pending` exists, it is transitioned to `Success` (best-effort — a failure here is logged and does not block the order). Log line: `Transitioned pending authorization to Success after payment_intent.succeeded`.
- The CT order is created **only** on `succeeded`.

### 3. Failure / cancellation
- `payment_intent.payment_failed` → `Authorization/Failure`.
- `payment_intent.canceled` → `Authorization/Failure` + `CancelAuthorization/Success`. Expiration without a deposit surfaces as `payment_intent.canceled`.

### Synchronous gate variant (non-redirect async methods)
- For methods that confirm synchronously through `POST /confirmPayments/:id`, `updatePaymentIntentStripeSuccessful()` runs the 4-point validation (see `business-rules/payment-lifecycle.md` Rules 2 & 8) and, when the PI is `processing`, writes `Authorization/Pending` only and returns `PENDING` (HTTP 202). It never creates an order while processing.
- The enabler branches on the outcome — a `pending` result does not signal success (no premature fulfillment). See `known-issues.md` KI-027 for the current `isSuccess:false` limitation.

---

## Configuration prerequisite

Crypto/stablecoin only appears in the Payment Element when it is enabled on the Stripe account **and** the connector uses automatic capture with saved payment methods NOT forced to `off_session` (`STRIPE_SAVED_PAYMENT_METHODS_CONFIG`). Otherwise Stripe filters non-savable methods and crypto is hidden. See `processor/README.md`.

---

## Error Paths

| Condition | Behavior | File |
|---|---|---|
| CT update fails on `processing` | Rethrown → non-2xx → Stripe retries; dedup prevents a duplicate `Pending` on redelivery | `stripe-payment.service.ts` → `processStripeEvent()` |
| Concurrent `Pending` write (gate ↔ webhook, or double delivery) | One loses on CT optimistic locking (409); recovered by retry + dedup re-check. No double charge/order. | See `known-issues.md` KI-026 |
| Settlement never resolves (dropped `succeeded`/`failed`/`canceled`) | `[HUMAN REVIEW]` Payment stays `Authorization/Pending`; no automated reconciliation today | — |
| Long mainnet `processing` window | `[HUMAN REVIEW]` Pending persists for minutes (vs seconds on testnet); confirm downstream UX | — |

---

## Notes

- Idempotency: the `Pending` write is deduped but not backed by a deterministic idempotency key — see `known-issues.md` KI-026 and the idempotency follow-up (KI-007).
- `payment_intent.requires_action` is a deliberate no-op in the converter (returns `[]`); it does not write a CT transaction. See `known-issues.md` KI-017.
