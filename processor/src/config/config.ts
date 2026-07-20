import Stripe from 'stripe';
import { parseJSON } from '../utils';
import { PaymentBehaviorConfig } from '../services/payment-behavior-resolver';

type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;

/**
 * Parses STRIPE_PAYMENT_BEHAVIOR_RULES strictly: throws at startup if the JSON is malformed.
 * Returns undefined when the env var is absent.
 * Does NOT use parseJSON() — that helper silently returns {} on error (unsuitable for startup validation).
 */
const getPaymentBehaviorConfig = (): PaymentBehaviorConfig | undefined => {
  const raw = process.env.STRIPE_PAYMENT_BEHAVIOR_RULES;
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // console.error instead of log — logger is not initialized at module load time.
    // eslint-disable-next-line no-console
    console.error('[config] STRIPE_PAYMENT_BEHAVIOR_RULES contains invalid JSON. Startup aborted.', e);
    throw new Error('STRIPE_PAYMENT_BEHAVIOR_RULES contains invalid JSON');
  }
  // Guard: must be a plain object (not null, not an array) whose values are objects.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'STRIPE_PAYMENT_BEHAVIOR_RULES must be a JSON object (e.g. {"MX":{"captureMethod":"manual"}}). Got: ' +
        JSON.stringify(parsed),
    );
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(
        `STRIPE_PAYMENT_BEHAVIOR_RULES["${key}"] must be an object rule (e.g. {"captureMethod":"manual"}). Got: ` +
          JSON.stringify(value),
      );
    }
  }
  return parsed as PaymentBehaviorConfig;
};

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
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  stripeApplePayWellKnown: process.env.STRIPE_APPLE_PAY_WELL_KNOWN || 'mockWellKnown',
  stripeApiVersion: process.env.STRIPE_API_VERSION || '2025-12-15.clover',
  stripeSavedPaymentMethodConfig: getSavedPaymentConfig(),
  stripeLayout: process.env.STRIPE_LAYOUT || '{"type":"tabs","defaultCollapsed":false}',
  stripeCollectBillingAddress: process.env.STRIPE_COLLECT_BILLING_ADDRESS || 'auto',
  stripeExpressElementOptions: process.env.STRIPE_EXPRESS_ELEMENT_OPTIONS,
  stripeBehaviorPaymentElement: process.env.STRIPE_BEHAVIOR_PAYMENT_ELEMENT,

  // Payment Providers config
  paymentInterface: process.env.PAYMENT_INTERFACE || 'checkout-stripe',
  merchantReturnUrl: process.env.MERCHANT_RETURN_URL || '',

  /**
   * Comma-separated list of allowed origins for POST /express-config (CORS validation).
   * Used when rendering Express buttons without session; requests must include an Origin header matching one of these values.
   * Environment variable: ALLOWED_ORIGINS
   */
  allowedOrigins: process.env.ALLOWED_ORIGINS || '',

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

  /**
   * Controls the Stripe Elements initialization strategy.
   *
   * - 'deferred'  (default): Elements created with { mode, amount, currency } — PaymentIntent created
   *                          at submit time via GET /payments. Compatible with all payment methods.
   * - 'pi_first'  : Elements created with { clientSecret } fetched eagerly via GET /payments at
   *                 config-element time. Required for payment methods that must bind to a
   *                 PaymentIntent before rendering (e.g. Blik).
   *
   * Change requires redeployment. Invalid values fall back to 'deferred' with a warning.
   * Environment variable: STRIPE_PAYMENT_FLOW
   */
  stripePaymentFlow: (() => {
    const raw = process.env.STRIPE_PAYMENT_FLOW ?? 'deferred';
    const allowed = ['deferred', 'pi_first'] as const;
    if (!allowed.includes(raw as 'deferred' | 'pi_first')) {
      // Intentional: log is not available at module load; use console so the warning reaches
      // stdout before the logger is initialized.
      // eslint-disable-next-line no-console
      console.warn(`[config] Unknown STRIPE_PAYMENT_FLOW value "${raw}". Falling back to "deferred".`);
      return 'deferred';
    }
    return raw as 'deferred' | 'pi_first';
  })(),

  /**
   * Per-cart payment behavior overrides.
   * Keys are store keys or ISO country codes; values override the flat env vars for matched carts.
   * Env vars are always the default — this map contains exceptions only. No wildcard key.
   * Environment variable: STRIPE_PAYMENT_BEHAVIOR_RULES
   * Example: {"MX":{"captureMethod":"manual"},"store-ca":{"flowType":"pi_first"}}
   */
  stripePaymentBehaviorRules: getPaymentBehaviorConfig(),
};

export const getConfig = () => {
  return config;
};
