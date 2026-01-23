# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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

### Changed
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
- **Refactored payment cancellation flow** - Streamlined the cancellation process by removing unnecessary payment updates
- **Updated test expectations** - Adjusted test cases to reflect simplified cancellation logic and proper amount handling
- **Webhook Configuration Updates** - Modified `actions.ts` to listen for `charge.updated` instead of `charge.captured`
- **Event Converter Enhancements** - Added `CHARGE__UPDATED` case in `StripeEventConverter` for partial capture transactions
- **Service Method Additions** - Implemented `processStripeEventMultipleCaptured` method for handling multicapture webhook events
- **Payment Intent Enhancements** - Added multicapture configuration to payment intent creation in `createPaymentIntentStripe` method

## [Previous Versions]

*Previous changelog entries would be documented here as the project evolves.*
