# Deployment — ct-connect-stripe-checkout

Prerequisites, configuration, and deploy/undeploy lifecycle for CT Connect. Source of truth: `connect.yaml`.

---

## Prerequisites

Complete these steps before deploying. Skipping any will cause silent failures.

### Stripe account

- [ ] Create a Webhook Endpoint in Stripe Dashboard pointing to `<CONNECT_SERVICE_URL>/stripe/webhooks`
- [ ] Note the Webhook Endpoint ID (`we_*****`) — required as `STRIPE_WEBHOOK_ID`
- [ ] Note the Webhook Signing Secret (`whsec_*****`) — required as `STRIPE_WEBHOOK_SIGNING_SECRET`
- [ ] Note the Publishable Key (`pk_*****`) and Secret Key (`sk_*****`)
- [ ] If using `STRIPE_ENABLE_MULTI_OPERATIONS=true`: enable multicapture in Stripe Dashboard → Settings → Payment capturing
- [ ] If using Apple Pay: obtain the domain association file from Stripe Dashboard and host it at `/.well-known/apple-developer-merchantid-domain-association` on the storefront

### commercetools project

- [ ] API client with these scopes on `CTP_CLIENT_ID`:
  - `manage_payments`
  - `manage_orders`
  - `view_sessions`
  - `view_api_clients`
  - `manage_checkout_payment_intents`
  - `introspect_oauth_tokens`
  - `manage_types`
  - `view_types`
- [ ] **Launchpad custom type created manually** (see `context/known-issues.md` KI-004) — `post-deploy` does NOT auto-create it. Key: `payment-launchpad-purchase-order` (configurable via `CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY`). Fields: `launchpadPurchaseOrderNumber` (String), `launchpadPurchaseOrderInvoiceMemo` (String).

---

## Environment Variables

### Standard configuration (not encrypted)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CTP_PROJECT_KEY` | Yes | — | CT project key |
| `CTP_AUTH_URL` | Yes | `https://auth.europe-west1.gcp.commercetools.com` | |
| `CTP_API_URL` | Yes | `https://api.europe-west1.gcp.commercetools.com` | |
| `CTP_SESSION_URL` | Yes | `https://session.europe-west1.gcp.commercetools.com` | |
| `CTP_CHECKOUT_URL` | Yes | — | |
| `CTP_JWKS_URL` | Yes | `https://mc-api.europe-west1.gcp.commercetools.com/.well-known/jwks.json` | |
| `CTP_JWT_ISSUER` | Yes | `https://mc-api.europe-west1.gcp.commercetools.com` | |
| `STRIPE_WEBHOOK_ID` | Yes | — | `we_*****` from Stripe Dashboard; used by `post-deploy` to update the webhook URL |
| `STRIPE_PUBLISHABLE_KEY` | Yes | — | `pk_*****`; returned to the frontend via `/config` and `/express-config` |
| `STRIPE_API_VERSION` | Yes | — | Stripe API version for ephemeral keys (must match the mobile SDK version if used) |
| `MERCHANT_RETURN_URL` | Yes | — | Base URL for 3DS and redirect-based payment method returns; `cartId` and `paymentReference` are appended as query params |
| `STRIPE_COLLECT_BILLING_ADDRESS` | No | `auto` | `auto` \| `never` \| `if_required` |
| `STRIPE_CAPTURE_METHOD` | No | `automatic` | `automatic` \| `automatic_async` \| `manual` |
| `STRIPE_ENABLE_MULTI_OPERATIONS` | No | `false` | `true` \| `false` — requires multicapture enabled in Stripe account |
| `STRIPE_APPEARANCE_PAYMENT_ELEMENT` | No | — | JSON string (Stripe Appearance API) for Payment Element styling |
| `STRIPE_LAYOUT` | No | `{"type":"tabs","defaultCollapsed":false}` | JSON string; valid types: `tabs`, `accordion`, `auto` |
| `STRIPE_SAVED_PAYMENT_METHODS_CONFIG` | No | `{"payment_method_save":"disabled"}` | JSON string for Payment Element saved methods feature |
| `STRIPE_APPLE_PAY_WELL_KNOWN` | No | — | Raw string content of the Apple Pay domain association file, returned by `GET /applePayConfig` |
| `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` | No | — | Sets PI `setup_future_usage`; overridden to `off_session` for recurring carts. Values `''`, `'none'`, `'null'`, `'undefined'` are treated as absent |
| `ALLOWED_ORIGINS` | No | — | Comma-separated CORS origins for `POST /express-config` (e.g. `https://shop.example.com,https://checkout.example.com`) |
| `PAYMENT_INTERFACE` | No | `checkout-stripe` | Written to `paymentMethodInfo.paymentInterface` on CT payments |
| `CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY` | No | `payment-connector-stripe-customer-id` | Key of the CT custom type that stores Stripe customer IDs on CT customers |
| `CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY` | No | `payment-launchpad-purchase-order` | Key of the Launchpad custom type (must be pre-created; see Prerequisites) |
| `CT_CUSTOM_TYPE_SUBSCRIPTION_LINE_ITEM_KEY` | No | `payment-connector-subscription-line-item-type` | Defined but not installed by post-deploy; for future recurring-payment features |
| `CT_PRODUCT_TYPE_SUBSCRIPTION_KEY` | No | `payment-connector-subscription-information` | Defined but not installed by post-deploy; for future recurring-payment features |
| `HEALTH_CHECK_TIMEOUT` | No | — | Timeout (ms) for the `/status` health check |
| `LOGGER_LEVEL` | No | — | Log level (`debug`, `info`, `warn`, `error`) |

### Secured configuration (encrypted by CT Connect)

| Variable | Required | Notes |
|---|---|---|
| `CTP_CLIENT_SECRET` | Yes | CT API client secret |
| `CTP_CLIENT_ID` | Yes | CT API client ID — must have the scopes listed in Prerequisites |
| `STRIPE_SECRET_KEY` | Yes | `sk_*****` — never log, never expose to the frontend |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | Yes | `whsec_*****` — used by `stripe.webhooks.constructEvent()` |

---

## Deploy Lifecycle

### Post-deploy (`npm run connector:post-deploy`)

Runs `processor/src/connectors/post-deploy.ts`. Executed automatically by CT Connect after deployment.

**What it does (in order):**

1. **Check Launchpad custom type** — calls `getTypeByKey()` for `CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY`. Logs whether it exists. Does NOT create it. Fails silently if absent (see `known-issues.md` KI-004).
2. **Update Stripe webhook** — retrieves the endpoint by `STRIPE_WEBHOOK_ID` and updates its URL to `<CONNECT_SERVICE_URL>/stripe/webhooks` with these enabled events:
   - `charge.succeeded`
   - `charge.updated`
   - `charge.refunded`
   - `payment_intent.succeeded`
   - `payment_intent.canceled`
   - `payment_intent.payment_failed`
   - `payment_intent.requires_action`
3. **Create customer custom type** — creates or updates `payment-connector-stripe-customer-id` with field `stripeConnector_stripeCustomerId`.

> If `STRIPE_WEBHOOK_ID` is empty, step 2 is skipped with a warning. The webhook URL must be configured manually in the Stripe Dashboard.

### Pre-undeploy (`npm run connector:pre-undeploy`)

Runs `processor/src/connectors/pre-undeploy.ts`. Executed automatically by CT Connect before undeployment.

**What it does:**

1. Removes the customer custom type (`CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY`)

> The Launchpad custom type (`CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY`) is NOT removed on undeploy.
> The subscription line-item type and subscription product type are not removed (they are not installed by post-deploy).

---

## Deployed Applications

CT Connect deploys two applications from this connector (defined in `connect.yaml`):

| Name | Type | Description |
|---|---|---|
| `enabler` | `assets` | Frontend JavaScript bundle — serves the Stripe Payment Element and Express Checkout dropin |
| `processor` | `service` | Backend Node.js service — all Stripe and CT API calls, webhook handler |

The processor exposes its root at `/`. The enabler is a static asset bundle consumed by the merchant's frontend.

---

## Validation After Deploy

1. Stripe Dashboard → Webhooks → confirm the endpoint URL is updated and all 7 events are enabled
2. CT Merchant Center → Types → confirm `payment-connector-stripe-customer-id` exists with field `stripeConnector_stripeCustomerId`
3. Hit `GET <CONNECT_SERVICE_URL>/status` — expect `200 OK`
4. Place a test payment end-to-end with a Stripe test card (`4242 4242 4242 4242`)
