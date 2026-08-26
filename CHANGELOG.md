# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Order.paymentState` is now written (new `order-subscriber` application)**: commercetools never derives `Order.paymentState` from a Payment's transactions, and commercetools Checkout creates the order without it — so orders previously stayed stateless and operations could not distinguish a paid order from an abandoned one. A third `deployAs` application (`applicationType: event`) subscribes to the commercetools `OrderCreated` message, reads the order's payments **fresh**, and records what is true at that moment: `Paid` when a `Charge/Success` is present, `Pending` when an `Authorization/Pending` is present with no charge, and **nothing** otherwise (a card authorized but not captured under `STRIPE_CAPTURE_METHOD=manual` is deliberately left to the merchant process). `Paid` outranks `Pending`, which matters for a retried checkout: an abandoned bank transfer leaves its pending authorization on the order forever, so ranking the other way would freeze a subsequently-paid order as pending. The subscriber only ever writes onto an **unset** field, so it never overwrites a state another writer produced. The webhook path also reflects terminal outcomes onto the order when the connector owns it. Requires the `manage_orders` scope, already present. More information in [`context/business-rules/order-payment-state.md`](./context/business-rules/order-payment-state.md) and [ADR-009](./context/decisions/adr-009-order-payment-state-reflection.md).
- **Bank transfer (`customer_balance`) support**: EU bank transfer through the Payment Element. `payment_intent.requires_action` with `display_bank_transfer_instructions` books an `Authorization: Pending` transaction — a bank transfer awaiting a wire is not a failure — and settles to `Success` on `payment_intent.succeeded`. `payment_intent.partially_funded` is deliberately a no-op: the order already says pending and a partial deposit adds no transaction. **Requires** a customer on the PaymentIntent and `setup_future_usage` **absent** — Stripe removes `customer_balance` from `payment_method_types` when the method cannot be saved. Subscription carts set `setup_future_usage`, so those markets need `flowType: pi_first` in `STRIPE_PAYMENT_BEHAVIOR_RULES` to strip it. Adds `euBankTransferCountry` (`DE`|`FR`|`IE`|`NL`) as a fifth behaviour-rule field, validated at startup so an invalid value aborts the deploy rather than reaching Stripe — it chooses **which** of the merchant's IBANs a EUR shopper sees, and is not an enable flag: unset, Stripe derives the variant from the currency and defaults to an Irish IBAN. The `pspInteraction` payload is now redacted before it is persisted (live `client_secret`, the merchant's IBAN, and unauthenticated hosted links are kept out of an append-only commercetools record) — see [`webhook-handling.md`](./context/business-rules/webhook-handling.md) Rule 9.

- **Stablecoin / Crypto Payments (async settlement)**: Support for Stripe crypto/stablecoin (e.g. USDC) through the Payment Element. Adds handling for the `payment_intent.processing` status — modeled as an `Authorization: Pending` transaction and finalized to `Success` on `payment_intent.succeeded`. The synchronous `/confirmPayments` gate now returns a `PaymentModificationStatus` (`PENDING` → HTTP 202) for in-flight settlement without creating an order, and the enabler branches on the outcome to avoid premature fulfillment. `payment_intent.requires_action` was made an explicit no-op here — **superseded by the bank transfer entry above**, which routes it to an `Authorization: Pending` when it carries `display_bank_transfer_instructions`. **Prerequisite:** crypto must be enabled on the Stripe account, with automatic capture and saved payment methods **not** forced to `off_session` (`STRIPE_SAVED_PAYMENT_METHODS_CONFIG`) — otherwise Stripe filters non-savable methods and crypto does not appear in the Payment Element. More information in [Crypto / Stablecoin Payments](./processor/README.md#crypto--stablecoin-payments-async-settlement).
- **Express Checkout `_Setup` path — customer binding**: When Express Checkout is initialized with a CT session at render time (`_Setup` path), the enabler now sends `x-express-customer-session: true` on `GET /payments`. The processor uses this header to bind `customer` and `setup_future_usage` on the PaymentIntent, matching the Stripe Elements instance created with `customerOptions` and `setupFutureUsage`. The `_SetupExpress` (deferred) path is unaffected — PaymentIntents on that path remain one-shot with no customer binding.
- Enhanced refund processing with support for multiple refunded events
- New `processStripeEventRefunded` method in StripePaymentService for dedicated refund event handling
- Improved refund data accuracy by retrieving latest refund information from Stripe API
- Comprehensive test coverage for refund processing scenarios
- New `populateAmountCanceled` method in StripeEventConverter for improved amount handling in canceled payment events
- **Multicapture Support**: Comprehensive support for multiple partial captures on the same payment intent
- New `processStripeEventMultipleCaptured` method for handling `charge.updated` webhook events
- Enhanced `capturePayment` method with partial capture logic and `final_capture` parameter support
- Balance transaction tracking for accurate multicapture amount calculations
- New `STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE` environment variable to override setup_future_usage independently from Customer Session configuration
- **Stripe Tax Calculation Integration**: Support for automatic tax calculations on payment intents via cart custom field `connectorStripeTax_calculationReferences`
- **Configurable Custom Type Keys**: New environment variables for customizing commercetools type keys:
  - `CT_CUSTOM_TYPE_LAUNCHPAD_PURCHASE_ORDER_KEY`: Custom type key for launchpad purchase order number
  - `CT_CUSTOM_TYPE_STRIPE_CUSTOMER_KEY`: Custom type key for Stripe customer ID storage
  - `CT_CUSTOM_TYPE_SUBSCRIPTION_LINE_ITEM_KEY`: Custom type key for subscription line items
  - `CT_PRODUCT_TYPE_SUBSCRIPTION_KEY`: Product type key for subscription information
- **ALLOWED_ORIGINS** environment variable for CORS validation on POST /express-config; must not be left empty or unset for security (when empty, CORS validation is disabled and any origin can call the endpoint)
- **Stripe Express Checkout**: Enabler exposes Express Checkout API (`PaymentExpressBuilder`, `ExpressComponent`, `ExpressOptions`), `DefaultExpressComponent` and `StripeExpressComponent` (Stripe ExpressCheckoutElement), shipping address/method callbacks and `onPayButtonClick` session flow (session obtained when user opens an Express wallet; mount only renders the button). Processor supports `x-express-checkout` header on `GET /payments` (called when user confirms) to create PaymentIntent without shipping for Express Checkout Element; `SupportedExpressPaymentData` and `express` array in payment components schema; `createPaymentIntentStripe(expressCheckout)` omits shipping when true.
- **Express Checkout `initialAmount` validation**: `StripeExpressBuilder.build()` now validates that `initialAmount.centAmount` (number) and `initialAmount.currencyCode` (string) are present and throws a descriptive error if either is missing, aligning with the commercetools Checkout Express SDK contract.
- **`STRIPE_EXPRESS_ELEMENT_OPTIONS`**: New optional environment variable to configure the Express Checkout Element. Accepts a stringified JSON with any of the following Stripe-supported fields: `buttonHeight`, `buttonTheme`, `buttonType`, `emailRequired`, `layout`, `paymentMethodOrder`, `phoneNumberRequired`. Fields not included are left to Stripe's defaults. Other fields are silently discarded to prevent unintended overrides of connector-managed options (`shippingAddressRequired`, `billingAddressRequired`).

### Fixed

- **A refund Stripe later rejected stayed recorded as successful forever**: `charge.refunded` reports only that a Refund was **created**, which on a delayed rail is not the same as succeeded — a bank transfer refund is created `pending` and resolves minutes to days later. `refund.updated` and `refund.failed` are now registered and write a `Refund: Failure` transaction, but **only** when the refund's status is `failed` or `canceled`; a success produces no second write, because acting on it too would book the same refund twice. The handler reads `ct_payment_id` from the refund's own metadata, since a Refund payload carries it nowhere else — so a refund issued from the Stripe Dashboard, which has no stamp, is not correctable this way. Also registers `customer_cash_balance_transaction.created` for observability: `funding_reversed` and `adjusted_for_overdraft` log at **error** level and are the only signal that money left the customer's cash balance after a payment was credited, with no commercetools update. More information in [`context/business-rules/refunds-reversals.md`](./context/business-rules/refunds-reversals.md) Rule 6 and [`webhook-handling.md`](./context/business-rules/webhook-handling.md) Rule 7.
- **Payment method was empty while an asynchronous payment was pending**: `StripeEventConverter` populated `paymentMethodInfo.method` only from a Charge (`payment_method_details.type`), so every `payment_intent.*` event left it unset — and for an asynchronous rail the settling Charge arrives days later, or never if the shopper abandons the transfer. A bank transfer therefore showed **no** payment method in commercetools for the entire time it mattered. The processor now resolves the type from the PaymentIntent's `payment_method` and passes it to the converter, generically for every rail rather than for bank transfer alone. The lookup lives in the service so the converter stays a pure function of the payload; it never throws (a cosmetic lookup must not fail a webhook handler that returns non-2xx on error) and leaves the field **unset** rather than empty when unresolved, so a failed lookup cannot erase a method the Charge branch already wrote.
- **A dismissed bank transfer instruction sheet is no longer reported as a failed payment**: closing Stripe's instruction modal surfaces as an error from `confirmPayment`, which put the shopper on a "Payment Failed" screen while the PaymentIntent was alive and awaiting a wire. The enabler now re-reads the PaymentIntent on that error path and, **only** when it is a bank transfer awaiting funds, continues instead of throwing. Every other `requires_action` — card 3DS, Boleto, redirect-based methods — still raises an error, because for those the shopper genuinely completed nothing. Note the host may still render a non-success screen: `PaymentResult` cannot express "pending" (see `context/known-issues.md` KI-027).

### Changed
- **Express Checkout (enabler)**: `onPayButtonClick` runs on **every** Express wallet `click` so `x-session-id` matches the current commercetools checkout session for the cart; cancel resets internal session state for the next open. **`clearExpressSession` removed** from `ExpressComponent` so the contract stays limited to **`mount`**, consistent with commercetools Checkout express expectations (session via callbacks, not extra enabler-only APIs).
- **Breaking — Express Checkout cancel contract**: `onCancel` has been removed from `ExpressOptions`. Cancellation is now signalled via the enabler-level `onError` callback with an error whose `name` is `'CANCEL'`, aligning with the commercetools Connect standard (same pattern as Adyen). Integrators that relied on `onCancel` must handle `onError` and check `error.name === 'CANCEL'` to revert shipping changes or reset checkout state.
- **Express Checkout — deferred Stripe Elements creation**: Stripe Elements is no longer created during the setup phase with a placeholder amount. Instead, `init()` creates (cart-only flow) or updates (session flow) the Elements instance using the integrator's real `initialAmount`. This removes the need for any default amount or environment variable and ensures the correct currency and amount are used from the start.
- **Documentation**: Express Checkout docs (enabler README—including session/cancel flow, `initialAmount` requirement, deferred Elements creation, and `ExpressComponent` surface—processor `GET /payments` session note, JSDoc, changelog) updated for **commercetools Checkout Express** integration (`GET /express-payment-data`, `POST /express-config`). Framing uses commercetools Checkout / Connect only; removed wording that implied copying another PSP template or comparing to other PSPs.
- Updated webhook handling to use dedicated method for `charge.refunded` events
- Improved refund transaction updates with correct refund IDs and amounts
- Enhanced error handling and logging for refund processing
- **Updated dependencies** to latest versions:
  - `stripe` to ^20.1.0 (with default API version `2025-12-15.clover`)
  - `@commercetools/connect-payments-sdk` to 0.24.0
  - `fastify` to 5.6.1
  - `@stripe/stripe-js` to ^5.6.0
  - `typescript` to 5.9.2
  - `jest` to 30.x
- **Simplified payment cancellation logic** - Removed redundant `updatePayment` call during payment cancellation in StripePaymentService
- **Enhanced event amount handling** - Updated canceled payment events to use proper amount values instead of zero
- **Improved API response handling** - Payment cancellation now returns Stripe API response ID instead of payment intent ID
- **Webhook Event Migration** - Replaced `charge.captured` with `charge.updated` webhook event for better multicapture support
- **Payment Intent Configuration** - Added `request_multicapture: 'if_available'` to payment method options for multicapture enablement
- **Event Processing Logic** - Enhanced `processStripeEvent` method with multicapture detection and balance transaction tracking

### Technical Details
- Modified `stripe-payment.route.ts` to route `charge.refunded` events to dedicated processing method
- Updated `stripe-payment.service.ts` with new `processStripeEventRefunded` method
- Enhanced test coverage in `stripe-payment.service.spec.ts` and `stripe-payment.spec.ts`
- Updated `.gitignore` to include context documentation and generated files
- Refactored `createPaymentIntentStripe()` into smaller private helpers (`resolveTaxCalculationContext`, `buildCreatePaymentParams`, `buildPaymentIntentResponse`) to bring its Cognitive Complexity back under the linter threshold; no behavior change
- **Refactored payment cancellation flow** - Streamlined the cancellation process by removing unnecessary payment updates
- **Updated test expectations** - Adjusted test cases to reflect simplified cancellation logic and proper amount handling
- **Webhook Configuration Updates** - Modified `actions.ts` to listen for `charge.updated` instead of `charge.captured`
- **Event Converter Enhancements** - Added `CHARGE__UPDATED` case in `StripeEventConverter` for partial capture transactions
- **Service Method Additions** - Implemented `processStripeEventMultipleCaptured` method for handling multicapture webhook events
- **Payment Intent Enhancements** - Added multicapture configuration to payment intent creation in `createPaymentIntentStripe` method
- **Async settlement (crypto/stablecoin)** - Added `PAYMENT_INTENT__PROCESSING` to the `StripeEvent` enum and a `StripeEventConverter` case emitting `Authorization: Pending` (amount from `data.amount`); mapped `payment_intent.requires_action` to a no-op (`[]`) — **since superseded by bank transfer, which gives that event an explicit converter case gated at the route**. Subscribed `payment_intent.processing` in `actions.ts` and routed it in `stripe-payment.route.ts`. In `processStripeEvent`, added a `hasTransactionInState` dedup guard, scoped the error-swallow so `processing` re-throws (Stripe retries), and added the `Authorization: Pending → Success` transition on `payment_intent.succeeded`. `updatePaymentIntentStripeSuccessful` now returns a `PaymentModificationStatus` (`PENDING` → HTTP 202 for `processing`, writing only `Authorization: Pending`, never an order); `PENDING` added to the enum and the `/confirmPayments` response schema; internal error detail no longer leaked to the browser. Enabler `dropin-embedded.ts` `confirmPaymentIntent` branches on the response outcome to avoid premature fulfillment.

### Security

- Resolved all high-severity npm advisories reported by `npm audit` in both `processor` and `enabler`:
  - `@fastify/static` bumped `^9.1.3` → `^10.1.2` (path-traversal / authorization-bypass advisories; unused direct dependency, compatible with Fastify 5).
  - Transitive advisory fixes via lockfile: `fast-uri`, `find-my-way` (processor); `brace-expansion`, `fast-uri`, `immutable`, `postcss` (enabler).
  - No source changes; `npm audit` reports 0 vulnerabilities in both modules after the update.

## [Previous Versions]

*Previous changelog entries would be documented here as the project evolves.*
