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
| `Order.paymentState` reflection | ✅ Supported | A third deployed application (`order-subscriber`, `applicationType: event`) subscribes to CT's `OrderCreated` message and writes `Paid`, `Pending`, or nothing. Separate app by necessity: for a card the money settles *before* the order exists, so the webhook path has nothing to write onto (a bounded retry measured 0/3). Writes only onto an unset field; `Paid` outranks `Pending`. Requires `manage_orders`. `Failed` is unreachable in checkout. See `business-rules/order-payment-state.md` and ADR-009. |
| Order creation | ❌ Not supported, by design | commercetools Checkout owns the cart and creates the order. The code that called `createOrderFromCart` was removed in `0ab8d2c` because it raced Checkout into a 409 `ConcurrentModification`, and the SDK's order service is read-only. This connector only ever *updates* `paymentState`. |
| Subscriptions / recurring billing | ❌ Not supported | Use `ct-connect-stripe-composable` |
| SetupIntent (save now, charge later) | ❌ Not supported | CT custom types defined but not installed by this connector |
| Mixed carts (subscription + one-time) | ❌ Not supported | — |
| Free trials | ❌ Not supported | — |

---

## Configuration-Driven Behavior

| Feature | Status | Notes |
| --- | --- | --- |
| Per-cart capture method / flow type override | ✅ Supported | `STRIPE_PAYMENT_BEHAVIOR_RULES` (JSON map keyed by ISO country code or CT store key) lets `captureMethod`, `flowType`, `setupFutureUsage`, `collectBillingAddress` and `euBankTransferCountry` be overridden per store/country; resolved via `resolvePaymentBehaviorWithSteeringCheck()` and falls back to the flat env vars when no rule matches. Matched on `cart.country` then `cart.store.key` only — shopper-supplied billing/shipping countries never select a rule. |
| Early PaymentIntent creation (`pi_first`) | ✅ Opt-in | `STRIPE_PAYMENT_FLOW=pi_first` creates the PI during `_Setup`, before the Payment Element mounts — required for payment methods that need the PI to exist up front (e.g. Blik). Default is `deferred` (PI created at confirm time). |
| Payment Element option overrides | ✅ Configurable | `STRIPE_BEHAVIOR_PAYMENT_ELEMENT` — JSON merged into the Element's creation options on the enabler side. Malformed JSON silently falls back to `{}` — no error surfaced. |

---

## Payment Element and Express Checkout

| Feature | Status | Notes |
| --- | --- | --- |
| Stripe Payment Element (embedded) | ✅ Supported | All Stripe-supported payment methods surfaced automatically based on currency, country, and Stripe account settings |
| Asynchronous / redirect payment methods (crypto, stablecoin) | ✅ Supported | PI confirms into `processing`; the connector models an `AUTHORIZATION:PENDING` transaction and finalizes on `payment_intent.succeeded` (webhook-driven — the synchronous confirm gate is not on the crypto redirect path). Requires automatic capture and saved payment methods NOT forced to `off_session` (`STRIPE_SAVED_PAYMENT_METHODS_CONFIG`), otherwise Stripe filters non-savable methods and crypto won't appear. See `processor/README.md`. |
| Express Checkout Element (Apple Pay, Google Pay) | ✅ Supported | Including shipping address and rate change callbacks that update CT cart |
| Hosted Payment Page (HPP) | ❌ Not supported | Defined in code but not exported from `enabler/src/main.ts` |
| Bank transfer (`customer_balance`) | ✅ Supported | EU bank transfer through the Payment Element. `payment_intent.requires_action` carrying `display_bank_transfer_instructions` books an `AUTHORIZATION:PENDING`; settlement days later moves it to `SUCCESS`. **Two silent prerequisites:** a customer must be attached to the PaymentIntent, and `setup_future_usage` must be absent — Stripe removes `customer_balance` from `payment_method_types` when the method cannot be saved, with no error and no warning. Subscription carts set `setup_future_usage`, so those markets need `flowType: pi_first`. `euBankTransferCountry` chooses which IBAN (DE/FR/IE/NL) the shopper sees; it does not enable the rail. |
| 3DS / SCA (Strong Customer Authentication) | ✅ Supported | Server-side PaymentIntent confirmation; 3DS redirect handled client-side by Stripe.js. `payment_intent.requires_action` is subscribed but for a card it writes **no** CT transaction — the event is filtered at the route by `isBankTransferNextAction()`, which only lets bank transfers through |
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
| `charge.refunded` | ✅ | Creates `REFUND` **and** `CHARGE_BACK` transactions on CT payment (see known-issues.md KI-025 — every ordinary refund is also recorded as a chargeback) |
| `payment_intent.succeeded` | ✅ | Creates `CHARGE` transaction on CT payment |
| `payment_intent.canceled` | ✅ | Creates `CANCEL_AUTHORIZATION` transaction |
| `payment_intent.payment_failed` | ✅ | Updates CT payment state |
| `payment_intent.processing` | ✅ | Async settlement (crypto/stablecoin, ACH-style): creates/transitions `AUTHORIZATION:PENDING` (amount from `data.amount`, not `amount_received`), deduped via `hasTransactionInState`; finalized to `SUCCESS` on `payment_intent.succeeded`. Write failures rethrow so Stripe retries (scoped exception to the KI-001 swallow). |
| `payment_intent.requires_action` | ✅ Method-dependent | **Bank transfer only:** creates `AUTHORIZATION:PENDING` for `pi.amount`. Card 3DS, Boleto and redirect-based methods emit the same event and write nothing — they are filtered at the route by `isBankTransferNextAction()`, which fails closed. Widening that predicate writes a pending authorization on every 3DS card payment; narrowing it to nothing kills the bank transfer rail with a green suite. See known-issues.md KI-017. |
| `payment_intent.partially_funded` | ✅ No-op | A bank transfer arriving in instalments. Writes no CT transaction — a second `Pending` would break the dedup invariant, and a partial `Charge` would recognise revenue sitting in the customer's cash balance. The interface interaction is persisted as an audit trail. |
| `refund.updated` / `refund.failed` | ✅ Failure only | Write `REFUND:FAILURE`, and **only** when the refund's status is `failed` or `canceled`. Successes are ignored — `charge.refunded` already owns that side, so acting here too would book the same refund twice. Do not use the converter; they read `ct_payment_id` from the refund's own metadata, so a Dashboard-issued refund carries no stamp and is not correctable this way. |
| `customer_cash_balance_transaction.created` | ✅ Observability only | Never converted — `convert()` rejects it explicitly. The event is customer-scoped and carries no `ct_payment_id`. `funding_reversed` and `adjusted_for_overdraft` log at **error** level: the only signal that money left the customer's cash balance after a payment was credited, with no CT update. |

Events **not registered** (Stripe does not deliver them):

| Event | Status |
| --- | --- |
| `charge.dispute.*` | ❌ Not registered — disputes are manual |
| Any `invoice.*` event | ❌ Not registered |
| Any `customer.subscription.*` event | ❌ Not registered |

**Note:** No `charge.dispute.*` event is registered or handled, so a genuine Stripe dispute is never reflected in CT — dispute handling for actual disputes is entirely manual. However, the `CHARGE_BACK` transaction type is not exclusively reserved for real disputes: the `charge.refunded` handler writes a `CHARGE_BACK` transaction on every ordinary refund too (see KI-025), so `CHARGE_BACK` records in CT do not reliably indicate an actual chargeback.

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
| ACH (US bank debit) | Not dedicated; Payment Element may surface it based on Stripe account settings. EU bank transfer (`customer_balance`) **is** supported — see the Payment Element table above |
| Reconciliation of stale `Pending` authorizations | None, deliberately. An abandoned bank transfer leaves a pending authorization no terminal event resolves, and the cart is not frozen during the funding window. Reconcile out of band — see ADR-007 |
| BNPL (Klarna, Afterpay, Affirm) | Not dedicated; Payment Element may surface it based on Stripe account settings |
| Stripe Terminal (in-person) | Not implemented |
| Stripe Link | Surfaced by Payment Element only; no dedicated flow |
| B2B Launchpad purchase orders | CT custom type is checked for existence on deploy but fields are not written by this connector |
| Hosted Payment Page (HPP) | Defined in code but not exported |
