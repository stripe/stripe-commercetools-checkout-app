# connect-payment-integration-template

This repository provides a commercetools [connect](https://docs.commercetools.com/connect) integration for [Stripe payment](https://docs.stripe.com/payments/payment-element), enabling a drop-in experience through the Stripe Payment Element and supporting webhook handling, payment intents, and checkout configuration.

## Features
- Uses [commercetools SDK](https://docs.commercetools.com/sdk/js-sdk-getting-started) for the commercetools-specific communication.
- It uses [connect payment SDK](https://github.com/commercetools/connect-payments-sdk) to manage request context, sessions, and JWT authentication.
- Use [commercetools payment api](https://docs.commercetools.com/checkout/payment-intents-api) to manage payment transactions.
- Includes local development utilities in npm commands to build, start, test, lint & prettify code.
- Supports the [Payment Element](https://stripe.com/docs/payments/payment-element) component and layout configuration.
- Backend (processor) use the [Stripe API](https://stripe.com/docs/api) for creating and managing payment intents, handling webhooks, and processing payments.
- Customer session management for Stripe, including customer creation and retrieval.[Considerations](./processor/README.md#considerations-for-stripe-customer-session)
- Transfer of shipping information from commercetools to Stripe payment intent.
- Support for Buy Now Pay Later (BNPL) payment method.[Considerations](./processor/README.md#merchant-return-url)

## Prerequisite

#### 1. commercetools composable commerce API client

Create an API client responsible for payment management in a composable commerce project. The API client details are input as environment variables/ configuration for connect, such as `CTP_PROJECT_KEY`, `CTP_CLIENT_ID`, and `CTP_CLIENT_SECRET`. Please read [Deployment Configuration](./README.md#deployment-configuration) for details.
In addition, please make sure the API client has enough scope to manage Payment. For details, please refer to [Running Application](./processor/README.md#running-application)

#### 2. Various URLs from commercetools composable commerce

Configure various URLs from the commercetools platform, so that the connect application can handle the session and authentication process for endpoints.
Their values are input for environment variables/configurations for connecting, with variable names `CTP_API_URL`, `CTP_AUTH_URL`, and `CTP_SESSION_URL`.

#### 4. Stripe account and keys

Configure Stripe secret and public keys so the Connect application can handle endpoint session and authentication processes. Their values are taken as input as environment variables/ configuration for Connect, with variable names `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SIGNING_SECRET`.

## Getting started

The `connect-payment-integration-stripe` contains two modules:

- **Enabler**: This is a wrapper implementation where Stripe frontend [Payment Element](https://docs.stripe.com/payments/payment-element) components are embedded. It gives checkout the control over when and how to load the connector frontend based on business configuration.
- **Processor**: This functions as a backend service and middleware for integration with the Stripe platform. It interacts with Stripe for transactions and updates the payment entity within Composable Commerce. Finding the Stripe customer that own the commercetools cart, or creating the customer and adding the information to the custome field of the cart. Additionally, it supports a listener for triggers related to Stripe webhook events to update the payment entity with `connect-payment-sdk` based on webhook events.

Regarding the development of a processor or enabler module, please refer to the following documentation:

- [Development of Processor](./processor/README.md)
- [Development of Enabler](./enabler/README.md)

![overview.png](docs%2Foverview.png)
### Components

1. **commercetools Checkout**
   Represents the [Checkout](https://docs.commercetools.com/checkout/) platform infrastructure provided by commercetools.
2. **Payment Connector**
    - A [Payment connector integration](https://docs.commercetools.com/checkout/payment-connectors-applications) within the infrastructure of commercetools that facilitates communication between commercetools and Stripe.
3. **Processor**
    - Manages payment transactions and interacts with Stripe to:
        - Create payment intents.
        - Handle manual API payment transactions.
        - Listening to webhooks events triggered by Stripe and processing all related payment operations.
        - Create Stripe customer session
4. **Enabler**
    - Assists in creating the [Stripe Payment Element](https://docs.stripe.com/payments/payment-element) component used as a payment method in the commercetools Checkout.
    - Connects to any sample site that wants to integrate the connector, providing the available payment components for seamless integration.
5. **Stripe**
    - The external payment service provider that handles various payment operations sends webhooks for events such as authorization, capture, refund, and cancel.

# Webhooks

The following webhooks are currently supported, and the payment transactions in commercetools are:
- **payment_intent.canceled**: Modified the payment transaction Authorization to Failure and create a payment transaction CancelAuthorization: Success
- **payment_intent.succeeded**: Creates a payment transaction Charge: Success.
- **payment_intent.payment_failed**: Modify the payment transaction Authorization to Failure.
- **payment_intent.requires_action**: Logs the information in the connector app inside the Processor logs.
- **charge.refunded**: Create a payment transaction Refund to Success and a Chargeback to Success.
- **charge.succeeded**: Create the payment transaction to 'Authorization:Success' if charge is not capture.
- **charge.captured**: Logs the information in the connector app inside the Processor logs.


## Prerequisite


#### 1. Stripe account credentials and configurations

Before installing the connector, you must create a Stripe account and obtain the necessary credentials. The Stripe account is required to process payments and manage transactions. Sign up for a Stripe account at [Stripe](https://stripe.com/). Once you have an account, you must set up the following configurations in your environment variables or configuration files. Before installing the connector, a webhook endpoint in Stripe must be created (using a dummy URL). Retrieve the ID and Signing Secret from the Stripe Console. The Webhook Endpoint is update during the post-deploy script after the deployed connector. It's important to set the correct values in the variables so the events are sent to the connector and can be accepted. The following Stripe account credentials and configurations are required:

1. **STRIPE_SECRET_KEY**: Provided by Stripe. Secret and stored securely in your web or mobile app's server-side code (such as in an environment variable or credential management system) to call Stripe APIs.
2. **STRIPE_CAPTURE_METHOD**: Configuration that enables the capture method selected by the user. The capture method controls when Stripe will capture the fundsthe customer's account. Possible enum values:
   - `automatic`: Stripe automatically captures funds when the customer authorizes the Payment.
   - `automatic_async`: (Default) Stripe asynchronously captures funds when the customer authorizes the Payment. Recommended over `capture_method=automatic` due to improved latency. Read the [integration guide](https://docs.stripe.com/elements/appearance-api) for more information.
   - `manual`: Places a hold on the funds when the customer authorizes the Payment but doesn't capture the funds until later. (Not all payment methods support this.)
3. **STRIPE_APPEARANCE_PAYMENT_ELEMENT**: This configuration enables the theming for the payment element component. The value needs to be a valid stringified JSON. More information about the properties can be found [here](https://docs.stripe.com/elements/appearance-api).
```
//stringified, eg.
{"theme":"night", "labels":"floating"}
```
4. **STRIPE_WEBHOOK_ID**: Unique identifier of a Webhook Endpoint in Stripe.
5. **STRIPE_WEBHOOK_SIGNING_SECRET**: Signing Secret of a Webhook Endpoint in Stripe.
6. **STRIPE_LAYOUT**: This configuration enables the Layout for the payment component. The value needs to be a valid stringified JSON. More information about the properties can be found [here](https://docs.stripe.com/payments/payment-element#layout).
```
//stringified, eg.
{"type":"accordion","defaultCollapsed":false,"radios":true, "spacedAccordionItems":false}
```
7. **STRIPE_SAVED_PAYMENT_METHODS_CONFIG**: The configuration for the saved payment methods. The value needs to be a valid stringified JSON. More information about the properties can be found [here](https://docs.stripe.com/api/customer_sessions/object#customer_session_object-components-payment_element-features). This feature is disabled by default. To enable it, you need to add the expected customer session object.
```
//stringified, eg.
{"payment_method_save_usage":"off_session","payment_method_redisplay_limit":10}
```
8. **STRIPE_PUBLISHABLE_KEY**: Provided by Stripe. The key is to create the Payment Element component on the front end.
9. **STRIPE_APPLE_PAY_WELL_KNOWN**: This is the domain association file from Stripe. Use to verify the domain for Apple Pay. More information can be found [here](https://stripe.com/docs/apple-pay/web).
10. **MERCHANT_RETURN_URL**: This is the return URL used on the confirmPayment return_url parameter. The Buy Now Pay Later payment methods will send the Stripe payment_intent in the URL; the Merchant will need to retrieve the payment intent and look for the metadata ct_payment_id is add in the commercetools Checkout SDK paymentReference.
11. **STRIPE_CAPTURE_METHOD**: This is the capture method used for the Payment. It can be either `automatic` or `manual`. The default value is `automatic`.
12. **STRIPE_WEBHOOK_ID**: This is the unique identifier for the Stripe Webhook Endpoint.


#### 2. commercetools

We must create the connector on the commercetools connect marketplace, enable the checkout feature in the merchant center, and select the payment connector as the drop-in payment method on the checkout configuration page. Users create an API client responsible for payment management in a composable commerce project. The API client's details are input as environment variables/ configuration for connecting, such as `CTP_PROJECT_KEY,` `CTP_CLIENT_ID,` and `CTP_CLIENT_SECRET`.

1. **API client **: Various URLs from the commercetools platform must be configured so that the connect application can handle the session and authentication process for endpoints. Their values are taken as input as environment variables/ configuration for connect, with variable names `CTP_API_URL`, `CTP_AUTH_URL`, and `CTP_SESSION_URL`.
2. **payment connector**: Install the payment connector from the commercetools connector marketplace.
3. **commercetools Checkout**: Enable the checkout connector in the merchant center to install the current connector as a drop-in payment method in the checkout dashboard configuration page.


## Development Guide

## Deployment Configuration

It needs to be published to deploy your customized connector application on commercetools Connect. For details, please refer to [documentation about commercetools Connect](https://docs.commercetools.com/connect/concepts)
In addition, the tax integration connector template has a folder structure, as listed below, to support Connect.

```
├── enabler
│   ├── src
│   ├── test
│   └── package.json
├── processor
│   ├── src
│   ├── test
│   └── package.json
└── connect.yaml
```

The connect deployment configuration specifie in `connect.yaml`, the information needed to publish the application. Following is the deployment configuration used by the Enabler and Processor modules

```
deployAs:
  - name: enabler
    applicationType: assets
  - name: processor
    applicationType: service
    endpoint: /
    scripts:
      postDeploy: npm install && npm run connector:post-deploy
      preUndeploy: npm install && npm run connector:pre-undeploy
    configuration:
      standardConfiguration:
        - key: CTP_PROJECT_KEY
          description: commercetools project key
          required: true
        - key: CTP_AUTH_URL
          description: commercetools Auth URL (example - https://auth.europe-west1.gcp.commercetools.com).
          required: true
          default: https://auth.europe-west1.gcp.commercetools.com
        - key: CTP_API_URL
          description: commercetools API URL (example - https://api.europe-west1.gcp.commercetools.com).
          required: true
          default: https://api.europe-west1.gcp.commercetools.com
        - key: CTP_SESSION_URL
          description: Session API URL (example - https://session.europe-west1.gcp.commercetools.com).
          required: true
          default: https://session.europe-west1.gcp.commercetools.com
        - key: CTP_JWKS_URL
          description: JWKs url (example - https://mc-api.europe-west1.gcp.commercetools.com/.well-known/jwks.json)
          required: true
          default: https://mc-api.europe-west1.gcp.commercetools.com/.well-known/jwks.json
        - key: CTP_JWT_ISSUER
          description: JWT Issuer for jwt validation (example - https://mc-api.europe-west1.gcp.commercetools.com)
          required: true
          default: https://mc-api.europe-west1.gcp.commercetools.com
        - key: STRIPE_CAPTURE_METHOD
          description: Stripe capture method (example - manual|automatic).
          default: automatic
        - key: STRIPE_WEBHOOK_ID
          description: Stripe unique identifier for the Webhook Endpoints (example - we_*****).
          required: true
        - key: STRIPE_APPEARANCE_PAYMENT_ELEMENT
          description: Stripe Appearance for Payment Element (example - {"theme":"night","labels":"floating"} ).
        - key: STRIPE_LAYOUT
          description: Stripe Layout for Payment Element (example - {"type":"accordion","defaultCollapsed":false,"radios":true,"spacedAccordionItems":false} ).
          default: '{"type":"tabs","defaultCollapsed":false}'
        - key: STRIPE_PUBLISHABLE_KEY
          description: Stripe Publishable Key
          required: true
        - key: STRIPE_APPLE_PAY_WELL_KNOWN
          description: Domain association file from Stripe. (example - https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association)
        - key: STRIPE_SAVED_PAYMENT_METHODS_CONFIG
          description: Stripe configuration for saved payment methods (example - {"payment_method_save_usage":"off_session","payment_method_redisplay_limit":10}).
          default: '{"payment_method_save":"disabled"}'
        - key: MERCHANT_RETURN_URL
          description: Merchant return URL
          required: true
      securedConfiguration:
        - key: CTP_CLIENT_SECRET
          description: commercetools client secret.
          required: true
        - key: CTP_CLIENT_ID
          description: commercetools client ID with manage_payments, manage_orders, view_sessions, view_api_clients, manage_checkout_payment_intents, introspect_oauth_tokens, manage_types and view_types scopes
          required: true
        - key: STRIPE_SECRET_KEY
          description: Stripe secret key (example - sk_*****).
          required: true
        - key: STRIPE_WEBHOOK_SIGNING_SECRET
          description: Stripe Webhook signing secret  (example - whsec_*****).
          required: true

```

Here, you can see the details about various variables in the configuration
- `CTP_PROJECT_KEY`: The key to the commercetools composable commerce project.
- `CTP_SCOPE`: The scope constrains the endpoints to which the commercetools client has access and the read/write access right to an endpoint.
- `CTP_AUTH_URL`: The URL for authentication in the commercetools platform. Generate the OAuth 2.0 token required in every API call to commercetools composable commerce. The default value is `https://auth.europe-west1.gcp.commercetools.com`. For details, please refer to the documentation [here](https://docs.commercetools.com/tutorials/api-tutorial#authentication).
- `CTP_API_URL`: The URL for commercetools composable commerce API. The default value is `https://api.europe-west1.gcp.commercetools.com`.
- `CTP_SESSION_URL`: The URL for session creation in the commercetools platform. Connectors rely on the session created to share information between the enabler and processor. The default value is `https://session.europe-west1.gcp.commercetools.com`.
- `CTP_JWKS_URL`: The JSON Web Key Set URL. Default value is `https://mc-api.europe-west1.gcp.commercetools.com/.well-known/jwks.json`
- `CTP_JWT_ISSUER`: The issuer inside JSON Web Token, required in the JWT validation process. The default value is `https://mc-api.europe-west1.gcp.commercetools.com`
- `STRIPE_CAPTURE_METHOD`: Stripe capture method (manual or automatic), default value: automatic.
- `STRIPE_APPEARANCE_PAYMENT_ELEMENT`: Stripe Elements supports visual customization, which allows you to match the design of your site with the `appearance` option. This value has the specific appearance of the Payment Element component. The value needs to be a valid stringified JSON. More information about the properties can be found [here](https://docs.stripe.com/elements/appearance-api).
- `STRIPE_LAYOUT`: Stripe allows you to customize the Payment Element's Layout to fit your checkout flow (accordions or tabs). Default value is `{"type":"tabs","defaultCollapsed":false}`
- `CTP_CLIENT_SECRET`: The client secret of commercetools composable commerce user account. It is used in commercetools for clients to communicate with commercetools composable commerce via SDK.
- `CTP_CLIENT_ID`: The client ID of your commercetools composable commerce user account. It is used in commercetools for clients to communicate with commercetools composable commerce via SDK. Expected scopes are: `manage_payments` `manage_orders` `view_sessions` `view_api_clients` `manage_checkout_payment_intents` `introspect_oauth_tokens` `manage_types` `view_types`.
- `STRIPE_SECRET_KEY`: Stripe authenticates your API requests using your account's API keys
- `STRIPE_PUBLISHABLE_KEY`: Stripe authenticates your frontend requests using your account's Publishable keys
- `STRIPE_WEBHOOK_ID`: Stripe unique identifier for the [Webhook Endpoints](https://docs.stripe.com/api/webhook_endpoints)
- `STRIPE_WEBHOOK_SIGNING_SECRET`: Stripe Secret key to verify webhook signatures using the official libraries. This key created in the [Stripe dashboard Webhook](https://docs.stripe.com/webhooks).
- `STRIPE_APPLE_PAY_WELL_KNOWN`: Domain association file from Stripe. We can find more information in this [link](https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association).
- `MERCHANT_RETURN_URL`: Merchant return URL used on the [confirmPayment](https://docs.stripe.com/js/payment_intents/confirm_payment) return_url parameter. The Buy Now Pay Later payment methods will send the Stripe payment_intent in the URL; the Merchant will need to retrieve the payment intent and look for the metadata `ct_payment_id` to be added in the commercetools Checkout SDK `paymentReference`. 
- `STRIPE_SAVED_PAYMENT_METHODS_CONFIG`: Stripe allows you to configure the saved payment methods in the Payment Element, refer to [docs](https://docs.stripe.com/api/customer_sessions/object#customer_session_object-components-payment_element-features). This feature is disabled by default. To enable it, you need to add the expected customer session object. Default value is `{"payment_method_save":"disabled"}`

## Development

Certain configurations are necessary to get started developing this connector, most of which involve updating environment variables in both services (enabler, processor).
Creating a Webhook Endpoint in Stripe (using a dummy URL) is necessary. Once created, retrieve the ID and Signing Secret from the Stripe Console. The Webhook Endpoint configuration is update during the post-deploy script after the connector is deploy. It's important to set the correct values in the variables so the events are sent to the connector and can be accepted.

#### Configuration steps

#### 1. Environment Variable Setup

Navigate to each service directory and duplicate the .env.template file, renaming the copy to .env. Populate the newly created .env file with the appropriate values.

```bash
cp .env.template .env
```

#### 2. Spin Up Components via Docker Compose

With the help of docker compose, you can spin up all necessary components required for developing the connector by running the following command from the root directory;

```bash
docker compose up
```

This command would start three services that are required for development.

1. JWT Server
2. Enabler
3. Processor
