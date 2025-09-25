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

### Changed
- Updated webhook handling to use dedicated method for `charge.refunded` events
- Improved refund transaction updates with correct refund IDs and amounts
- Enhanced error handling and logging for refund processing
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
