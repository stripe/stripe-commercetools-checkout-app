# Stripe + commercetools Checkout Connector

## What This Is
A **commercetools Connect** payment connector that integrates **Stripe** into the **commercetools Checkout** product (pre-built checkout, part of their Payment Hub framework). It supports the Stripe **Payment Element** and **Express Checkout Element** via commercetools' drop-in framework.

## What This Is NOT
- This is NOT a storefront or commerce solution — merchants build their own
- This does NOT manage order state — commercetools Checkout handles that automatically
- This does NOT enforce a reference architecture for order flows
- Source code is public; merchants can use it natively from the Connect marketplace or fork it as a "custom connect application"

## Two-Module Architecture

### Enabler (`enabler/`) — Frontend Assets
Vite-bundled library deployed as `assets` via Connect. Wraps Stripe.js elements for commercetools' drop-in framework.

| File | Role |
|------|------|
| `src/main.ts` | Entry point — exports `MockPaymentEnabler as Enabler` |
| `src/payment-enabler/payment-enabler.ts` | Interfaces: `PaymentEnabler`, builders, components, `ExpressOptions` |
| `src/payment-enabler/payment-enabler-mock.ts` | Main class: `MockPaymentEnabler` — setup, Stripe SDK loading, element creation |
| `src/dropin/dropin-embedded.ts` | `DropinEmbeddedBuilder` + `DropinComponents` — Payment Element drop-in |
| `src/express/dropin-express.ts` | `StripeExpressBuilder` + `StripeExpressComponent` — Express Checkout |
| `src/express/base.ts` | `DefaultExpressComponent` — abstract base with callback delegation |
| `src/components/base.ts` | `BaseComponent` — abstract base for individual components |

**Two initialization paths:**
- **Session flow** (`_Setup`): fetches `/config-element/payment` + `/operations/config` + `/customer/session` using `x-session-id` header
- **Express no-session flow** (`_SetupExpress`): fetches `POST /express-config` (CORS-only, no session needed)

**Supported builders:**
- `createDropinBuilder('embedded')` → Stripe Payment Element
- `createExpressBuilder('dropin')` → Stripe Express Checkout Element
- `createComponentBuilder(type)` → individual components (currently empty)

### Processor (`processor/`) — Backend Service
Fastify HTTP service deployed as `service` via Connect.

| File | Role |
|------|------|
| `src/main.ts` | Entry point |
| `src/config/config.ts` | All environment variable configuration |
| `src/payment-sdk.ts` | CT Payment SDK singleton setup |
| `src/server/app.ts` | Wires `StripePaymentService` with CT SDK services |
| `src/routes/stripe-payment.route.ts` | Payment, webhook, config, customer, express routes |
| `src/routes/operation.route.ts` | `/operations/*` endpoints |
| `src/services/stripe-payment.service.ts` | **Core business logic** (~900 lines) |
| `src/services/converters/stripeEventConverter.ts` | Stripe events → CT transaction data |
| `src/services/commerce-tools/` | CT client helpers (customer, custom types, product types) |
| `src/clients/stripe.client.ts` | Stripe API client factory (includes partner ID `pp_partner_c0mmercet00lsc0NNect`) |
| `src/connectors/actions.ts` | Post-deploy / pre-undeploy actions |
| `src/connectors/post-deploy.ts` | Creates custom types, updates Stripe webhook URL |
| `src/connectors/pre-undeploy.ts` | Removes custom types |
| `src/custom-types/custom-types.ts` | CT TypeDraft/ProductTypeDraft definitions |
| `src/constants.ts` | `CT_CUSTOM_FIELD_TAX_CALCULATIONS` |
| `src/libs/fastify/cors/cors.ts` | CORS origin validation hook |
| `src/libs/fastify/hooks/stripe-header-auth.hook.ts` | Stripe webhook signature check |

## API Endpoints

### Stripe Payment Routes
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/payments` | Session | Create PaymentIntent (supports `x-express-checkout` header) |
| POST | `/confirmPayments/:id` | Session | Confirm payment in CT after Stripe confirms |
| GET | `/config-element/:paymentComponent` | Session | Element config (appearance, layout, cart info) |
| GET | `/customer/session` | Session | Get/create Stripe customer session |
| POST | `/stripe/webhooks` | Stripe signature | Receive Stripe webhook events |
| POST | `/express-config` | CORS | Public config for express buttons (no session) |
| GET | `/applePayConfig` | None | Apple Pay domain association file |

### Operation Routes
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/operations/config` | Session | publishableKey + environment |
| GET | `/operations/status` | JWT | Health check |
| GET | `/operations/payment-components` | JWT | Supported components list |
| POST | `/operations/payment-intents/:id` | OAuth2 + AuthZ | Modify payment (capture/refund/cancel) |

## Webhook Event → CT Transaction Mapping

| Stripe Event | CT Transaction Type | CT State | Amount Source |
|---|---|---|---|
| `payment_intent.canceled` | Authorization | Failure | PI `amount` |
| `payment_intent.canceled` | CancelAuthorization | Success | PI `amount` |
| `payment_intent.succeeded` | Charge | Success | PI `amount_received` |
| `payment_intent.payment_failed` | Authorization | Failure | PI `amount_received` |
| `charge.succeeded` | Authorization | Success | Charge `amount_refunded` |
| `charge.refunded` | Refund + Chargeback | Success | Charge `amount_refunded` |
| `charge.updated` | Charge | Success | Charge amount (multicapture only) |

Events route through `StripeEventConverter.convert()` which extracts `ct_payment_id` from metadata.

## Key Patterns and Conventions

### CT ↔ Stripe Linking
- `metadata.ct_payment_id` on PaymentIntent links to commercetools payment ID
- `stripeConnector_stripeCustomerId` custom field on CT customer stores Stripe customer ID
- `connectorStripeTax_calculationReferences` cart custom field feeds Stripe Tax

### Feature Flag: `STRIPE_ENABLE_MULTI_OPERATIONS`
When `true`:
- `charge.refunded` → enhanced `processStripeEventRefunded()` (queries Stripe for latest refund)
- `charge.updated` → `processStripeEventMultipleCaptured()` (partial capture tracking)
- PaymentIntent created with `request_multicapture: 'if_available'`
- Partial captures use `final_capture: false`

When `false` (default):
- `charge.refunded` → basic converter flow
- `charge.updated` → skipped
- Partial capture attempts throw error

### Payment Interface
Default: `checkout-stripe` (configurable via `PAYMENT_INTERFACE`)

### Stripe API Version
Default: `2025-12-15.clover` (configurable via `STRIPE_API_VERSION`)

### Custom Types (managed by deploy scripts)
| Key | Resource | Fields |
|-----|----------|--------|
| `payment-launchpad-purchase-order` | payment | purchaseOrderNumber, invoiceMemo |
| `payment-connector-stripe-customer-id` | customer | `stripeConnector_stripeCustomerId` |
| `payment-connector-subscription-line-item-type` | line-item | productSubscriptionId, stripeSubscriptionId, stripeSubscriptionError |
| `payment-connector-subscription-information` | product type | recurring interval, collection method, trial, billing cycle attributes |

All keys are configurable via `CT_CUSTOM_TYPE_*` / `CT_PRODUCT_TYPE_*` env vars.

## Payment Flows

### Drop-in (Payment Element)
1. Enabler fetches config → loads Stripe SDK → creates Elements + PaymentElement
2. Checkout mounts PaymentElement to DOM
3. On submit: `elements.submit()` → `GET /payments` (creates PI) → `sdk.confirmPayment()` → `POST /confirmPayments/:id`
4. Webhooks update CT payment with transaction states

### Express Checkout
1. Enabler creates ExpressCheckoutElement (with `initialAmount`)
2. User clicks pay → `onPayButtonClick` gets session → modal opens
3. User selects address → `shippingaddresschange` → callbacks update cart
4. User selects shipping → `shippingratechange` → callbacks update cart + amount
5. User confirms → `elements.submit()` → `GET /payments` (with `x-express-checkout: true`, no shipping on PI) → `sdk.confirmPayment()` → `POST /confirmPayments/:id`

### BNPL Return Flow
For redirect-based methods (BNPL), Stripe appends `payment_intent` to `MERCHANT_RETURN_URL`. Merchant must extract `ct_payment_id` from PI metadata and pass as `paymentReference` to CT Checkout SDK.

## Connect Deployment (`connect.yaml`)
- **Enabler**: `applicationType: assets`
- **Processor**: `applicationType: service`, endpoint `/`
  - `postDeploy`: creates custom types + updates Stripe webhook URL
  - `preUndeploy`: removes custom types (subscription product type, line item type, customer type)

## Dev Commands

### Processor
```bash
cd processor
cp .env.template .env  # fill in values
npm install
npm run build
npm run dev            # local development
npm run test
npm run lint:fix
npm run connector:post-deploy
npm run connector:pre-undeploy
```

### Enabler
```bash
cd enabler
cp .env.template .env
npm install
npm run build
npm run dev            # http://127.0.0.1:3000/
```

### Docker (all services + JWT mock server)
```bash
docker compose up      # starts JWT server, enabler, processor
```
