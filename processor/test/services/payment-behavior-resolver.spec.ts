import { describe, expect, test } from '@jest/globals';
import {
  extractDiscriminator,
  resolvePaymentBehavior,
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

  describe('resolvePaymentBehavior', () => {
    test('returns matching rule on exact cart.country key match', () => {
      const config: PaymentBehaviorConfig = {
        MX: { captureMethod: 'manual' },
      };
      const cart = mockGetCartWithCountry('MX');
      const result = resolvePaymentBehavior(config, cart);
      expect(result).toEqual({ captureMethod: 'manual' });
    });

    test('returns undefined when config has a key but cart country does not match', () => {
      const config: PaymentBehaviorConfig = {
        MX: { captureMethod: 'manual' },
      };
      const cart = mockGetCartWithCountry('DE');
      const result = resolvePaymentBehavior(config, cart);
      expect(result).toBeUndefined();
    });

    test('returns undefined when cart discriminator matches no key in the config', () => {
      const config: PaymentBehaviorConfig = {
        CA: { flowType: 'pi_first' },
      };
      const cart = mockGetCartWithCountry('MX');
      expect(resolvePaymentBehavior(config, cart)).toBeUndefined();
    });

    test('returns undefined for an empty config map', () => {
      const cart = mockGetCartWithCountry('MX');
      expect(resolvePaymentBehavior({}, cart)).toBeUndefined();
    });

    test('returns undefined when config is undefined', () => {
      const cart = mockGetCartWithCountry('MX');
      expect(resolvePaymentBehavior(undefined, cart)).toBeUndefined();
    });

    test('returns a partial rule containing only the supplied fields', () => {
      const config: PaymentBehaviorConfig = {
        MX: { captureMethod: 'manual' },
        // No flowType, setupFutureUsage, or collectBillingAddress in this rule
      };
      const cart = mockGetCartWithCountry('MX');
      const result = resolvePaymentBehavior(config, cart);
      expect(result).toBeDefined();
      expect(result!.captureMethod).toBe('manual');
      expect(result!.flowType).toBeUndefined();
      expect(result!.setupFutureUsage).toBeUndefined();
      expect(result!.collectBillingAddress).toBeUndefined();
    });

    test('resolves rule via store.key when no country fields are present', () => {
      const config: PaymentBehaviorConfig = {
        'store-ca': { flowType: 'pi_first' },
      };
      const cart = mockGetCartWithStoreKey('store-ca');
      const result = resolvePaymentBehavior(config, cart);
      expect(result).toEqual({ flowType: 'pi_first' });
    });

    test('resolves rule via billingAddress.country when cart.country is absent', () => {
      const config: PaymentBehaviorConfig = {
        CA: { collectBillingAddress: 'if_required' },
      };
      const cart = mockGetCartWithBillingCountryOnly('CA');
      const result = resolvePaymentBehavior(config, cart);
      expect(result).toEqual({ collectBillingAddress: 'if_required' });
    });
  });
});
