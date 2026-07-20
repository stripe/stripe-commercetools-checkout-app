# Feature Scope — ct-connect-stripe-checkout

What this connector supports, what it does not support, and what is partially supported or has known gaps. An LLM consulting this document should answer "not in scope for this connector" rather than inferring from general Stripe knowledge.

---

## Payment Models

| Feature | Status | Notes |
| --- | --- | --- |
| One-time payments | ✅ Supported | Core use case |
| Guest checkout | ✅ Supported | `/customer/session` returns 204 for guests; Payment Element works without a saved customer |
| Authenticated customer checkout | ✅ Supported | Saves Stripe customer ID on CT customer |
| Saved payment methods | ✅ Supported | Via Stripe customer session + ephemeral key |
| Automatic capture | ✅ Supported | `STRIPE_CAPTURE_METHOD=automatic` (default) |
| Manual capture (authorize now, capture later) | ✅ Opt-in | `STRIPE_CAPTURE_METHOD=manual` |
| Multi-capture (partial captures) | ✅ Opt-in | `STRIPE_ENABLE_MULTI_OPERATIONS=true`; requires multicapture enabled on Stripe account |
| Subscriptions / recurring billing | ❌ Not supported | Use `ct-connect-stripe-composable` |
| SetupIntent (save now, charge later) | ❌ Not supported | CT custom types defined but not installed by this connector |
| Mixed carts (subscription + one-time) | ❌ Not supported | — |
| Free trials | ❌ Not supported | — |

---

## Configuration-Driven Behavior

| Feature | Status | Notes |
| --- | --- | --- |
| Per-cart capture method / flow type override | ✅ Supported | `STRIPE_PAYMENT_BEHAVIOR_RULES` (JSON map keyed by ISO country code or CT store key) lets `captureMethod` and `flowType` be overridden per store/country; resolved in `createPaymentIntentStripe()` via `resolvePaymentBehavior()` and falls back to the flat `STRIPE_CAPTURE_METHOD`/flow env vars when no rule matches. |

---

## Payment Element and Express Checkout

| Feature | Status | Notes |
| --- | --- | --- |
| Stripe Payment Element (embedded) | ✅ Supported | All Stripe-supported payment methods surfaced automatically based on currency, country, and Stripe account settings |
| Express Checkout Element (Apple Pay, Google Pay) | ✅ Supported | Including shipping address and rate change callbacks that update CT cart |
| Hosted Payment Page (HPP) | ❌ Not supported | Defined in code but not exported from `enabler/src/main.ts` |
| 3DS / SCA (Strong Customer Authentication) | ✅ Supported | Server-side PaymentIntent confirmation; `payment_intent.requires_action` is subscribed but has no handler — 3DS redirect handled client-side by Stripe.js |
| Apple Pay domain verification | ✅ Supported | `/applePayConfig` endpoint returns domain association file (no auth required) |
| Billing address collection | ✅ Configurable | `STRIPE_COLLECT_BILLING_ADDRESS`: `auto`, `never`, `if_required` |
| Setup future usage (save card) | ✅ Configurable | `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` |

---

## Refunds

| Feature | Status | Notes |
| --- | --- | --- |
| Full refund | ✅ Supported | — |
| Partial refund | ✅ Supported | — |
| Multiple refunds on one payment | ✅ Opt-in | `STRIPE_ENABLE_MULTI_OPERATIONS=true` |
| Idempotency on refund | ⚠️ Known gap | `refunds.create()` has no idempotency key — retrying after a network failure may create a duplicate refund. See `known-issues.md` KI-007. |

---

## Webhook Events

Events registered in `processor/src/connectors/actions.ts`:

| Event | Handled | Effect |
| --- | --- | --- |
| `charge.succeeded` | ✅ | Sets `AUTHORIZATION:SUCCESS` on CT payment (does NOT create a CHARGE transaction) |
| `charge.updated` | ✅ | Creates `CHARGE:SUCCESS` transaction on CT payment; used for multi-capture delta tracking |
| `charge.refunded` | ✅ | Creates `REFUND` transaction on CT payment |
| `payment_intent.succeeded` | ✅ | Creates `CHARGE` transaction on CT payment |
| `payment_intent.canceled` | ✅ | Creates `CANCEL_AUTHORIZATION` transaction |
| `payment_intent.payment_failed` | ✅ | Updates CT payment state |
| `payment_intent.requires_action` | ⚠️ Subscribed, no handler | Events are received and silently dropped — 3DS handled client-side by Stripe.js |

Events **not registered** (Stripe does not deliver them):

| Event | Status |
| --- | --- |
| `charge.dispute.*` | ❌ Not registered — disputes are manual |
| Any `invoice.*` event | ❌ Not registered |
| Any `customer.subscription.*` event | ❌ Not registered |

**Note:** The CT data model includes a `CHARGE_BACK` transaction type, but no webhook handler or registered event covers disputes. Dispute handling is entirely manual.

---

## Integration with ct-stripe-tax

| Integration | Status | Notes |
| --- | --- | --- |
| Stripe Tax (`ct-stripe-tax`) | ✅ Supported | Reads `connectorStripeTax_calculationReferences` from CT cart; forwards to Stripe PI only when **exactly one** reference is present. Zero or multiple references are silently ignored. |

---

## Out of Scope for This Connector

| Feature | Why |
| --- | --- |
| Subscriptions | Requires `ct-connect-stripe-composable` |
| CT coupon / discount → Stripe sync | Not implemented |
| CT price → Stripe price sync | Not implemented |
| Dispute / chargeback automation | No `charge.dispute.*` webhook handler; manual process required |
| Stripe Connect (marketplace, split payments) | Handled by separate `mirakl-stripe` integration |
| ACH / bank transfers | Not dedicated; Payment Element may surface it based on Stripe account settings |
| BNPL (Klarna, Afterpay, Affirm) | Not dedicated; Payment Element may surface it based on Stripe account settings |
| Stripe Terminal (in-person) | Not implemented |
| Stripe Link | Surfaced by Payment Element only; no dedicated flow |
| B2B Launchpad purchase orders | CT custom type is checked for existence on deploy but fields are not written by this connector |
| Hosted Payment Page (HPP) | Defined in code but not exported |
