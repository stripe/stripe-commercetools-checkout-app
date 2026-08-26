import { Cart } from '@commercetools/connect-payments-sdk';
import { EuBankTransferCountry } from '../mappers/bank-transfer-mapper';

/**
 * A single rule applied when a cart matches a discriminator key.
 * All fields are optional — only supplied fields override the flat env vars.
 */
export interface PaymentBehaviorRule {
  flowType?: 'deferred' | 'pi_first';
  captureMethod?: 'automatic' | 'automatic_async' | 'manual';
  setupFutureUsage?: 'off_session' | 'on_session' | '' | 'none' | 'null' | 'undefined';
  collectBillingAddress?: 'auto' | 'never' | 'if_required';
  /**
   * Merchant-configured IBAN country for EUR bank transfers. Absent is the normal case: Stripe
   * derives eu_bank_transfer from the currency on its own and defaults to an Irish IBAN. This field
   * only overrides WHICH IBAN a EUR shopper sees — a treasury preference, never a technical
   * requirement, and there is deliberately no enable flag.
   *
   * Like every field on this interface, it resolves through resolvePaymentBehaviorWithSteeringCheck,
   * which matches on merchant-controlled cart data only: it selects which of the merchant's IBANs the
   * shopper is shown, so it must not be reachable from shopper-supplied cart data.
   *
   * CALIBRATION, stated so nobody over-invests in defending this later. An earlier version of this
   * docblock said the field "selects a destination account", which reads considerably stronger than
   * the real exposure. Even with the discriminator FULLY compromised, the shopper can only select
   * among DE, FR, IE and NL — all IBANs on the MERCHANT'S OWN Stripe account, all validated against
   * EU_BANK_TRANSFER_COUNTRIES at startup (config.ts), so no unvalidated string reaches Stripe and no
   * value can name an account outside the merchant's. This is a TREASURY and FEE-ATTRIBUTION boundary
   * — who absorbs cross-border transfer fees, and whether the merchant looks like a local business —
   * NOT a fund-diversion boundary. Worth having; not worth hardening further.
   */
  euBankTransferCountry?: EuBankTransferCountry;
}

/**
 * Map of discriminator key → rule.
 * Keys are either a two-letter ISO country code (e.g. "MX") or a CT store key (e.g. "store-mx").
 * Env vars are always the default — this map contains exceptions only. No wildcard key.
 */
export interface PaymentBehaviorConfig {
  [key: string]: PaymentBehaviorRule;
}

/**
 * Narrowing type for CT Cart extended with a store reference.
 * The @commercetools/connect-payments-sdk Cart type does not expose the store field,
 * but the CT platform-sdk Cart may carry it. This interface narrows safely without any.
 */
interface CartWithStore extends Cart {
  store?: { typeId: 'store'; key: string };
}

/**
 * Extracts the discriminator value from a cart.
 * Priority:
 *   1. cart.country       — top-level field, set at cart creation, not customer-editable
 *   2. cart.billingAddress.country
 *   3. cart.shippingAddress.country
 *   4. cart.store.key
 * Returns undefined when no discriminator can be derived.
 */
export const extractDiscriminator = (cart: Cart): string | undefined => {
  if (cart.country) return cart.country;

  const billingCountry = cart.billingAddress?.country;
  if (billingCountry) return billingCountry;

  const shippingCountry = cart.shippingAddress?.country;
  if (shippingCountry) return shippingCountry;

  const storeKey = (cart as CartWithStore).store?.key;
  if (storeKey) return storeKey;

  return undefined;
};

/**
 * Resolves the rule a cart would match if SHOPPER-SUPPLIED data were allowed to select it.
 *
 * DELIBERATELY NOT EXPORTED, AND THAT IS THE WHOLE POINT — do not re-export it "because another
 * module needs it". Nothing outside this file may resolve a rule this way: the billingAddress and
 * shippingAddress fallbacks in extractDiscriminator are shopper-supplied, and the express enabler
 * writes the shopper's own address to the cart. Encapsulation is the mechanism here, not naming
 * convention: a renamed-but-exported helper is a warning anyone can ignore, an unexported symbol is
 * one nobody can reach. If you find yourself wanting this value in another module, what you actually
 * want is resolvePaymentBehaviorWithSteeringCheck below, which returns the trusted rule plus the
 * divergence signal.
 *
 * Its ONLY legitimate use is as the comparison arm of that steering check.
 *
 * @param config  Parsed STRIPE_PAYMENT_BEHAVIOR_RULES map. May be empty or undefined.
 * @param cart    The current CT cart.
 * @returns       The matching PaymentBehaviorRule, or undefined when no rule matches.
 */
const resolveUntrustedBehaviorForComparisonOnly = (
  config: PaymentBehaviorConfig | undefined,
  cart: Cart,
): PaymentBehaviorRule | undefined => {
  if (!config || Object.keys(config).length === 0) return undefined;

  const discriminator = extractDiscriminator(cart);
  if (discriminator && config[discriminator]) {
    return config[discriminator];
  }

  return undefined;
};

/**
 * Extracts the discriminator value from a cart, restricted to MERCHANT-CONTROLLED data.
 * Priority:
 *   1. cart.country   — top-level field, set at cart creation, not customer-editable
 *   2. cart.store.key — merchant-defined
 *
 * Deliberately narrower than extractDiscriminator: the billingAddress and shippingAddress fallbacks
 * are dropped. Both are shopper-supplied, and shipping country is shopper-controlled INSIDE this
 * connector rather than merely upstream of it — the express enabler writes the shopper's own
 * address to the cart (enabler/src/express/dropin-express.ts handleShippingAddressChange).
 *
 * Do not widen this "for consistency" with extractDiscriminator — the asymmetry IS the point.
 *
 * WHAT THIS DOES NOT CLAIM. The guarantee is "not shopper-controlled BY US", not "not
 * shopper-controlled". Both remaining fields are unwritable by this connector — the processor issues
 * only custom-type and custom-field actions, never setCountry or setShippingAddress — but a
 * storefront that exposes a country or store switcher still lets the shopper steer which rule
 * matches. That is upstream of this connector and not fixable here. See the calibration note on
 * PaymentBehaviorRule.euBankTransferCountry for why the residual exposure is acceptable.
 *
 * CURRENT SCOPE: ALL FIVE fields of PaymentBehaviorRule resolve through this path (2026-08-13). Until
 * then only `euBankTransferCountry` did, and this docblock recorded that limit. Nothing resolves
 * through shopper-supplied data any more — the untrusted resolver is not exported.
 */
export const extractTrustedDiscriminator = (cart: Cart): string | undefined => {
  // Truthiness rather than ?? — deliberately IDENTICAL to extractDiscriminator's fallthrough. An
  // earlier version used ?? here, which meant cart.country === '' returned '' instead of falling
  // through to the store key, silently discarding a merchant-configured store rule the untrusted
  // sibling would have honoured. Two sibling functions differing by one character, with a
  // behavioural consequence, reads as deliberate when it is not. Keep them aligned.
  if (cart.country) return cart.country;

  const storeKey = (cart as CartWithStore).store?.key;
  if (storeKey) return storeKey;

  return undefined;
};

/**
 * Resolves a rule from merchant-controlled cart data only.
 *
 * Differs from the shopper-reachable lookup when the cart has no `cart.country` and the shopper-supplied
 * billing or shipping country would have matched a rule key. In that case this either falls through
 * to the cart's store key — which is merchant-defined and therefore still trusted — or returns
 * undefined, so the caller uses the flat env var default rather than a rule the shopper selected.
 *
 * @param config  Parsed STRIPE_PAYMENT_BEHAVIOR_RULES map. May be empty or undefined.
 * @param cart    The current CT cart.
 * @returns       The matching PaymentBehaviorRule, or undefined when no rule matches.
 */
export const resolveTrustedPaymentBehavior = (
  config: PaymentBehaviorConfig | undefined,
  cart: Cart,
): PaymentBehaviorRule | undefined => {
  if (!config || Object.keys(config).length === 0) return undefined;

  const discriminator = extractTrustedDiscriminator(cart);
  if (discriminator && config[discriminator]) {
    return config[discriminator];
  }

  return undefined;
};

/**
 * Every field of PaymentBehaviorRule. The steering check must cover the whole rule surface, not the
 * subset someone remembered.
 *
 * `satisfies` alone constrains MEMBERSHIP, not COMPLETENESS — it rejects a name that is not a field,
 * but says nothing about a field that is missing from the list. A code review found that adding a
 * sixth field to the interface and forgetting it here was caught by neither tsc nor any test, so the
 * exhaustiveness assertion below does that job at compile time.
 */
const RULE_FIELDS = [
  'flowType',
  'captureMethod',
  'setupFutureUsage',
  'collectBillingAddress',
  'euBankTransferCountry',
] as const satisfies readonly (keyof PaymentBehaviorRule)[];

/**
 * Compile-time guard: fails with "Type '\"yourNewField\"' does not satisfy the constraint 'never'"
 * the moment a field is added to PaymentBehaviorRule and not to RULE_FIELDS. Do not delete this to
 * make a build pass — add the field to the list instead.
 */
type AssertNever<T extends never> = T;
type _RuleFieldsAreExhaustive = AssertNever<Exclude<keyof PaymentBehaviorRule, (typeof RULE_FIELDS)[number]>>;

export interface BehaviorResolution {
  /** The rule to use. Always resolved from merchant-controlled cart data only. */
  rule: PaymentBehaviorRule | undefined;
  /**
   * Fields where shopper-supplied cart data WOULD have selected a different value. Field names only,
   * never values — see the asymmetry note below.
   */
  steeredFields: (keyof PaymentBehaviorRule)[];
}

/**
 * THE ONLY WAY TO RESOLVE A BEHAVIOR RULE. Returns the trusted rule together with a signal for
 * whether shopper-supplied data would have selected something different.
 *
 * WHY THIS EXISTS AS ONE FUNCTION INSTEAD OF TWO EXPORTED RESOLVERS. Callers previously resolved the
 * trusted and untrusted rules separately and picked fields from whichever they happened to reference.
 * That let four of the five fields keep resolving through shopper-supplied data long after the
 * trusted path existed, because nothing forced the choice to be made once. Returning a single
 * resolution removes the choice: there is no untrusted rule object to read a field off.
 *
 * EVERY CALLER MUST USE THE SAME RESOLUTION FOR EVERY FIELD, AND ALL CALL SITES MUST AGREE.
 * createPaymentIntentStripe builds the PaymentIntent; initializeCartPayment tells the enabler how to
 * render the element. If the two disagree, Stripe validates the deferred element options against the
 * retrieved intent and rejects the confirm — a market-wide checkout outage rather than a cosmetic
 * mismatch. For collectBillingAddress the breakage is directional: an element configured to hide the
 * address fields while the processor sends no billing_details is rejected, whereas the inverse is
 * harmless. There is a test asserting the two sites resolve identically; if it fails, do not weaken
 * it — one of the two sites has drifted.
 *
 * THE STEERING SIGNAL IS DELIBERATELY ASYMMETRIC, and this is the part most likely to be "fixed" into
 * uselessness. It fires ONLY when the untrusted path would have picked a value and the trusted path
 * did not pick that same one. It stays silent when the trusted path finds a rule the untrusted one
 * missed, because the two fallback orders differ rather than nest — extractDiscriminator tries
 * billing/shipping BEFORE store.key, extractTrustedDiscriminator skips straight to store.key — so a
 * shopper address can SHADOW a store-key rule on the untrusted path. That direction is benign: it is
 * the merchant's own configuration working correctly, and under express checkout (which writes the
 * shopper's address to the cart) it would be the PERMANENT state for any merchant using store-key
 * rules. A symmetric comparison would sit at 100% true for them and be worthless as a signal.
 *
 * FIELD NAMES ONLY, NEVER VALUES. Callers log this. A rule is selected by cart.billingAddress.country
 * or cart.shippingAddress.country — the shopper's own address — and the call sites already log
 * cartId, which resolves to an identified customer. Emitting which FIELDS diverged is enough to
 * diagnose; emitting the values would leak the discriminator that selected them.
 */
export const resolvePaymentBehaviorWithSteeringCheck = (
  config: PaymentBehaviorConfig | undefined,
  cart: Cart,
): BehaviorResolution => {
  const rule = resolveTrustedPaymentBehavior(config, cart);
  const untrusted = resolveUntrustedBehaviorForComparisonOnly(config, cart);

  // The ONLY silent case: shopper-supplied data selected no rule at all. That is the benign
  // shadowing direction described above, and it is the permanent state for store-key merchants under
  // express checkout, so reporting it would make the signal worthless.
  //
  // Everything else compares field by field. An earlier version instead gated per field on
  // `untrusted?.[field] !== undefined`, which was broader than this justification and created a real
  // blind spot found in review: when the shopper's address matched a DIFFERENT configured rule that
  // simply lacked the field, the comparison was skipped and the divergence went unreported. The
  // question this signal answers is "which fields would have had a different EFFECTIVE value had
  // shopper data been trusted", so absence on either side is part of the answer, not a reason to skip.
  if (untrusted === undefined) {
    return { rule, steeredFields: [] };
  }

  const steeredFields = RULE_FIELDS.filter((field) => untrusted[field] !== rule?.[field]);

  return { rule, steeredFields };
};
