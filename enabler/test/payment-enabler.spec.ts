import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { MockPaymentEnabler } from '../src/payment-enabler/payment-enabler-mock';
import { loadStripe } from '@stripe/stripe-js';

// Mock loadStripe
jest.mock('@stripe/stripe-js', () => ({
  loadStripe: jest.fn(),
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('MockPaymentEnabler - Express Checkout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock Stripe SDK
    const mockStripe = {
      elements: jest.fn().mockReturnValue({
        create: jest.fn().mockReturnValue({
          mount: jest.fn(),
          update: jest.fn(),
          on: jest.fn(),
        }),
        update: jest.fn(),
        _options: {
          currency: 'usd',
          amount: 10000,
          country: 'US',
        },
      }),
      paymentRequest: jest.fn(),
      confirmPayment: jest.fn(),
    };
    
    (loadStripe as jest.Mock).mockResolvedValue(mockStripe);
    
    // Mock fetch for multiple calls
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      // Mock /config-element/payment
      if (url.includes('/config-element/')) {
        return Promise.resolve({
          ok: true,
          json: jest.fn().mockResolvedValue({
            cartInfo: {
              currency: 'usd',
              amount: 10000,
            },
            appearance: '{}',
            captureMethod: 'automatic',
            layout: '{"type":"tabs"}',
            collectBillingAddress: 'auto',
          }),
        });
      }
      // Mock /operations/config
      if (url.includes('/operations/config')) {
        return Promise.resolve({
          ok: true,
          json: jest.fn().mockResolvedValue({
            publishableKey: 'pk_test_1234567890',
            environment: 'test',
          }),
        });
      }
      // Mock /customer/session
      if (url.includes('/customer/session')) {
        return Promise.resolve({
          status: 204,
          json: jest.fn().mockResolvedValue(undefined),
        });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  });

  test('should create express builder for type "dropin"', async () => {
    const enabler = new MockPaymentEnabler({
      processorUrl: 'http://localhost:3000',
      sessionId: 'test-session',
    });

    // Wait for setup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const builder = await enabler.createExpressBuilder('dropin');
    expect(builder).toBeDefined();
    expect(builder.build).toBeDefined();

    const expressOptions = {
      onPayButtonClick: jest.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
      onShippingAddressSelected: jest.fn().mockResolvedValue(undefined),
      getShippingMethods: jest.fn().mockResolvedValue([]),
      onShippingMethodSelected: jest.fn().mockResolvedValue(undefined),
      onPaymentSubmit: jest.fn().mockResolvedValue(undefined),
      onComplete: jest.fn(),
      onError: jest.fn(),
      initialAmount: { centAmount: 2000, currencyCode: 'EUR', fractionDigits: 2 },
    };
    const component = builder.build(expressOptions as any);
    expect((component as any).baseOptions?.expressCheckout).toBe(true);
  });

  test('should throw error for unsupported express type', async () => {
    const enabler = new MockPaymentEnabler({
      processorUrl: 'http://localhost:3000',
      sessionId: 'test-session',
    });

    // Wait for setup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(enabler.createExpressBuilder('invalid')).rejects.toThrow(
      'Express checkout type not supported'
    );
  });
});
