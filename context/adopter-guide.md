# ct-connect-stripe-checkout — Adopter Guide

> Who this is for: teams deploying ct-connect-stripe-checkout for one-time payments.
> For connector internals see `context/ARCHITECTURE.md`.
> Not sure which connector you need? See `ct-stripe/context/adopter-guide.md`.

---

## 1. Prerequisites

Before deploying, confirm you have:

**commercetools:**
- CT project with API client credentials (client ID, client secret, project key)
- API client scopes: `manage_payments`, `manage_orders`, `manage_customers`, `manage_types`, `manage_products`, `view_products`

**Stripe:**
- Stripe account (test or live)
- Stripe secret key (`sk_test_...` or `sk_live_...`)
- Stripe publishable key (`pk_test_...` or `pk_live_...`)
- Stripe webhook signing secret — created automatically by CT Connect post-deploy; do not set manually before first deploy

> If you plan to use Multicapture (partial captures and multi-refund), contact Stripe to enable `STRIPE_ENABLE_MULTI_OPERATIONS` on your account before going live.

---

## 2. What This Connector Deploys

Post-deploy creates these resources in your environment automatically:

| Component | Type | What it does |
| --- | --- | --- |
| Stripe webhook endpoint | Stripe | Receives 12 events — `charge.succeeded`, `charge.updated`, `charge.refunded`, `refund.updated`, `refund.failed`, `payment_intent.succeeded`, `payment_intent.canceled`, `payment_intent.payment_failed`, `payment_intent.requires_action`, `payment_intent.processing`, `payment_intent.partially_funded`, `customer_cash_balance_transaction.created` — delivers to the processor's `/stripe/webhooks`. The authoritative list is the `enabled_events` array in `processor/src/connectors/actions.ts`; an event handled in code but absent there is never delivered, and that fails silently |
| `payment-connector-stripe-customer-id` | CT Custom Type (customer) | Stores `stripeConnector_stripeCustomerId` — links a CT customer to their Stripe Customer |
| CT `OrderCreated` subscription | CT Subscription | Created by the `order-subscriber` app's post-deploy; delivers `OrderCreated` messages to `/orderSubscriber` so the order's `paymentState` can be written |

> **Three applications are deployed, not two:** `processor` (service), `enabler` (assets) and
> `order-subscriber` (event). The subscriber exists because for a card the money settles *before* the
> order exists, so the webhook path has nothing to write `paymentState` onto. It needs the
> `manage_orders` scope, and `connect.yaml` has no `inheritAs` block — it declares its own
> `CTP_*` configuration. Omitting those values does not fail the deploy: the app boots and dies on
> its first required-config check, which looks like a crash-loop rather than missing configuration.

> **Not created by the connector:** `payment-launchpad-purchase-order` — this CT custom type is required for B2B purchase orders but must be created by your team before deploying. See Section 5.

---

## 3. Installation

### Step 1 — Deploy via CT Connect

Deploy `ct-connect-stripe-checkout` through the CT Connect marketplace. The post-deploy script runs automatically and creates the resources listed above.

### Step 2 — Configure environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | **Yes** | Stripe secret API key |
| `STRIPE_PUBLISHABLE_KEY` | **Yes** | Stripe publishable key — sent to the browser enabler |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | **Yes** | Copy from Stripe Dashboard after first deploy — do not guess this value |
| `MERCHANT_RETURN_URL` | **Yes** | Full URL of your storefront's payment return page (used after 3DS redirect) |
| `ALLOWED_ORIGINS` | **Yes** | Comma-separated storefront origins allowed to call `/express-config` (e.g. `https://your-store.com`). Without this, Express Checkout returns 403. |
| `CTP_PROJECT_KEY` | **Yes** | CT project key |
| `CTP_CLIENT_ID` | **Yes** | CT API client ID |
| `CTP_CLIENT_SECRET` | **Yes** | CT API client secret |
| `STRIPE_CAPTURE_METHOD` | No | `automatic` (default), `automatic_async`, or `manual` |
| `STRIPE_ENABLE_MULTI_OPERATIONS` | No | `true` to enable partial captures and multi-refund (Stripe account feature required) |
| `STRIPE_COLLECT_BILLING_ADDRESS` | No | `auto` (default), `never`, or `if_required` |
| `STRIPE_PAYMENT_FLOW` | No | `deferred` (default) or `pi_first` — set to `pi_first` if you need to support Blik. See Section 4 "Blik" for what changes when you enable this. |
| `STRIPE_BEHAVIOR_PAYMENT_ELEMENT` | No | JSON object merged into the Payment Element's creation options on the enabler side. Invalid JSON is silently ignored (falls back to no overrides) — validate your JSON before deploying. |
| `STRIPE_PAYMENT_BEHAVIOR_RULES` | No | JSON map of per-market exceptions, keyed by ISO country code or CT store key. Each rule may set `flowType`, `captureMethod`, `setupFutureUsage`, `collectBillingAddress`, `euBankTransferCountry`. Only the fields you supply override; omitted fields fall back to the flat env var above, **which may be the opposite instruction** — "field absent" is not "no instruction". Malformed JSON aborts startup. Matched on `cart.country` then `cart.store.key`; shopper-supplied billing/shipping countries deliberately never select a rule. |

**If you want EU bank transfer,** set `euBankTransferCountry` (`DE`, `FR`, `IE` or `NL`) on the markets that should offer it. Two things Stripe does silently, and they are the most common reason the tab never appears:

- A **customer must be attached** to the PaymentIntent. Guest carts do not get the rail; Stripe accepts and discards the options rather than erroring.
- **`setup_future_usage` must be absent.** Stripe removes `customer_balance` from `payment_method_types` when the method cannot be saved, with no error and no warning — so enabling saved payment methods (`STRIPE_SAVED_PAYMENT_METHODS_CONFIG`) or `STRIPE_CAPTURE_METHOD=manual` suppresses the tab. Subscription carts set `setup_future_usage`, so those markets need `flowType: pi_first`, which strips it.

`euBankTransferCountry` only chooses **which** of your own IBANs a EUR shopper sees — it is not an enable flag, and leaving it unset does not disable the rail: Stripe then derives the variant from the currency and defaults to an Irish IBAN.

**If you want ACH (US bank debit, `us_bank_account`),** there is **no connector config** — enable `us_bank_account` (and Financial Connections) in Stripe Dashboard → Payment methods, on a USD-capable account. It then surfaces in the Payment Element automatically. Validated E2E 2026-08-27. What to expect:

- **Async by nature.** The order goes `Pending` on `requires_action`/`processing` and `Paid` only when the debit settles (`succeeded`) — **days** later in production. The buyer's `/success`-vs-`/failed` screen is not authoritative for ACH; trust `Order.paymentState`.
- **Two verification paths, both hosted by Stripe:** *instant* (Financial Connections — the shopper logs into their bank in-session, no microdeposits) and *manual entry* (microdeposits — Stripe emails a hosted link; the shopper returns and enters the descriptor code; 1–2 business days). Both resolve to the same `succeeded` → `Paid`. No connector code drives the verification.
- **Not suppressed by `setup_future_usage`.** Unlike EU bank transfer (`customer_balance`), ACH via Financial Connections is savable, so enabling saved methods / `setup_future_usage` does **not** hide the tab.
- **Failures.** An async debit failure (insufficient funds, account closed → `insufficient_funds`/`no_account`) lands *after* the order exists, so the order becomes `Failed`. A synchronous rejection at confirm (e.g. weekly-volume limit → `charge_exceeds_source_limit`) is rejected before any order is created — the cart stays `Active`, no order.
- **Same abandonment caveat as bank transfer.** A shopper who never completes microdeposit verification leaves a durable `Pending` (no terminal event, cart not frozen) — reconcile out of band.

> **After first deploy:** go to Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret. Copy it into `STRIPE_WEBHOOK_SIGNING_SECRET` and redeploy. Payments will succeed but CT will not update until this is set.

### Step 3 — Verify post-deploy resources

In CT Merchant Center → Settings → Developer → API → Custom Types:
- `payment-connector-stripe-customer-id` exists with field `stripeConnector_stripeCustomerId`

In Stripe Dashboard → Developers → Webhooks:
- A webhook endpoint pointing at `https://your-processor/stripe/webhooks` exists
- It lists all 12 events from Section 2. A missing event is delivered by nobody and fails silently — compare against `processor/src/connectors/actions.ts`, which is the only source of truth

In CT Merchant Center → Settings → Developer → Subscriptions:
- A subscription for the `OrderCreated` message pointing at `/orderSubscriber` exists. Without it, orders are created with no `paymentState` and nothing reports the error — the subscriber simply never runs

---

## 4. Integrating the Enabler

The enabler is a JavaScript bundle that wraps Stripe Payment Element and Express Checkout Element. Mount it in your checkout page.

### Standard embedded payment (Payment Element)

```typescript
import { Enabler } from '@your-scope/ct-connect-stripe-checkout-enabler';

const enabler = new Enabler({
  processorUrl: 'https://your-processor.ct-connect.example.com',
  sessionId: ctSessionId,   // from CT session API
  locale: 'en-US',
});

const dropin = await enabler.createDropin({ paymentElementType: 'paymentElement' });
await dropin.mount('#payment-element');
```

### Express Checkout (Apple Pay / Google Pay)

Requires `ALLOWED_ORIGINS` to be set to your storefront's origin.

```typescript
const dropin = await enabler.createDropin({ paymentElementType: 'expressCheckout' });
await dropin.mount('#express-checkout-element');
```

### Blik

Blik (a Polish payment method) requires the PaymentIntent to exist **before** the Payment Element mounts — unlike other methods, which create the PaymentIntent only at confirm time. To support Blik, set `STRIPE_PAYMENT_FLOW=pi_first`. With this enabled, the enabler creates the PaymentIntent during setup instead of waiting for the shopper to submit the form — no change is needed on your side beyond the env var and mounting the Payment Element as usual; Blik then appears alongside other Stripe-supported methods based on your account settings and the cart's currency/country.

> If you don't need Blik, leave `STRIPE_PAYMENT_FLOW` unset (default `deferred`) — the early PaymentIntent creation has no benefit for other payment methods.

### B2B Launchpad purchase orders

The `payment-launchpad-purchase-order` CT custom type must be created by your team **before deploying**. The connector checks for its existence at startup but does not create it.

```typescript
// Create via CT API before first deploy:
{
  key: 'payment-launchpad-purchase-order',
  resourceTypeIds: ['payment'],
  fields: [
    { name: 'launchpadPurchaseOrderNumber', type: { name: 'String' }, required: false },
    { name: 'launchpadPurchaseOrderInvoiceMemo', type: { name: 'String' }, required: false },
  ]
}
```

---

## 5. Verification Checklist

Before go-live:

- [ ] `GET /operations/config` returns a response including `publishableKey`
- [ ] Complete a test payment using Stripe test card `4242 4242 4242 4242` — CT payment should have a `CHARGE:SUCCESS` transaction
- [ ] Check Stripe Dashboard — a PaymentIntent with `ct_payment_id` in metadata should appear
- [ ] Trigger a refund via `POST /payment-intents/{id}` with `action: refund` — CT payment should gain a `REFUND` transaction
- [ ] Stripe Dashboard → Webhooks → Recent deliveries — all events should show HTTP 200
- [ ] Express Checkout buttons appear on the page (if using `expressCheckout` drop-in)
- [ ] If `STRIPE_PAYMENT_FLOW=pi_first` is set: Blik appears as a payment option for eligible currency/country combinations, and the PaymentIntent is visible in Stripe Dashboard before the shopper submits the form
- [ ] The completed test order has `paymentState: Paid` in CT — if it is unset, the `order-subscriber` is not running or its `OrderCreated` subscription is missing
- [ ] If using EU bank transfer: the `customer_balance` tab actually renders for a **signed-in** shopper on a EUR cart. If it does not, check `setup_future_usage` and `capture_method` before anything else — Stripe suppresses the rail silently, and the processor logs a warning naming the reason
- [ ] If using EU bank transfer: complete one transfer end to end and confirm the order moves `Pending` → `Paid`. Then abandon one deliberately and confirm you are comfortable with the result — the pending authorization stays forever and nothing reconciles it
- [ ] If offering ACH (`us_bank_account`): run one Financial Connections *instant* payment (Success test account) and confirm `Order.paymentState` reaches `Paid`; run one *microdeposit* payment (manual entry, code `SM11AA` in test) and confirm the order is `Pending` until verification then `Paid`. Do **not** trust the `/failed` screen for ACH — verify in CT / Merchant Center (validated E2E 2026-08-27)

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Stripe webhook events show HTTP 400 | `STRIPE_WEBHOOK_SIGNING_SECRET` wrong or not set | Copy signing secret from Stripe Dashboard webhook endpoint; redeploy |
| Payment succeeds in Stripe but CT payment not updated | Webhook failing — signing secret mismatch | Same as above; also check processor logs for 400s |
| Express Checkout buttons not appearing | `ALLOWED_ORIGINS` not set — `/express-config` returns 403 | Set `ALLOWED_ORIGINS` to your storefront origin |
| CT payment stuck in `AUTHORIZATION:SUCCESS`, never moves to `CHARGE` | `payment_intent.succeeded` webhook not processed | Verify webhook health in Stripe Dashboard; check processor logs |
| Refund processed in Stripe but CT payment has no `REFUND` transaction | `charge.refunded` webhook failed | Check Stripe Dashboard → Webhooks → logs for that event |
| Double charge after network retry | Connector does not use stable idempotency keys on capture | Check Stripe Dashboard; manually refund duplicate; disable infrastructure-level auto-retry |
| All payments fail at startup with auth errors | Placeholder credentials in env vars (`'stripeSecretKey'`, `'xxx'`) | Set all required env vars with real values |
| `payment-launchpad-purchase-order` not found | Custom type not created before deploy | Create the custom type manually (see Section 4) |
| Bank transfer tab never appears, no error anywhere | `setup_future_usage` is set (often via `STRIPE_SAVED_PAYMENT_METHODS_CONFIG`) or `STRIPE_CAPTURE_METHOD=manual` — Stripe removes `customer_balance` from `payment_method_types` when the method cannot be saved, silently | Clear `setup_future_usage` for that market, or set `flowType: pi_first` in `STRIPE_PAYMENT_BEHAVIOR_RULES` to strip it. Check processor logs — the connector warns and names the reason |
| Bank transfer tab missing only for some shoppers | Those carts have no customer attached. `customer_balance` requires one; Stripe accepts and discards the options for a guest cart rather than erroring | Expected. The rail is only available to signed-in shoppers |
| Shopper sees an Irish IBAN when you expected a local one | `euBankTransferCountry` not set for that market — Stripe derives the variant from the currency and defaults to IE | Set `euBankTransferCountry` to `DE`, `FR`, `IE` or `NL` in that market's rule |
| Order sits at `paymentState: Pending` for days | Normal for a bank transfer awaiting a wire, **or an ACH debit awaiting settlement / microdeposit verification** — or the shopper abandoned it and never completed it | Nothing to fix if the payment is in flight. If abandoned, nothing resolves it automatically; reconcile out of band and cancel the PaymentIntent in Stripe |
| ACH order shows `/failed` in the storefront but the payment actually worked | The sample site routes every non-instant ACH outcome (processing, requires_action) to `/failed` — a **storefront** display bug, not the connector. `Order.paymentState` and the Stripe PaymentIntent are correct | Verify in CT / Stripe, not the screen. Fix belongs in the sample site's result routing, not this connector |
| Orders have no `paymentState` at all | `order-subscriber` not deployed, missing its `CTP_*` configuration, or its `OrderCreated` subscription absent | Check the app is running (missing config looks like a crash-loop, not a config error) and that the subscription exists in Merchant Center |
| Refund shows as successful in CT but the money never arrived | Before `refund.updated`/`refund.failed` were registered this was permanent. Now only Dashboard-issued refunds have it — they carry no `ct_payment_id` stamp, so the failure cannot be matched back | Issue refunds through the connector, not the Stripe Dashboard |
