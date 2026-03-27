# Payment Integration Enabler
This module provides an application based on [commercetools Connect](https://docs.commercetools.com/connect), which acts a wrapper implementation to cover frontend components provided by Payment Service Providers (PSPs)

PSPs provide libraries that can be used on client side to load on browser or other user agent which securely load DOM elements for payment methods and/or payment fields inputs. These libraries take control on saving PAN data of customer and reduce PCI scopes of the seller implementation. Now, with the usage of `enabler`, it allows the control to checkout product on when and how to load the `enabler` as connector UI based on business configuration. In cases connector is used directly and not through Checkout product, this connector UI can be loaded directly on frontend than the libraries provided by PSPs.

## Considerations for Apple Pay and Google Pay

### Apple Pay Requirements
To enable Apple Pay, you must ensure the following conditions are satisfied:

1. The website must include a `https://www.website.com/.well-known/apple-developer-merchantid-domain-association` call that redirects to:
   ```text
   {COMMERCETOOLS_PROCESSOR_URL}/applePayConfig
   ```
   This endpoint retrieves the required merchant ID domain association file declared in the installation configuration `STRIPE_APPLE_PAY_WELL_KNOWN`. For more details, refer to Stripe’s official [Apple Pay domain association documentation](https://support.stripe.com/questions/enable-apple-pay-on-your-stripe-account).


2. The environment and devices must meet Apple Pay testing requirements:
    - You need an **iOS device** running iOS 11.3 or later, or a **Mac** running macOS 11.3 or later with Safari.
    - The browser must be configured with an active card in the Apple Wallet in sandbox mode.
    - A valid Stripe account must be linked with Apple Pay and properly configured.
    - All webpages hosting an Apple Pay button are HTTPS.

3. Make sure your Stripe account has Apple Pay enabled (this is configured via your Stripe dashboard).

### Google Pay Requirements
To enable Google Pay, you must ensure the following conditions are satisfied:

1. The device and browser requirements for testing Google Pay are met:
    - Use a **Chrome browser** on any device (mobile or desktop) supporting Google Pay.
    - Add a payment method (card) to your Google Pay account and ensure your testing environment is set up for sandbox mode.

2. Additional configuration for your Stripe account:
    - Ensure **Google Pay** is enabled via your Stripe dashboard.
    - Stripe automatically manages domain validation for Google Pay—manual setup is not required.

## Express Checkout

The enabler supports [Stripe Express Checkout](https://docs.stripe.com/payments/express-checkout-element) in line with **commercetools Checkout expectations for Express payment integration** (callbacks, session usage, and cart updates are the merchant’s responsibility; the enabler orchestrates Stripe and processor calls).

Use `createExpressBuilder(type)` to obtain an Express Checkout builder; the supported type is `'dropin'`, which builds the Stripe Express Checkout Element (`ExpressCheckoutElement`). Express Checkout can be used **with an existing session ID** (when the Enabler is created with a session) or **with cart only**: in that case the processor can still expose publishable config via [`POST /express-config`](../processor/README.md#express-config-no-session) (CORS + `ALLOWED_ORIGINS`), and checkout creates the commercetools session in `onPayButtonClick` and returns it.

### Flow

1. Checkout calls `enabler.createExpressBuilder('dropin')` and uses the builder to create and mount the Express component with options (callbacks, initial amount). On mount, the component only renders the Express button(s); no session is requested yet. The enabler sets amount and currency on the shared Stripe **Elements** instance from `ExpressOptions.initialAmount` (the Express Checkout element itself does not carry amount/currency in its options).

2. When the user clicks an Express wallet button, Stripe emits a `click` event: the component calls `resolve` immediately (with line items derived from `initialAmount` to satisfy Stripe’s time limit) and starts `onPayButtonClick` in the background when no session was passed at enabler construction. If shipping or confirm runs before the session is ready, `ensureSessionId` may call `onPayButtonClick` again as a fallback (implementations should be idempotent). The Enabler does not call the processor at the `click` step.

3. The user selects shipping address and method in the Express Checkout modal. The enabler invokes `onShippingAddressSelected`, `getShippingMethods`, and `onShippingMethodSelected` so checkout can update the cart. After a shipping address change, if there are shipping methods, the enabler **applies the first shipping rate by default** (so totals update even when `shippingratechange` does not fire), then calls the processor [`GET /express-payment-data`](../processor/README.md#get-express-payment-data) with `x-session-id` to refresh **total** and **line items**, updates Elements, and resolves the Stripe event. On shipping method change it repeats the fetch and Element update. The enabler does not persist cart data by itself.

4. On confirm (Stripe `confirm` event): the enabler runs **`elements.submit()`**, optionally reads shipping/billing from the element, then calls **`onPaymentSubmit`** with a **partial** [`ExpressPaymentSubmitPayload`](./src/payment-enabler/payment-enabler.ts) only when the wallet exposed address or email (so checkout can sync the cart before creating the payment). Next it calls **`GET /payments`** on the processor with `x-session-id` and, when the enabler is built for Express, **`x-express-checkout: true`**, so the PaymentIntent is created **without** a `shipping` object for the Express Checkout Element. It then **confirms** with Stripe (`confirmPayment`), calls **`POST /confirmPayments/:paymentReference`** on the processor to record success in commercetools, and finally **`onComplete`**. If Stripe does not expose addresses or email on confirm, `onPaymentSubmit` may be skipped; the cart should already reflect earlier shipping callbacks.

### Options

Configure the Express component with `ExpressOptions`, aligned with **commercetools Checkout Express integration**: `initialAmount`, `onPayButtonClick`, `onShippingAddressSelected`, `getShippingMethods`, `onShippingMethodSelected`, `onPaymentSubmit` (partial payload only—`shippingAddress`, `billingAddress`, and/or `customerEmail`; persist only defined keys so empty shipping updates are not sent while a shipping method is set), `onCancel`, `onComplete`, and optionally `allowedCountries` (ISO 3166-1 alpha-2 codes to restrict express wallets). Processor details for [`GET /express-payment-data`](../processor/README.md#get-express-payment-data) and [`POST /express-config`](../processor/README.md#express-config-no-session) are in the processor README.

For a working example integrating with commercetools (cart, shipping methods, address updates), see the dev utilities in `dev-utils/checkout.js`.

## Getting Started
Please run following npm commands under `enabler` folder for development work in local environment.

#### Install dependencies
```
$ npm install
```
#### Build the application in local environment. NodeJS source codes are then generated under public folder
```
$ npm run build
```
#### Build development site in local environment. The location of the site is http://127.0.0.1:3000/
```
$ npm run dev
```
