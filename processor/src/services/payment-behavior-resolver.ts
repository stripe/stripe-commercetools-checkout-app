import { Cart } from '@commercetools/connect-payments-sdk';

/**
 * A single rule applied when a cart matches a discriminator key.
 * All fields are optional — only supplied fields override the flat env vars.
 */
export interface PaymentBehaviorRule {
  flowType?: 'deferred' | 'pi_first';
  captureMethod?: 'automatic' | 'automatic_async' | 'manual';
  setupFutureUsage?: 'off_session' | 'on_session' | '' | 'none' | 'null' | 'undefined';
  collectBillingAddress?: 'auto' | 'never' | 'if_required';
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
 * Resolves the PaymentBehaviorRule that applies to a given cart.
 *
 * Lookup:
 *   1. cart discriminator key (country or store key, in priority order)
 *   2. undefined — no override; caller uses flat env var values
 *
 * No wildcard key. Env vars are always the default.
 *
 * @param config  Parsed STRIPE_PAYMENT_BEHAVIOR_RULES map. May be empty or undefined.
 * @param cart    The current CT cart.
 * @returns       The matching PaymentBehaviorRule, or undefined when no rule matches.
 */
export const resolvePaymentBehavior = (
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
