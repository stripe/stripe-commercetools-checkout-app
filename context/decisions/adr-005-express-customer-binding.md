# ADR-005 — Express Checkout Customer Binding When Session Is Available at Render Time

**Status:** Accepted  
**Date:** 2026-05-20

## Context

Express Checkout (Apple Pay / Google Pay) has two initialization paths:

- **`_SetupExpress` (deferred):** No CT session at render time. Stripe Elements is created lazily inside `init()`, without `customerOptions` or `setupFutureUsage`. The PI is created one-shot with no customer binding.
- **`_Setup` (upfront):** A CT session and cart are available before the buttons render. Stripe Elements is created in `getElements()` with `customerOptions`, `setupFutureUsage`, and `customerSessionClientSecret` — identical to the standard embedded checkout initialization.

The original implementation blocked `customer` and `setup_future_usage` on the PI unconditionally whenever `x-express-checkout: true` was set, with the comment: _"no customer/setup_future_usage so the PI matches frontend Elements (created without them)."_

This comment was accurate for `_SetupExpress` but incorrect for `_Setup`: in the `_Setup` path, Elements already carries `setupFutureUsage`. The block created an inconsistency — Elements signaled the save intent to Stripe, but the PI did not — causing Stripe to reject the `confirmPayment` call with a `setup_future_usage` mismatch error.

A naive fix of conditioning solely on `stripeCustomerId` on the processor side was rejected: it activates for any express checkout where the CT customer happened to have a `stripeCustomerId` from a previous checkout, including `_SetupExpress` flows where Elements was created without `setupFutureUsage`. This introduced the opposite mismatch (PI has `off_session`, Elements has `null`).

## Decision

The enabler signals to the processor whether Elements was initialized with customer data by sending an `x-express-customer-session: true` header in `GET /payments`. This header is only sent when `this.baseOptions.stripeCustomerId` is set — which happens exclusively in the `_Setup` path where `GET /customer/session` resolved a Stripe customer.

**Enabler** (`dropin-express.ts` → `getHeadersConfig()`):

```ts
if (this.baseOptions.stripeCustomerId) {
  headers['x-express-customer-session'] = 'true';
}
```

**Processor route** (`stripe-payment.route.ts`):

```ts
const isExpressCustomerSession =
  request.headers['x-express-customer-session'] === 'true';
const resp = await opts.paymentService.createPaymentIntentStripe(isExpressCheckout, isExpressCustomerSession);
```

**Processor service** (`stripe-payment.service.ts` → `createPaymentIntentStripe()`):

```ts
const expressWithCustomer = expressCheckout && Boolean(stripeCustomerId) && expressCustomerSession;
```

The PI condition in `buildPaymentIntentCreateParams()`:

```ts
// before
...(!expressCheckout && stripeCustomerId && { customer, setup_future_usage })
// after
...((!expressCheckout || expressWithCustomer) && stripeCustomerId && { customer, setup_future_usage })
```

**CORS** (`server.ts`): `x-express-customer-session` added to `allowedHeaders`.

The `_SetupExpress` path never sets `baseOptions.stripeCustomerId`, so it never sends the header, and `expressWithCustomer` remains `false`. Behavior for that path is unchanged.

## Alternatives Considered

| Alternative | Why discarded |
|---|---|
| Block `setup_future_usage` on all Express paths | Breaks saved payment methods for merchants who provide a session at render time; Elements and PI stay inconsistent |
| Condition solely on `stripeCustomerId` in processor | Activates for `_SetupExpress` when CT customer has a prior `stripeCustomerId`, causing the opposite mismatch (PI has `off_session`, Elements has `null`) |
| Always resolve customer in `_SetupExpress` | Requires `GET /customer/session` at button render time, not possible without a session |
| Separate endpoint for Express-with-customer | Duplicates PI creation logic; a flag and header in the existing flow is sufficient |

## Consequences

**Positive:**

- Express Checkout with `_Setup` path now correctly binds `customer` and `setup_future_usage` on the PI, consistent with Elements
- `_SetupExpress` path is completely unaffected — no behavior change for deferred flows
- Standard embedded checkout is unaffected
- `off_session` for recurring carts (Rule 3, `customer-session.md`) applies to Express-with-customer as well

**Negative:**

- The enabler now sends an additional header on `GET /payments` in the `_Setup` path; CORS allowedHeaders must include it
- The condition in `buildPaymentIntentCreateParams()` is slightly more complex

**Risks:**

- Stripe API behavior for `setup_future_usage=off_session` combined with `automatic_payment_methods: { enabled: true }` and wallet payment methods should be verified against Stripe documentation — if any automatically enabled method does not support off-session reuse, Stripe may return an error at PI creation
- KI-008 still applies: if `getCtCustomer()` silently fails, `stripeCustomerId` is absent, `expressWithCustomer` is `false`, and the method is not saved, with no error surfaced to the caller
