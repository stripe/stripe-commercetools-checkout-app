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

/**
 * Guards the requires_action branching in confirmStripePayment (SB3-207 task 026).
 *
 * `payment_intent.requires_action` arrives for card 3DS, Boleto, redirect methods AND bank
 * transfers, and the two groups must go opposite ways. For 3DS/Boleto the buyer completed nothing,
 * so the enabler must keep throwing and the host must treat it as an error. For a bank transfer the
 * buyer has done everything they can do inside checkout — Stripe.js already showed them the
 * instructions — so throwing put them on a "Payment Failed" screen, measured 2026-08-13 against the
 * commercetools overlay. Nobody wires money after being told the payment failed.
 */
describe('DropinComponents.confirmStripePayment — requires_action branching (SB3-207 task 026)', () => {
  const CONFIRM_ARGS = {
    merchantReturnUrl: 'https://shop.example.com/return',
    cartId: 'cart-1',
    clientSecret: 'pi_test_secret',
    paymentReference: 'pay-ref-1',
  };

  const buildWithIntent = (paymentIntent: unknown, confirmResult?: unknown, retrieved?: unknown) => {
    const baseOptions = {
      sdk: {
        confirmPayment: jest.fn().mockResolvedValue(confirmResult ?? { paymentIntent }),
        retrievePaymentIntent: jest.fn().mockResolvedValue({ paymentIntent: retrieved ?? paymentIntent }),
      },
      environment: 'test',
      processorUrl: 'http://localhost:8080',
      sessionId: 'test-session',
      onComplete: jest.fn(),
      onError: jest.fn(),
      paymentElement: {} as unknown as StripePaymentElement,
      elements: {} as unknown as StripeElements,
    } as unknown as BaseOptions;
    const component = new DropinComponents({ baseOptions, dropinOptions: {} as DropinOptions });
    const call = (): Promise<{ paymentIntent: unknown }> =>
      (
        component as unknown as {
          confirmStripePayment: (p: typeof CONFIRM_ARGS) => Promise<{ paymentIntent: unknown }>;
        }
      ).confirmStripePayment(CONFIRM_ARGS);
    return { baseOptions, call };
  };

  const bankTransferIntent = {
    id: 'pi_bt_1',
    status: 'requires_action',
    next_action: {
      type: 'display_bank_transfer_instructions',
      display_bank_transfer_instructions: { reference: 'BT-REF-1', type: 'eu_bank_transfer' },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ***** MIRROR ASSERTION *****
  // The release gates below pass just as happily if NOTHING is let through — which is the state
  // that put the buyer on a failure screen. This is the half that fails if the predicate is broken
  // in the other direction.
  test('MIRROR: a bank transfer requires_action does NOT throw and returns the intent', async () => {
    const { call } = buildWithIntent(bankTransferIntent);

    await expect(call()).resolves.toEqual({ paymentIntent: bankTransferIntent });
  });

  // ***** RELEASE GATE *****
  test('RELEASE GATE: card 3DS requires_action still throws with type requires_action', async () => {
    const { call } = buildWithIntent({
      id: 'pi_3ds_1',
      status: 'requires_action',
      next_action: { type: 'use_stripe_sdk', use_stripe_sdk: { type: 'three_d_secure_redirect' } },
    });

    await expect(call()).rejects.toMatchObject({ type: 'requires_action' });
  });

  // ***** RELEASE GATE *****
  test('RELEASE GATE: Boleto requires_action still throws with type requires_action', async () => {
    const { call } = buildWithIntent({
      id: 'pi_boleto_1',
      status: 'requires_action',
      next_action: { type: 'boleto_display_details', boleto_display_details: { number: '00000' } },
    });

    await expect(call()).rejects.toMatchObject({ type: 'requires_action' });
  });

  // Fails CLOSED: discriminator matches but the payload Stripe promises alongside it is absent.
  test('the bank transfer type without the instructions object still throws', async () => {
    const { call } = buildWithIntent({
      id: 'pi_x',
      status: 'requires_action',
      next_action: { type: 'display_bank_transfer_instructions' },
    });

    await expect(call()).rejects.toMatchObject({ type: 'requires_action' });
  });

  test('a succeeded intent is unaffected — returns without throwing', async () => {
    const { call } = buildWithIntent({ id: 'pi_ok', status: 'succeeded', next_action: null });

    await expect(call()).resolves.toMatchObject({ paymentIntent: { status: 'succeeded' } });
  });
});

/**
 * The error path of confirmPayment — SB3-207 task 026, reopened after the 2026-08-17 end-to-end run.
 *
 * The first version of the fix guarded `paymentIntent.status === 'requires_action'`, and the suite
 * passed, and it did not work. Stripe.js reports a dismissed instructions modal as an ERROR, so the
 * throw fires before that guard is ever reached. The tests could not have caught it: their mock
 * resolved confirmPayment with `{ paymentIntent }` and no error — encoding the very assumption under
 * test. A mock cannot refute its own premise.
 *
 * These tests therefore drive the ERROR shape Stripe actually returns.
 */
describe('DropinComponents.confirmStripePayment — the error path (SB3-207 task 026, reopened)', () => {
  const CONFIRM_ARGS = {
    merchantReturnUrl: 'https://shop.example.com/return',
    cartId: 'cart-1',
    clientSecret: 'pi_test_secret',
    paymentReference: 'pay-ref-1',
  };

  const awaitingBankTransfer = {
    id: 'pi_bt_1',
    status: 'requires_action',
    next_action: {
      type: 'display_bank_transfer_instructions',
      display_bank_transfer_instructions: { reference: 'BT-REF-1', type: 'eu_bank_transfer' },
    },
  };

  const build = (confirmResult: unknown, retrieved: unknown) => {
    const baseOptions = {
      sdk: {
        confirmPayment: jest.fn().mockResolvedValue(confirmResult),
        retrievePaymentIntent: jest.fn().mockResolvedValue({ paymentIntent: retrieved }),
      },
      environment: 'test',
      processorUrl: 'http://localhost:8080',
      sessionId: 'test-session',
      onComplete: jest.fn(),
      onError: jest.fn(),
      paymentElement: {} as unknown as StripePaymentElement,
      elements: {} as unknown as StripeElements,
    } as unknown as BaseOptions;
    const component = new DropinComponents({ baseOptions, dropinOptions: {} as DropinOptions });
    const call = (): Promise<{ paymentIntent: unknown }> =>
      (
        component as unknown as {
          confirmStripePayment: (p: typeof CONFIRM_ARGS) => Promise<{ paymentIntent: unknown }>;
        }
      ).confirmStripePayment(CONFIRM_ARGS);
    return { baseOptions, call };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ***** THE REGRESSION THIS TASK EXISTS FOR *****
  // This is the exact shape measured in production: confirmPayment rejects with an error while the
  // PaymentIntent is alive and awaiting a wire.
  test('a dismissed bank transfer modal is rescued instead of thrown', async () => {
    const { call } = build({ error: { type: 'invalid_request_error', message: 'cancelled' } }, awaitingBankTransfer);

    await expect(call()).resolves.toEqual({ paymentIntent: awaitingBankTransfer });
  });

  // ***** RELEASE GATE *****
  // A real decline leaves the intent in requires_payment_method. It must still throw — rescuing it
  // would tell the buyer their payment is pending when it was declined.
  test('RELEASE GATE: a genuine card decline still throws', async () => {
    const declined = { id: 'pi_card_1', status: 'requires_payment_method', next_action: null };
    const { call } = build({ error: { type: 'card_error', code: 'card_declined' } }, declined);

    await expect(call()).rejects.toMatchObject({ code: 'card_declined' });
  });

  // ***** RELEASE GATE *****
  test('RELEASE GATE: an error on a 3DS intent still throws', async () => {
    const threeDs = {
      id: 'pi_3ds_1',
      status: 'requires_action',
      next_action: { type: 'use_stripe_sdk', use_stripe_sdk: {} },
    };
    const { call } = build({ error: { type: 'card_error', code: 'authentication_failure' } }, threeDs);

    await expect(call()).rejects.toMatchObject({ code: 'authentication_failure' });
  });

  // The rescue must never mask the original error with one about itself.
  test('a failing retrieve re-throws the ORIGINAL error', async () => {
    const baseOptions = {
      sdk: {
        confirmPayment: jest.fn().mockResolvedValue({ error: { type: 'api_error', message: 'original' } }),
        retrievePaymentIntent: jest.fn().mockRejectedValue(new Error('retrieve blew up')),
      },
      environment: 'test',
      processorUrl: 'http://localhost:8080',
      sessionId: 'test-session',
      onComplete: jest.fn(),
      onError: jest.fn(),
      paymentElement: {} as unknown as StripePaymentElement,
      elements: {} as unknown as StripeElements,
    } as unknown as BaseOptions;
    const component = new DropinComponents({ baseOptions, dropinOptions: {} as DropinOptions });

    await expect(
      (
        component as unknown as {
          confirmStripePayment: (p: typeof CONFIRM_ARGS) => Promise<unknown>;
        }
      ).confirmStripePayment(CONFIRM_ARGS),
    ).rejects.toMatchObject({ message: 'original' });
  });
});
