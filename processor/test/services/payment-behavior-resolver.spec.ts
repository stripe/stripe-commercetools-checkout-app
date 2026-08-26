import { describe, expect, test } from '@jest/globals';
import {
  extractDiscriminator,
  extractTrustedDiscriminator,
  resolvePaymentBehaviorWithSteeringCheck,
  resolveTrustedPaymentBehavior,
  PaymentBehaviorConfig,
} from '../../src/services/payment-behavior-resolver';
import {
  mockGetCartWithCountry,
  mockGetCartWithBillingCountryOnly,
  mockGetCartWithShippingCountryOnly,
  mockGetCartWithStoreKey,
  mockGetCartResult,
} from '../utils/mock-cart-data';

describe('payment-behavior-resolver', () => {
  describe('extractDiscriminator', () => {
    test('cart.country wins when all other fields are also present', () => {
      const cart = mockGetCartWithCountry('MX');
      // cart.country = 'MX', billingAddress.country = 'US', shippingAddress.country = 'US'
      expect(extractDiscriminator(cart)).toBe('MX');
    });

    test('falls back to billingAddress.country when cart.country is absent', () => {
      const cart = mockGetCartWithBillingCountryOnly('CA');
      expect(extractDiscriminator(cart)).toBe('CA');
    });

    test('falls back to shippingAddress.country when cart.country and billingAddress are absent', () => {
      const cart = mockGetCartWithShippingCountryOnly('BR');
      expect(extractDiscriminator(cart)).toBe('BR');
    });

    test('falls back to store.key when no country fields are present', () => {
      const cart = mockGetCartWithStoreKey('store-mx');
      expect(extractDiscriminator(cart)).toBe('store-mx');
    });

    test('returns undefined when no discriminator can be derived', () => {
      const cart = {
        ...mockGetCartResult(),
        country: undefined,
        billingAddress: undefined,
        shippingAddress: undefined,
      };
      expect(extractDiscriminator(cart as any)).toBeUndefined();
    });
  });

  /**
   * These previously exercised the untrusted resolver directly. That symbol is now module-private on
   * purpose — see its docblock — so they exercise the public API instead. The behaviour they pin is
   * unchanged where it should be, and inverted where the whole point of this change was to invert it.
   */
  describe('resolvePaymentBehaviorWithSteeringCheck', () => {
    test('returns matching rule on exact cart.country key match', () => {
      const config: PaymentBehaviorConfig = { MX: { captureMethod: 'manual' } };
      const { rule, steeredFields } = resolvePaymentBehaviorWithSteeringCheck(config, mockGetCartWithCountry('MX'));
      expect(rule).toEqual({ captureMethod: 'manual' });
      // cart.country is merchant-controlled, so both resolvers agree and nothing was steered.
      expect(steeredFields).toEqual([]);
    });

    test('returns undefined when config has a key but cart country does not match', () => {
      const config: PaymentBehaviorConfig = { MX: { captureMethod: 'manual' } };
      expect(resolvePaymentBehaviorWithSteeringCheck(config, mockGetCartWithCountry('DE')).rule).toBeUndefined();
    });

    test('returns undefined when cart discriminator matches no key in the config', () => {
      const config: PaymentBehaviorConfig = { CA: { flowType: 'pi_first' } };
      expect(resolvePaymentBehaviorWithSteeringCheck(config, mockGetCartWithCountry('MX')).rule).toBeUndefined();
    });

    test('returns undefined for an empty config map', () => {
      expect(resolvePaymentBehaviorWithSteeringCheck({}, mockGetCartWithCountry('MX')).rule).toBeUndefined();
    });

    test('returns undefined when config is undefined', () => {
      expect(resolvePaymentBehaviorWithSteeringCheck(undefined, mockGetCartWithCountry('MX')).rule).toBeUndefined();
    });

    test('returns a partial rule containing only the supplied fields', () => {
      const config: PaymentBehaviorConfig = { MX: { captureMethod: 'manual' } };
      const { rule } = resolvePaymentBehaviorWithSteeringCheck(config, mockGetCartWithCountry('MX'));
      expect(rule).toBeDefined();
      expect(rule!.captureMethod).toBe('manual');
      expect(rule!.flowType).toBeUndefined();
      expect(rule!.setupFutureUsage).toBeUndefined();
      expect(rule!.collectBillingAddress).toBeUndefined();
    });

    test('resolves rule via store.key when no country fields are present', () => {
      const config: PaymentBehaviorConfig = { 'store-ca': { flowType: 'pi_first' } };
      const { rule, steeredFields } = resolvePaymentBehaviorWithSteeringCheck(
        config,
        mockGetCartWithStoreKey('store-ca'),
      );
      // store.key is merchant-defined, so it is honoured on the trusted path.
      expect(rule).toEqual({ flowType: 'pi_first' });
      expect(steeredFields).toEqual([]);
    });

    /**
     * THE CASE THAT DOES NOT EXIST IN THE REAL DATA, AND THAT IS WHY IT IS BUILT BY HAND.
     *
     * A read-only sweep of the 200 most recently modified carts in the real commercetools project
     * found 100% carry cart.country, so the untrusted billing/shipping fallback never fires there and
     * neither the flaw nor this fix is observable in that data. That is a fact about ONE project
     * populated by ONE example storefront — it is not a guarantee for a merchant storefront that does
     * not set cart.country. So the fixture below is deliberately constructed rather than sampled, and
     * this comment is the honest label for it.
     */
    describe('a cart with no cart.country, where the two resolvers disagree', () => {
      test('does NOT honour a rule reachable only through a shopper-supplied billing country', () => {
        const config: PaymentBehaviorConfig = { CA: { collectBillingAddress: 'if_required' } };
        const cart = mockGetCartWithBillingCountryOnly('CA');

        // The untrusted path WOULD have matched — asserted through the extractor, since the resolver
        // itself is no longer reachable from here.
        expect(extractDiscriminator(cart)).toBe('CA');
        expect(extractTrustedDiscriminator(cart)).toBeUndefined();

        const { rule, steeredFields } = resolvePaymentBehaviorWithSteeringCheck(config, cart);
        expect(rule).toBeUndefined();
        expect(steeredFields).toEqual(['collectBillingAddress']);
      });

      test('reports EVERY steered field, not just the first', () => {
        // Guards the RULE_FIELDS list: a field added to PaymentBehaviorRule but not to that list
        // would silently drop out of the signal.
        const config: PaymentBehaviorConfig = {
          CA: {
            flowType: 'pi_first',
            captureMethod: 'manual',
            setupFutureUsage: 'off_session',
            collectBillingAddress: 'never',
            euBankTransferCountry: 'NL',
          },
        };
        const { rule, steeredFields } = resolvePaymentBehaviorWithSteeringCheck(
          config,
          mockGetCartWithBillingCountryOnly('CA'),
        );
        expect(rule).toBeUndefined();
        expect(steeredFields.sort()).toEqual(
          ['captureMethod', 'collectBillingAddress', 'euBankTransferCountry', 'flowType', 'setupFutureUsage'].sort(),
        );
      });

      test('does NOT honour a rule reachable only through a shopper-supplied shipping country', () => {
        const config: PaymentBehaviorConfig = { BR: { captureMethod: 'manual' } };
        const cart = mockGetCartWithShippingCountryOnly('BR');
        const { rule, steeredFields } = resolvePaymentBehaviorWithSteeringCheck(config, cart);
        expect(rule).toBeUndefined();
        expect(steeredFields).toEqual(['captureMethod']);
      });
    });

    test('stays SILENT when the trusted path finds a rule the untrusted one missed', () => {
      // The benign direction, and the reason the signal is one-directional. The two fallback orders
      // differ rather than nest, so a shopper address can shadow a store-key rule on the untrusted
      // path. A symmetric comparison would sit at 100% true for any merchant using store-key rules
      // under express checkout, which would make the signal worthless.
      const config: PaymentBehaviorConfig = { 'store-mx': { captureMethod: 'manual' } };
      const cart = { ...mockGetCartResult(), country: undefined, store: { typeId: 'store', key: 'store-mx' } };

      const { rule, steeredFields } = resolvePaymentBehaviorWithSteeringCheck(config, cart as any);
      expect(rule).toEqual({ captureMethod: 'manual' });
      expect(steeredFields).toEqual([]);
    });
  });

  describe('extractTrustedDiscriminator', () => {
    // Narrower than extractDiscriminator on purpose: it accepts only merchant-controlled cart data.
    // The asymmetry between the two IS the mechanism, so these tests assert the DIFFERENCE, not
    // just the behavior of each in isolation.

    test('uses cart.country when present', () => {
      expect(extractTrustedDiscriminator(mockGetCartWithCountry('MX'))).toBe('MX');
    });

    test('falls back to store.key — merchant-defined, so trusted', () => {
      expect(extractTrustedDiscriminator(mockGetCartWithStoreKey('store-mx'))).toBe('store-mx');
    });

    test('IGNORES billingAddress.country where extractDiscriminator accepts it', () => {
      const cart = mockGetCartWithBillingCountryOnly('CA');
      expect(extractDiscriminator(cart)).toBe('CA');
      expect(extractTrustedDiscriminator(cart)).toBeUndefined();
    });

    test('IGNORES shippingAddress.country where extractDiscriminator accepts it', () => {
      // Shipping country is shopper-controlled inside this connector, not merely upstream of it:
      // the express enabler writes the shopper's own address to the cart.
      const cart = mockGetCartWithShippingCountryOnly('BR');
      expect(extractDiscriminator(cart)).toBe('BR');
      expect(extractTrustedDiscriminator(cart)).toBeUndefined();
    });

    test('returns undefined when no trusted discriminator can be derived', () => {
      const cart = {
        ...mockGetCartResult(),
        country: undefined,
        billingAddress: undefined,
        shippingAddress: undefined,
      };
      expect(extractTrustedDiscriminator(cart as any)).toBeUndefined();
    });

    test('falls through a shopper-supplied country to the store key rather than to undefined', () => {
      // The two resolvers do not merely differ by "trusted returns undefined". With no cart.country,
      // a billing country matching one rule and a store key matching another, the untrusted path
      // picks the billing rule and the trusted path picks the STORE rule — store keys are
      // merchant-defined and therefore still trusted. Pinned because the earlier docblock described
      // this case incorrectly.
      const cart = {
        ...mockGetCartResult(),
        country: undefined,
        billingAddress: { country: 'CA' },
        shippingAddress: undefined,
        store: { typeId: 'store', key: 'store-mx' },
      };
      expect(extractDiscriminator(cart as any)).toBe('CA');
      expect(extractTrustedDiscriminator(cart as any)).toBe('store-mx');
    });

    test('an empty cart.country falls through to store.key in BOTH siblings, identically', () => {
      // The point of this test is not the likelihood of country: '' — commercetools validates
      // country codes, so it is improbable. The point is to PIN that the two sibling functions
      // treat a falsy country the same way.
      //
      // An earlier version of extractTrustedDiscriminator used `??` where extractDiscriminator uses
      // truthiness. That one-character difference made '' a valid discriminator on the trusted path
      // only, so it stopped falling through to the store key and silently discarded a
      // merchant-configured store rule that the untrusted sibling honoured. If anyone diverges them
      // again, this test fails.
      const cart = {
        ...mockGetCartResult(),
        country: '',
        billingAddress: undefined,
        shippingAddress: undefined,
        store: { typeId: 'store', key: 'store-mx' },
      };
      expect(extractDiscriminator(cart as any)).toBe('store-mx');
      expect(extractTrustedDiscriminator(cart as any)).toBe('store-mx');
      expect(extractTrustedDiscriminator(cart as any)).toBe(extractDiscriminator(cart as any));
    });

    test('an empty cart.country with no store key returns undefined in BOTH siblings', () => {
      const cart = {
        ...mockGetCartResult(),
        country: '',
        billingAddress: undefined,
        shippingAddress: undefined,
      };
      expect(extractDiscriminator(cart as any)).toBeUndefined();
      expect(extractTrustedDiscriminator(cart as any)).toBeUndefined();
    });
  });

  describe('resolveTrustedPaymentBehavior', () => {
    test('resolves on cart.country exactly like the untrusted resolver', () => {
      const config: PaymentBehaviorConfig = { MX: { euBankTransferCountry: 'DE' } };
      const cart = mockGetCartWithCountry('MX');
      expect(resolveTrustedPaymentBehavior(config, cart)).toEqual({ euBankTransferCountry: 'DE' });
    });

    test('resolves on store.key', () => {
      const config: PaymentBehaviorConfig = { 'store-ca': { euBankTransferCountry: 'FR' } };
      const cart = mockGetCartWithStoreKey('store-ca');
      expect(resolveTrustedPaymentBehavior(config, cart)).toEqual({ euBankTransferCountry: 'FR' });
    });

    test('does NOT honour a rule reachable only through a shopper-supplied billing country', () => {
      // The load-bearing case. Same config, same cart, two different answers — the untrusted
      // resolver lets the shopper select which IBAN they are shown; the trusted one falls back to
      // the flat env var instead.
      const config: PaymentBehaviorConfig = { CA: { euBankTransferCountry: 'NL' } };
      const cart = mockGetCartWithBillingCountryOnly('CA');
      expect(extractDiscriminator(cart)).toBe('CA');
      expect(resolveTrustedPaymentBehavior(config, cart)).toBeUndefined();
    });

    test('does NOT honour a rule reachable only through a shopper-supplied shipping country', () => {
      const config: PaymentBehaviorConfig = { BR: { euBankTransferCountry: 'IE' } };
      const cart = mockGetCartWithShippingCountryOnly('BR');
      expect(extractDiscriminator(cart)).toBe('BR');
      expect(resolveTrustedPaymentBehavior(config, cart)).toBeUndefined();
    });

    test('returns undefined for an empty config map', () => {
      expect(resolveTrustedPaymentBehavior({}, mockGetCartWithCountry('MX'))).toBeUndefined();
    });

    test('returns undefined when config is undefined', () => {
      expect(resolveTrustedPaymentBehavior(undefined, mockGetCartWithCountry('MX'))).toBeUndefined();
    });

    test('returns undefined when the trusted discriminator matches no key', () => {
      const config: PaymentBehaviorConfig = { CA: { euBankTransferCountry: 'DE' } };
      expect(resolveTrustedPaymentBehavior(config, mockGetCartWithCountry('MX'))).toBeUndefined();
    });
  });
});
