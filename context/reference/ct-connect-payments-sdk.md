# Reference — CT Connect Payments SDK

Package: `@commercetools/connect-payments-sdk@0.27.2` (pinned in `processor/package.json`)

## What the SDK Provides

The CT Connect Payments SDK is the framework layer for commercetools Connect payment connectors. It handles:

- **Session management** — `SessionHeaderAuthenticationHook` validates the `x-session-id` header on frontend-facing endpoints
- **OAuth2 auth** — `OAuth2AuthenticationHook` validates JWT tokens on back-office endpoints (capture, cancel, refund)
- **CT API client** — Pre-configured `commercetools/platform-sdk` client with automatic token refresh
- **Payment service wrappers** — `CtPaymentService`, `CtCartService`, `CtCustomerService` with typed methods
- **Error classes** — `CommercetoolsError`, `StripeError` mapped to HTTP responses
- **Connect lifecycle hooks** — `post-deploy.js` / `pre-undeploy.js` runner for connector installation

## Auth Middleware Used in This Connector

| Route group | Middleware | Header |
|---|---|---|
| Frontend payment routes | `SessionHeaderAuthenticationHook` | `x-session-id` |
| CT Connect operations (capture/cancel/refund) | `OAuth2AuthenticationHook` | `Authorization: Bearer <jwt>` |
| `/express-config` | None (public CORS) | — |
| `/stripe/webhooks` | Stripe signature (`stripe-signature`) | — |

## Key Service Methods (as called by this connector)

The exact SDK signatures live in `node_modules/@commercetools/connect-payments-sdk/dist/...`. The shapes below describe how the connector invokes them; the SDK accepts a single options object on each call rather than positional arguments.

### CommercetoolsPaymentService

- `getPayment({ id })` → `Promise<Payment>`
- `createPayment(draft)` → `Promise<Payment>` (draft includes `amountPlanned`, `paymentMethodInfo`, `transactions`, optional `customer`/`anonymousId`)
- `updatePayment({ id, transaction?, paymentMethodInfo?, pspReference?, pspInteraction?, ... })` → `Promise<Payment>` (options object; the connector spreads converter output and passes a `transaction` per loop iteration)
- `hasTransactionInState({ payment, transactionType, states })` → `boolean` (used by `refundPayment`/`reversePayment`)

### CommercetoolsCartService

- `getCart({ id })` → `Promise<Cart>`
- `addPayment({ resource: { id, version }, paymentId })` → `Promise<Cart>`
- `getPaymentAmount({ cart })` → `Promise<{ centAmount, currencyCode }>`
- `isRecurringCart?(cart)` → optional, may be unavailable in older SDK versions; called with optional chaining

### CommercetoolsPaymentMethodService

- `getByTokenValue({ customerId, paymentInterface, tokenValue })` → `Promise<PaymentMethod | undefined>` (throws `ErrorResourceNotFound` when absent in some SDK versions; the connector catches it)
- `save({ customerId, paymentInterface, token, method })` → `Promise<PaymentMethod>`

### Customer access (no dedicated SDK service used)

The connector reads CT customers via the raw API client:

- `paymentSDK.ctAPI.client.customers().withId({ ID }).get().execute()`
- Updates go through `processor/src/services/commerce-tools/customerClient.ts` → `updateCustomerById({ id, version, actions })`

## Connect Lifecycle

```text
Deploy → connector:post-deploy   (processor/src/connectors/post-deploy.ts)
Undeploy → connector:pre-undeploy (processor/src/connectors/pre-undeploy.ts)
```

What `post-deploy` actually does today (`processor/src/connectors/post-deploy.ts` and `connectors/actions.ts`):

1. Calls `createLaunchpadPurchaseOrderNumberCustomType()` — only **logs** if the type already exists (no creation logic in the function as written).
2. If `STRIPE_WEBHOOK_ID` env var is set, retrieves the existing Stripe webhook endpoint and, if its URL differs from `${CONNECT_SERVICE_URL}stripe/webhooks`, calls `webhookEndpoints.update()` with the connector URL and the canonical `enabled_events` list (`charge.succeeded`, `charge.updated`, `payment_intent.succeeded`, `charge.refunded`, `payment_intent.canceled`, `payment_intent.payment_failed`, `payment_intent.requires_action`).
3. If `STRIPE_WEBHOOK_ID` is not set, prints a stderr message asking the operator to register the webhook manually in the Stripe dashboard. It does **not** call `webhookEndpoints.create()` or persist a signing secret to CT.
4. Calls `createOrUpdateCustomerCustomType()` to install the `payment-connector-stripe-customer-id` custom type (`stripeCustomerIdCustomType` in `custom-types.ts`).

`STRIPE_WEBHOOK_SIGNING_SECRET` must be supplied via environment configuration; it is not auto-provisioned.

## Optimistic Locking Pattern

CT API requires the current `version` on every update. The SDK does NOT retry on `409 ConcurrentModification` — the connector must handle this:

```typescript
const payment = await ctPaymentService.getPayment(id); // get fresh version
await ctPaymentService.updatePayment(payment, actions); // uses payment.version
```

## Official Docs

- CT Connect Payments SDK: https://github.com/commercetools/connect-payment-integration-adyen (reference implementation)
- CT Payments API: https://docs.commercetools.com/api/projects/payments
- CT API Extension: https://docs.commercetools.com/api/projects/api-extensions
