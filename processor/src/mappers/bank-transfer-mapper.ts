import Stripe from 'stripe';
import type { PaymentBehaviorRule } from '../services/payment-behavior-resolver';

/**
 * Countries Stripe accepts inside `eu_bank_transfer.country`.
 *
 * Measured against the API on 2026-08-05, not read from the documentation: an invalid value is
 * rejected with "The country provided (US) is not supported for `eu_bank_transfer` details.
 * `eu_bank_transfer` details can be provided with the following countries: DE, FR, IE, or NL."
 *
 * Stripe's own TypeScript declares this field as a plain `string`
 * (Stripe.PaymentIntentCreateParams.PaymentMethodOptions.CustomerBalance.BankTransfer.EuBankTransfer),
 * so this union is the only thing standing between a typo in merchant config and a 400 at the till.
 * config.ts validates `euBankTransferCountry` against this same array — one array for both, because
 * duplicating the list is how the two drift apart.
 *
 * These four are an IBAN-LOCALIZATION list, not a list of markets that can pay. Stripe accepts EUR
 * bank transfers for accounts in 34 countries; a merchant in ES or IT can take them perfectly well,
 * they simply have to show the shopper a DE, FR, IE or NL IBAN. SEPA is a single payment area, so any
 * eurozone shopper can wire to any of the four.
 */
export const EU_BANK_TRANSFER_COUNTRIES = ['DE', 'FR', 'IE', 'NL'] as const;

export type EuBankTransferCountry = (typeof EU_BANK_TRANSFER_COUNTRIES)[number];

/**
 * Builds `payment_method_options.customer_balance` for a EUR cart whose market has a configured IBAN
 * country. Returns `undefined` for every other cart, which means "send nothing and let Stripe decide".
 *
 * WHY SENDING NOTHING IS THE DEFAULT, having previously been treated as a broken state.
 * Measured on 2026-08-05 against a PaymentIntent with automatic_payment_methods, a customer and no
 * customer_balance options at all: Stripe resolves the variant from the CURRENCY on its own, and the
 * confirm returns complete, usable funding instructions.
 *   - usd -> us_bank_transfer, with aba and swift addresses
 *   - eur -> eu_bank_transfer, country IE, a real IBAN and BIC
 * So the whole rail works with no configuration. An earlier design sent explicit options for every
 * eligible cart, which forced a `euBankTransferCountry` to become mandatory for EUR (stating
 * `bank_transfer.type` makes the nested country required) and made an unconfigured EUR cart throw.
 * That obligation was self-inflicted: it existed only because we were sending the options in the first
 * place.
 *
 * WHAT THIS IS FOR, then. Exactly one thing: overriding Stripe's IE default when the merchant wants the
 * shopper to see an IBAN in a specific country — normally their own, to avoid cross-border transfer
 * fees for the buyer and to look like a local business. It is a treasury preference, never a technical
 * requirement.
 *
 * NO CURRENCY ALLOW-LIST, deliberately, and this reverses a previous restriction. A prior version
 * refused any currency outside eur/usd, on a measurement taken on a US test account. That measurement
 * was real but its scope was misread: Stripe also offers gbp, jpy and mxn bank transfers to accounts
 * based in GB, JP and MX, and the US account simply had no such capability. Since this function now
 * declines to interfere with anything but EUR, a GB merchant's GBP cart reaches Stripe untouched and
 * gets gb_bank_transfer — which the old allow-list would have blocked with a 400 that blamed Stripe for
 * our own restriction.
 *
 * @param currencyCode - The cart's currency. Case-insensitive: commercetools carries 'USD'.
 * @param euBankTransferCountry - Merchant-configured IBAN country, if this market has one.
 * @returns The customer_balance options, or undefined to leave the PaymentIntent alone.
 */
export const getBankTransferOptions = ({
  currencyCode,
  euBankTransferCountry,
}: {
  currencyCode: string;
  euBankTransferCountry?: EuBankTransferCountry;
}): Stripe.PaymentIntentCreateParams.PaymentMethodOptions.CustomerBalance | undefined => {
  if (!euBankTransferCountry || currencyCode.toLowerCase() !== 'eur') {
    return undefined;
  }

  // funding_type and bank_transfer.type are an atomic pair: sending funding_type alone is a 400,
  // "the payment_method_options[customer_balance][bank_transfer][type] parameter is required".
  //
  // `requested_address_types` is deliberately not set: Stripe returns all valid types for the variant,
  // which is what the storefront's funding-instructions UI needs, and narrowing it is a merchant
  // display preference with no consumer here yet.
  return {
    funding_type: 'bank_transfer',
    bank_transfer: { type: 'eu_bank_transfer', eu_bank_transfer: { country: euBankTransferCountry } },
  };
};

/**
 * WHY THE BANK TRANSFER TAB CAN NEVER APPEAR EVEN WHEN EVERYTHING IS CONFIGURED
 *
 * Sending `payment_method_options.customer_balance` is not sufficient. Stripe filters out payment
 * methods that cannot satisfy the PaymentIntent's own configuration, and it does so SILENTLY —
 * `customer_balance` disappears from `payment_method_types` and the options come back null, with no
 * error and no warning. A merchant configures `euBankTransferCountry`, deploys, and the tab simply
 * never renders.
 *
 * It fails in the direction nobody probes first: `setup_future_usage` is only ever bound when a
 * customer is attached, and a bound customer is exactly what `customer_balance` requires. A guest
 * cart is unaffected because it never had the rail to begin with.
 *
 * MEASURED against the live API on 2026-08-12 (--project-name=dev-ct-fortuno), EUR 12300 cart with a
 * customer and eu_bank_transfer/DE options. Do not extend this table by reasoning about the
 * mechanism — one of these four was predicted wrong by exactly that reasoning:
 *
 *   setup_future_usage 'off_session'  -> SUPPRESSED
 *   setup_future_usage 'on_session'   -> SUPPRESSED
 *   capture_method     'manual'       -> SUPPRESSED
 *   capture_method     'automatic_async' -> NOT suppressed   <-- the one the mechanism got wrong
 *
 * `automatic_async` looks like it should suppress ("anything that is not plain automatic capture"),
 * and it does not. Warning on it would tell every merchant running async capture to change a setting
 * that is not their problem, on carts where the rail works — which spends the credibility of the one
 * signal this whole surface exists to provide.
 *
 * This is NOT a bug to fix by forcing the rail back on. Silently rewriting a merchant's mandate or
 * capture policy is more surprising than the missing tab. Composable tried exactly that and removed
 * it. A merchant who wants bank transfer in one market says so with the fields that already exist:
 * {"DE":{"setupFutureUsage":"none"}}.
 */
export type RailSuppressionReason = 'setupFutureUsage' | 'captureMethod';

/**
 * The ONLY two values that actually bind a mandate on the PaymentIntent.
 *
 * An ACCEPT-list, mirroring what the consumer accepts, not a reject-list of the spellings that mean
 * "off". The distinction is not cosmetic: getPaymentIntentSetupFutureUsage treats anything outside
 * these two as INVALID — it logs and falls through to the saved-payment-methods default — so a
 * reject-list would report `setup_future_usage resolves to 'banana'` for a value that resolves to
 * nothing of the sort, warning a merchant about a rail that works. That is the same credibility
 * cost the measured `automatic_async` result exists to avoid, arriving through a different input.
 */
const SETUP_FUTURE_USAGE_BINDING = ['off_session', 'on_session'];

/**
 * The measured suppression predicate. Pure, and the single source of truth for both warning sites.
 */
const isBindingSetupFutureUsage = (value?: string): boolean =>
  Boolean(value && SETUP_FUTURE_USAGE_BINDING.includes(value.trim().toLowerCase()));

export const resolveRailSuppression = ({
  setupFutureUsage,
  captureMethod,
}: {
  setupFutureUsage?: string;
  captureMethod?: string;
}): RailSuppressionReason[] => {
  const reasons: RailSuppressionReason[] = [];

  const normalisedSetupFutureUsage = setupFutureUsage?.trim().toLowerCase();
  if (normalisedSetupFutureUsage && SETUP_FUTURE_USAGE_BINDING.includes(normalisedSetupFutureUsage)) {
    reasons.push('setupFutureUsage');
  }

  // ONLY 'manual'. 'automatic' and 'automatic_async' both leave the rail intact — measured.
  if (captureMethod?.trim().toLowerCase() === 'manual') {
    reasons.push('captureMethod');
  }

  return reasons;
};

/**
 * Only the four fields this check reads, derived from the real rule type with `Pick` rather than
 * redeclared structurally. An all-optional `{ [k: string]: string }` shape would accept
 * PaymentBehaviorRule no matter what happened to it — renaming `euBankTransferCountry` on the real
 * type would typecheck here and silently kill the check, which is the independent-copies drift this
 * file's own EU_BANK_TRANSFER_COUNTRIES comment warns about.
 *
 * `import type` is erased at compile time, so this does not close a runtime cycle with
 * payment-behavior-resolver.ts (which imports EuBankTransferCountry from this module).
 */
type BehaviorRuleLike = Pick<
  PaymentBehaviorRule,
  'flowType' | 'captureMethod' | 'setupFutureUsage' | 'euBankTransferCountry'
>;

export type RailSuppressionWarning = { marketKey: string; message: string };

/**
 * THE FIVE SOURCES OF `setup_future_usage`, IN THE ORDER THEY OVERRIDE EACH OTHER. This is why there
 * are TWO warnings and not one — do not remove either as redundant:
 *
 *   1. recurring cart          -> forces 'off_session'  (getPaymentIntentSetupFutureUsage, Priority 1)
 *   2. the market's rule       -> rule.setupFutureUsage                              (Priority 2)
 *   3. the flat env var        -> STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE           (Priority 3)
 *   4. saved payment methods   -> STRIPE_SAVED_PAYMENT_METHODS_CONFIG.payment_method_save_usage
 *                                                                                   (Priority 4)
 *   5. flowType 'pi_first'     -> strips it entirely, which UN-suppresses the rail
 *
 * Source 4 is easy to miss and is an ordinary configuration, not an exotic one: a merchant who turns
 * saved payment methods on with `off_session` suppresses the rail without ever touching
 * STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE. It is static, so startup must read it.
 *
 * Startup can see 2, 3, 4 and 5 — all static configuration. It cannot see 1, which depends on the
 * cart. So this function catches the merchant's static contradiction at deploy time, and the runtime
 * warning in stripe-payment.service.ts catches what only a cart reveals.
 *
 * RESOLVED 2026-08-13 — this note used to record a KNOWN LIMIT and no longer does, kept because the
 * limit it describes is the obvious thing to re-introduce. `euBankTransferCountry` came from
 * resolveTrustedPaymentBehavior (cart.country -> store.key) while `captureMethod` and
 * `setupFutureUsage` came from the untrusted resolver (cart.country -> billing -> shipping ->
 * store.key), so when cart.country was absent those selected DIFFERENT rules and a live PaymentIntent
 * could pair an IBAN from one rule with a mandate from another — a combination this per-rule check
 * structurally cannot see. All five fields now resolve through the same trusted path, so one cart
 * yields one rule and the mixed-rule PaymentIntent is no longer constructible. If a field is ever
 * moved back to a separate resolver, this limit returns and this check silently stops covering it.
 *
 * Startup is also the only one of the two that may NAME THE MARKET. Here we iterate the merchant's
 * own configuration map. The runtime site must not, because a market key can be resolved from
 * cart.billingAddress.country / shippingAddress.country — the shopper's own address.
 */
/** Where a resolved value came from, which decides both the wording and the remedy verb. */
type ValueSource = 'rule' | 'env';

/**
 * Names the config key a suppressing `setup_future_usage` actually came from.
 *
 * Extracted from the nested ternary this used to be, purely to keep
 * `findRailSuppressionAtStartup` under the cognitive complexity ceiling `connect validate`
 * enforces. Same three outcomes, same precedence.
 */
const describeSetupFutureUsageSource = (
  marketKey: string,
  source: ValueSource,
  envSetupFutureUsage?: string,
): string => {
  if (source === 'rule') {
    return `the "${marketKey}" rule`;
  }
  return isBindingSetupFutureUsage(envSetupFutureUsage)
    ? 'STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE'
    : 'STRIPE_SAVED_PAYMENT_METHODS_CONFIG.payment_method_save_usage';
};

/**
 * Builds the operator-facing warning for one suppressed market.
 *
 * The remedy is the point of this message. A warning that only describes the symptom leaves the
 * reader exactly where they started; naming the market and the literal config to type is the
 * difference between a line that gets ignored and one that ends the investigation.
 * "add" vs "set": when the offending value came from the rule itself, telling the reader to
 * "add" a field they already wrote reads as though the tool has not looked at their config.
 */
const buildRailSuppressionWarning = (opts: {
  marketKey: string;
  reasons: readonly string[];
  effectiveSetupFutureUsage?: string;
  setupFutureUsageSource: ValueSource;
  captureMethodSource: ValueSource;
  envSetupFutureUsage?: string;
}): RailSuppressionWarning => {
  const { marketKey, reasons, effectiveSetupFutureUsage, setupFutureUsageSource, captureMethodSource } = opts;

  const causes = reasons.map((reason) => {
    if (reason === 'setupFutureUsage') {
      const from = describeSetupFutureUsageSource(marketKey, setupFutureUsageSource, opts.envSetupFutureUsage);
      return `setup_future_usage resolves to '${effectiveSetupFutureUsage}' (from ${from})`;
    }
    const from = captureMethodSource === 'rule' ? `the "${marketKey}" rule` : 'STRIPE_CAPTURE_METHOD';
    return `capture_method resolves to 'manual' (from ${from})`;
  });

  const remedies = reasons.map((reason) => {
    if (reason === 'setupFutureUsage') {
      return `${setupFutureUsageSource === 'rule' ? 'set' : 'add'} "setupFutureUsage":"none"`;
    }
    return `${captureMethodSource === 'rule' ? 'set' : 'add'} "captureMethod":"automatic"`;
  });

  return {
    marketKey,
    message:
      `[config] STRIPE_PAYMENT_BEHAVIOR_RULES["${marketKey}"] sets euBankTransferCountry, but the ` +
      `bank transfer option will never appear for this market: ${causes.join(' and ')}. ` +
      `Stripe removes customer_balance from payment_method_types when the payment method cannot ` +
      `be saved or captured that way. To offer bank transfer here, ${remedies.join(' and ')} ` +
      `to the "${marketKey}" rule.`,
  };
};

/**
 * Resolves the values a market's PaymentIntent would actually carry, and where each came from.
 *
 * Kept apart from the loop so `findRailSuppressionAtStartup` stays under the complexity ceiling.
 * The precedence encoded here is the load-bearing part and is unchanged:
 *
 * `pi_first` strips setup_future_usage off the PaymentIntent, so it cannot suppress the rail.
 * For the static sources this mirrors getPaymentIntentSetupFutureUsage's priority order — the rule
 * wins over the env var, and the saved-payment-methods default applies when neither binds.
 */
const resolveEffectiveRailInputs = (
  rule: BehaviorRuleLike,
  env: {
    envSetupFutureUsage?: string;
    envCaptureMethod?: string;
    envFlowType?: string;
    savedPaymentMethodSaveUsage?: string;
  },
): {
  setupFutureUsage?: string;
  captureMethod?: string;
  setupFutureUsageSource: ValueSource;
  captureMethodSource: ValueSource;
} => {
  const flowType = rule.flowType ?? env.envFlowType;
  const staticSetupFutureUsage =
    rule.setupFutureUsage ??
    (isBindingSetupFutureUsage(env.envSetupFutureUsage) ? env.envSetupFutureUsage : env.savedPaymentMethodSaveUsage);

  return {
    setupFutureUsage: flowType === 'pi_first' ? undefined : staticSetupFutureUsage,
    captureMethod: rule.captureMethod ?? env.envCaptureMethod,
    setupFutureUsageSource: rule.setupFutureUsage !== undefined ? 'rule' : 'env',
    captureMethodSource: rule.captureMethod !== undefined ? 'rule' : 'env',
  };
};

export const findRailSuppressionAtStartup = ({
  rules,
  envSetupFutureUsage,
  envCaptureMethod,
  envFlowType,
  savedPaymentMethodSaveUsage,
}: {
  rules?: Record<string, BehaviorRuleLike>;
  envSetupFutureUsage?: string;
  envCaptureMethod?: string;
  envFlowType?: string;
  savedPaymentMethodSaveUsage?: string;
}): RailSuppressionWarning[] => {
  if (!rules) return [];

  const warnings: RailSuppressionWarning[] = [];

  for (const [marketKey, rule] of Object.entries(rules)) {
    if (!rule?.euBankTransferCountry) continue;

    const effective = resolveEffectiveRailInputs(rule, {
      envSetupFutureUsage,
      envCaptureMethod,
      envFlowType,
      savedPaymentMethodSaveUsage,
    });

    const reasons = resolveRailSuppression({
      setupFutureUsage: effective.setupFutureUsage,
      captureMethod: effective.captureMethod,
    });
    if (reasons.length === 0) continue;

    warnings.push(
      buildRailSuppressionWarning({
        marketKey,
        reasons,
        effectiveSetupFutureUsage: effective.setupFutureUsage,
        setupFutureUsageSource: effective.setupFutureUsageSource,
        captureMethodSource: effective.captureMethodSource,
        envSetupFutureUsage,
      }),
    );
  }

  return warnings;
};
