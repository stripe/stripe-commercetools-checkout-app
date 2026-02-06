import Stripe from 'stripe';
import { parseJSON } from '../utils';

type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;

const getSavedPaymentConfig = (): PaymentFeatures => {
  const config = process.env.STRIPE_SAVED_PAYMENT_METHODS_CONFIG;
  return {
    //default values disabled {"payment_method_save":"disabled"}
    ...(config ? parseJSON<PaymentFeatures>(config) : null),
  };
};

export const config = {
  // Required by Payment SDK
  projectKey: process.env.CTP_PROJECT_KEY || 'payment-integration',
  clientId: process.env.CTP_CLIENT_ID || 'xxx',
  clientSecret: process.env.CTP_CLIENT_SECRET || 'xxx',
  jwksUrl: process.env.CTP_JWKS_URL || 'https://mc-api.europe-west1.gcp.commercetools.com/.well-known/jwks.json',
  jwtIssuer: process.env.CTP_JWT_ISSUER || 'https://mc-api.europe-west1.gcp.commercetools.com',
  authUrl: process.env.CTP_AUTH_URL || 'https://auth.europe-west1.gcp.commercetools.com',
  apiUrl: process.env.CTP_API_URL || 'https://api.europe-west1.gcp.commercetools.com',
  sessionUrl: process.env.CTP_SESSION_URL || 'https://session.europe-west1.gcp.commercetools.com/',
  checkoutUrl: process.env.CTP_CHECKOUT_URL || 'https://checkout.europe-west1.gcp.commercetools.com',
  healthCheckTimeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '5000'),

  // Required by logger
  loggerLevel: process.env.LOGGER_LEVEL || 'info',

  // Update with specific payment providers config
  mockClientKey: process.env.MOCK_CLIENT_KEY || 'stripe',
  mockEnvironment: process.env.MOCK_ENVIRONMENT || 'TEST',

  // Update with specific payment providers config
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || 'stripeSecretKey',
  stripeWebhookSigningSecret: process.env.STRIPE_WEBHOOK_SIGNING_SECRET || '',
  stripeCaptureMethod: process.env.STRIPE_CAPTURE_METHOD || 'automatic',
  stripePaymentElementAppearance: process.env.STRIPE_APPEARANCE_PAYMENT_ELEMENT,
  stripeSecretKeyUS: process.env.STRIPE_SECRET_KEY_US!,
  stripeSecretKeyCA: process.env.STRIPE_SECRET_KEY_CA!,
  stripeSecretKeyEU: process.env.STRIPE_SECRET_KEY_EU!,
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  stripeApplePayWellKnown: process.env.STRIPE_APPLE_PAY_WELL_KNOWN || 'mockWellKnown',
  stripeApiVersion: process.env.STRIPE_API_VERSION || '2025-12-15.clover',
  stripeSavedPaymentMethodConfig: getSavedPaymentConfig(),
  stripeLayout: process.env.STRIPE_LAYOUT || '{"type":"tabs","defaultCollapsed":false}',
  stripeCollectBillingAddress: process.env.STRIPE_COLLECT_BILLING_ADDRESS || 'auto',

  // Payment Providers config
  paymentInterface: process.env.PAYMENT_INTERFACE || 'checkout-stripe',
  merchantReturnUrl: process.env.MERCHANT_RETURN_URL || '',

  /**
   * Enable multicapture and multirefund support for Stripe payments
   * When enabled, allows:
   * - Multiple partial captures on a single payment (multicapture)
   * - Multiple refunds to be processed on a single charge (multirefund)
   *
   * Default: false (disabled) - Merchants must opt-in to enable these advanced features
   * Note: This feature requires multicapture to be enabled in your Stripe account
   *
   * Environment variable: STRIPE_ENABLE_MULTI_OPERATIONS
   */
  stripeEnableMultiOperations: process.env.STRIPE_ENABLE_MULTI_OPERATIONS === 'true' || false,

  /**
   * Override setup_future_usage value for PaymentIntent creation
   *
   * This setting decouples the PaymentIntent's setup_future_usage from the
   * Customer Session's payment_method_save_usage configuration.
   *
   * Values:
   * - 'off_session': Payment method will be used for future off-session payments
   * - 'on_session': Payment method will be used for future on-session payments
   * - '' (empty), 'none', 'null', or 'undefined': Do NOT include setup_future_usage in PaymentIntent
   * Environment variable: STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE
   */
  stripePaymentIntentSetupFutureUsage: process.env.STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE,
};

export const getConfig = () => {
  return config;
};
