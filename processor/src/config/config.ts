import Stripe from 'stripe';
import { parseJSON } from '../utils';
import { PaymentBehaviorConfig, PaymentBehaviorRule } from '../services/payment-behavior-resolver';
import { EU_BANK_TRANSFER_COUNTRIES, findRailSuppressionAtStartup } from '../mappers/bank-transfer-mapper';

type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;

const RULE_FLOW_TYPES = ['deferred', 'pi_first'] as const;
const RULE_CAPTURE_METHODS = ['automatic', 'automatic_async', 'manual'] as const;
const RULE_SETUP_FUTURE_USAGE = ['off_session', 'on_session', '', 'none', 'null', 'undefined'] as const;
const RULE_COLLECT_BILLING_ADDRESS = ['auto', 'never', 'if_required'] as const;

/**
 * Validates a single rule, field by field.
 *
 * DEGRADES, NEVER ABORTS: an unusable field is reported and left unset, so the flat env var default
 * applies for that setting while every other field in the rule survives. Structural failures still
 * abort in the caller — there is no per-field fallback for losing the whole map at once.
 *
 * Why degrade here when the structural checks abort: a mistyped field must not brick the storefront.
 * Before this validation a value like {"MX":{"captureMethod":"banana"}} started cleanly and then
 * failed at the till for every MX shopper, because the value was blind-cast and reached Stripe.
 * Failing at startup instead would be worse still — one typo takes the whole store down. Reporting
 * and falling back is the only option that keeps the store selling.
 *
 * This follows two existing precedents in this codebase rather than inventing a third stance:
 * parsePaymentElementOptions (utils.ts) drops invalid keys with a warning, and STRIPE_PAYMENT_FLOW
 * (below) warns and falls back to 'deferred'.
 *
 * @param key   The discriminator key this rule is filed under, used only for reporting.
 * @param rule  The raw parsed rule object. Already known to be a non-null, non-array object.
 * @returns     A rule containing only the fields that validated.
 */
/**
 * Reports an unusable field and leaves it unset, so the flat env var default applies.
 *
 * Module-level rather than nested inside `validateBehaviorRule`: a nested function's complexity
 * counts toward its parent, and the parent was over the ceiling `connect validate` enforces.
 */
const dropField = (prefix: string, field: string, expected: string, value: unknown): void => {
  // console.error instead of log — logger is not initialized at module load time.
  // eslint-disable-next-line no-console
  console.error(
    `[config] ${prefix}.${field} ${expected} Got: ${JSON.stringify(value)}. ` +
      `Ignoring this field — it falls back to the default. Startup continues.`,
  );
};

/**
 * Shared shape for the two fields that must be CANONICALISED before the membership check.
 *
 * Both `setupFutureUsage` and `euBankTransferCountry` do the same four steps — reject non-strings,
 * canonicalise, check membership, return — differing only in the transform and the wording of the
 * expectation. Folding them together removes the duplicated nesting that pushed
 * `validateBehaviorRule` over the complexity ceiling. The two call sites keep their own
 * `canonicalise` and message, so neither behaviour nor any operator-facing string moves.
 */
const canonicalOneOf = <T extends string>(
  prefix: string,
  field: string,
  value: unknown,
  allowed: readonly string[],
  canonicalise: (raw: string) => string,
  expected: string,
): T | undefined => {
  if (typeof value !== 'string') {
    dropField(prefix, field, 'must be a string.', value);
    return undefined;
  }
  const canonical = canonicalise(value);
  if (!allowed.includes(canonical)) {
    dropField(prefix, field, expected, value);
    return undefined;
  }
  return canonical as T;
};

const validateBehaviorRule = (key: string, rule: Record<string, unknown>): PaymentBehaviorRule => {
  const prefix = `STRIPE_PAYMENT_BEHAVIOR_RULES["${key}"]`;
  const validated: PaymentBehaviorRule = {};

  /**
   * Generic over the allow-list so the return type IS the field's literal union. Assigning the
   * result of `oneOf(field, value, RULE_CAPTURE_METHODS)` to `validated.flowType` does not
   * typecheck, so a case wired to the WRONG list is a compile error rather than a silent runtime
   * bug. A non-generic `oneOf` returning `string` plus a per-field cast would NOT catch this —
   * verified by compile probe, not assumed.
   *
   * WHAT THIS DOES NOT CATCH, and why the positive test cases are therefore not redundant with it:
   * SUBSET DRIFT. Removing a member from an allow-list while leaving the field's union intact
   * compiles perfectly cleanly — the return type merely narrows, and a narrower union is still
   * assignable. That is precisely the OVER-REJECTION failure mode that caused a real regression in
   * this file's first version, where a valid value was silently dropped and the connector fell back
   * to the flat env var, which can be the opposite of what the merchant configured.
   *
   * So: the type guards against a list that is wrong or too WIDE; the positive test case for every
   * valid value in test/config/config.spec.ts guards against a list that is too NARROW. They cover
   * different halves of the same failure. Do not delete the positive cases as "redundant with the
   * type" — they are not, and the gap between them is where the last bug lived.
   *
   * Two fields deliberately bypass this helper and therefore have NO compile-time protection at
   * all: `setupFutureUsage` (needs canonicalisation first) and `euBankTransferCountry` (needs a
   * different canonicalisation). `euBankTransferCountry` is safe regardless, because
   * EU_BANK_TRANSFER_COUNTRIES is single-sourced through EuBankTransferCountry into the interface
   * field. RULE_SETUP_FUTURE_USAGE and the union on PaymentBehaviorRule.setupFutureUsage are two
   * INDEPENDENT copies of the same list and can drift apart — its positive test cases are the only
   * thing holding them together.
   */
  const oneOf = <T extends string>(field: string, value: unknown, allowed: readonly T[]): T | undefined => {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      dropField(prefix, field, `must be one of ${allowed.map((v) => `'${v}'`).join(', ')}.`, value);
      return undefined;
    }
    return value as T;
  };

  for (const [field, value] of Object.entries(rule)) {
    switch (field) {
      case 'flowType':
        validated.flowType = oneOf(field, value, RULE_FLOW_TYPES);
        break;
      case 'captureMethod':
        validated.captureMethod = oneOf(field, value, RULE_CAPTURE_METHODS);
        break;
      case 'setupFutureUsage': {
        // Canonicalised before the membership check, unlike flowType / captureMethod /
        // collectBillingAddress. The asymmetry is deliberate and load-bearing: this is the ONLY rule
        // field whose CONSUMER already normalises (getPaymentIntentSetupFutureUsage in
        // stripe-payment.service.ts lowercases before comparing), so 'OFF_SESSION' and 'None' were
        // accepted long before this validation existed and must keep working.
        //
        // Dropping them would NOT mean "no override" — it means "fall back to the flat env var",
        // which can be the OPPOSITE instruction. With STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE set
        // to off_session, a rule of {"setupFutureUsage":"None"} exists precisely to disable the
        // mandate for that market; silently dropping it would hand every shopper in that market the
        // mandate the merchant turned off.
        validated.setupFutureUsage = canonicalOneOf<NonNullable<PaymentBehaviorRule['setupFutureUsage']>>(
          prefix,
          field,
          value,
          RULE_SETUP_FUTURE_USAGE as readonly string[],
          (raw) => raw.trim().toLowerCase(),
          `must be one of ${RULE_SETUP_FUTURE_USAGE.map((v) => `'${v}'`).join(', ')}.`,
        );
        break;
      }
      case 'collectBillingAddress':
        validated.collectBillingAddress = oneOf(field, value, RULE_COLLECT_BILLING_ADDRESS);
        break;
      case 'euBankTransferCountry':
        // Case-INSENSITIVE, unlike flowType / captureMethod / collectBillingAddress, and the
        // asymmetry is reasoned rather than an inconsistency: an ISO country code has one
        // conventional casing, so 'de' is a typo of the same value. 'PI_FIRST' is a different
        // behavior, so it is not silently accepted.
        validated.euBankTransferCountry = canonicalOneOf<NonNullable<PaymentBehaviorRule['euBankTransferCountry']>>(
          prefix,
          field,
          value,
          EU_BANK_TRANSFER_COUNTRIES as readonly string[],
          (raw) => raw.trim().toUpperCase(),
          `must be one of ${EU_BANK_TRANSFER_COUNTRIES.join(', ')}.`,
        );
        break;
      default:
        // eslint-disable-next-line no-console
        console.error(
          `[config] ${prefix} has unknown field '${field}'. Supported: flowType, captureMethod, ` +
            `setupFutureUsage, collectBillingAddress, euBankTransferCountry. ` +
            `Ignoring this field. Startup continues.`,
        );
    }
  }

  return validated;
};

/**
 * Parses STRIPE_PAYMENT_BEHAVIOR_RULES. Returns undefined when the env var is absent.
 *
 * Two different failure stances, deliberately:
 *   - STRUCTURE aborts startup — malformed JSON, a non-object map, or a rule that is not an object.
 *     There is no sensible per-field fallback when the whole map is unreadable.
 *   - FIELD VALUES degrade — an unusable field is reported and dropped so the flat env var applies.
 *     See validateBehaviorRule.
 *
 * Does NOT use parseJSON() — that helper silently returns {} on error (unsuitable for startup validation).
 */
const getPaymentBehaviorConfig = (): PaymentBehaviorConfig | undefined => {
  // Trimmed before the emptiness check: the CT Connect config UI can return a whitespace-only value
  // for an optional variable with no default, and an untrimmed '  ' would reach JSON.parse and abort
  // the deploy. That would be the one remaining path where a harmless input bricks startup, which is
  // exactly the stance the field-level validation below exists to avoid.
  const raw = process.env.STRIPE_PAYMENT_BEHAVIOR_RULES?.trim();
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
  const validatedConfig: PaymentBehaviorConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(
        `STRIPE_PAYMENT_BEHAVIOR_RULES["${key}"] must be an object rule (e.g. {"captureMethod":"manual"}). Got: ` +
          JSON.stringify(value),
      );
    }
    validatedConfig[key] = validateBehaviorRule(key, value as Record<string, unknown>);
  }
  return validatedConfig;
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

/**
 * Startup half of the bank-transfer rail-suppression warning. See findRailSuppressionAtStartup for
 * the measured suppression table and for why there are two warning sites rather than one.
 *
 * This one catches the STATIC contradiction — a market configured with euBankTransferCountry whose
 * own mandate or capture policy guarantees the tab can never render — and it reaches the person who
 * just wrote that configuration and is watching the deploy. The runtime warning in
 * stripe-payment.service.ts catches what only a cart can reveal (a recurring cart forces
 * setup_future_usage to 'off_session' no matter what this map says).
 *
 * `console.warn`, not `log.warn`, and this is NOT an oversight to tidy up: the winston logger is not
 * initialised at module-load time, which is when this file executes. The same reason is why the JSON
 * parse failure above uses console.error. Switching either to `log` breaks startup.
 *
 * Warns and continues — it never aborts. The configuration is individually valid at every field; it
 * is only the combination that is self-defeating, and that is the merchant's call to make.
 */
for (const { message } of findRailSuppressionAtStartup({
  rules: config.stripePaymentBehaviorRules,
  envSetupFutureUsage: config.stripePaymentIntentSetupFutureUsage,
  envCaptureMethod: config.stripeCaptureMethod,
  envFlowType: config.stripePaymentFlow,
  savedPaymentMethodSaveUsage: config.stripeSavedPaymentMethodConfig?.payment_method_save_usage,
})) {
  // eslint-disable-next-line no-console
  console.warn(message);
}

export const getConfig = () => {
  return config;
};
