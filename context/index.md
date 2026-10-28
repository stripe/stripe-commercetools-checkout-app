# Context Index — ct-connect-stripe-checkout

**What this connector covers:** Stripe Payment Element and Express Checkout for commercetools Checkout —
one-time payments, 3DS, EU bank transfer and async settlement, capture / cancel / refund / reverse,
multi-capture, recurring off-session charges for commercetools recurring orders, Stripe Tax forwarding,
and `Order.paymentState` reflection. Three applications: enabler, processor, order-subscriber.

**What it does not cover:** see `feature-scope.md` → Out of Scope.

## At a glance

| # | Section | What decides whether to read it |
| --- | --- | --- |
| 1 | Route by question | The question you have → the document and rule that answers it |
| 2 | Reading order by role | Adopting, onboarding, implementing, debugging, integrating a host |
| 3 | Every document | One line per file in `context/` |

---

## 1. Route by question

### "Can I / is it possible to…?"

| Question | Document |
| --- | --- |
| Does this connector support feature X? | `feature-scope.md` |
| Can I charge recurring orders / subscriptions? | `feature-scope.md` §5 + `business-rules/recurring-charges.md` — commercetools recurring orders, charged off-session; not Stripe Billing |
| Can I do partial captures or several refunds? | `business-rules/multi-operations.md` |
| Can I save payment methods for future use? | `business-rules/customer-session.md` |
| Does it handle 3DS? | `feature-scope.md` §3 |
| Can I override behaviour per market or store? | `business-rules/payment-behavior-rules.md` |

### "How does X work?"

| Question | Document |
| --- | --- |
| How does the payment flow work end to end? | `ARCHITECTURE.md` + `workflows/process-standard-payment.md` |
| How do the three applications talk to each other? | `ARCHITECTURE.md` §4 |
| How are webhooks processed? | `business-rules/webhook-handling.md` + `workflows/process-webhook.md` |
| How are refunds processed? | `business-rules/refunds-reversals.md` |
| How does the payment lifecycle map to CT transactions? | `business-rules/payment-lifecycle.md` |
| Who marks the **order** as paid, and when? | `business-rules/order-payment-state.md` |
| Which Stripe event becomes which CT state, per payment method? | `business-rules/order-payment-state.md` |
| How does an application embed the enabler? | `host-integration.md` |

### "What happens when X fails?"

| Question | Document |
| --- | --- |
| What happens on a CT 409 conflict? | `business-rules/payment-lifecycle.md` Rule 4 |

### "What are the rules for X?"

| Question | Document |
| --- | --- |
| Rules for refunds | `business-rules/refunds-reversals.md` |
| Rules for webhooks | `business-rules/webhook-handling.md` |
| Rules for the **order** payment state | `business-rules/order-payment-state.md` |
| Rules for the order subscription | `business-rules/order-subscription.md` |
| What gets stripped from a persisted event, and why | `business-rules/webhook-handling.md` Rule 9 |
| Why does the bank transfer tab never appear? | `business-rules/payment-behavior-rules.md` Rules 6 and 8 |
| Which IBAN does a EUR shopper see? | `business-rules/payment-behavior-rules.md` Rules 6-7 (`euBankTransferCountry`) |
| Rules for multi-capture | `business-rules/multi-operations.md` |

## 2. Reading order by role

**Adopting this connector (installing it).** `adopter-guide.md` → `workflows/deploy-connector.md`.

**New to this connector (developer onboarding).** `ARCHITECTURE.md` → `feature-scope.md` →
`business-rules/payment-lifecycle.md`.

**Implementing a change.** `ARCHITECTURE.md` for the module → the `business-rules/` file for the area.

**Debugging a payment.** `business-rules/payment-lifecycle.md` →
`business-rules/webhook-handling.md` → `business-rules/order-payment-state.md`.

**Integrating a host application.** `host-integration.md` → `reference/stripe-js.md`.

## 3. Every document

### Generated from code (regenerated on every refresh)

| File | What it holds |
| --- | --- |
| `ARCHITECTURE.md` | Modules, placement and cross-module contracts, entry points with their callers, external calls, data model, webhook events, configuration |
| `feature-scope.md` | What is supported, traced to entry points, and what is out of scope |
| `index.md` | This router |

### Maintained by people

| File | What it holds |
| --- | --- |
| `adopter-guide.md` | Prerequisites, installation, configuration, verification checklist, troubleshooting |
| `host-integration.md` | How another application embeds the enabler and drives the processor at runtime |
| `business-rules/customer-session.md` | Stripe customer resolution, customer sessions, `setup_future_usage` precedence |
| `business-rules/multi-operations.md` | Partial captures and multiple refunds |
| `business-rules/order-payment-state.md` | Both axes — Payment transactions and `Order.paymentState` — per event and payment method |
| `business-rules/order-subscription.md` | The order-subscriber's commercetools Subscription and message acknowledgement |
| `business-rules/payment-behavior-rules.md` | Per-cart behaviour rules, their trusted keys, and bank-transfer rail suppression |
| `business-rules/payment-lifecycle.md` | What `GET /payments` and the confirm gate guarantee |
| `business-rules/recurring-charges.md` | What `POST /operations/transactions` guarantees |
| `business-rules/refunds-reversals.md` | Refunds, reversals and payment operations |
| `business-rules/webhook-handling.md` | Signature, dedup, scoped exceptions, redaction |
| `workflows/charge-recurring-installment.md` | Recurring installment charge, step by step |
| `workflows/deploy-connector.md` | Deploy and undeploy |
| `workflows/process-async-settlement.md` | Crypto / stablecoin async settlement |
| `workflows/process-capture-cancel.md` | Manual capture and cancel |
| `workflows/process-express-checkout.md` | Express Checkout (Apple Pay / Google Pay) |
| `workflows/process-refund-reversal.md` | Refund and reversal |
| `workflows/process-standard-payment.md` | Standard embedded payment |
| `workflows/process-webhook.md` | Webhook processing |
| `workflows/reflect-payment-state-on-order-created.md` | Order payment state at order creation |
| `workflows/stripe-customer-session.md` | Stripe customer session |
| `reference/ct-connect-payments-sdk.md` | The commercetools payments SDK as this unit uses it |
| `reference/stripe-js.md` | Stripe.js as the enabler uses it |
| `reference/stripe-v20-payment-intents.md` | The Stripe Node SDK's PaymentIntents API as the processor uses it |
