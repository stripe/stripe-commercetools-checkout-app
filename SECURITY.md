# Security Model

## Authentication Layers

This connector uses five distinct authentication mechanisms depending on the endpoint.

### 1. Session Header Authentication
**Used by**: `/payments`, `/confirmPayments/:id`, `/config-element/:paymentComponent`, `/customer/session`, `/operations/config`

- Relies on `@commercetools/connect-payments-sdk` `SessionHeaderAuthenticationHook`
- Requires `x-session-id` header containing a valid commercetools session ID
- Session is created by the commercetools Checkout SDK and ties to a specific cart
- The session carries cart context (cartId, allowed payment methods, checkout transaction item ID)

### 2. Stripe Webhook Signature Verification
**Used by**: `POST /stripe/webhooks`

- Hook: `StripeHeaderAuthHook` (`libs/fastify/hooks/stripe-header-auth.hook.ts`)
- Validates presence of `stripe-signature` header
- Event is verified via `stripeApi().webhooks.constructEvent()` using `STRIPE_WEBHOOK_SIGNING_SECRET`
- **Raw body required**: route uses `config: { rawBody: true }` — Stripe signature verification requires the unparsed request body

### 3. JWT Authentication (Merchant Center)
**Used by**: `/operations/status`, `/operations/payment-components`

- Relies on `JWTAuthenticationHook` from CT payments SDK
- Token issued by merchant center via forward-to proxy
- Validated against `CTP_JWKS_URL` with issuer check against `CTP_JWT_ISSUER`
- For local dev, a JWT mock server is available via `docker compose up`

### 4. OAuth2 + Authorization
**Used by**: `POST /operations/payment-intents/:id`

- Two-step: `Oauth2AuthenticationHook` then `AuthorityAuthorizationHook`
- Requires CT OAuth2 token with `manage_project` or `manage_checkout_payment_intents` scope
- Used for payment modifications (capture, refund, cancel) initiated by CT Checkout

### 5. CORS Origin Validation
**Used by**: `POST /express-config`

- Hook: `corsAuthHook` (`libs/fastify/cors/cors.ts`)
- Validates `Origin` request header against `ALLOWED_ORIGINS` comma-separated list
- **No session required** — this endpoint serves Express Checkout buttons before a session exists
- Returns 403 if origin doesn't match

### 6. Public (No Auth)
**Used by**: `GET /applePayConfig`

- Returns the Apple Pay domain association file string
- Content comes from `STRIPE_APPLE_PAY_WELL_KNOWN` config value

## Secrets and Secured Configuration

### Secured Variables (encrypted in Connect)
These are stored in `securedConfiguration` in `connect.yaml` and are never exposed to the frontend:

| Variable | Contains |
|----------|----------|
| `CTP_CLIENT_SECRET` | commercetools API client secret |
| `CTP_CLIENT_ID` | commercetools API client ID |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_*`) — server-side only |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | Stripe webhook signing secret (`whsec_*`) |

### Frontend-Safe Variables
Only `STRIPE_PUBLISHABLE_KEY` is exposed to the frontend (via `/operations/config` and `/express-config`). This is by design — Stripe publishable keys are safe for client-side use.

## PCI Compliance Scope

### Enabler (Frontend)
- Uses `@stripe/stripe-js` (Stripe.js) which loads Stripe's hosted iframe
- **Never touches PAN data** — all card input is handled by Stripe's secure elements
- The enabler only orchestrates mount/submit/confirm lifecycle
- Payment method data stays within Stripe's iframe boundary

### Processor (Backend)
- Uses Stripe Node SDK with secret key for server-side operations
- Receives `paymentIntentId` and `clientSecret` — never raw card numbers
- Webhook payloads contain event objects, not raw PAN data
- Customer session creation uses Stripe's ephemeral key pattern

## CORS and Origin Security

### `/express-config` Endpoint
- The only endpoint that uses CORS-based auth instead of session
- `ALLOWED_ORIGINS` env var **must not be left empty** in production — when empty, CORS validation is disabled and any origin can call the endpoint
- Validates the `Origin` header against the allowlist
- Used to render Express Checkout buttons before a checkout session exists

### Other Endpoints
- Standard endpoints rely on session/JWT/OAuth2 — CORS is not the primary security mechanism for these

## Required CT API Client Scopes
```
manage_payments
manage_checkout_payment_intents
view_sessions
introspect_oauth_tokens
view_api_clients
manage_orders
manage_types
manage_payment_methods
manage_recurring_payment_jobs
```

## Custom Type Security
Custom types store non-sensitive integration data:
- `stripeConnector_stripeCustomerId` on CT customer — Stripe customer ID (not a secret, but links identity)
- Subscription fields on line items — subscription metadata
- Custom type keys are configurable to avoid conflicts with other connectors

## Webhook Security
- Webhook endpoint URL is automatically set during post-deploy via `updateWebhookEndpoint()`
- Only processes known event types (listed in `actions.ts`): `charge.succeeded`, `charge.updated`, `charge.refunded`, `payment_intent.succeeded`, `payment_intent.canceled`, `payment_intent.payment_failed`, `payment_intent.requires_action`
- Unknown event types are logged and ignored (not processed)
- Signature verification happens before any business logic

## Stripe Partner ID
The connector identifies itself to Stripe via `partner_id: 'pp_partner_c0mmercet00lsc0NNect'` in the Stripe client app info. This is set in `clients/stripe.client.ts`.
