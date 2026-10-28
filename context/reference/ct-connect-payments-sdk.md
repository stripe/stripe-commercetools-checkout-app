# Reference — CT Connect Payments SDK (`@commercetools/connect-payments-sdk`)

## Version in use

`1.2.2`, pinned exactly at `processor/package.json:27`.

## What this unit uses it for

The CT Connect Payments SDK is the framework layer for commercetools Connect payment connectors.
The processor is built on it: request context and sessions, the authentication hooks, and the
commercetools cart, payment, order and payment-method services every flow calls.

- **Session management** — `sessionHeaderAuthHookFn` validates the `x-session-id` header on frontend-facing endpoints
- **Back-office auth** — `jwtAuthHookFn`, `oauth2AuthHookFn` and `authorityAuthorizationHookFn` on operations endpoints (capture, cancel, refund)
- **CT API client** — pre-configured `commercetools/platform-sdk` client with automatic token refresh
- **Payment service wrappers** — `CtPaymentService`, `CtCartService` with typed methods
- **Error classes** — `CommercetoolsError` and the SDK's `Errorx`, mapped to HTTP responses; this connector's own `StripeApiError` is built on `Errorx` (`processor/src/errors/stripe-api.error.ts:14-22`)

## Calls used

### Auth middleware used in this connector

| Route group | Hook | Header |
|---|---|---|
| Frontend payment routes | `sessionHeaderAuthHookFn` | `x-session-id` |
| CT Connect operations (capture/cancel/refund) | `oauth2AuthHookFn` (+ `authorityAuthorizationHookFn`) | `Authorization: Bearer <jwt>` |
| `/express-config` | None (public CORS) | — |
| `/stripe/webhooks` | Stripe signature (`stripe-signature`) | — |

Exact wiring: `/operations/payment-intents/:id` and `/operations/transactions` use the OAuth2 hook plus
the authorization hook (`manage_checkout_payment_intents`, `manage_checkout_transactions`;
`processor/src/routes/operation.route.ts:87-88`, `:122-123`); `/operations/status` and
`/operations/payment-components` use the JWT hook (`:54`, `:70`); `/operations/config` and the
storefront routes use the session hook (`:38`; `processor/src/routes/stripe-payment.route.ts:51,77,99,150,397`).
The Stripe signature pre-handler is the connector's own (`stripe-payment.route.ts:211`).

| Call | Where | Why |
| --- | --- | --- |
| `setupPaymentSDK` | `processor/src/payment-sdk.ts:23` | SDK instance |
| `sessionHeaderAuthHookFn`, `jwtAuthHookFn`, `oauth2AuthHookFn`, `authorityAuthorizationHookFn` | `processor/src/server/plugins/operation.plugin.ts:10-13`; `processor/src/server/plugins/stripe-payment.plugin.ts:27` | route authentication |
| `ctCartService.getCart` / `getPaymentAmount` / `addPayment` | `processor/src/services/stripe-payment.service.ts:755,777,936` | cart and amount |
| `ctPaymentService.createPayment` / `updatePayment` / `getPayment` / `hasTransactionInState` | `processor/src/services/stripe-payment.service.ts:900,1658,1555,2139` | Payment and transactions |
| `ctOrderService.getOrderByPaymentId` | `processor/src/services/stripe-payment.service.ts:2418` | order for state reflection |
| `ctPaymentMethodService.get` / `getByTokenValue` / `save` | `processor/src/services/stripe-payment.service.ts:3557,3731,3755` | saved methods |
| `ctRecurringPaymentJobService` | `processor/src/server/app.ts:9-11` | optional; stubbed when the SDK lacks it |
| `ctAPI.client` (raw) | `processor/src/services/stripe-payment.service.ts:2572,3478` | `changePaymentState`, payment by key |

### Key service methods (as called by this connector)

The exact SDK signatures live in `node_modules/@commercetools/connect-payments-sdk/dist/...`. The shapes below describe how the connector invokes them; the SDK accepts a single options object on each call rather than positional arguments.

#### CommercetoolsPaymentService

- `getPayment({ id })` → `Promise<Payment>`
- `createPayment(draft)` → `Promise<Payment>` (draft includes `amountPlanned`, `paymentMethodInfo`, `transactions`, optional `customer`/`anonymousId`, and `key: pi-create-{cartId}-{cartVersion}`, whose `DuplicateField` is the concurrent-create mutex — `processor/src/services/stripe-payment.service.ts:897-934`)
- `updatePayment({ id, transaction?, paymentMethodInfo?, pspReference?, pspInteractions?, ... })` → `Promise<Payment>` (options object; the connector spreads converter output and passes a `transaction` per loop iteration)
- `hasTransactionInState({ payment, transactionType, states })` → `boolean` (used by `refundPayment`/`reversePayment`)

#### CommercetoolsCartService

- `getCart({ id })` → `Promise<Cart>`
- `addPayment({ resource: { id, version }, paymentId })` → `Promise<Cart>`
- `getPaymentAmount({ cart })` → `Promise<{ centAmount, currencyCode }>`
- `isRecurringCart?(cart)` → optional, may be unavailable in older SDK versions; called with optional chaining

#### CommercetoolsPaymentMethodService

- `getByTokenValue({ customerId, paymentInterface, tokenValue })` → `Promise<PaymentMethod | undefined>` (throws `ErrorResourceNotFound` when absent in some SDK versions; the connector catches it)
- `save({ customerId, paymentInterface, token, method })` → `Promise<PaymentMethod>`

#### Customer access (no dedicated SDK service used)

The connector reads CT customers via the raw API client:

- `paymentSDK.ctAPI.client.customers().withId({ ID }).get().execute()`
- Updates go through `processor/src/services/commerce-tools/customerClient.ts` → `updateCustomerById({ id, version, actions })`

## Constraints that affect this unit

### Optimistic Locking Pattern

CT API requires the current `version` on every update. `ctPaymentService.updatePayment` handles a
`409` itself: on each attempt it re-reads the Payment, rebuilds the actions against the fresh
version, and retries a `409` up to 3 attempts in all with exponential backoff (100 ms base, jitter,
2 s cap), then rethrows. Writes outside the SDK services get no such retry: the raw-client order
write (`processor/src/services/stripe-payment.service.ts:2572-2581`) is retried once by the
connector itself (`:2530-2557`).

- The SDK wraps a raw commercetools error in its own `Errorx` shape (`httpErrorStatus`, `fields`,
  `cause`), so duplicate-key detection matches the wrapped, the raw and the `cause` shapes
  (`processor/src/services/stripe-payment.service.ts:3491-3513`).
- No cart-freeze capability is exposed (`processor/src/routes/stripe-payment.route.ts:299-301`).

### Connect lifecycle

```text
Deploy → connector:post-deploy   (processor/src/connectors/post-deploy.ts)
Undeploy → connector:pre-undeploy (processor/src/connectors/pre-undeploy.ts)
```

`STRIPE_WEBHOOK_SIGNING_SECRET` must be supplied via environment configuration; it is not
auto-provisioned.

## What this unit deliberately does NOT use

The SDK for the order-subscriber: that app uses `@commercetools/platform-sdk` directly
(`order-subscriber/package.json:21`). No SDK order write: the order service exposes only
`getOrderByPaymentId`, and `paymentState` is written through the raw client
(`processor/src/services/stripe-payment.service.ts:2245-2251`, `:2572-2581`).

## Official Docs

- CT Connect Payments SDK: https://github.com/commercetools/connect-payment-integration-adyen (reference implementation)
- CT Payments API: https://docs.commercetools.com/api/projects/payments
- CT API Extension: https://docs.commercetools.com/api/projects/api-extensions
