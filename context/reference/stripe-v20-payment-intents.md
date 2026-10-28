# Reference — Stripe API v20: Payment Intents (`stripe` Node SDK)

## Version in use

Stripe SDK version used: `stripe@^20.1.0` (`processor/package.json:41`).

The client is constructed per call without `apiVersion` (`processor/src/clients/stripe.client.ts:9`),
so the SDK's default API version applies; `STRIPE_API_VERSION` reaches only `ephemeralKeys.create`
(`processor/src/services/stripe-payment.service.ts:2962-2964`).

### Key Changes in v20 (from v17–v19)

- Full TypeScript strict-mode types for all API objects
- Pagination via `autoPagingToArray()` and `autoPagingEach()` on list methods
- `stripe.paymentIntents.create()` returns `Stripe.PaymentIntent` (typed)
- `latest_charge` field on PaymentIntent is now a full `Stripe.Charge` object when expanded
- `stripe.webhooks.constructEventAsync()` available for async webhook validation (this connector
  uses the synchronous `webhooks.constructEvent`, `processor/src/routes/stripe-payment.route.ts:220`)

## What this unit uses it for

Server-side PaymentIntent lifecycle for commercetools carts, refunds, customers and customer sessions
for the Payment Element, webhook verification, and pointing the webhook endpoint at the deployment.

### Payment Intent Lifecycle

```
requires_payment_method → requires_confirmation → requires_action → processing → succeeded
                                                                              ↘ canceled
                                                                              ↘ requires_capture (manual)
```

The create path reads these statuses on the cart's existing PaymentIntent before creating a new one:
`requires_payment_method` / `requires_confirmation` / `requires_action` → reuse;
`succeeded` / `requires_capture` / `processing` → refuse ("a payment is already in progress")
(`processor/src/services/stripe-payment.service.ts:1281-1295`).

### Key Parameters Used by This Connector

| Parameter | Type | Purpose |
|---|---|---|
| `amount` | integer (cents) | Payment amount — always integer, never float |
| `currency` | string (ISO 4217) | Lowercase currency code from CT cart |
| `capture_method` | `automatic` \| `automatic_async` \| `manual` | Set by `STRIPE_CAPTURE_METHOD` env var, or per cart by `STRIPE_PAYMENT_BEHAVIOR_RULES` (`processor/src/services/stripe-payment.service.ts:778`) |
| `setup_future_usage` | `on_session` \| `off_session` | Set by `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE`; overridable per cart, and sent only when a customer is bound (`processor/src/services/stripe-payment.service.ts:676-742`, `:1464-1468`) |
| `metadata` | object | Stores CT cart ID, project key, payment ID — `cart_id`, `ct_project_key`, `ct_customer_id` at create (`:1475-1479`); `ct_payment_id` by a separate `paymentIntents.update` (`:1393-1400`). `cart_id` is now also checked at confirm (`:1728-1737`) |
| `customer` | string (cus_xxx) | Stripe customer ID for saved payment methods |

## Calls used

| Call | Where | Why |
| --- | --- | --- |
| `paymentIntents.create` | `processor/src/services/stripe-payment.service.ts:875`, `:3317` | checkout PaymentIntent; off-session recurring charge |
| `paymentIntents.update` | `processor/src/services/stripe-payment.service.ts:1393` | write `metadata.ct_payment_id` |
| `paymentIntents.retrieve` | `processor/src/services/stripe-payment.service.ts:328`, `:1577`, `:1273`, `:1110` | capture check; confirm gate; reuse check and concurrent-create winner |
| `paymentIntents.capture` / `.cancel` | `processor/src/services/stripe-payment.service.ts:350`, `:389` | operations |
| `refunds.create` / `.list` | `processor/src/services/stripe-payment.service.ts:488`, `:2746` | refund; enhanced refund tracking |
| `balanceTransactions.list` | `processor/src/services/stripe-payment.service.ts:2174` | multicapture amount adjustment |
| `paymentMethods.retrieve` / `.list` | `processor/src/services/stripe-payment.service.ts:1983`, `:2619`, `:3578`, `:255` | method type, saving, health |
| `customers.retrieve` / `.search` / `.create` | `processor/src/services/stripe-payment.service.ts:2881`, `:2896`, `:2908` | Stripe customer for a commercetools customer |
| `customerSessions.create`, `ephemeralKeys.create` | `processor/src/services/stripe-payment.service.ts:2940`, `:2962` | saved methods in the Payment Element |
| `webhooks.constructEvent` | `processor/src/routes/stripe-payment.route.ts:220` | HMAC verification |
| `webhookEndpoints.retrieve` / `.update` | `processor/src/connectors/actions.ts:52`, `:64` | post-deploy |

### Webhook Events Handled

The authoritative mapping is `business-rules/webhook-handling.md` and the registered list is
`processor/src/connectors/actions.ts:65-86`; this table is a summary.

| Event | CT Action |
|---|---|
| `payment_intent.succeeded` | Add `CHARGE: SUCCESS` transaction (also triggers `storePaymentMethod`) |
| `charge.succeeded` | Add `AUTHORIZATION: SUCCESS` transaction (also triggers `storePaymentMethod`) |
| `payment_intent.canceled` | Add `AUTHORIZATION: FAILURE` + `CANCEL_AUTHORIZATION: SUCCESS` transactions |
| `payment_intent.payment_failed` | Add `AUTHORIZATION: FAILURE` transaction |
| `payment_intent.processing` | Async settlement: `AUTHORIZATION: PENDING`, deduped; write failures rethrow so Stripe retries |
| `payment_intent.requires_action` | Routed to `processStripeEvent` **only** when `next_action.type === 'display_bank_transfer_instructions'`, where it writes `AUTHORIZATION: PENDING` for `pi.amount`. Card 3DS, Boleto, ACH microdeposits (`verify_with_microdeposits`) and redirect variants are log-only at the route. The converter has an explicit case |
| `payment_intent.partially_funded` | Bank transfer arriving in instalments. No CT transaction |
| `charge.refunded` | Add `REFUND: SUCCESS` + `CHARGE_BACK: SUCCESS` transactions |
| `charge.updated` | Multi-ops only — add `CHARGE: SUCCESS` transaction with delta from `previous_attributes.amount_captured` |
| `refund.updated` / `refund.failed` | `REFUND: FAILURE` only when the refund failed or was cancelled; `ct_payment_id` read from the refund's own metadata |
| `customer_cash_balance_transaction.created` | Observability only; never converted |

`charge.dispute.created` is **not** currently handled by this connector. Disputes/chargebacks have to be reflected manually or by adding a new case to the dispatcher and converter.

## Constraints that affect this unit

### Idempotency

Refunds carry the idempotency key `refund-{paymentId}-{amount}`
(`processor/src/services/stripe-payment.service.ts:494`; `business-rules/refunds-reversals.md` Rule 5),
recurring charges `charge-{installment}` (`:3306`). Duplicate creates are prevented in commercetools
(reuse check plus a unique Payment key — `:853-858`).

### Other constraints

- The partner `appInfo` is fixed in the client (`processor/src/clients/stripe.client.ts:10-15`).
- Stripe errors carry `raw` and `payment_intent` as enumerable properties; the code logs scalars for
  that reason (`processor/src/services/stripe-payment.service.ts:2089-2100`).
- Webhook payloads may arrive out of order and be redelivered; see `business-rules/webhook-handling.md`.

### Apple Pay Domain Verification

Stripe requires a domain association file at:
```
/.well-known/apple-developer-merchantid-domain-association
```
The processor serves this via `GET /applePayConfig`, returning the configured string verbatim
(`processor/src/routes/stripe-payment.route.ts:419-422`); `STRIPE_APPLE_PAY_WELL_KNOWN` must hold the
file's contents (`processor/.env.template:37`).

## What this unit deliberately does NOT use

Stripe Billing (subscriptions, invoices), Checkout Sessions, Connect accounts, Stripe Tax calculation
creation (it only forwards an existing calculation id through `hooks.inputs.tax`, and only when the
cart has exactly one).

## Official Docs

- Payment Intents API: https://stripe.com/docs/api/payment_intents
- Stripe Node.js SDK: https://github.com/stripe/stripe-node
- Migration guide v19→v20: https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v20
- Webhook signatures: https://stripe.com/docs/webhooks/signatures
