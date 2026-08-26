import { describe, test, expect, jest } from '@jest/globals';
import Stripe from 'stripe';
import {
  isBankTransferNextAction,
  ORDER_PAYMENT_STATE_BY_EVENT,
  parseJSON,
  parsePaymentElementOptions,
  shouldTransitionOrderPaymentState,
} from '../../src/utils';
import { OrderPaymentState, StripeEvent } from '../../src/services/types/stripe-payment.type';

describe('parseJSON', () => {
  test('should parse valid JSON string', () => {
    const jsonString = '{"key": "test value"}';
    const result = parseJSON<{ key: string }>(jsonString);
    expect(result).toEqual({ key: 'test value' });
  });

  test('should return empty object for invalid string and log error', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const jsonString = 'invalid json';
    const result = parseJSON<{ key: string }>(jsonString);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error parsing JSON', expect.any(SyntaxError));
    expect(result).toEqual({});
    consoleErrorSpy.mockRestore();
  });

  test('should return empty object for empty string', () => {
    const jsonString = '';
    const result = parseJSON<{ key: string }>(jsonString);
    expect(result).toEqual({});
  });

  test('should return empty object for null', () => {
    const jsonString = null as unknown as string;
    const result = parseJSON<{ key: string }>(jsonString);
    expect(result).toEqual({});
  });

  test('should return empty object for undefined', () => {
    const jsonString = undefined as unknown as string;
    const result = parseJSON<{ key: string }>(jsonString);
    expect(result).toEqual({});
  });
});

describe('parsePaymentElementOptions', () => {
  test('should return empty object when raw is undefined', () => {
    expect(parsePaymentElementOptions(undefined)).toEqual({});
  });

  test('should return empty object and log error for malformed JSON', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = parsePaymentElementOptions('{invalid');
    expect(result).toEqual({});
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Invalid JSON in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring',
      expect.any(SyntaxError),
    );
    consoleErrorSpy.mockRestore();
  });

  test('should return empty object and log error when value is not a JSON object', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = parsePaymentElementOptions('[1,2,3]');
    expect(result).toEqual({});
    expect(consoleErrorSpy).toHaveBeenCalledWith('STRIPE_BEHAVIOR_PAYMENT_ELEMENT must be a JSON object, ignoring');
    consoleErrorSpy.mockRestore();
  });

  test('should drop unknown top-level keys and log a warning', () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parsePaymentElementOptions('{"paymentMethodTypes":["card"],"readOnly":true}');
    expect(result).toEqual({ readOnly: true });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Unknown key "paymentMethodTypes" in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring',
    );
    consoleWarnSpy.mockRestore();
  });

  test('should drop only the key with an invalid value, keeping the rest of a valid object', () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parsePaymentElementOptions(
      JSON.stringify({
        wallets: { applePay: 'sometimes' },
        readOnly: true,
      }),
    );
    expect(result).toEqual({ readOnly: true });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Invalid value for "wallets" in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring key',
    );
    consoleWarnSpy.mockRestore();
  });

  test('should parse and validate a fully valid object', () => {
    const input = {
      terms: { card: 'never', sepaDebit: 'always' },
      wallets: { applePay: 'auto', googlePay: 'never' },
      defaultValues: { billingDetails: { name: 'Jane Doe', address: { country: 'US' } } },
      fields: { billingDetails: { email: 'never' } },
      business: { name: 'My Store' },
      paymentMethodOrder: ['card', 'paypal'],
      readOnly: false,
      layout: { type: 'accordion', defaultCollapsed: true },
    };
    const result = parsePaymentElementOptions(JSON.stringify(input));
    expect(result).toEqual(input);
  });
});

describe('isBankTransferNextAction', () => {
  const withNextAction = (nextAction: unknown): Stripe.PaymentIntent =>
    ({ next_action: nextAction }) as unknown as Stripe.PaymentIntent;

  test('returns true for a bank transfer PaymentIntent', () => {
    const paymentIntent = withNextAction({
      type: 'display_bank_transfer_instructions',
      display_bank_transfer_instructions: { reference: 'BT-REF-11111', type: 'eu_bank_transfer' },
    });
    expect(isBankTransferNextAction(paymentIntent)).toBe(true);
  });

  // ***** RELEASE GATE *****
  // Card 3DS emits the same payment_intent.requires_action event. If this ever returns true,
  // every 3DS payment gets an Authorization/Pending written to commercetools.
  test('returns false for a card 3DS PaymentIntent (use_stripe_sdk)', () => {
    const paymentIntent = withNextAction({ type: 'use_stripe_sdk', use_stripe_sdk: {} });
    expect(isBankTransferNextAction(paymentIntent)).toBe(false);
  });

  // ***** RELEASE GATE *****
  test('returns false for a Boleto PaymentIntent (boleto_display_details)', () => {
    const paymentIntent = withNextAction({ type: 'boleto_display_details', boleto_display_details: {} });
    expect(isBankTransferNextAction(paymentIntent)).toBe(false);
  });

  test('returns false for a redirect-based PaymentIntent', () => {
    const paymentIntent = withNextAction({ type: 'redirect_to_url', redirect_to_url: { url: 'https://x' } });
    expect(isBankTransferNextAction(paymentIntent)).toBe(false);
  });

  test('returns false when there is no next_action at all', () => {
    expect(isBankTransferNextAction(withNextAction(null))).toBe(false);
    expect(isBankTransferNextAction({} as Stripe.PaymentIntent)).toBe(false);
  });

  // Both halves of the predicate are load-bearing. This is the half a `type`-only check misses:
  // the discriminator matches but the payload Stripe promises alongside it is absent, which is
  // the shape a future API change is most likely to produce.
  test('returns false when the type matches but the instructions object is absent', () => {
    const paymentIntent = withNextAction({ type: 'display_bank_transfer_instructions' });
    expect(isBankTransferNextAction(paymentIntent)).toBe(false);
  });
});

// ===========================================================================
// Order.paymentState — the second state axis (SB3-207 task 028, ADR-009)
// ===========================================================================

describe('ORDER_PAYMENT_STATE_BY_EVENT', () => {
  test('maps the five payment_intent events the connector reflects onto the order', () => {
    expect(ORDER_PAYMENT_STATE_BY_EVENT).toEqual({
      [StripeEvent.PAYMENT_INTENT__REQUIRED_ACTION]: OrderPaymentState.PENDING,
      [StripeEvent.PAYMENT_INTENT__PROCESSING]: OrderPaymentState.PENDING,
      [StripeEvent.PAYMENT_INTENT__SUCCEEDED]: OrderPaymentState.PAID,
      [StripeEvent.PAYMENT_INTENT__PAYMENT_FAILED]: OrderPaymentState.FAILED,
      [StripeEvent.PAYMENT_INTENT__CANCELED]: OrderPaymentState.FAILED,
    });
  });

  // The absences are the design, so they are asserted rather than left implied. An exhaustive
  // equality check above would already fail if one were added — this spells out WHY each is out,
  // so a future reader adding one has to disagree with a reason instead of filling a gap.
  test.each([
    // Charge-level events say nothing new about the order: payment_intent.succeeded already covers
    // settlement, and reflecting both would double-write the same fact.
    [StripeEvent.CHARGE__SUCCEEDED],
    [StripeEvent.CHARGE__UPDATED],
    // Refunds/chargebacks are a CreditOwed question, and whether a refunded order stops being Paid
    // is a merchant business decision — explicitly deferred in the 2026-08-18 session.
    [StripeEvent.CHARGE__REFUNDED],
    [StripeEvent.REFUND__UPDATED],
    [StripeEvent.REFUND__FAILED],
    // A partially funded transfer is still pending, and the order already says Pending from
    // requires_action. Writing again would be a no-op that reads like a state change.
    [StripeEvent.PAYMENT_INTENT__PARTIALLY_FUNDED],
    // Customer-scoped: carries no ct_payment_id, so there is no order to resolve.
    [StripeEvent.CUSTOMER_CASH_BALANCE_TRANSACTION__CREATED],
  ])('deliberately does not map %s', (event) => {
    expect(ORDER_PAYMENT_STATE_BY_EVENT[event]).toBeUndefined();
  });
});

describe('shouldTransitionOrderPaymentState', () => {
  const { PENDING, PAID, FAILED } = OrderPaymentState;

  // The full precedence lattice, written out rather than derived, so a change to the rule shows up
  // as a diff in expected values instead of a diff in test logic.
  test.each([
    // from unset — every target is allowed
    [undefined, PENDING, true],
    [undefined, PAID, true],
    [undefined, FAILED, true],
    // from Pending — resolves either way, never re-writes itself
    ['Pending', PENDING, false],
    ['Pending', PAID, true],
    ['Pending', FAILED, true],
    // from Failed — a late settlement still wins, because money is the fact
    ['Failed', PENDING, false],
    ['Failed', PAID, true],
    ['Failed', FAILED, false],
    // from Paid — terminal and authoritative in every direction
    ['Paid', PENDING, false],
    ['Paid', PAID, false],
    ['Paid', FAILED, false],
  ])('current=%s target=%s → %s', (current, target, expected) => {
    expect(shouldTransitionOrderPaymentState(current as string | undefined, target)).toBe(expected);
  });

  // ***** RELEASE GATE *****
  // The single most expensive cell. Stripe emits payment_intent.payment_failed when a shopper's
  // first card attempt is declined and a later attempt succeeds on the SAME PaymentIntent, and it
  // redelivers events for up to three days. If this ever returns true, a settled order gets marked
  // Failed and the merchant stops fulfilling a paid order.
  test('RELEASE GATE: never downgrades a Paid order to Failed', () => {
    expect(shouldTransitionOrderPaymentState('Paid', FAILED)).toBe(false);
  });

  // ***** MIRROR ASSERTION *****
  // The gate above passes just as happily if the function returns false for everything. Without
  // this, the whole reflection can be dead with a green suite — the -005/-012 lesson.
  test('MIRROR: still promotes an unset order to Paid', () => {
    expect(shouldTransitionOrderPaymentState(undefined, PAID)).toBe(true);
  });

  // commercetools has two states this connector never writes. They must behave like any other
  // non-Paid current value — overwritable — rather than being special-cased into a no-op, which is
  // how a merchant-set BalanceDue would silently block our settlement write.
  test.each([['BalanceDue'], ['CreditOwed']])(
    'treats the unwritten commercetools state %s as overwritable by a settlement',
    (current) => {
      expect(shouldTransitionOrderPaymentState(current, PAID)).toBe(true);
      expect(shouldTransitionOrderPaymentState(current, PENDING)).toBe(false);
    },
  );

  test('treats an empty string like unset', () => {
    expect(shouldTransitionOrderPaymentState('', PENDING)).toBe(true);
  });
});
