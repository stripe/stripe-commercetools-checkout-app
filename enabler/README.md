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
   This endpoint retrieves the required merchant ID domain association file. For more details, refer to Stripe’s official [Apple Pay domain association documentation](https://support.stripe.com/questions/enable-apple-pay-on-your-stripe-account).

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
