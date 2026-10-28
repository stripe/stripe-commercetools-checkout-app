# @stripe/stripe-js

## Version in use

`@stripe/stripe-js ^5.6.0`, `enabler/package.json:19`.

## What this unit uses it for

The enabler's whole UI: loading Stripe.js, creating the Payment Element and the Express Checkout Element, and confirming the PaymentIntent in the browser.

## Calls used

| Call | Where | Why |
| --- | --- | --- |
| `loadStripe(publishableKey)` | `enabler/src/payment-enabler/payment-enabler-mock.ts:256` | SDK instance |
| `stripe.elements({...})` | `enabler/src/payment-enabler/payment-enabler-mock.ts:278-298`; `enabler/src/express/dropin-express.ts:120-130` | deferred (`mode: 'payment'`, amount, currency) or `clientSecret` for `pi_first` |
| `elements.create('payment')` | `enabler/src/payment-enabler/payment-enabler-mock.ts:178` | Payment Element |
| `elements.create('expressCheckout')` | `enabler/src/express/dropin-express.ts:138` | Express Checkout Element |
| `elements.submit()` | `enabler/src/dropin/dropin-embedded.ts:86`; `enabler/src/express/dropin-express.ts:420` | validate before creating the PaymentIntent |
| `stripe.confirmPayment({ redirect: 'if_required' })` | `enabler/src/dropin/dropin-embedded.ts:156`; `enabler/src/express/dropin-express.ts:525` | confirm |
| `stripe.retrievePaymentIntent` | `enabler/src/dropin/dropin-embedded.ts:232` | bank-transfer rescue after a confirm error |
| `event.paymentFailed({ reason: 'fail' })` (Express `confirm` event) | `enabler/src/express/dropin-express.ts:475` | tell the wallet sheet a confirm failed |
| `elements.update({ amount })` | `enabler/src/express/dropin-express.ts:308`, `:337` | Express shipping changes |

## Constraints that affect this unit

- `clientSecret` and `setupFutureUsage` cannot be combined in elements options (`processor/src/services/stripe-payment.service.ts:1887-1889`), which is why `pi_first` drops `setup_future_usage`.
- Only `redirect: 'if_required'`; redirect methods return to `merchantReturnUrl`.

## What this unit deliberately does NOT use

Individual payment-method elements (card, IBAN): `createComponentBuilder` always throws. Hosted payment page (`hpp` drop-in is commented out).
