import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { DropinComponents } from '../../src/dropin/dropin-embedded';
import { BaseOptions } from '../../src/payment-enabler/payment-enabler-mock';
import { DropinOptions } from '../../src/payment-enabler/payment-enabler';
import { Stripe, StripeElements, StripePaymentElement } from '@stripe/stripe-js';

/**
 * Guards the fulfillment decision in confirmPaymentIntent (dropin-embedded.ts).
 * The security-critical property: the enabler must NEVER signal success
 * (onComplete({ isSuccess: true })) while the PaymentIntent is still `processing`
 * (crypto/stablecoin async settlement) — otherwise the merchant fulfills the order
 * before the funds settle. The order is created later by the webhook on succeeded.
 */
describe('DropinComponents.confirmPaymentIntent — outcome branching (anti premature fulfillment)', () => {
  const PROCESSOR_URL = 'http://localhost:8080';
  const PAYMENT_REFERENCE = 'pay-ref-1';
  const PAYMENT_INTENT_ID = 'pi_test_123';

  const createBaseOptions = (overrides?: Partial<BaseOptions>): BaseOptions =>
    ({
      sdk: {} as unknown as Stripe,
      environment: 'test',
      processorUrl: PROCESSOR_URL,
      sessionId: 'test-session',
      onComplete: jest.fn(),
      onError: jest.fn(),
      paymentElement: {} as unknown as StripePaymentElement,
      elements: {} as unknown as StripeElements,
      ...overrides,
    }) as unknown as BaseOptions;

  const buildComponent = (baseOptions: BaseOptions): DropinComponents =>
    new DropinComponents({ baseOptions, dropinOptions: {} as DropinOptions });

  // confirmPaymentIntent is private; invoke it directly — it is the unit that decides fulfillment.
  const callConfirm = (component: DropinComponents): Promise<void> =>
    (
      component as unknown as {
        confirmPaymentIntent: (p: { paymentIntentId: string; paymentReference: string }) => Promise<void>;
      }
    ).confirmPaymentIntent({ paymentIntentId: PAYMENT_INTENT_ID, paymentReference: PAYMENT_REFERENCE });

  const mockConfirmResponse = (body: { ok: boolean; status: number; outcome?: string }): void => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: body.ok,
      status: body.status,
      json: () => Promise.resolve(body.outcome !== undefined ? { outcome: body.outcome } : {}),
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('APPROVED (synchronous card, 200) → onComplete(isSuccess:true); onError not called', async () => {
    const baseOptions = createBaseOptions();
    mockConfirmResponse({ ok: true, status: 200, outcome: 'approved' });

    await callConfirm(buildComponent(baseOptions));

    expect(baseOptions.onComplete).toHaveBeenCalledWith({ isSuccess: true, paymentReference: PAYMENT_REFERENCE });
    expect(baseOptions.onError).not.toHaveBeenCalled();
  });

  test('PENDING (crypto processing, 202) → never signals success; onError not called', async () => {
    const baseOptions = createBaseOptions();
    mockConfirmResponse({ ok: true, status: 202, outcome: 'pending' });

    await callConfirm(buildComponent(baseOptions));

    // Security invariant: onComplete must NOT have been called with isSuccess:true.
    expect(baseOptions.onComplete).not.toHaveBeenCalledWith(
      expect.objectContaining({ isSuccess: true }),
    );
    expect(baseOptions.onComplete).toHaveBeenCalledWith({ isSuccess: false });
    expect(baseOptions.onError).not.toHaveBeenCalled();
  });

  test('real error (non-ok response, 400) → throws; never signals success', async () => {
    const baseOptions = createBaseOptions();
    mockConfirmResponse({ ok: false, status: 400 });

    const component = buildComponent(baseOptions);

    await expect(callConfirm(component)).rejects.toBe('Error on /confirmPayments');
    expect(baseOptions.onComplete).not.toHaveBeenCalled();
  });
});

/**
 * End-to-end wiring through submit(): proves a non-ok /confirmPayments surfaces to onError
 * (submit() owns the try/catch that calls onError; confirmPaymentIntent only throws).
 */
describe('DropinComponents.submit — error path reaches onError', () => {
  const PROCESSOR_URL = 'http://localhost:8080';

  test('non-ok /confirmPayments → onError called, no success signalled', async () => {
    const onComplete = jest.fn();
    const onError = jest.fn();

    const elements = {
      submit: jest.fn<() => Promise<{ error: undefined }>>().mockResolvedValue({ error: undefined }),
    } as unknown as StripeElements;

    const sdk = {
      confirmPayment: jest
        .fn<() => Promise<{ error: undefined; paymentIntent: { id: string; status: string } }>>()
        .mockResolvedValue({ error: undefined, paymentIntent: { id: 'pi_1', status: 'succeeded' } }),
    } as unknown as Stripe;

    const baseOptions = {
      sdk,
      environment: 'test',
      processorUrl: PROCESSOR_URL,
      sessionId: 'test-session',
      onComplete,
      onError,
      paymentElement: {} as unknown as StripePaymentElement,
      elements,
    } as unknown as BaseOptions;

    global.fetch = jest.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('confirmPayments')) {
        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) });
      }
      // GET /payments — returns the cached payment data for the deferred flow.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            sClientSecret: 'cs_test',
            paymentReference: 'pay-ref',
            merchantReturnUrl: 'https://example.com/return',
            cartId: 'cart-1',
          }),
      });
    }) as unknown as typeof fetch;

    const component = new DropinComponents({ baseOptions, dropinOptions: {} as DropinOptions });
    await component.submit();

    expect(onError).toHaveBeenCalledWith('Error on /confirmPayments');
    expect(onComplete).not.toHaveBeenCalled();
  });
});
