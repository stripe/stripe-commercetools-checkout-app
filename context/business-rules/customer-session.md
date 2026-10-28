# Customer Session & Saved Payment Methods

How the connector maps commercetools customers to Stripe customers for saved payment methods, and how
it decides `setup_future_usage`. The CT customer record is the source of truth for the customer
identity; Stripe is the source of truth for the payment methods.

---

## Rule 1: Stripe customer ID is resolved with a 3-step fallback

**What:** When a customer session is requested, the service resolves the Stripe customer in this order:
1. Read saved ID from CT customer custom field (`CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY`)
2. If found, validate it still exists in Stripe (`customers.retrieve`), is not deleted, and that `metadata.ct_customer_id` matches the CT customer ID
3. If not found or invalid, search Stripe by `metadata.ct_customer_id` using `customers.search({ query: "metadata['ct_customer_id']:'<id>'" })` — the CT customer ID must be a valid UUID or the search is skipped
4. If still not found, create a new Stripe customer with email, name, phone, and address; `ct_customer_id` is stored in Stripe metadata. Email priority: `cart.customerEmail` → `customer.email` → `cart.shippingAddress?.email` → `undefined` (there is no empty-string fallback — `const email = cart.customerEmail || customer.email || cart.shippingAddress?.email` at `stripe-payment.service.ts:2907`; if all three are absent, `email` is left `undefined`)

**Why:** CT customers can exist before any Stripe interaction. Stripe customers may be deleted externally. The search-by-metadata fallback recovers from edge cases where the custom field was lost. UUID validation before search prevents Stripe from receiving malformed queries.

**Implementation:** `processor/src/services/stripe-payment.service.ts` → `retrieveOrCreateStripeCustomerId()` (`:2852-2877`), `validateStripeCustomerId()` (`:2879-2887`), `findStripeCustomer()` (`:2889-2903`, UUID check `:2891-2894` via `processor/src/utils.ts:18-21`), `createStripeCustomer()` (`:2905-2917`)

---

## Rule 2: Stripe customer ID is saved back to CT immediately after creation

**What:** After creating a new Stripe customer, the ID is saved to the CT customer's custom field via `saveStripeCustomerId()`. The same happens when the ID was recovered through the metadata search.

**Invariant:** `retrieveOrCreateStripeCustomerId()` always ends with a valid, persisted Stripe customer ID in CT.

**Implementation:** `processor/src/services/stripe-payment.service.ts:2919-2936` → `saveStripeCustomerId()`; called after a search hit (`:2864`) and after creation (`:2871`). A failed save propagates (no catch), so the session request fails rather than returning an unpersisted ID.

---

## Rule 3: Recurring carts force `off_session` and `payment_method_save`

**What:** If the cart is identified as a recurring cart, `setup_future_usage` is forced to `off_session` regardless of the `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` config, and the customer session enables `payment_method_save` (with `payment_method_save_usage: off_session`).

**Why:** Recurring carts (subscriptions) require a saved payment method that can be charged without the customer being present. This is non-negotiable for subscription billing.

**Implementation:** `processor/src/services/stripe-payment.service.ts` → `getPaymentIntentSetupFutureUsage()` (recurring branch `:682-687`), `createSession()` (`:2938-2957`, recurring features `:2947-2950`)

---

## Rule 4: Customer session requires a logged-in customer (cart.customerId)

**What:** `GET /customer/session` only proceeds if `cart.customerId` is present. If the cart has no customer (guest checkout), the session is skipped.

**Why:** Saved payment methods are tied to a customer identity. Guest checkouts have no identity to associate methods with.

**Invariant:** Never create a Stripe customer or session for a guest cart. Return without customer data; the Payment Element will operate without saved methods.

**Implementation:** `processor/src/services/stripe-payment.service.ts:624-662` → `getCustomerSession()` — early return if no `customerId` (`:627-631`); the route answers 204 for an empty result (`processor/src/routes/stripe-payment.route.ts:59-65`).

---

## Rule 5: `setup_future_usage` follows a precedence order

**What:** `getPaymentIntentSetupFutureUsage()` resolves the value in this order:

1. **Recurring cart (highest priority):** if `isRecurringCart(cart)` returns true, `getPaymentIntentSetupFutureUsage` returns `off_session`, taking precedence over the config override below
2. **Config override:** the market rule's `setupFutureUsage` if the cart matched a `STRIPE_PAYMENT_BEHAVIOR_RULES` rule that sets it, otherwise the `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` env var, if set to a non-empty, non-null, non-`'none'` value
3. **Default:** the connector's default config value

String normalization: values of `''`, `'none'`, `'null'`, and `'undefined'` are treated as absent (no `setup_future_usage` set on the PI).

**Why:** The config override allows merchants to set a default for non-recurring flows.

**Invariant:** `getPaymentIntentSetupFutureUsage` returns `'off_session'` whenever `isRecurringCart(cart)` is true. The config override only applies when the cart is not recurring.

**Implementation:** `processor/src/services/stripe-payment.service.ts:676-742` → `getPaymentIntentSetupFutureUsage()`; called from `createPaymentIntentStripe` (`:780`) and `initializeCartPayment` (`:1890-1893`).

**Note — Express Checkout scope:** This rule applies to all checkout paths, including Express Checkout when a customer is known (`expressWithCustomer = true`). The `_SetupExpress` deferred path (no session at render time, no customer) produces no `setup_future_usage` regardless of this rule, because there is no customer to bind. See `payment-lifecycle.md` Rule 7.

---

## Rule 6: Ephemeral keys are scoped to the Stripe API version in config

**What:** `ephemeralKeys.create()` uses the `STRIPE_API_VERSION` from config.

**Why:** Ephemeral keys are version-locked. A key created with one API version cannot be used with a different version in the mobile SDK.

**Invariant:** The API version used for ephemeral keys must match the version used by the mobile SDK client.

**Implementation:** `processor/src/services/stripe-payment.service.ts:2959-2967` → `createEphemeralKey()`; `processor/src/config/config.ts:259` (default `2025-12-15.clover`).

---

## Rule 7: The `pi_first` flow never sends `setup_future_usage`

**What:** when the effective flow type is `pi_first`, `setup_future_usage` is removed from the
PaymentIntent and from the element configuration.

**Why:** the PaymentIntent must accept binding methods such as Blik, and Stripe rejects `clientSecret`
together with `setupFutureUsage` in elements (`processor/src/services/stripe-payment.service.ts:1354-1358`,
`:1887-1889`). Merchants who need saved cards should use the deferred flow.

**Invariant:** `applyPiFirstOverride` returns `undefined` for `pi_first`, and `initializeCartPayment`
returns `setupFutureUsage: undefined` for `pi_first`.

**Implementation:** `processor/src/services/stripe-payment.service.ts:781-782` (applied on create),
`:1359-1364` → `applyPiFirstOverride()`, `:1890-1893` (element configuration).
