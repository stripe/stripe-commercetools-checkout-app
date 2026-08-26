import { describe, test, expect } from '@jest/globals';
import { StripeEventConverter } from '../../../src/services/converters/stripeEventConverter';
import {
  mockEvent__charge_refund_captured,
  mockEvent__paymentIntent_canceled,
  mockEvent__paymentIntent_paymentFailed,
  mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
  mockEvent__paymentIntent_processing,
  mockEvent__paymentIntent_requiresAction,
  mockEvent__charge_succeeded_notCaptured,
  mockEvent__charge_refund_notCaptured,
  mockEvent__paymentIntent_requiresAction_bankTransfer,
  mockEvent__paymentIntent_partiallyFunded_bankTransfer,
  mockEvent__customerCashBalanceTransaction_fundingReversed,
  makeNextActionEvent,
  mockEvent__nextAction_redirectToUrl,
  mockEvent__nextAction_boleto,
  mockEvent__nextAction_multibanco,
  mockEvent__nextAction_microdeposits,
  mockEvent__nextAction_pix,
  mockEvent__nextAction_useStripeSdk,
} from '../../utils/mock-routes-data';
import Stripe from 'stripe';

/**
 * The persisted interaction for a PaymentIntent-shaped event is now byte-identical to the source
 * EXCEPT that `client_secret` is nulled — deliberately, on every persisted PI, because a
 * client_secret is a credential and not an identifier, so it has no audit value. Charge-shaped
 * events are still byte-identical outright: a Charge has no `client_secret` field.
 *
 * Kept as a transform of the fixture rather than a hand-written literal so these assertions stay
 * sensitive to every OTHER field. Hard-coding the expected JSON would turn them into snapshots
 * that stop noticing unrelated changes.
 */
const withClientSecretNulled = (event: Stripe.Event): string =>
  JSON.stringify({
    ...event,
    data: { ...event.data, object: { ...event.data.object, client_secret: null } },
  });

describe('stripeEvent.converter', () => {
  const converter = new StripeEventConverter();

  test('convert a payment_intent.succeeded event', () => {
    const result = converter.convert(mockEvent__paymentIntent_succeeded_captureMethodAutomatic);

    expect(result).toEqual({
      paymentMethodInfo: {
        method: undefined,
      },
      id: 'pi_11111',
      pspReference: 'pi_11111',
      pspInteraction: {
        response: withClientSecretNulled(mockEvent__paymentIntent_succeeded_captureMethodAutomatic),
      },
      transactions: [
        {
          amount: {
            centAmount: 13200,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Success',
          type: 'Charge',
        },
      ],
    });
  });

  test('convert a payment_intent.canceled event', () => {
    const result = converter.convert(mockEvent__paymentIntent_canceled);

    expect(result).toEqual({
      id: 'pi_11111',
      paymentMethodInfo: {
        method: undefined,
      },
      pspReference: 'pi_11111',
      pspInteraction: {
        response: withClientSecretNulled(mockEvent__paymentIntent_canceled),
      },
      transactions: [
        {
          amount: {
            centAmount: 45600,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Failure',
          type: 'Authorization',
        },
        {
          amount: {
            centAmount: 45600,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Success',
          type: 'CancelAuthorization',
        },
      ],
    });
  });

  test('convert a payment_intent.payment_failed event transaction', () => {
    const result = converter.convert(mockEvent__paymentIntent_paymentFailed);

    expect(result).toEqual({
      id: undefined,
      paymentMethodInfo: {
        method: undefined,
      },
      pspInteraction: {
        response: withClientSecretNulled(mockEvent__paymentIntent_paymentFailed),
      },
      pspReference: 'pi_11111',
      transactions: [
        {
          amount: {
            centAmount: 0,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Failure',
          type: 'Authorization',
        },
      ],
    });
  });

  test('convert a charge.refunded event captured to transaction', () => {
    const result = converter.convert(mockEvent__charge_refund_captured);

    expect(result).toEqual({
      id: 'pi_11111',
      paymentMethodInfo: {
        method: 'card',
      },
      pspReference: 'pi_11111',
      pspInteraction: {
        response: JSON.stringify(mockEvent__charge_refund_captured),
      },
      transactions: [
        {
          amount: {
            centAmount: 34500,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Success',
          type: 'Refund',
        },
        {
          amount: {
            centAmount: 34500,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Success',
          type: 'Chargeback',
        },
      ],
    });
  });

  test('convert a charge.refunded event not captured to refund and chargeback transactions', () => {
    const result = converter.convert(mockEvent__charge_refund_notCaptured);

    expect(result).toEqual({
      id: 'pi_11111',
      paymentMethodInfo: {
        method: 'card',
      },
      pspReference: 'pi_11111',
      transactions: [
        {
          amount: {
            centAmount: 34500,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Success',
          type: 'Refund',
        },
        {
          amount: {
            centAmount: 34500,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Success',
          type: 'Chargeback',
        },
      ],
      pspInteraction: {
        response: JSON.stringify(mockEvent__charge_refund_notCaptured),
      },
    });
  });

  test('convert a payment_intent.processing event to a pending authorization', () => {
    const result = converter.convert(mockEvent__paymentIntent_processing);

    expect(result.transactions).toEqual([
      {
        amount: {
          centAmount: 13200,
          currencyCode: 'MXN',
        },
        interactionId: 'pi_11111',
        state: 'Pending',
        type: 'Authorization',
      },
    ]);
  });

  // INVERTED BY SB3-207 task 005. This used to assert requires_action converted to a no-op, which
  // was true while the route sent EVERY requires_action here. The route now narrows to bank
  // transfers (isBankTransferNextAction), so this case is unconditional by design: anything that
  // reaches the converter on this event type is already known to be a bank transfer awaiting
  // funds, and gets the pending authorization. The 3DS/Boleto exclusion is asserted where it now
  // lives — the route spec's release gates and the predicate's own unit tests.
  test('convert a payment_intent.requires_action event to a pending authorization', () => {
    const result = converter.convert(mockEvent__paymentIntent_requiresAction);

    expect(result.transactions).toEqual([
      {
        amount: { centAmount: 13200, currencyCode: 'MXN' },
        interactionId: 'pi_11111',
        state: 'Pending',
        type: 'Authorization',
      },
    ]);
  });

  test('convert a payment_intent.partially_funded event to a no-op (no transactions, no throw)', () => {
    const result = converter.convert(mockEvent__paymentIntent_partiallyFunded_bankTransfer);

    expect(result.transactions).toEqual([]);
  });

  // The route must never send this event here. Asserting the rejection makes that invariant
  // self-enforcing rather than a property of one switch statement in another file.
  test('rejects customer_cash_balance_transaction.created — observability only', () => {
    expect(() => converter.convert(mockEvent__customerCashBalanceTransaction_fundingReversed)).toThrow(
      /observability-only/,
    );
  });

  test('convert a non supported event notification', () => {
    const event = mockEvent__charge_refund_captured;
    event.type = 'account.application.deauthorized';

    try {
      converter.convert(event);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  test('convert a charge.succeeded event captured return transaction', () => {
    const result = converter.convert(mockEvent__charge_succeeded_notCaptured);

    expect(result).toEqual({
      id: 'pi_11111',
      paymentMethodInfo: {
        method: 'card',
      },
      pspReference: 'pi_11111',
      pspInteraction: {
        response: JSON.stringify(mockEvent__charge_succeeded_notCaptured),
      },
      transactions: [
        {
          amount: {
            centAmount: 0,
            currencyCode: 'MXN',
          },
          interactionId: 'pi_11111',
          state: 'Success',
          type: 'Authorization',
        },
      ],
    });
  });

  describe('pspInteraction redaction — SB3-207 Task C', () => {
    test('strips financial_addresses and hosted_instructions_url, keeps reference and amount_remaining', () => {
      const result = converter.convert(mockEvent__paymentIntent_requiresAction_bankTransfer);
      const persisted = JSON.parse(result.pspInteraction?.response as string);
      const instructions = persisted.data.object.next_action.display_bank_transfer_instructions;

      // What must go. `hosted_instructions_url` is DELETED, not nulled — a deliberate change
      // from the bank-transfer-only version of this method, which nulled it to preserve the
      // SDK's `string | null` shape. Shape preservation stopped being achievable once the rule
      // became "keep an explicit allowlist" rather than "blank out three known fields".
      expect(instructions.financial_addresses).toBeUndefined();
      expect(instructions.hosted_instructions_url).toBeUndefined();

      // First path that persists an OPEN PaymentIntent: the client_secret is live and usable
      // against Stripe's public client API for the whole funding window.
      expect(persisted.data.object.client_secret).toBeNull();
    });

    // A redaction that deleted EVERYTHING would pass a suite that only asserts what disappears.
    // This is the mirror half: the non-sensitive fields support needs must survive.
    test('keeps the non-sensitive instruction fields support needs to trace a transfer', () => {
      const result = converter.convert(mockEvent__paymentIntent_requiresAction_bankTransfer);
      const persisted = JSON.parse(result.pspInteraction?.response as string);
      const instructions = persisted.data.object.next_action.display_bank_transfer_instructions;

      expect(instructions.reference).toBe('BT-REF-11111');
      expect(instructions.amount_remaining).toBe(12300);
      expect(instructions.currency).toBe('eur');
      expect(instructions.type).toBe('eu_bank_transfer');

      // The rest of the event must survive untouched too.
      expect(persisted.data.object.id).toBe('pi_bt_11111');
      expect(persisted.data.object.status).toBe('requires_action');
      expect(persisted.data.object.metadata.ct_payment_id).toBe('ct_payment_bt_11111');
      expect(persisted.type).toBe('payment_intent.requires_action');
    });

    // Content assertions, not field-path assertions. These survive Stripe renaming or moving the
    // field: a rename makes the guard fall open and the field-path checks above would go green on
    // a payload that still contains the IBAN. This repo has already lost a guard exactly that way,
    // with fixtures keeping the suite green (same failure shape as KI-043).
    test('nothing resembling an IBAN, an instructions URL or a live secret survives anywhere in the blob', () => {
      const result = converter.convert(mockEvent__paymentIntent_requiresAction_bankTransfer);

      expect(result.pspInteraction?.response).not.toContain('DE89370400440532013000');
      expect(result.pspInteraction?.response).not.toContain('BUKBGB22');
      expect(result.pspInteraction?.response).not.toContain('payments.stripe.com/bank_transfer_instructions');
      expect(result.pspInteraction?.response).not.toContain('pi_bt_11111_secret');
    });

    test('does not mutate the source event — later readers of event.data.object must be unaffected', () => {
      const event = mockEvent__paymentIntent_requiresAction_bankTransfer;
      converter.convert(event);
      const instructions = (event.data.object as Stripe.PaymentIntent).next_action?.display_bank_transfer_instructions;

      expect(instructions?.financial_addresses).toBeDefined();
      expect(instructions?.hosted_instructions_url).toContain('payments.stripe.com');
      expect((event.data.object as Stripe.PaymentIntent).client_secret).toBe('pi_bt_11111_secret');
    });

    // INVERTED BY SB3-207 task 005. This used to assert the path stayed dormant — that redaction
    // happened but no transaction was written — which is what let task C land before the webhook
    // task. Task 005 is that webhook task, so the assertion flips from "proves it is inert" to
    // "proves it is correct".
    //
    // THE AMOUNT IS THE WHOLE POINT OF THIS TEST. The fixture carries `amount: 12300` and
    // `amount_received: 0`, because the wire has not landed yet. populateAmount() reads
    // `amount_received`, so reusing it here would book a 0-cent authorization against a real
    // order and the suite would still be green — this asserts the value that distinguishes the
    // two, not merely that a transaction exists.
    test('writes one pending authorization for pi.amount, never amount_received', () => {
      const result = converter.convert(mockEvent__paymentIntent_requiresAction_bankTransfer);

      expect(result.transactions).toEqual([
        {
          amount: { centAmount: 12300, currencyCode: 'EUR' },
          interactionId: 'pi_bt_11111',
          state: 'Pending',
          type: 'Authorization',
        },
      ]);

      // Stated separately and deliberately: the toEqual above would also pass if Stripe ever made
      // amount_received equal amount. This one fails the moment the source field changes.
      const pi = mockEvent__paymentIntent_requiresAction_bankTransfer.data.object as Stripe.PaymentIntent;
      expect(pi.amount_received).toBe(0);
      expect(result.transactions[0].amount.centAmount).not.toBe(pi.amount_received);
    });
  });

  describe('client_secret on every persisted PaymentIntent — SB3-207 task 018', () => {
    const persistedObject = (event: Stripe.Event) =>
      JSON.parse(converter.convert(event).pspInteraction?.response as string).data.object;

    // These are the two that matter: both write a transaction, so both ARE persisted, and both
    // carry a secret that still works against Stripe's public client API — `processing` because
    // settlement is in flight, `payment_failed` because the PI returns to
    // requires_payment_method so the buyer can retry.
    //
    // Asserted structurally rather than by content: the fixtures set client_secret to the same
    // literal as the PaymentIntent id, so a `not.toContain` here would pass for the wrong reason.
    test.each([
      ['payment_intent.processing', mockEvent__paymentIntent_processing],
      ['payment_intent.payment_failed', mockEvent__paymentIntent_paymentFailed],
      ['payment_intent.succeeded', mockEvent__paymentIntent_succeeded_captureMethodAutomatic],
      ['payment_intent.canceled', mockEvent__paymentIntent_canceled],
    ])('%s persists no client_secret', (_label, event) => {
      expect(persistedObject(event as Stripe.Event).client_secret).toBeNull();
    });

    // The credential goes; the identifier stays. A redaction that dropped the id too would pass
    // every assertion above while making the record useless for support.
    test('keeps the PaymentIntent id — the credential goes, the identifier stays', () => {
      const object = persistedObject(mockEvent__paymentIntent_processing);

      expect(object.id).toBe('pi_11111');
      expect(object.status).toBe('processing');
      expect(object.metadata.ct_payment_id).toBe('pi_11111');
    });

    test('does not mutate the source event', () => {
      converter.convert(mockEvent__paymentIntent_processing);

      expect((mockEvent__paymentIntent_processing.data.object as Stripe.PaymentIntent).client_secret).toBe('pi_11111');
    });

    // Charge-shaped payloads have no client_secret field, so they must stay byte-identical and
    // must NOT acquire a `client_secret: null` key they never had.
    test('a charge-shaped event is untouched and gains no client_secret key', () => {
      const result = converter.convert(mockEvent__charge_succeeded_notCaptured);

      expect(result.pspInteraction?.response).toBe(JSON.stringify(mockEvent__charge_succeeded_notCaptured));
      expect(JSON.parse(result.pspInteraction?.response as string).data.object).not.toHaveProperty('client_secret');
    });

    // The early return exits only on the ONE positively-safe shape, so an unrecognised object
    // type is redacted by default rather than handed through. Pins the polarity of that guard:
    // an `!== 'payment_intent'` guard reads the same today and fails open on SetupIntent, whose
    // next_action.redirect_to_url.url embeds a live setup_intent_client_secret.
    test('an unrecognised object shape is redacted, not passed through', () => {
      const event = JSON.parse(JSON.stringify(mockEvent__paymentIntent_processing)) as Stripe.Event;
      const object = event.data.object as unknown as Record<string, unknown>;
      object.object = 'setup_intent';
      object.client_secret = 'seti_11111_secret_LIVE';
      object.next_action = {
        type: 'redirect_to_url',
        redirect_to_url: { url: 'https://hooks.stripe.com/redirect?setup_intent_client_secret=UNSEEN-SECRET-11111' },
      };

      const blob = converter.convert(event).pspInteraction?.response as string;

      expect(blob).not.toContain('seti_11111_secret_LIVE');
      expect(blob).not.toContain('UNSEEN-SECRET-11111');
    });
  });

  describe('next_action allowlist — SB3-207 task 015', () => {
    const persisted = (event: Stripe.Event) => converter.convert(event).pspInteraction?.response as string;

    // Every one of these is a customer-facing artifact that could act on the payment, not just
    // identify it. The buyer already has them from the widget; the audit record does not need them.
    test.each([
      [
        'redirect_to_url',
        mockEvent__nextAction_redirectToUrl,
        ['hooks.stripe.com/redirect', 'shop.example.com/return'],
      ],
      [
        'boleto_display_details',
        mockEvent__nextAction_boleto,
        ['boleto/voucher', '34191790010104351004791020150008291070026000'],
      ],
      ['multibanco_display_details', mockEvent__nextAction_multibanco, ['multibanco/voucher', '12345']],
      ['verify_with_microdeposits', mockEvent__nextAction_microdeposits, ['microdeposit/test_11111']],
      [
        'pix_display_qr_code',
        mockEvent__nextAction_pix,
        ['SECRET-PIX-PAYLOAD-11111', 'pix/test_11111.png', 'pix/test_11111.svg'],
      ],
      ['use_stripe_sdk', mockEvent__nextAction_useStripeSdk, ['3d_secure_2/hosted']],
    ])('%s: no customer-facing artifact survives', (_variant, event, secrets) => {
      const blob = persisted(event as Stripe.Event);

      for (const secret of secrets as string[]) {
        expect(blob).not.toContain(secret);
      }
      // The PaymentIntent's own secret goes too — and note redirect_to_url and use_stripe_sdk
      // carry a SECOND live copy of it inside their URLs, which is why nulling the top-level
      // field alone would not have been enough.
      expect(blob).not.toContain('pi_na_11111_secret');
    });

    test('keeps the allowlisted trace fields', () => {
      const parsed = JSON.parse(persisted(mockEvent__nextAction_multibanco));
      const details = parsed.data.object.next_action.multibanco_display_details;

      expect(parsed.data.object.next_action.type).toBe('multibanco_display_details');
      expect(details.reference).toBe('MB-REF-11111');
      expect(details.expires_at).toBe(1717700000);
      // Not allowlisted, so it goes even though it is innocuous on its own.
      expect(details.entity).toBeUndefined();
    });

    // THE FAIL-CLOSED PROBE. This is the assertion the whole allowlist design exists for: a
    // variant nobody has heard of, carrying a field nobody enumerated, must still be dropped.
    // An enumerated denylist would pass every other test in this file and fail this one.
    test('an unknown future variant with an unknown field is dropped without anyone updating the code', () => {
      const event = makeNextActionEvent('quantum_teleport_display_details', {
        hosted_teleport_url: 'https://payments.stripe.com/teleport/UNSEEN-SECRET-11111',
        teleport_token: 'tok_UNSEEN-SECRET-22222',
        reference: 'QT-REF-11111',
      });

      const blob = persisted(event);

      expect(blob).not.toContain('UNSEEN-SECRET-11111');
      expect(blob).not.toContain('UNSEEN-SECRET-22222');
      // ...while the allowlisted field still survives, so "fails closed" does not degrade into
      // "drops everything", which would be indistinguishable in a suite that only checks removal.
      expect(JSON.parse(blob).data.object.next_action.quantum_teleport_display_details.reference).toBe('QT-REF-11111');
    });

    test('an allowlisted NAME wrapping an object cannot smuggle a subtree through', () => {
      const event = makeNextActionEvent('sneaky_display_details', {
        reference: { nested: 'SMUGGLED-SECRET-11111' },
      });

      expect(persisted(event)).not.toContain('SMUGGLED-SECRET-11111');
    });

    // The array case of the same guard. `financial_addresses[].type` is the real instance of an
    // allowlisted name sitting on a sensitive structure, so this is not hypothetical.
    test('an allowlisted NAME holding an array cannot smuggle it through either', () => {
      const event = makeNextActionEvent('sneaky_display_details', {
        type: [{ iban: 'SMUGGLED-IBAN-11111' }],
        currency: ['SMUGGLED-CURRENCY-11111'],
      });

      const blob = persisted(event);
      expect(blob).not.toContain('SMUGGLED-IBAN-11111');
      expect(blob).not.toContain('SMUGGLED-CURRENCY-11111');
    });

    // Prototype pollution: `__proto__` arrives from JSON.parse as an own enumerable key.
    test('a __proto__ key neither leaks nor pollutes Object.prototype', () => {
      const event = makeNextActionEvent('sneaky_display_details', {
        __proto__: { polluted: 'PROTO-SECRET-11111' },
      });

      expect(persisted(event)).not.toContain('PROTO-SECRET-11111');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test('does not mutate the source event', () => {
      converter.convert(mockEvent__nextAction_pix);
      const pi = mockEvent__nextAction_pix.data.object as Stripe.PaymentIntent;

      expect(JSON.stringify(pi.next_action)).toContain('SECRET-PIX-PAYLOAD-11111');
      expect(pi.client_secret).toBe('pi_na_11111_secret');
    });
  });
  /**
   * The payment method label on a PaymentIntent-shaped event.
   *
   * Before 2026-08-21 this branch left the field empty, so a bank transfer sitting at Pending showed
   * NO payment method in commercetools — and the Charge that would have filled it arrives days later,
   * or never if the shopper abandons the transfer. Reported by Luis against a real Pending order.
   */
  describe('payment method on a PaymentIntent event', () => {
    test('uses the method the caller resolved', () => {
      const result = converter.convert(mockEvent__paymentIntent_requiresAction_bankTransfer, 'customer_balance');

      expect(result.paymentMethodInfo?.method).toBe('customer_balance');
    });

    // ***** MIRROR *****
    // The assertion above passes for an implementation that hardcodes the string. This is what makes
    // it a pass-through of the caller's answer rather than a bank-transfer special case.
    test('passes through whatever the caller resolved, not a fixed value', () => {
      const result = converter.convert(mockEvent__paymentIntent_requiresAction_bankTransfer, 'us_bank_account');

      expect(result.paymentMethodInfo?.method).toBe('us_bank_account');
    });

    // ***** RELEASE GATE *****
    // undefined, NOT ''. These events arrive repeatedly for one payment and Stripe redelivers for
    // three days; an empty string would overwrite a method the Charge branch already wrote, turning
    // an unresolvable lookup into the erasure of a correct label.
    test('RELEASE GATE: leaves the field unset when the caller could not resolve it', () => {
      const result = converter.convert(mockEvent__paymentIntent_requiresAction_bankTransfer);

      expect(result.paymentMethodInfo?.method).toBeUndefined();
      expect(result.paymentMethodInfo?.method).not.toBe('');
    });

    // A Charge carries payment_method_details.type in the payload and needs no help; the caller's
    // value must not be able to override what the payload states.
    test('a Charge event ignores the resolved value and keeps the payload type', () => {
      const result = converter.convert(mockEvent__charge_succeeded_notCaptured, 'customer_balance');

      expect(result.paymentMethodInfo?.method).toBe('card');
    });
  });
});
