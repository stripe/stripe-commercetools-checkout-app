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
| Stripe webhook endpoint | Stripe | Receives `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.succeeded`, `charge.refunded` — delivers to the processor's `/stripe/webhooks` |
| `payment-connector-stripe-customer-id` | CT Custom Type (customer) | Stores `stripeConnector_stripeCustomerId` — links a CT customer to their Stripe Customer |

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

> **After first deploy:** go to Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret. Copy it into `STRIPE_WEBHOOK_SIGNING_SECRET` and redeploy. Payments will succeed but CT will not update until this is set.

### Step 3 — Verify post-deploy resources

In CT Merchant Center → Settings → Developer → API → Custom Types:
- `payment-connector-stripe-customer-id` exists with field `stripeConnector_stripeCustomerId`

In Stripe Dashboard → Developers → Webhooks:
- A webhook endpoint pointing at `https://your-processor/stripe/webhooks` exists

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
