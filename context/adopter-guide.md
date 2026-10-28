# ct-connect-stripe-checkout — Adopter Guide

> Who this is for: teams deploying ct-connect-stripe-checkout for one-time payments with
> commercetools Checkout (and the off-session charges of commercetools Recurring Orders).
> For connector internals see `context/ARCHITECTURE.md`. For how an application calls the connector
> once it runs, see `context/host-integration.md`.

---

## 1. Prerequisites

Before deploying, confirm you have:

**Host platform:**
- commercetools Composable Commerce with Connect and Checkout enabled. The processor pins
  `@commercetools/connect-payments-sdk 1.2.2` and Node `>=24.22.1` (`processor/package.json:22-24`).

**commercetools:**
- CT project with API client credentials (client ID, client secret, project key)
- API client scopes: `manage_payments`, `manage_orders`, `manage_customers`, `manage_types`, `manage_products`, `view_products`
- The scopes `connect.yaml` declares for the processor's `CTP_CLIENT_ID` are a different list:
  `manage_payments`, `manage_orders`, `manage_payment_methods`, `manage_recurring_payment_jobs`,
  `view_sessions`, `view_api_clients`, `manage_checkout_payment_intents`,
  `manage_checkout_transactions`, `introspect_oauth_tokens`, `manage_types`, `view_types`
  (`connect.yaml:141-143`). Grant the union of both lists.
- The `order-subscriber` uses its own client, which needs `manage_orders` (`connect.yaml:27-29`).

**Stripe:**
- Stripe account (test or live). Test and live are told apart by the publishable key: a key
  containing `_test_` makes the enabler report `test` (`enabler/src/payment-enabler/payment-enabler-mock.ts:172`).
- Stripe secret key (`sk_test_...` or `sk_live_...`)
- Stripe publishable key (`pk_test_...` or `pk_live_...`)
- **A Stripe webhook endpoint created by you before install (any URL), its id (`we_…`) and its
  signing secret (`whsec_…`).** Post-deploy repoints that endpoint's URL at the deployed processor
  when `STRIPE_WEBHOOK_ID` is set (`processor/src/connectors/post-deploy.ts:19-33`).

> If you plan to use Multicapture (partial captures and multi-refund), contact Stripe to enable `STRIPE_ENABLE_MULTI_OPERATIONS` on your account before going live.

---

## 2. What This Connector Deploys

Three applications (`connect.yaml:1-35`):

| Component | Type | What it does |
| --- | --- | --- |
| `enabler` | Connect `assets` | Browser bundle `connector-enabler.{es,umd}.js` that the checkout loads to render Stripe elements |
| `processor` | Connect `service`, endpoint `/` | Payment API for the enabler, payment operations, recurring charges, `/stripe/webhooks` |
| `order-subscriber` | Connect `event`, endpoint `/orderSubscriber` | Writes `Order.paymentState` when an order is created |

Post-deploy creates or updates these resources in your environment:

| Component | Type | What it does |
| --- | --- | --- |
| Stripe webhook endpoint | Stripe (updated, not created) | Receives 12 events — `charge.succeeded`, `charge.updated`, `charge.refunded`, `refund.updated`, `refund.failed`, `payment_intent.succeeded`, `payment_intent.canceled`, `payment_intent.payment_failed`, `payment_intent.requires_action`, `payment_intent.processing`, `payment_intent.partially_funded`, `customer_cash_balance_transaction.created` — delivers to the processor's `/stripe/webhooks`. The authoritative list is the `enabled_events` array in `processor/src/connectors/actions.ts`. URL and events are written only when the endpoint's URL differs from the deployment's (`processor/src/connectors/post-deploy.ts:28-32`) |
| `payment-connector-stripe-customer-id` | CT Custom Type (customer) | Stores `stripeConnector_stripeCustomerId` — links a CT customer to their Stripe Customer |
| CT Subscription `ct-connect-stripe-checkout-order-subscription-{topic}` | CT Subscription | Created by the `order-subscriber` app's post-deploy; delivers `OrderCreated` and `OrderCreatedFromRecurringOrder` messages through the Pub/Sub topic Connect provisions for the app, which Connect delivers to `/orderSubscriber`, so the order's `paymentState` can be written (`order-subscriber/src/connectors/subscription.ts:32-45`; `order-subscriber/src/constants.ts:15`) |

> **Three applications are deployed, not two:** `processor` (service), `enabler` (assets) and
> `order-subscriber` (event). The subscriber exists because for a card the money settles *before* the
> order exists, so the webhook path has nothing to write `paymentState` onto. It needs the
> `manage_orders` scope, and `connect.yaml` has no `inheritAs` block — it declares its own
> `CTP_*` configuration.

> **Not created by the connector:** `payment-launchpad-purchase-order` — this CT custom type is not
> created or used by the connector at runtime. Post-deploy only reads it and logs when it already
> exists (`processor/src/connectors/actions.ts:41-46`). Create it only if something else in your
> project relies on it (Section 4).

> The subscription line-item type and the subscription product type are also not created by the connector.

---

## 3. Installation

### Step 1 — Deploy via CT Connect

Deploy `ct-connect-stripe-checkout` through the CT Connect marketplace (or deploy your fork through
Connect). The post-deploy scripts run automatically and create the resources listed above. Then add
it to a Checkout Application as a **Drop-in** payment integration (and, for Express, as Express
Payments integrations) — `host-integration.md` §2.5 has the Merchant Center steps.

### Step 2 — Configure environment variables

`processor` and `order-subscriber` each declare their own configuration; there is no shared block
(`connect.yaml:11-13`).

| Variable | Required | Description |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | **Yes** | Stripe secret API key |
| `STRIPE_PUBLISHABLE_KEY` | **Yes** | Stripe publishable key — sent to the browser enabler |
| `STRIPE_WEBHOOK_ID` | **Yes** | The `we_…` id of the endpoint you created; post-deploy repoints it (`connect.yaml:70-72`) |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | **Yes** | That endpoint's signing secret, from the Stripe Dashboard — do not guess this value |
| `MERCHANT_RETURN_URL` | **Yes** | Full URL of your storefront's payment return page (used after 3DS redirect). **Must be a valid absolute URL even if nothing redirects:** the enabler parses it before every confirmation (`host-integration.md` §5.4, §5.4.1) |
| `ALLOWED_ORIGINS` | **Yes** | Comma-separated storefront origins allowed to call `/express-config` (e.g. `https://your-store.com`). Only the enabler constructed without a session calls that route (`host-integration.md` §1, path F) |
| `CTP_PROJECT_KEY` | **Yes**, for both apps | CT project key |
| `CTP_CLIENT_ID` | **Yes**, for both apps | CT API client ID |
| `CTP_CLIENT_SECRET` | **Yes**, for both apps | CT API client secret |
| `CTP_AUTH_URL`, `CTP_API_URL` | **Yes**, for both apps | Region URLs (defaults: europe-west1) |
| `CTP_SESSION_URL`, `CTP_CHECKOUT_URL`, `CTP_JWKS_URL`, `CTP_JWT_ISSUER` | **Yes** (processor) | Session, Checkout API and JWT validation for your region |
| `STRIPE_CAPTURE_METHOD` | No | `automatic` (default), `automatic_async`, or `manual` |
| `STRIPE_ENABLE_MULTI_OPERATIONS` | No | `true` to enable partial captures and multi-refund (Stripe account feature required) |
| `STRIPE_COLLECT_BILLING_ADDRESS` | No | `auto` (default), `never`, or `if_required` |
| `STRIPE_PAYMENT_FLOW` | No | `deferred` (default) or `pi_first` — set to `pi_first` if you need to support Blik. See Section 4 "Blik" for what changes when you enable this. |
| `STRIPE_BEHAVIOR_PAYMENT_ELEMENT` | No | JSON object merged into the Payment Element's creation options on the enabler side. Validate your JSON before deploying. |
| `STRIPE_PAYMENT_BEHAVIOR_RULES` | No | JSON map of per-market exceptions, keyed by ISO country code or CT store key. Each rule may set `flowType`, `captureMethod`, `setupFutureUsage`, `collectBillingAddress`, `euBankTransferCountry`. Only the fields you supply override; omitted fields fall back to the flat env var above, **which may be the opposite instruction** — "field absent" is not "no instruction". Malformed JSON aborts startup. Matched on `cart.country` then `cart.store.key`; shopper-supplied billing/shipping countries deliberately never select a rule. |
| `PAYMENT_INTERFACE` | No | Default `checkout-stripe`. **Do not change it** unless you also change the order-subscriber's code: the subscriber matches that literal (`processor/src/config/config.ts:267` vs `order-subscriber/src/constants.ts:39`) |

Other optional settings: `STRIPE_SAVED_PAYMENT_METHODS_CONFIG`, `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE`,
appearance, layout and Express element options, `STRIPE_APPLE_PAY_WELL_KNOWN`, `STRIPE_API_VERSION`,
`CT_CUSTOM_TYPE_*`, `CT_PRODUCT_TYPE_SUBSCRIPTION_KEY`.

> **Signing secret:** copy it from Stripe Dashboard → Developers → Webhooks → your endpoint → Signing
> secret into `STRIPE_WEBHOOK_SIGNING_SECRET`. The endpoint is the one you created before install
> (Section 1), so its secret is available before the first deploy; set it then. The first deploy
> changes the endpoint's URL, not its secret.

### Step 3 — Verify post-deploy resources

In CT Merchant Center → Settings → Developer → API → Custom Types:
- `payment-connector-stripe-customer-id` (or your `CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY`) exists with field `stripeConnector_stripeCustomerId`

In Stripe Dashboard → Developers → Webhooks:
- A webhook endpoint pointing at `https://your-processor/stripe/webhooks` exists
- It lists all 12 events from Section 2; compare against `processor/src/connectors/actions.ts`, which is the authoritative list

In CT Merchant Center → Settings → Developer → Subscriptions:
- A subscription for the `OrderCreated` message pointing at `/orderSubscriber` exists
- Its key is `ct-connect-stripe-checkout-order-subscription-{topic}`, it covers `OrderCreated` and
  `OrderCreatedFromRecurringOrder`, and its destination is a Google Cloud Pub/Sub topic, not a URL
  (`order-subscriber/src/connectors/subscription.ts:32-45`)

In the processor's deploy log:
- No `[RETRIEVE_WEBHOOK_ENDPOINT]` / `[UPDATE_WEBHOOK_ENDPOINT]` error and no "STRIPE_WEBHOOK_ID var
  is not assigned"

---

## 4. Using it

How a storefront or Checkout calls the connector — sessions, the enabler bundle and its builders,
callbacks, outcomes, the return page — is in **`host-integration.md`**. This section covers what the
operator configures and what to observe.

The enabler's builders are `createDropinBuilder('embedded')` and `createExpressBuilder('dropin')`
(`enabler/src/payment-enabler/payment-enabler-mock.ts:211-249`); it is not published to npm
(`enabler/package.json:3`). The correct calls and the bundle URL are in `host-integration.md` §4.0–4.5.

### Card and wallet checkout (Payment Element)

Checkout loads the enabler; the shopper pays in the Payment Element. Observable result: a Payment on
the order with `Authorization/Success`, then `Charge/Success` when captured. With automatic capture,
`Order.paymentState` becomes `Paid` **on commercetools Checkout's timing**: the order-subscriber
writes it at `OrderCreated` only if `Charge/Success` is already on the Payment, which held because
Checkout created the order 333–877 ms after the charge in the connector's measurements
(`order-subscriber/src/guard.ts:135-142`). An order created before the charge is recorded —
including by a storefront that creates orders itself — keeps no `paymentState`. With manual capture
none is written. `Paid` also requires the order's charges to cover its tax-inclusive gross total;
short coverage leaves it unset with a warning (`order-subscriber/src/guard.ts:189-206`). See
`host-integration.md` §5.3 and §5.5.

### Express Checkout (Apple Pay / Google Pay)

Observable result as above; the PaymentIntent has no shipping
(`processor/src/services/stripe-payment.service.ts:1480`). `ALLOWED_ORIGINS` matters only when the
enabler runs Express without a session (`host-integration.md` §1, path F). A duplicate wallet
`confirm` is ignored and a repeated `GET /payments` on an unchanged cart reuses the open
PaymentIntent instead of charging twice.

### Blik

Blik (a Polish payment method) requires the PaymentIntent to exist **before** the Payment Element mounts — unlike other methods, which create the PaymentIntent only at confirm time. To support Blik, set `STRIPE_PAYMENT_FLOW=pi_first`. With this enabled, the enabler creates the PaymentIntent during setup instead of waiting for the shopper to submit the form — no change is needed on your side beyond the env var and mounting the Payment Element as usual; Blik then appears alongside other Stripe-supported methods based on your account settings and the cart's currency/country.

> If you don't need Blik, leave `STRIPE_PAYMENT_FLOW` unset (default `deferred`) — the early PaymentIntent creation has no benefit for other payment methods.

> `pi_first` strips `setup_future_usage` from the PaymentIntent.

### EU bank transfer (`customer_balance`)

**No rule switches it on.** A `eur` cart is offered bank transfer only when **all** of these hold
(Stripe imposes them and omits the method with no error when one fails) (`processor/README.md:671-690`):

- A **customer must be attached** to the PaymentIntent. Guest carts do not get the rail; Stripe accepts and discards the options rather than erroring. The processor attaches one only for a cart with a `customerId` whose commercetools customer already carries the Stripe customer id (`processor/src/services/stripe-payment.service.ts:812`, `:1464-1468`); the enabler's setup call `GET /customer/session` creates and stores that id for a logged-in shopper (`stripe-payment.service.ts:624-661`). Express attaches the customer only when its setup resolved one (`x-express-customer-session`, `stripe-payment.service.ts:1372-1377`).
- **`setup_future_usage` must be absent.** Stripe removes `customer_balance` from `payment_method_types` when the method cannot be saved, with no error and no warning — so enabling saved payment methods (`STRIPE_SAVED_PAYMENT_METHODS_CONFIG`) or `STRIPE_CAPTURE_METHOD=manual` suppresses the tab. Subscription carts set `setup_future_usage`, so those markets need `flowType: pi_first`, which strips it.
  - The PaymentIntent's `setup_future_usage` comes from a recurring cart, the market's rule or
    `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` (`stripe-payment.service.ts:676-742`);
    `STRIPE_SAVED_PAYMENT_METHODS_CONFIG` reaches only the Customer Session
    (`stripe-payment.service.ts:2938-2951`).
- **`captureMethod` `automatic`** (`processor/README.md:685-686`).
- **Bank transfer activated** in the Stripe Dashboard's payment-method settings. Stripe states both
  this and the customer requirement: bank transfers "are not available on PaymentIntents that don't
  have an associated customer"
  (https://docs.stripe.com/payments/bank-transfers/accept-a-payment?payment-ui=elements&api-integration=paymentintents).

`euBankTransferCountry` only chooses **which** of your own IBANs a EUR shopper sees — it is not an enable flag, and leaving it unset does not disable the rail: Stripe then derives the variant from the currency and defaults to an Irish IBAN. Allowed values `DE`, `FR`, `IE`, `NL` (`processor/src/mappers/bank-transfer-mapper.ts:22`, `:59-68`; `processor/src/services/stripe-payment.service.ts:1505-1509`; `processor/README.md:688-690`). Example: `{"DE":{"euBankTransferCountry":"DE"}}`.

Observable result: `Authorization/Pending` and order `Pending` until funds arrive, then `Paid`. For
markets that set `euBankTransferCountry`, a startup warning names any where the mandate or capture
settings will make Stripe suppress the option (`processor/src/config/config.ts:340-366`); a per-cart
warning covers recurring carts (`stripe-payment.service.ts:804-810`, `:999-1019`).

### ACH (US bank debit, `us_bank_account`)

**If you want ACH (US bank debit, `us_bank_account`),** there is **no connector config** — enable `us_bank_account` (and Financial Connections) in Stripe Dashboard → Payment methods, on a USD-capable account. It then surfaces in the Payment Element automatically. What to expect:

- **Async by nature.** The order goes `Pending` on `requires_action`/`processing` and `Paid` only when the debit settles (`succeeded`) — **days** later in production. The buyer's `/success`-vs-`/failed` screen is not authoritative for ACH; trust `Order.paymentState`.
- **Two verification paths, both hosted by Stripe:** *instant* (Financial Connections — the shopper logs into their bank in-session, no microdeposits) and *manual entry* (microdeposits — Stripe emails a hosted link; the shopper returns and enters the descriptor code; 1–2 business days). Both resolve to the same `succeeded` → `Paid`. No connector code drives the verification.
- **Not suppressed by `setup_future_usage`.** Unlike EU bank transfer (`customer_balance`), ACH via Financial Connections is savable, so enabling saved methods / `setup_future_usage` does **not** hide the tab.
- **Failures.** An async debit failure (insufficient funds, account closed → `insufficient_funds`/`no_account`) lands *after* the order exists, so the order becomes `Failed`. A synchronous rejection at confirm (e.g. weekly-volume limit → `charge_exceeds_source_limit`) is rejected before any order is created — the cart stays `Active`, no order.
- **Abandonment** behaves as for bank transfer: a shopper who never completes microdeposit verification leaves a `Pending` to reconcile out of band.

### Per-market behaviour

`STRIPE_PAYMENT_BEHAVIOR_RULES` keyed by `cart.country` or store key, e.g.
`{"MX":{"captureMethod":"manual"},"store-ca":{"flowType":"pi_first"}}`. Malformed JSON stops the
processor at startup. See `business-rules/payment-behavior-rules.md`.

### Capture, refund, cancel

From Merchant Center or `POST /operations/payment-intents/{paymentId}` (OAuth2,
`manage_checkout_payment_intents`) with `{"actions":[{"action":"refundPayment","amount":{…}}]}`;
the actions are `capturePayment`, `refundPayment`, `cancelPayment`, `reversePayment`
(`processor/src/routes/operation.route.ts:83-90`; `processor/src/dtos/operations/payment-intents.dto.ts:9-39`).
Partial captures require `STRIPE_ENABLE_MULTI_OPERATIONS=true`.
A refused operation (Stripe error, partial capture without the flag, collapsed refund) answers
**HTTP 200** with `outcome: rejected` — check the outcome, not the status; only a reverse with nothing to
reverse answers 400 (`processor/src/routes/operation.route.ts:107-112`;
`business-rules/refunds-reversals.md` Rule 8).

### Recurring orders

commercetools Recurring Orders call `POST /operations/transactions`; the saved method is charged
off-session. See `business-rules/`.

### B2B Launchpad purchase orders

The connector does not create or use the `payment-launchpad-purchase-order` CT custom type (Section 2).
Create it only if something else in your project relies on it:

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

- [ ] The processor's deploy log has no `[RETRIEVE_WEBHOOK_ENDPOINT]` / `[UPDATE_WEBHOOK_ENDPOINT]` error and no "STRIPE_WEBHOOK_ID var is not assigned"
- [ ] The Stripe webhook endpoint's URL ends in `stripe/webhooks` and lists 12 events
- [ ] The customer Type exists with the configured key; the order-subscriber's Subscription exists with the key in Section 3
- [ ] `GET /operations/config` (with an `X-Session-Id` header) returns a response including `publishableKey`
- [ ] Complete a test payment using Stripe test card `4242 4242 4242 4242` — CT payment should have a `CHARGE:SUCCESS` transaction
- [ ] Check Stripe Dashboard — a PaymentIntent with `ct_payment_id` and `cart_id` in metadata should appear
- [ ] Trigger a refund via `POST /operations/payment-intents/{id}` with action `refundPayment` — CT payment should gain a `REFUND` transaction
- [ ] Stripe Dashboard → Webhooks → Recent deliveries — all events should show HTTP 200 (400 means the signing secret is wrong)
- [ ] Express Checkout buttons appear on the page (if using Express)
- [ ] If `STRIPE_PAYMENT_FLOW=pi_first` is set: Blik appears as a payment option for eligible currency/country combinations, and the PaymentIntent is visible in Stripe Dashboard before the shopper submits the form
- [ ] The completed test order has `paymentState: Paid` in CT — if it is unset, the `order-subscriber` is not running or its `OrderCreated` subscription is missing. This holds for automatic capture on commercetools Checkout's timing only, and only when the charge covers the order total (Section 4)
- [ ] If using EU bank transfer: the `customer_balance` tab actually renders for a **signed-in** shopper on a EUR cart, and does **not** for a guest EUR cart. If it does not render for the signed-in shopper, check `setup_future_usage` and `capture_method` first — the processor logs a warning naming the reason
- [ ] If using EU bank transfer: complete one transfer end to end and confirm the order moves `Pending` → `Paid`
- [ ] If offering ACH (`us_bank_account`): run one Financial Connections *instant* payment (Success test account) and confirm `Order.paymentState` reaches `Paid`; run one *microdeposit* payment (manual entry, code `SM11AA` in test) and confirm the order is `Pending` until verification then `Paid`. Do **not** trust the `/failed` screen for ACH — verify in CT / Merchant Center
- [ ] If `ALLOWED_ORIGINS` is set: `POST /express-config` from an origin not in the list returns 403

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Stripe webhook events show HTTP 400 | `STRIPE_WEBHOOK_SIGNING_SECRET` wrong or not set | Copy signing secret from Stripe Dashboard webhook endpoint; redeploy |
| Payment succeeds in Stripe but CT payment not updated | Webhook failing — signing secret mismatch | Same as above; also check processor logs for 400s |
| No payment ever updates after checkout | Webhook endpoint not repointed | Check the deploy log; set `STRIPE_WEBHOOK_ID` and redeploy, or set the URL by hand |
| CT payment stuck in `AUTHORIZATION:SUCCESS`, never moves to `CHARGE` | `payment_intent.succeeded` webhook not processed | Verify webhook health in Stripe Dashboard; check processor logs |
| Refund processed in Stripe but CT payment has no `REFUND` transaction | `charge.refunded` webhook failed | Check Stripe Dashboard → Webhooks → logs for that event |
| `GET /payments` answers 500 right after a payment, or Express fails on a second tap | The cart already has a PaymentIntent that succeeded or is processing while its commercetools authorization is not yet written; the processor refuses a second one (`processor/src/services/stripe-payment.service.ts:1281-1283`, `:1056-1062`) | Expected; the first payment completes through its webhook. Check the Payment before retrying |
| Several Payments on one cart | Each attempt whose amount or configuration differed from the open one, a PaymentIntent that was no longer confirmable, or the orphan left by a concurrent create | Expected; judge the newest Payment or any with `Charge/Success` (`host-integration.md` §3.10, §5.2) |
| All payments fail at startup with auth errors | Placeholder credentials in env vars (`'stripeSecretKey'`, `'xxx'`) | Set all required env vars with real values |
| Processor does not start | Malformed `STRIPE_PAYMENT_BEHAVIOR_RULES` | Fix the JSON |
| `payment-launchpad-purchase-order` not found | This connector never reads this type and logs nothing when it is absent (Section 2); the message comes from another component | — |
| Bank transfer tab never appears, no error anywhere | `setup_future_usage` is set (often via `STRIPE_SAVED_PAYMENT_METHODS_CONFIG`) or `STRIPE_CAPTURE_METHOD=manual` — Stripe removes `customer_balance` from `payment_method_types` when the method cannot be saved. Also: no Stripe customer on the PaymentIntent, currency not `eur`, or bank transfer not activated in the Dashboard — **not** a missing `euBankTransferCountry`, which only pins the IBAN country | Clear `setup_future_usage` for that market, or set `flowType: pi_first` in `STRIPE_PAYMENT_BEHAVIOR_RULES` to strip it. Check processor logs — the connector warns and names the reason (startup warning for markets with `euBankTransferCountry`; per-cart warning "Bank transfer options were sent but Stripe will suppress the rail") |
| Bank transfer tab missing only for some shoppers | Those carts have no customer attached. `customer_balance` requires one; Stripe accepts and discards the options for a guest cart rather than erroring. Express without a resolved customer behaves the same | Expected. The rail is only available to signed-in shoppers |
| Shopper sees an Irish IBAN when you expected a local one | `euBankTransferCountry` not set for that market — Stripe derives the variant from the currency and defaults to IE | Set `euBankTransferCountry` to `DE`, `FR`, `IE` or `NL` in that market's rule |
| Order sits at `paymentState: Pending` for days | Normal for a bank transfer awaiting a wire, **or an ACH debit awaiting settlement / microdeposit verification** — or the shopper abandoned it and never completed it | Nothing to fix if the payment is in flight. If abandoned, reconcile out of band and cancel the PaymentIntent in Stripe |
| Orders have no `paymentState` at all | `order-subscriber` not deployed, missing its `CTP_*` configuration, or its `OrderCreated` subscription absent; or `PAYMENT_INTERFACE` changed from `checkout-stripe` | Check the app is running and that the subscription exists in Merchant Center; restore `checkout-stripe` |
| An order paid by card has no `paymentState` | Order created before `Charge/Success` was recorded (not Checkout's timing); manual capture; or the charges do not cover the order's gross total (warning "settled amount does not cover the order gross total") | `host-integration.md` §5.3; set it yourself, or create the order after the charge. A coverage warning needs manual review |
