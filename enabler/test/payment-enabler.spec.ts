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
      // Mock /express-config (used by createExpressBuilder when sessionId is empty)
      if (url.includes('/express-config')) {
        return Promise.resolve({
          ok: true,
          json: jest.fn().mockResolvedValue({
            publishableKey: 'pk_test_1234567890',
            environment: 'test',
          }),
        });
      }
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

  test('should create express builder for type "dropin" (with session)', async () => {
    const enabler = new MockPaymentEnabler({
      processorUrl: 'http://localhost:3000',
      sessionId: 'test-session',
    });

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

    await expect(enabler.createExpressBuilder('invalid')).rejects.toThrow(
      'Express checkout type not supported'
    );
  });

  test('should create express builder without session using POST /express-config', async () => {
    const enabler = new MockPaymentEnabler({
      processorUrl: 'http://localhost:3000',
      sessionId: '',
    });

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
    expect((global.fetch as jest.Mock).mock.calls.some((call: unknown[]) => String(call[0]).includes('/express-config'))).toBe(true);
    // Elements must NOT be created during setup — deferred to init() with real initialAmount
    expect((component as any).baseOptions?.elements).toBeNull();
  });

  test('should create elements with initialAmount when mounting express without session', async () => {
    const mockStripe = (loadStripe as jest.Mock).mock.results[0]?.value ?? await (loadStripe as jest.Mock).mock.results[0]?.value;

    const enabler = new MockPaymentEnabler({
      processorUrl: 'http://localhost:3000',
      sessionId: '',
    });

    const builder = await enabler.createExpressBuilder('dropin');
    const expressOptions = {
      onPayButtonClick: jest.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
      onShippingAddressSelected: jest.fn().mockResolvedValue(undefined),
      getShippingMethods: jest.fn().mockResolvedValue([]),
      onShippingMethodSelected: jest.fn().mockResolvedValue(undefined),
      onPaymentSubmit: jest.fn().mockResolvedValue(undefined),
      onComplete: jest.fn(),
      onError: jest.fn(),
      initialAmount: { centAmount: 3500, currencyCode: 'EUR', fractionDigits: 2 },
    };
    const component = builder.build(expressOptions as any);
    await component.mount('#express-checkout');

    // After mount, elements must have been created via sdk.elements() with initialAmount values
    expect((component as any).baseOptions?.elements).not.toBeNull();
  });

  test('should forward converted locale to stripe.elements() in standard flow', async () => {
    const enabler = new MockPaymentEnabler({
      processorUrl: 'http://localhost:3000',
      sessionId: 'test-session',
      locale: 'es-MX',
    } as any);

    await enabler.createDropinBuilder('embedded' as any);

    const mockStripe = await (loadStripe as jest.Mock).mock.results[0]?.value;
    expect(mockStripe.elements).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'es' }),
    );
  });

  test('should forward converted locale to sdk.elements() in Express without session', async () => {
    const enabler = new MockPaymentEnabler({
      processorUrl: 'http://localhost:3000',
      sessionId: '',
      locale: 'pt-BR',
    } as any);

    const builder = await enabler.createExpressBuilder('dropin');
    const expressOptions = {
      onPayButtonClick: jest.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
      onShippingAddressSelected: jest.fn().mockResolvedValue(undefined),
      getShippingMethods: jest.fn().mockResolvedValue([]),
      onShippingMethodSelected: jest.fn().mockResolvedValue(undefined),
      onPaymentSubmit: jest.fn().mockResolvedValue(undefined),
      onComplete: jest.fn(),
      onError: jest.fn(),
      initialAmount: { centAmount: 3500, currencyCode: 'EUR', fractionDigits: 2 },
    };
    const component = builder.build(expressOptions as any);
    await component.mount('#express-checkout');

    const mockStripe = await (loadStripe as jest.Mock).mock.results[0]?.value;
    expect(mockStripe.elements).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'pt-BR' }),
    );
  });
});

describe('MockPaymentEnabler - Elements Behavior (STRIPE_BEHAVIOR_PAYMENT_ELEMENT) merge', () => {
  const buildStripeMock = () => {
    const create = jest.fn().mockReturnValue({ mount: jest.fn(), update: jest.fn(), on: jest.fn() });
    const mockStripe = {
      elements: jest.fn().mockReturnValue({ create, update: jest.fn() }),
      paymentRequest: jest.fn(),
      confirmPayment: jest.fn(),
    };
    return { mockStripe, create };
  };

  const mockConfigElementResponse = (overrides: Record<string, unknown> = {}) => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/config-element/')) {
        return Promise.resolve({
          ok: true,
          json: jest.fn().mockResolvedValue({
            cartInfo: { currency: 'usd', amount: 10000 },
            appearance: '{}',
            captureMethod: 'automatic',
            layout: '{"type":"tabs"}',
            collectBillingAddress: 'auto',
            ...overrides,
          }),
        });
      }
      if (url.includes('/operations/config')) {
        return Promise.resolve({
          ok: true,
          json: jest.fn().mockResolvedValue({ publishableKey: 'pk_test_1234567890', environment: 'test' }),
        });
      }
      if (url.includes('/customer/session')) {
        return Promise.resolve({ status: 204, json: jest.fn().mockResolvedValue(undefined) });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('falls back to legacy collectBillingAddress when Field 2 is absent', async () => {
    const { mockStripe, create } = buildStripeMock();
    (loadStripe as jest.Mock).mockResolvedValue(mockStripe);
    mockConfigElementResponse({ collectBillingAddress: 'never' });

    const enabler = new MockPaymentEnabler({ processorUrl: 'http://localhost:3000', sessionId: 'test-session' });
    await enabler.createDropinBuilder('embedded');

    const elementsOptions = create.mock.calls[0][1];
    expect(elementsOptions.fields).toEqual({ billingDetails: { address: 'never' } });
    expect(elementsOptions.terms).toBeUndefined();
    expect(elementsOptions.wallets).toBeUndefined();
  });

  test('Field 2 layout takes priority over legacy STRIPE_LAYOUT', async () => {
    const { mockStripe, create } = buildStripeMock();
    (loadStripe as jest.Mock).mockResolvedValue(mockStripe);
    mockConfigElementResponse({
      layout: '{"type":"tabs"}',
      paymentElementOptions: JSON.stringify({ layout: { type: 'accordion', defaultCollapsed: true } }),
    });

    const enabler = new MockPaymentEnabler({ processorUrl: 'http://localhost:3000', sessionId: 'test-session' });
    await enabler.createDropinBuilder('embedded');

    const elementsOptions = create.mock.calls[0][1];
    expect(elementsOptions.layout).toEqual({ type: 'accordion', defaultCollapsed: true });
  });

  test('passes terms and wallets through directly when present in Field 2', async () => {
    const { mockStripe, create } = buildStripeMock();
    (loadStripe as jest.Mock).mockResolvedValue(mockStripe);
    mockConfigElementResponse({
      paymentElementOptions: JSON.stringify({
        terms: { card: 'never' },
        wallets: { applePay: 'auto', googlePay: 'never' },
      }),
    });

    const enabler = new MockPaymentEnabler({ processorUrl: 'http://localhost:3000', sessionId: 'test-session' });
    await enabler.createDropinBuilder('embedded');

    const elementsOptions = create.mock.calls[0][1];
    expect(elementsOptions.terms).toEqual({ card: 'never' });
    expect(elementsOptions.wallets).toEqual({ applePay: 'auto', googlePay: 'never' });
  });

  test('Field 2 fields.billingDetails wins entirely over legacy collectBillingAddress', async () => {
    const { mockStripe, create } = buildStripeMock();
    (loadStripe as jest.Mock).mockResolvedValue(mockStripe);
    mockConfigElementResponse({
      collectBillingAddress: 'never',
      paymentElementOptions: JSON.stringify({ fields: { billingDetails: 'auto' } }),
    });

    const enabler = new MockPaymentEnabler({ processorUrl: 'http://localhost:3000', sessionId: 'test-session' });
    await enabler.createDropinBuilder('embedded');

    const elementsOptions = create.mock.calls[0][1];
    expect(elementsOptions.fields).toEqual({ billingDetails: 'auto' });
  });
});
