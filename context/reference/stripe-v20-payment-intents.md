# Reference — Stripe API v20: Payment Intents

Stripe SDK version used: `stripe@^20.1.0`

## Key Changes in v20 (from v17–v19)

- Full TypeScript strict-mode types for all API objects
- Pagination via `autoPagingToArray()` and `autoPagingEach()` on list methods
- `stripe.paymentIntents.create()` returns `Stripe.PaymentIntent` (typed)
- `latest_charge` field on PaymentIntent is now a full `Stripe.Charge` object when expanded
- `stripe.webhooks.constructEventAsync()` available for async webhook validation

## Payment Intent Lifecycle

```
requires_payment_method → requires_confirmation → requires_action → processing → succeeded
                                                                              ↘ canceled
                                                                              ↘ requires_capture (manual)
```

## Key Parameters Used by This Connector

| Parameter | Type | Purpose |
|---|---|---|
| `amount` | integer (cents) | Payment amount — always integer, never float |
| `currency` | string (ISO 4217) | Lowercase currency code from CT cart |
| `capture_method` | `automatic` \| `automatic_async` \| `manual` | Set by `STRIPE_CAPTURE_METHOD` env var |
| `setup_future_usage` | `on_session` \| `off_session` | Set by `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` |
| `metadata` | object | Stores CT cart ID, project key, payment ID |
| `customer` | string (cus_xxx) | Stripe customer ID for saved payment methods |

## Webhook Events Handled

| Event | CT Action |
|---|---|
| `payment_intent.succeeded` | Add `CHARGE: SUCCESS` transaction (also triggers `storePaymentMethod`) |
| `charge.succeeded` | Add `AUTHORIZATION: SUCCESS` transaction (also triggers `storePaymentMethod`) |
| `payment_intent.canceled` | Add `AUTHORIZATION: FAILURE` + `CANCEL_AUTHORIZATION: SUCCESS` transactions |
| `payment_intent.payment_failed` | Add `AUTHORIZATION: FAILURE` transaction |
| `payment_intent.requires_action` | Routed to `processStripeEvent` but the converter has no case for it; the resulting `Unsupported event` error is swallowed and CT is not updated |
| `charge.refunded` | Add `REFUND: SUCCESS` + `CHARGE_BACK: SUCCESS` transactions (multi-ops uses per-refund amount via `refunds.list`) |
| `charge.updated` | Multi-ops only — add `CHARGE: SUCCESS` transaction with delta from `previous_attributes.amount_captured` |

`charge.dispute.created` is **not** currently handled by this connector. Disputes/chargebacks have to be reflected manually or by adding a new case to the dispatcher and converter.

## Idempotency

All write operations require an idempotency key:
```typescript
stripe.paymentIntents.create(params, { idempotencyKey: `pi-${ctPaymentId}` })
```

Use a deterministic key based on the CT payment ID to ensure safe retries.

## Apple Pay Domain Verification

Stripe requires a domain association file at:
```
/.well-known/apple-developer-merchantid-domain-association
```
The processor serves this via `GET /applePayConfig` — the URL is set in `STRIPE_APPLE_PAY_WELL_KNOWN`.

## Official Docs

- Payment Intents API: https://stripe.com/docs/api/payment_intents
- Stripe Node.js SDK: https://github.com/stripe/stripe-node
- Migration guide v19→v20: https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v20
- Webhook signatures: https://stripe.com/docs/webhooks/signatures
