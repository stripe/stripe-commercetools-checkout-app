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
        update: jest.fn(),
        on: jest.fn(),
      }),
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
    test('should initialize and mount ExpressCheckoutElement', async () => {
      const baseOptions = createMockBaseOptions();
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      await component.mount('#express-checkout');
      
      // Verify onPayButtonClick was called
      expect(expressOptions.onPayButtonClick).toHaveBeenCalled();
      
      // Verify ExpressCheckoutElement was created with initialAmount
      expect(baseOptions.elements?.create).toHaveBeenCalledWith('expressCheckout', expect.objectContaining({
        amount: expressOptions.initialAmount.centAmount,
        currency: expressOptions.initialAmount.currencyCode.toLowerCase(),
      }));
    });

    test('should throw error if initialization fails', async () => {
      const mockElements = {
        create: jest.fn().mockReturnValue(null),
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
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      // Verify cancel event handler was registered
      expect(mockOn).toHaveBeenCalledWith('cancel', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('confirm', expect.any(Function));
    });
  });

  describe('handleShippingRateChange', () => {
    test('should call onAmountUpdated and update elements when callback is provided', async () => {
      const baseOptions = createMockBaseOptions();
      const expressOptions = createMockExpressOptions();
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      const mockUpdate = jest.fn();
      (baseOptions.elements as any).update = mockUpdate;

      const mockElement = {
        mount: jest.fn(),
        update: jest.fn(),
        on: jest.fn(),
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      // Simulate shipping rate change event
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

      // Access the private method via type assertion for testing
      await (component as any).handleShippingRateChange(event);

      expect(expressOptions.onShippingMethodSelected).toHaveBeenCalledWith({
        shippingMethod: { id: 'shipping-1' },
      });

      if (expressOptions.onAmountUpdated) {
        expect(expressOptions.onAmountUpdated).toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenCalledWith({
          amount: 2500, // initialAmount (2000) + shipping (500)
        });
      }

      expect(mockResolve).toHaveBeenCalled();
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
    test('should call onCancel callback when cancel event is triggered', async () => {
      const baseOptions = createMockBaseOptions();
      const mockOnCancel = jest.fn().mockResolvedValue(undefined);
      const expressOptions: ExpressOptions = {
        ...createMockExpressOptions(),
        onCancel: mockOnCancel,
      };
      
      const component = new StripeExpressComponent({ baseOptions, expressOptions });

      let cancelHandler: (() => Promise<void>) | null = null;
      const mockOn = jest.fn((event, handler) => {
        if (event === 'cancel') {
          cancelHandler = handler;
        }
      });
      const mockElement = {
        mount: jest.fn(),
        update: jest.fn(),
        on: mockOn,
      };
      (baseOptions.elements?.create as jest.Mock).mockReturnValue(mockElement);

      await component.mount('#express-checkout');

      // Verify cancel handler was registered
      expect(mockOn).toHaveBeenCalledWith('cancel', expect.any(Function));

      // Simulate cancel event by calling the handler
      if (cancelHandler) {
        await cancelHandler();
        // Verify onCancel was called
        expect(mockOnCancel).toHaveBeenCalled();
      } else {
        throw new Error('Cancel handler not found');
      }
    });
  });
});
