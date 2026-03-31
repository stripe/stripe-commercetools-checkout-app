import { describe, test, expect, jest } from '@jest/globals';
import { StripeExpressBuilder, StripeExpressComponent } from '../../src/express/dropin-express';
import { DefaultExpressComponent } from '../../src/express/base';
import { BaseOptions } from '../../src/payment-enabler/payment-enabler-mock';
import { ExpressOptions } from '../../src/payment-enabler/payment-enabler';
import { Stripe, StripeElements } from '@stripe/stripe-js';

describe('StripeExpressBuilder', () => {
  const createMockBaseOptions = (): BaseOptions => {
    const mockElements = {
      create: jest.fn(),
      _options: {
        currency: 'usd',
        amount: 10000,
        country: 'US',
      },
    } as unknown as StripeElements;

    const mockSdk = {
      paymentRequest: jest.fn(),
    } as unknown as Stripe;

    return {
      sdk: mockSdk,
      environment: 'test',
      processorUrl: 'http://localhost:3000',
      sessionId: 'test-session',
      onComplete: jest.fn(),
      onError: jest.fn(),
      paymentElement: {} as any,
      elements: mockElements,
    };
  };

  const createMockExpressOptions = (): ExpressOptions => ({
    onPayButtonClick: jest.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    onShippingAddressSelected: jest.fn().mockResolvedValue(undefined),
    getShippingMethods: jest.fn().mockResolvedValue([]),
    onShippingMethodSelected: jest.fn().mockResolvedValue(undefined),
    onPaymentSubmit: jest.fn().mockResolvedValue(undefined),
    onComplete: jest.fn(),
    onError: jest.fn(),
    initialAmount: {
      centAmount: 2000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    },
  });

  test('should create StripeExpressComponent following template framework', () => {
    const builder = new StripeExpressBuilder(createMockBaseOptions());
    const component = builder.build(createMockExpressOptions());
    expect(component).toBeInstanceOf(DefaultExpressComponent);
    expect(component).toBeInstanceOf(StripeExpressComponent);
    expect(component.mount).toBeDefined();
  });
});

describe('StripeExpressComponent', () => {
  const createMockBaseOptions = (overrides?: Partial<BaseOptions>): BaseOptions => {
    const mockElements = {
      create: jest.fn().mockReturnValue({
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: jest.fn(),
      }),
      update: jest.fn(),
      _options: {
        currency: 'usd',
        amount: 10000,
        country: 'US',
      },
    } as unknown as StripeElements;

    const mockSdk = {
      paymentRequest: jest.fn(),
      confirmPayment: jest.fn(),
    } as unknown as Stripe;

    return {
      sdk: mockSdk,
      environment: 'test',
      processorUrl: 'http://localhost:3000',
      sessionId: 'test-session',
      onComplete: jest.fn(),
      onError: jest.fn(),
      paymentElement: {} as any,
      elements: mockElements,
      ...overrides,
    };
  };

  const createMockExpressOptions = (): ExpressOptions => ({
    onPayButtonClick: jest.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    onShippingAddressSelected: jest.fn().mockResolvedValue(undefined),
    getShippingMethods: jest.fn().mockResolvedValue([]),
    onShippingMethodSelected: jest.fn().mockResolvedValue(undefined),
    onPaymentSubmit: jest.fn().mockResolvedValue(undefined),
    onComplete: jest.fn(),
    onError: jest.fn(),
    initialAmount: {
      centAmount: 2000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    },
  });

  describe('mount', () => {
    test('should initialize and mount ExpressCheckoutElement without calling onPayButtonClick', async () => {
      const baseOptions = createMockBaseOptions();
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      await component.mount('#express-checkout');

      // Mount binds listeners; onPayButtonClick runs on Stripe `click` or ensureSessionId fallback, not on mount
      expect(expressOptions.onPayButtonClick).not.toHaveBeenCalled();

      // Verify ExpressCheckoutElement was created with shipping/billing required
      expect(baseOptions.elements?.create).toHaveBeenCalledWith('expressCheckout', expect.objectContaining({
        shippingAddressRequired: true,
        billingAddressRequired: true,
      }));
    });

    test('should register click handler for Express wallet', async () => {
      const baseOptions = createMockBaseOptions();
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      const mockOn = jest.fn();
      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      expect(mockOn).toHaveBeenCalledWith('click', expect.any(Function));
    });

    test('should throw error if initialization fails', async () => {
      const mockElements = {
        create: jest.fn().mockReturnValue(null),
        update: jest.fn(),
        _options: {
          currency: 'usd',
          amount: 10000,
          country: 'US',
        },
      } as unknown as StripeElements;

      const baseOptions = createMockBaseOptions({ elements: mockElements });
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      await expect(component.mount('#express-checkout')).rejects.toThrow(
        'Failed to initialize Express Checkout element.'
      );
      expect(baseOptions.onError).toHaveBeenCalled();
    });

    test('should register cancel event handler', async () => {
      const baseOptions = createMockBaseOptions();
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      const mockOn = jest.fn();
      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      // Verify cancel event handler was registered
      expect(mockOn).toHaveBeenCalledWith('cancel', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('confirm', expect.any(Function));
    });

    test('simulated Stripe click calls onPayButtonClick when there is no initial session', async () => {
      const baseOptions = createMockBaseOptions({ sessionId: '' });
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      let clickHandler: ((e: { resolve: jest.Mock; expressPaymentType: string; elementType: string }) => void) | null =
        null;
      const mockOn = jest.fn((event: string, handler: typeof clickHandler) => {
        if (event === 'click') clickHandler = handler as typeof clickHandler;
      });
      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      expect(clickHandler).not.toBeNull();
      const mockResolve = jest.fn();
      clickHandler!({
        resolve: mockResolve,
        expressPaymentType: 'google_pay',
        elementType: 'expressCheckout',
      });

      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({
          lineItems: [{ name: 'Total', amount: 2000 }],
        })
      );

      await new Promise<void>((r) => setImmediate(r));
      expect(expressOptions.onPayButtonClick).toHaveBeenCalled();
    });

    test('simulated Stripe click calls onPayButtonClick even when enabler already has sessionId', async () => {
      const baseOptions = createMockBaseOptions({ sessionId: 'prebound-session' });
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      let clickHandler: ((e: { resolve: jest.Mock; expressPaymentType: string; elementType: string }) => void) | null =
        null;
      const mockOn = jest.fn((event: string, handler: typeof clickHandler) => {
        if (event === 'click') clickHandler = handler as typeof clickHandler;
      });
      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      expect(clickHandler).not.toBeNull();
      clickHandler!({
        resolve: jest.fn(),
        expressPaymentType: 'google_pay',
        elementType: 'expressCheckout',
      });

      await new Promise<void>((r) => setImmediate(r));
      expect(expressOptions.onPayButtonClick).toHaveBeenCalledTimes(1);
    });

    test('each simulated Stripe click invokes onPayButtonClick again', async () => {
      const baseOptions = createMockBaseOptions({ sessionId: '' });
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      let clickHandler: ((e: { resolve: jest.Mock; expressPaymentType: string; elementType: string }) => void) | null =
        null;
      const mockOn = jest.fn((event: string, handler: typeof clickHandler) => {
        if (event === 'click') clickHandler = handler as typeof clickHandler;
      });
      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      const payload = {
        resolve: jest.fn(),
        expressPaymentType: 'google_pay',
        elementType: 'expressCheckout',
      };
      clickHandler!(payload);
      await new Promise<void>((r) => setImmediate(r));
      clickHandler!(payload);
      await new Promise<void>((r) => setImmediate(r));

      expect(expressOptions.onPayButtonClick).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleShippingRateChange', () => {
    test('should call getInitialPaymentData and update elements when shipping rate changes', async () => {
      const baseOptions = createMockBaseOptions();
      const expressOptions = createMockExpressOptions();
      (expressOptions.onPayButtonClick as jest.Mock).mockResolvedValue({ sessionId: 'test-session-id' });
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      const mockUpdate = jest.fn();
      (baseOptions.elements as any).update = mockUpdate;

      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: jest.fn(),
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            totalPrice: { centAmount: 2500, currencyCode: 'EUR', fractionDigits: 2 },
            currencyCode: 'EUR',
            lineItems: [
              { name: 'Subtotal', amount: { centAmount: 2000, currencyCode: 'EUR', fractionDigits: 2 }, type: 'SUBTOTAL' },
              { name: 'Standard Shipping', amount: { centAmount: 500, currencyCode: 'EUR', fractionDigits: 2 }, type: 'SHIPPING' },
            ],
          }),
      });
      global.fetch = mockFetch;

      await component.mount('#express-checkout');

      const mockResolve = jest.fn();
      const mockReject = jest.fn();
      const event = {
        shippingRate: {
          id: 'shipping-1',
          amount: 500,
          displayName: 'Standard Shipping',
        },
        resolve: mockResolve,
        reject: mockReject,
      };

      await (component as any).handleShippingRateChange(event);

      expect(expressOptions.onShippingMethodSelected).toHaveBeenCalledWith({
        shippingMethod: { id: 'shipping-1' },
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/express-payment-data',
        expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'x-session-id': 'test-session' }) }),
      );
      expect(mockUpdate).toHaveBeenCalledWith({ amount: 2500 });
      expect(mockResolve).toHaveBeenCalledWith({
        lineItems: [
          { name: 'Subtotal', amount: 2000 },
          { name: 'Standard Shipping', amount: 500 },
        ],
      });
    });
  });

  describe('expressCheckout header', () => {
    test('should include x-express-checkout header when baseOptions.expressCheckout is true', async () => {
      const baseOptions = createMockBaseOptions({ expressCheckout: true });
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      const headers = (component as any).getHeadersConfig();
      expect(headers['x-express-checkout']).toBe('true');
    });
  });

  describe('handleCancel', () => {
    test('should call baseOptions.onError with name CANCEL when cancel event is triggered', async () => {
      const baseOptions = createMockBaseOptions();
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      let cancelHandler: (() => void) | null = null;
      const mockOn = jest.fn((event, handler) => {
        if (event === 'cancel') {
          cancelHandler = handler;
        }
      });
      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      // Verify cancel handler was registered
      expect(mockOn).toHaveBeenCalledWith('cancel', expect.any(Function));

      // Simulate cancel event by calling the handler
      if (cancelHandler) {
        cancelHandler();
        // Verify onError was called with name CANCEL
        expect(baseOptions.onError).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'CANCEL' }),
        );
      } else {
        throw new Error('Cancel handler not found');
      }
    });

    test('resets session state to initial enabler session after cancel', async () => {
      const baseOptions = createMockBaseOptions({ sessionId: 'initial-session' });
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      let clickHandler: ((e: { resolve: jest.Mock }) => void) | null = null;
      let cancelHandler: (() => Promise<void>) | null = null;
      const mockOn = jest.fn((event: string, handler: unknown) => {
        if (event === 'click') clickHandler = handler as typeof clickHandler;
        if (event === 'cancel') cancelHandler = handler as typeof cancelHandler;
      });
      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      clickHandler!({ resolve: jest.fn() });
      await new Promise<void>((r) => setImmediate(r));
      expect((component as unknown as { currentSessionId: string }).currentSessionId).toBe('test-session-id');

      await cancelHandler!();
      expect((component as unknown as { currentSessionId: string }).currentSessionId).toBe('initial-session');
    });
  });

  describe('handlePaymentConfirm / onPaymentSubmit payload', () => {
    const paymentRes = {
      sClientSecret: 'cs_test',
      paymentReference: 'pay-ref',
      merchantReturnUrl: 'https://example.com/return',
      cartId: 'cart-1',
    };

    /**
     * Mounts Express with a confirm handler wired; `elements.submit` and `sdk.confirmPayment` mocked.
     */
    async function mountWithConfirmHandler(elementProps?: Record<string, unknown>) {
      let confirmHandler: (() => Promise<void>) | null = null;
      const mockOn = jest.fn((event: string, handler: () => Promise<void>) => {
        if (event === 'confirm') confirmHandler = handler;
      });
      const mockElement = {
        mount: jest.fn(),
        unmount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
        ...elementProps,
      };
      const mockSubmit = jest.fn().mockResolvedValue({});
      const mockElements = {
        create: jest.fn().mockReturnValue(mockElement),
        update: jest.fn(),
        submit: mockSubmit,
        _options: { currency: 'usd', amount: 10000, country: 'US' },
      } as unknown as StripeElements;

      const mockConfirmPayment = jest.fn().mockResolvedValue({
        error: undefined,
        paymentIntent: { id: 'pi_123', status: 'succeeded' },
      });
      const mockSdk = {
        paymentRequest: jest.fn(),
        confirmPayment: mockConfirmPayment,
      } as unknown as Stripe;

      const baseOptions = createMockBaseOptions({
        sdk: mockSdk,
        elements: mockElements,
      });
      const expressOptions = createMockExpressOptions();

      const mockFetch = jest.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes('/payments') && !u.includes('confirmPayments')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(paymentRes),
          });
        }
        if (u.includes('confirmPayments')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        return Promise.reject(new Error(`unexpected fetch ${u}`));
      });
      global.fetch = mockFetch as typeof fetch;

      const component = new StripeExpressComponent({ baseOptions, expressOptions });
      await component.mount('#express-checkout');

      expect(confirmHandler).not.toBeNull();
      return {
        component,
        expressOptions,
        confirmHandler: confirmHandler!,
        mockSubmit,
        mockConfirmPayment,
      };
    }

    test('does not call onPaymentSubmit when wallet exposes no address or email', async () => {
      const { expressOptions, confirmHandler } = await mountWithConfirmHandler();
      await confirmHandler();
      await new Promise<void>((r) => setImmediate(r));
      expect(expressOptions.onPaymentSubmit).not.toHaveBeenCalled();
    });

    test('calls onPaymentSubmit with billingAddress only when shipping is absent', async () => {
      const { expressOptions, confirmHandler } = await mountWithConfirmHandler({
        _lastBillingAddress: {
          address: { country: 'DE', line1: '1 Hauptstraße' },
          email: 'buyer@example.com',
        },
      });
      await confirmHandler();
      await new Promise<void>((r) => setImmediate(r));
      expect(expressOptions.onPaymentSubmit).toHaveBeenCalledTimes(1);
      const payload = (expressOptions.onPaymentSubmit as jest.Mock).mock.calls[0][0];
      expect(payload.shippingAddress).toBeUndefined();
      expect(payload.billingAddress).toEqual(
        expect.objectContaining({ country: 'DE', email: 'buyer@example.com' }),
      );
      expect(payload.customerEmail).toBe('buyer@example.com');
    });

    test('calls onPaymentSubmit with customerEmail only when addresses have no country', async () => {
      const { expressOptions, confirmHandler } = await mountWithConfirmHandler({
        _lastBillingAddress: {
          email: 'only@email.test',
          address: {},
        },
      });
      await confirmHandler();
      await new Promise<void>((r) => setImmediate(r));
      expect(expressOptions.onPaymentSubmit).toHaveBeenCalledTimes(1);
      const payload = (expressOptions.onPaymentSubmit as jest.Mock).mock.calls[0][0];
      expect(payload).toEqual({ customerEmail: 'only@email.test' });
    });
  });
});
