# Stripe Customer Session

**Trigger:** `GET /customer/session` from the enabler during `_Setup` (drop-in, and Express with a session).
**Modules involved:** enabler, processor.
**Outcome:** for a logged-in commercetools customer, a Stripe customer id stored on the customer, an ephemeral key and a customer session for the Payment Element (`{ stripeCustomerId, ephemeralKey, sessionId }`); 204 for an anonymous cart.

## Happy Path

1. Enabler calls `GET /customer/session` with `X-Session-Id` — `enabler/src/payment-enabler/payment-enabler-mock.ts:433-444`
2. Route calls `getCustomerSession`; `undefined` → 204, otherwise 200 — `processor/src/routes/stripe-payment.route.ts:47-67`
3. Load the session cart; no `customerId` → `undefined` (204) — `processor/src/services/stripe-payment.service.ts:626-631`
4. Load the commercetools customer; not found → `undefined` (204) — `processor/src/services/stripe-payment.service.ts:633-637,2969-2980`
5. `retrieveOrCreateStripeCustomerId`: validate the saved id (exists, not deleted, `metadata.ct_customer_id` matches), else search Stripe by `metadata['ct_customer_id']` (UUID-checked), else `customers.create` — `processor/src/services/stripe-payment.service.ts:2852-2917`
6. Store a found or created id in the customer's custom field — `processor/src/services/stripe-payment.service.ts:2864,2871,2919-2936`
7. `ephemeralKeys.create` (passes `STRIPE_API_VERSION`) — `processor/src/services/stripe-payment.service.ts:644-647,2959-2967`
8. `customerSessions.create` with the Payment Element features from `STRIPE_SAVED_PAYMENT_METHODS_CONFIG`; a recurring cart forces `payment_method_save: enabled` and `payment_method_save_usage: off_session` — `processor/src/services/stripe-payment.service.ts:649-652,2938-2957`
9. Returns `{ stripeCustomerId, ephemeralKey, sessionId: session.client_secret }`; the enabler passes them to Elements as `customerOptions` and `customerSessionClientSecret` — `processor/src/services/stripe-payment.service.ts:654-658`; `enabler/src/payment-enabler/payment-enabler-mock.ts:288-295`

## Notes

- The customer custom type is created by post-deploy (`deploy-connector.md`).
- Business rules: `business-rules/customer-session.md`.
