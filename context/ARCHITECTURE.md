# Architecture — ct-connect-stripe-checkout

Commercetools Connect connector that integrates Stripe Payment Element and Express Checkout into a CT-managed checkout flow. Handles payment creation, confirmation, capture, refunds, and webhook synchronization between Stripe and CT.

## System Overview

Two-tier architecture: a **processor** (Node.js backend) and an **enabler** (TypeScript frontend wrapper). They communicate via HTTP; the processor talks to both Stripe and CT APIs.

```text
Browser / Storefront
  └── Enabler (Stripe.js SDK wrapper)
        │  GET /config-element, /customer/session, /payments
        │  POST /confirmPayments/:id
        ▼
    Processor (Fastify)
        ├── Stripe API (Payment Intents, Customers, Refunds, Webhooks)
        └── commercetools API (Payments, Carts, Customers, Custom Types)

Stripe (async)
  └── POST /stripe/webhooks → Processor → CT Payment updates
```

## Components

| Component | Role | Entry point |
| --- | --- | --- |
| `processor/` | Backend — all Stripe and CT API calls | `processor/src/main.ts` |
| `enabler/` | Frontend — mounts Stripe Elements, orchestrates payment submission | `enabler/src/main.ts` |

### Processor internals

| Layer | Path | Purpose |
| --- | --- | --- |
| Routes | `src/routes/stripe-payment.route.ts` | Frontend-facing payment endpoints + Stripe webhook dispatcher |
| Routes | `src/routes/operation.route.ts` | CT Connect SDK endpoints (capture, cancel, refund, reverse) |
| Service | `src/services/abstract-payment.service.ts` | Abstract base + `modifyPayment()` action dispatch |
| Service | `src/services/stripe-payment.service.ts` | All Stripe business logic (PI, customer session, refunds, webhooks, multi-capture) |
| Service | `src/services/payment-behavior-resolver.ts` | Resolves per-cart `STRIPE_PAYMENT_BEHAVIOR_RULES` overrides — `resolvePaymentBehavior()`, `extractDiscriminator()` |
| Converter | `src/services/converters/stripeEventConverter.ts` | Maps Stripe events → CT transaction updates |
| CT helpers | `src/services/commerce-tools/customerClient.ts`, `customTypeClient.ts`, `customTypeHelper.ts`, `productTypeClient.ts` | CT API helpers used by service and connectors |
| Client | `src/clients/stripe.client.ts` | Stripe SDK factory + error wrapping |
| Config | `src/config/config.ts` | Environment variable access |
| Constants | `src/constants.ts` | Tax calculation custom field constants |
| Custom types | `src/custom-types/custom-types.ts` | CT custom type and product type definitions |
| Connectors | `src/connectors/actions.ts`, `post-deploy.ts`, `pre-undeploy.ts` | Deploy/undeploy lifecycle hooks |
| Hooks | `src/libs/fastify/hooks/stripe-header-auth.hook.ts` | Pre-handler hook checking `stripe-signature` header presence (full HMAC verification happens inside the route handler via `stripe.webhooks.constructEvent()`) |

### Enabler internals

| Layer | Path | Purpose |
| --- | --- | --- |
| Interface | `src/payment-enabler/payment-enabler.ts` | Public contracts (no implementation) |
| Implementation | `src/payment-enabler/payment-enabler-mock.ts` | SDK init, session setup, config fetch |
| Drop-in | `src/dropin/dropin-embedded.ts` | Stripe Payment Element — submit flow |
| Express | `src/express/dropin-express.ts` | Express Checkout Element — session and shipping callbacks |

#### Dropin types

| Dropin | Builder | Status |
| --- | --- | --- |
| `embedded` | `DropinEmbeddedBuilder` | Active |
| `express` | `StripeExpressBuilder` | Active |
| `hpp` | _(not exported from main.ts)_ | Not supported |

#### Initialization flows

**Session flow** (`_Setup`) — used by embedded dropin and express when a `sessionId` is available:

```text
GET /config-element/payment  ─┐  (parallel)
GET /operations/config       ─┘
GET /customer/session
loadStripe(publishableKey)
stripe.elements({ mode:'payment', amount, currency, customerOptions, appearance, capture_method })
elements.create('payment', elementOptions)
```

**Express-without-session flow** (`_SetupExpress`) — used when rendering Express buttons before the user has a session (no `sessionId` on `EnablerOptions`):

```text
POST /express-config   (CORS only — no session header)
loadStripe(publishableKey)
← Elements creation deferred to StripeExpressComponent.init() when real amount is available
```

#### Express Checkout event flow

| Stripe event | Handler | What it does |
| --- | --- | --- |
| `click` | `kickOffSessionInitFromClick()` | Resolves immediately with initial line items; starts async `onPayButtonClick()` session refresh in background |
| `confirm` | `handlePaymentConfirm()` | Submit Elements → optional `onPaymentSubmit` → `GET /payments` → `confirmPayment` → `POST /confirmPayments/:id` → `onComplete` |
| `cancel` | `handleCancel()` | Resets session state; calls `onError` with `error.name = 'CANCEL'` |
| `shippingaddresschange` | `handleShippingAddressChange()` | Sets CT shipping address → loads shipping methods → applies first rate → fetches totals → updates Elements amount |
| `shippingratechange` | `handleShippingRateChange()` | Sets CT shipping method → fetches totals → updates Elements amount |

**Session generation guard:** `sessionInitGeneration` counter prevents stale async completions from a previous `click` from overwriting a newer session.

#### Processor API calls from the enabler

| Method | Endpoint | Header | Purpose |
| --- | --- | --- | --- |
| `GET` | `/config-element/payment` | `x-session-id` | Appearance, layout, captureMethod, setupFutureUsage, cartInfo |
| `GET` | `/operations/config` | `x-session-id` | publishableKey, environment |
| `GET` | `/customer/session` | `x-session-id` | stripeCustomerId, ephemeralKey, sessionId (204 = guest) |
| `POST` | `/express-config` | none (CORS) | publishableKey, captureMethod, appearance, expressElementOptions |
| `GET` | `/payments` | `x-session-id`, `x-express-checkout: true` (express only) | Creates PI + CT Payment; returns clientSecret |
| `POST` | `/confirmPayments/:id` | `x-session-id` | 4-point validation; updates CT to AUTHORIZED |
| `GET` | `/express-payment-data` | `x-session-id` | Cart totals and line items after shipping changes |

## API Endpoints

### Frontend-facing (`stripe-payment.route.ts`)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /payments` | SessionHeader | Creates Stripe PaymentIntent + CT Payment. Accepts header `x-express-checkout: 'true'` or `'1'` (string, case-sensitive) to skip shipping params on the PI. |
| `POST /confirmPayments/:id` | SessionHeader | Validates PI against CT payment (4-point check) and marks CT payment as AUTHORIZED. |
| `GET /customer/session` | SessionHeader | Returns Stripe customer ID, ephemeral key, and customer session ID for saved payment methods. Returns 204 if the cart has no `customerId` (guest checkout) or the customer cannot be found. |
| `GET /express-payment-data` | SessionHeader | Returns cart totals and line items for Express Checkout display. |
| `GET /config-element/:paymentComponent` | SessionHeader | Returns appearance, layout, capture method, and billing address config for the element. |
| `POST /express-config` | CORS | Returns publishable key and config for Express buttons. No session required — called before user interaction. |
| `GET /applePayConfig` | None | Returns Apple Pay domain association file. Intentionally public — required by Apple's domain verification spec. |
| `POST /stripe/webhooks` | Stripe Signature | Receives and processes Stripe events. Pre-handler hook checks `stripe-signature` header presence; full signature verification (`stripe.webhooks.constructEvent`) happens inside the handler. Event processing runs synchronously and the handler returns 200 after processing completes. |

### CT Connect SDK (`operation.route.ts`)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /operations/config` | SessionHeader | Returns publishable key, capture method, appearance. |
| `GET /status` | JWT | Health check — validates CT permissions + Stripe connectivity. |
| `GET /payment-components` | JWT | Returns supported components under the `dropins` key: `dropin` (embedded), `express` (dropin). |
| `POST /payment-intents/:id` | OAuth2 | Modifies a payment: capture, cancel, refund, or reverse. |

## Integration Boundaries

### Stripe API calls (by operation)

| Operation | Stripe methods |
| --- | --- |
| Create payment | `paymentIntents.create()`, then `paymentIntents.update()` (separate metadata patch for `ct_payment_id`) |
| Confirm payment | `paymentIntents.retrieve()` |
| Capture | `paymentIntents.capture()` |
| Cancel | `paymentIntents.cancel()` |
| Refund | `refunds.create()`, `refunds.list()` |
| Customer | `customers.retrieve()`, `customers.search()`, `customers.create()` |
| Saved methods | `paymentMethods.retrieve()`, `paymentMethods.list()` |
| Session | `customerSessions.create()`, `ephemeralKeys.create()` |
| Webhooks | `webhooks.constructEvent()` |
| Multi-capture | `balanceTransactions.list()` — called in `processStripeEvent()` only when: `charge.updated` event, `capture_method === 'manual'`, `payment_method_options.card.request_multicapture === 'if_available'`, and `latest_charge` is a non-empty string. |

### commercetools API calls (by operation)

| Operation | CT methods |
| --- | --- |
| Create payment | `ctCartService.getCart()`, `ctPaymentService.createPayment()`, `ctCartService.addPayment()` |
| Confirm payment | `ctPaymentService.getPayment()`, `ctPaymentService.updatePayment()` |
| Webhooks | `ctPaymentService.updatePayment()` |
| Customer session | `paymentSDK.ctAPI.client.customers()`, `updateCustomerById()` |
| Saved methods | `ctPaymentMethodService.getByTokenValue()`, `ctPaymentMethodService.save()` |

## CT Data Model

### CT Payment object

The CT Payment is the source of truth for transaction state. Stripe is the source of truth for money movement.

| Field | Value |
| --- | --- |
| `paymentMethodInfo.paymentInterface` | `checkout-stripe` (configurable via `PAYMENT_INTERFACE`) |
| `paymentMethodInfo.method` | Stripe payment method type |
| `paymentMethodInfo.token.value` | Stripe `PaymentMethod` ID (set by `updatePaymentWithToken` after a saved-card webhook) |
| Tax calculations | Stored on the **cart** custom field `connectorStripeTax_calculationReferences` (see `processor/src/constants.ts` → `CT_CUSTOM_FIELD_TAX_CALCULATIONS`). Forwarded to the PI via `hooks.inputs.tax.calculation` only when **exactly one** reference is present; zero or multiple references are silently ignored. |

### CT Custom Types and Product Types

**Installed by `post-deploy`:**

| Key (env override) | Resource | Purpose |
| --- | --- | --- |
| `payment-connector-stripe-customer-id` (`CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY`) | customer | Stores Stripe customer ID in field `stripeConnector_stripeCustomerId` |
| `payment-launchpad-purchase-order` (`CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY`) | payment | Existence check only during post-deploy; fields `launchpadPurchaseOrderNumber`, `launchpadPurchaseOrderInvoiceMemo` must be pre-created by merchant |

**Defined but NOT installed by `post-deploy` (subscription-related; not used by this connector):**

| Key (env override) | Resource | Purpose |
| --- | --- | --- |
| `payment-connector-subscription-line-item-type` (`CT_CUSTOM_TYPE_SUBSCRIPTION_LINE_ITEM_KEY`) | line-item | Fields: `stripeConnector_productSubscriptionId`, `stripeConnector_stripeSubscriptionId`, `stripeConnector_stripeSubscriptionError` |
| `payment-connector-subscription-information` (`CT_PRODUCT_TYPE_SUBSCRIPTION_KEY`) | product-type | 15 subscription attributes (see `ct-connect-stripe-composable` for full list) |

### Transaction types used

| CT Transaction Type | Meaning |
| --- | --- |
| `AUTHORIZATION` | PI created (requires_capture) or succeeded |
| `CHARGE` | Payment captured or succeeded (automatic) |
| `CANCEL_AUTHORIZATION` | PI canceled |
| `REFUND` | Charge refunded |
| `CHARGE_BACK` | Chargeback initiated (no handler — manual only) |

## Webhook Event Subscriptions

The following events are registered on the Stripe webhook endpoint during `post-deploy` (hardcoded in `src/connectors/actions.ts`):

- `charge.succeeded`
- `charge.updated` (required for multi-capture delta tracking)
- `charge.refunded`
- `payment_intent.succeeded`
- `payment_intent.canceled`
- `payment_intent.payment_failed`
- `payment_intent.requires_action` (subscribed but has no handler — events are received and silently dropped)

## Key Configuration

| Variable | Required | Effect |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes | Stripe API key. Defaults to `'stripeSecretKey'` — must be overridden. |
| `STRIPE_PUBLISHABLE_KEY` | Yes | Sent to browser for Stripe.js initialization. Defaults to `''`. |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | Yes | Webhook HMAC secret. Defaults to `''` — all webhooks rejected if not set. |
| `STRIPE_CAPTURE_METHOD` | No | `automatic`, `automatic_async`, or `manual`. Default: `automatic`. |
| `STRIPE_ENABLE_MULTI_OPERATIONS` | No | Enables multicapture + multi-refund via `charge.updated`. Default: `false`. |
| `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` | No | Sets reuse intent on PaymentIntent. Values `''`, `'none'`, `'null'`, `'undefined'` treated as absent. |
| `STRIPE_SAVED_PAYMENT_METHODS_CONFIG` | No | JSON config for Payment Element saved methods feature. |
| `STRIPE_COLLECT_BILLING_ADDRESS` | No | `auto`, `never`, or `if_required`. Default: `auto`. |
| `STRIPE_APPLE_PAY_WELL_KNOWN` | No | Raw string returned by `/applePayConfig` for Apple Pay domain association. |
| `STRIPE_PAYMENT_BEHAVIOR_RULES` | No | `processor/src/config/config.ts` (parsed by `getPaymentBehaviorConfig()`) + `processor/src/services/payment-behavior-resolver.ts` (`resolvePaymentBehavior()`) + `processor/src/services/stripe-payment.service.ts` (`createPaymentIntentStripe()` calls the resolver). JSON map keyed by ISO country code or CT store key; overrides `captureMethod` and `flowType` (and `setupFutureUsage`/`collectBillingAddress`) per cart based on cart country or store. Malformed JSON aborts startup. |
| `STRIPE_BEHAVIOR_PAYMENT_ELEMENT` | No | JSON config merged with the legacy `layout`/`STRIPE_COLLECT_BILLING_ADDRESS` values in the enabler's `getElementsOptions()`. Supports `terms`, `wallets`, `defaultValues`, `business`, `paymentMethodOrder`, `readOnly`, `fields`, `layout`. An explicit value here wins over the legacy env var per attribute. |
| `STRIPE_EXPRESS_ELEMENT_OPTIONS` | No | Options forwarded to the Express Checkout Element (Apple Pay / Google Pay) configuration. |
| `ALLOWED_ORIGINS` | Yes | Comma-separated CORS whitelist for `/express-config`. Must include the storefront origin. |
| `MERCHANT_RETURN_URL` | Yes | Return URL after 3DS or redirect-based payment methods. |
| `PAYMENT_INTERFACE` | No | Value written to `paymentMethodInfo.paymentInterface`. Default: `checkout-stripe`. |
| `CTP_PROJECT_KEY` | Yes | CT project key. Defaults to `'payment-integration'`. |
| `CTP_CLIENT_ID` | Yes | CT OAuth2 client ID. Defaults to `'xxx'`. |
| `CTP_CLIENT_SECRET` | Yes | CT OAuth2 client secret. Defaults to `'xxx'`. |
| `CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY` | No | Custom type key for Stripe customer ID. Default: `payment-connector-stripe-customer-id`. |
| `CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY` | No | Custom type key for Launchpad PO. Default: `payment-launchpad-purchase-order`. |
| `CONNECT_SERVICE_URL` | Yes (post-deploy) | CT Connect service URL; injected by CT Connect. |
| `STRIPE_WEBHOOK_ID` | Yes (post-deploy) | Stripe webhook endpoint ID; injected by CT Connect. |

## Out of Scope

| Feature | Status |
| --- | --- |
| Subscriptions / recurring billing | Use `ct-connect-stripe-composable` |
| SetupIntent (save now, charge later) | CT custom types defined but not installed or used |
| Dispute / chargeback automation | `charge.dispute.*` not registered; requires manual process |
| CT coupon / discount → Stripe sync | Not implemented |
| Stripe Connect (marketplace, split payments) | Not in this hub |
| Stripe Terminal (in-person) | Not implemented |
| Stripe Link | Surfaced by Payment Element only; no dedicated flow |
| Hosted Payment Page (HPP) | Defined in code but not exported or supported |
| Mixed carts (subscription + one-time) | Requires `ct-connect-stripe-composable` |
