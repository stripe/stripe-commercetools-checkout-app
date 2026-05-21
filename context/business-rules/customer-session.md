# Business Rule: Customer Session & Saved Payment Methods

## Overview

To support saved payment methods, the connector manages a bidirectional mapping between CT customers and Stripe customers. The CT customer record is the source of truth for the customer identity; Stripe is the source of truth for the payment methods.

---

## Rule 1: Stripe customer ID is resolved with a 3-step fallback

**What:** When a customer session is requested, the service resolves the Stripe customer in this order:
1. Read saved ID from CT customer custom field (`CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY`)
2. If found, validate it still exists in Stripe (`customers.retrieve`), is not deleted, and that `metadata.ct_customer_id` matches the CT customer ID
3. If not found or invalid, search Stripe by `metadata.ct_customer_id` using `customers.search({ query: "metadata['ct_customer_id']:'<id>'" })` — the CT customer ID must be a valid UUID or the search is skipped
4. If still not found, create a new Stripe customer with email, name, phone, and address; `ct_customer_id` is stored in Stripe metadata. Email priority: `cart.customerEmail` → `customer.email` → `cart.shippingAddress?.email` → empty string

**Why:** CT customers can exist before any Stripe interaction. Stripe customers may be deleted externally. The search-by-metadata fallback recovers from edge cases where the custom field was lost. UUID validation before search prevents Stripe from receiving malformed queries.

**Invariant:** Never create a duplicate Stripe customer for the same CT customer. Always exhaust the lookup chain before creating.

**Implementation:** `stripe-payment.service.ts` → `retrieveOrCreateStripeCustomerId()`, `validateStripeCustomerId()`, `findStripeCustomer()`, `createStripeCustomer()`

**What breaks if violated:** Same CT customer accumulates multiple Stripe customer records, causing split payment method history and potential billing inconsistencies. Non-UUID CT customer IDs will silently skip the search and always create a new Stripe customer.

---

## Rule 2: Stripe customer ID is saved back to CT immediately after creation

**What:** After creating a new Stripe customer, the ID is saved to the CT customer's custom field via `saveStripeCustomerId()`.

**Why:** Without this, every subsequent session request would fail the lookup and create a new Stripe customer (violating Rule 1).

**Invariant:** `retrieveOrCreateStripeCustomerId()` always ends with a valid, persisted Stripe customer ID in CT.

**Implementation:** `stripe-payment.service.ts` → `saveStripeCustomerId()`

**What breaks if violated:** Duplicate Stripe customers are created on every session request for the same CT customer.

---

## Rule 3: Recurring carts always force `off_session` and `payment_method_save`

**What:** If the cart is identified as a recurring cart, `setup_future_usage` is forced to `off_session` regardless of the `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` config, and the customer session enables `payment_method_save`.

**Why:** Recurring carts (subscriptions) require a saved payment method that can be charged without the customer being present. This is non-negotiable for subscription billing.

**Invariant:** `off_session` cannot be overridden by config for recurring carts. The config override only applies to non-recurring carts.

**Implementation:** `stripe-payment.service.ts` → `getPaymentIntentSetupFutureUsage()`, `createSession()`

**What breaks if violated:** Subscriptions fail when attempting to charge the saved payment method, because Stripe was not told the method would be used off-session.

---

## Rule 4: Customer session requires a logged-in customer (cart.customerId)

**What:** `GET /customer/session` only proceeds if `cart.customerId` is present. If the cart has no customer (guest checkout), the session is skipped.

**Why:** Saved payment methods are tied to a customer identity. Guest checkouts have no identity to associate methods with.

**Invariant:** Never create a Stripe customer or session for a guest cart. Return without customer data; the Payment Element will operate without saved methods.

**Implementation:** `stripe-payment.service.ts` → `getCustomerSession()` — early return if no `customerId`.

**What breaks if violated:** Stripe customers are created for anonymous sessions, polluting the Stripe customer list with records that can never be reused.

---

## Rule 5: `setup_future_usage` follows a 3-tier priority system

**What:** `getPaymentIntentSetupFutureUsage()` resolves the value in this order:

1. **Recurring cart (highest priority):** if `isRecurringCart(cart)` returns true, forces `off_session` regardless of any config value
2. **Config override:** `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` env var, if set to a non-empty, non-null, non-`'none'` value
3. **Default:** the connector's default config value

String normalization: values of `''`, `'none'`, `'null'`, and `'undefined'` are treated as absent (no `setup_future_usage` set on the PI).

**Why:** Recurring carts must always produce `off_session` — this cannot be overridden by operators. The config override allows merchants to set a default for non-recurring flows. Normalization prevents silent breakage from misconfigured env vars.

**Invariant:** `off_session` for recurring carts is unconditional. The config override only applies when the cart is not recurring.

**Implementation:** `stripe-payment.service.ts` → `getPaymentIntentSetupFutureUsage()`

**What breaks if violated:** Subscriptions fail when attempting to charge the saved payment method off-session. Stripe rejects the charge with "This payment method was not set up for off-session use."

**Note — Express Checkout scope:** This rule applies to all checkout paths, including Express Checkout when a customer is known (`expressWithCustomer = true`). The `_SetupExpress` deferred path (no session at render time, no customer) produces no `setup_future_usage` regardless of this rule, because there is no customer to bind. See `payment-lifecycle.md` Rule 7 and ADR-005.

---

## Rule 6: Ephemeral keys are scoped to the Stripe API version in config

**What:** `ephemeralKeys.create()` uses the `STRIPE_API_VERSION` from config.

**Why:** Ephemeral keys are version-locked. A key created with one API version cannot be used with a different version in the mobile SDK.

**Invariant:** The API version used for ephemeral keys must match the version used by the mobile SDK client.

**Implementation:** `stripe-payment.service.ts` → `createEphemeralKey()`

**What breaks if violated:** Mobile SDK fails to use the ephemeral key, blocking saved payment method display on mobile.
