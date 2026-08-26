import { describe, expect, test } from '@jest/globals';
import {
  EU_BANK_TRANSFER_COUNTRIES,
  EuBankTransferCountry,
  getBankTransferOptions,
  resolveRailSuppression,
  findRailSuppressionAtStartup,
} from '../../src/mappers/bank-transfer-mapper';

describe('bank-transfer-mapper', () => {
  describe('EU_BANK_TRANSFER_COUNTRIES', () => {
    test('is exactly the set Stripe accepts for eu_bank_transfer', () => {
      // Guard against drift. config.ts validates euBankTransferCountry against this same array,
      // so widening it here silently widens what merchant config accepts. Stripe rejects anything
      // else with "The country provided (US) is not supported for `eu_bank_transfer` details."
      expect(EU_BANK_TRANSFER_COUNTRIES).toEqual(['DE', 'FR', 'IE', 'NL']);
    });
  });

  describe('getBankTransferOptions', () => {
    test('returns undefined for a EUR cart with no configured country', () => {
      // The unconfigured EUR cart is the NORMAL case, not a broken one: Stripe derives
      // eu_bank_transfer from the currency and defaults to an Irish IBAN.
      expect(getBankTransferOptions({ currencyCode: 'EUR' })).toBeUndefined();
    });

    test('returns undefined for USD with no configured country', () => {
      expect(getBankTransferOptions({ currencyCode: 'USD' })).toBeUndefined();
    });

    test('returns undefined for USD even when a country IS configured', () => {
      // euBankTransferCountry is meaningless outside EUR — Stripe picks us_bank_transfer for USD.
      expect(getBankTransferOptions({ currencyCode: 'USD', euBankTransferCountry: 'DE' })).toBeUndefined();
    });

    test.each(['GBP', 'JPY', 'MXN'])('leaves %s untouched so Stripe can pick its own variant', (currencyCode) => {
      // Deliberately no currency allow-list: a GB merchant's GBP cart must reach Stripe untouched
      // and get gb_bank_transfer. An earlier design blocked these with a 400 that blamed Stripe.
      expect(getBankTransferOptions({ currencyCode, euBankTransferCountry: 'DE' })).toBeUndefined();
    });

    test('returns the exact customer_balance options for EUR with a configured country', () => {
      expect(getBankTransferOptions({ currencyCode: 'EUR', euBankTransferCountry: 'DE' })).toEqual({
        funding_type: 'bank_transfer',
        bank_transfer: { type: 'eu_bank_transfer', eu_bank_transfer: { country: 'DE' } },
      });
    });

    test.each(EU_BANK_TRANSFER_COUNTRIES)('accepts %s and passes it through verbatim', (country) => {
      const result = getBankTransferOptions({ currencyCode: 'EUR', euBankTransferCountry: country });
      expect(result?.bank_transfer?.eu_bank_transfer?.country).toBe(country);
    });

    test('matches currency case-insensitively — commercetools carries uppercase', () => {
      const upper = getBankTransferOptions({ currencyCode: 'EUR', euBankTransferCountry: 'FR' });
      const lower = getBankTransferOptions({ currencyCode: 'eur', euBankTransferCountry: 'FR' });
      expect(lower).toEqual(upper);
      expect(lower).toBeDefined();
    });

    test('never emits funding_type without bank_transfer.type — they are an atomic pair', () => {
      // Sending funding_type alone is a Stripe 400:
      // "the payment_method_options[customer_balance][bank_transfer][type] parameter is required".
      for (const country of EU_BANK_TRANSFER_COUNTRIES) {
        const result = getBankTransferOptions({ currencyCode: 'EUR', euBankTransferCountry: country });
        if (result?.funding_type !== undefined) {
          expect(result.bank_transfer?.type).toBe('eu_bank_transfer');
        }
      }
    });

    test('does not set requested_address_types', () => {
      // Left unset on purpose: Stripe returns all valid types for the variant, which is what the
      // storefront funding-instructions UI needs. Narrowing it is a display preference with no
      // consumer here yet.
      const result = getBankTransferOptions({ currencyCode: 'EUR', euBankTransferCountry: 'NL' });
      expect(result?.bank_transfer).not.toHaveProperty('requested_address_types');
    });

    test('an unconfigured country and an invalid one are indistinguishable at this layer', () => {
      // The mapper does not validate — config.ts already dropped anything invalid before this
      // point. This test pins that division of responsibility so validation is not duplicated here.
      const invalid = 'US' as unknown as EuBankTransferCountry;
      expect(getBankTransferOptions({ currencyCode: 'EUR', euBankTransferCountry: invalid })).toEqual({
        funding_type: 'bank_transfer',
        bank_transfer: { type: 'eu_bank_transfer', eu_bank_transfer: { country: 'US' } },
      });
    });
  });

  describe('resolveRailSuppression — SB3-207 task 014', () => {
    // NEGATIVE HALF: what genuinely suppresses. All four rows measured against the live API on
    // 2026-08-12; none is inferred from the mechanism.
    test.each([
      [
        'off_session binds a mandate the rail cannot satisfy',
        { setupFutureUsage: 'off_session' },
        ['setupFutureUsage'],
      ],
      ['on_session does too', { setupFutureUsage: 'on_session' }, ['setupFutureUsage']],
      ['manual capture does', { captureMethod: 'manual' }, ['captureMethod']],
      [
        'both at once report both, so the remedy message is complete',
        { setupFutureUsage: 'off_session', captureMethod: 'manual' },
        ['setupFutureUsage', 'captureMethod'],
      ],
    ])('%s', (_label, input, expected) => {
      expect(resolveRailSuppression(input)).toEqual(expected);
    });

    // POSITIVE HALF, and this is the half that carries the task. A predicate that returned
    // ['setupFutureUsage'] unconditionally would satisfy every assertion above. These are what
    // separate "warns correctly" from "warns always" — the same failure shape that let Task A ship
    // an over-rejecting validator behind 69 green tests.
    test.each([
      ['nothing configured', {}],
      ['plain automatic capture', { captureMethod: 'automatic' }],
      // MEASURED, and the single most valuable result of this task: automatic_async does NOT
      // suppress. Warning on it would tell every merchant running async capture to change a setting
      // that is not their problem, on carts where the rail works.
      ['automatic_async capture — measured NOT to suppress', { captureMethod: 'automatic_async' }],
      ['setup_future_usage explicitly disabled', { setupFutureUsage: 'none' }],
      ['the empty-string spelling of disabled', { setupFutureUsage: '' }],
      ['the null spelling', { setupFutureUsage: 'null' }],
      ['the undefined spelling', { setupFutureUsage: 'undefined' }],
      ['mixed case and padding, as config.ts canonicalises', { setupFutureUsage: '  NONE  ' }],
      ['a healthy full configuration', { setupFutureUsage: 'none', captureMethod: 'automatic_async' }],
      // Pins the ACCEPT-list directly. The startup path also filters invalid values before they
      // reach here, so without this case a reject-list implementation would pass the whole suite —
      // the predicate's own stance would be untested defence in depth.
      ['an invalid value binds no mandate — the consumer rejects it and falls through', { setupFutureUsage: 'banana' }],
    ])('does not warn: %s', (_label, input) => {
      expect(resolveRailSuppression(input)).toEqual([]);
    });
  });

  describe('findRailSuppressionAtStartup — SB3-207 task 014', () => {
    const country = { euBankTransferCountry: 'DE' };

    test('names the market, the source of the value, and the exact config to type', () => {
      const [warning, ...rest] = findRailSuppressionAtStartup({
        rules: { DE: country },
        envSetupFutureUsage: 'off_session',
        envCaptureMethod: 'automatic',
      });

      expect(rest).toEqual([]);
      expect(warning.marketKey).toBe('DE');
      // The remedy is the point. A message that only describes the symptom leaves the reader where
      // they started.
      expect(warning.message).toContain('STRIPE_PAYMENT_BEHAVIOR_RULES["DE"]');
      expect(warning.message).toContain('STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE');
      expect(warning.message).toContain('"setupFutureUsage":"none"');
    });

    test('attributes the value to the rule when the rule is what set it', () => {
      const [warning] = findRailSuppressionAtStartup({
        rules: { DE: { ...country, captureMethod: 'manual' } },
        envCaptureMethod: 'automatic',
      });

      expect(warning.message).toContain('the "DE" rule');
      expect(warning.message).toContain('"captureMethod":"automatic"');
    });

    // POSITIVE CASES. Each is a configuration a real merchant runs, and warning on any of them
    // would be a false alarm.
    test('does not warn when the market has no euBankTransferCountry — the rail was never requested', () => {
      expect(
        findRailSuppressionAtStartup({
          rules: { DE: { captureMethod: 'manual' } },
          envSetupFutureUsage: 'off_session',
        }),
      ).toEqual([]);
    });

    test('does not warn when pi_first strips setup_future_usage off the PaymentIntent', () => {
      // pi_first UN-suppresses the rail: the mandate never reaches Stripe, so there is nothing to
      // filter on. Warning here would be wrong in the direction that costs the most credibility.
      expect(
        findRailSuppressionAtStartup({
          rules: { DE: { ...country, flowType: 'pi_first' } },
          envSetupFutureUsage: 'off_session',
        }),
      ).toEqual([]);
    });

    test('does not warn when the rule disables the mandate the env var would have bound', () => {
      expect(
        findRailSuppressionAtStartup({
          rules: { DE: { ...country, setupFutureUsage: 'none' } },
          envSetupFutureUsage: 'off_session',
        }),
      ).toEqual([]);
    });

    // The consumer treats anything outside off_session/on_session as INVALID and falls through, so
    // an invalid value binds no mandate and the rail works. Warning here would print a sentence that
    // is factually wrong ("resolves to 'banana'") about a working configuration.
    test('does not warn for an invalid setup_future_usage value', () => {
      expect(findRailSuppressionAtStartup({ rules: { DE: country }, envSetupFutureUsage: 'banana' as never })).toEqual(
        [],
      );
    });

    // The fifth source. A merchant who enables saved payment methods with off_session suppresses the
    // rail without ever touching STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE — static, so startup must
    // see it, and it must attribute the value to the right variable.
    test('warns when the saved-payment-methods default is what binds the mandate', () => {
      const [warning] = findRailSuppressionAtStartup({
        rules: { DE: country },
        savedPaymentMethodSaveUsage: 'off_session',
      });

      expect(warning.message).toContain('STRIPE_SAVED_PAYMENT_METHODS_CONFIG.payment_method_save_usage');
      expect(warning.message).toContain('add "setupFutureUsage":"none"');
    });

    test('says "set", not "add", when the offending value came from the rule itself', () => {
      const [warning] = findRailSuppressionAtStartup({
        rules: { DE: { ...country, setupFutureUsage: 'off_session' } },
      });

      expect(warning.message).toContain('set "setupFutureUsage":"none"');
    });

    test('does not warn for automatic_async', () => {
      expect(findRailSuppressionAtStartup({ rules: { DE: country }, envCaptureMethod: 'automatic_async' })).toEqual([]);
    });

    test('does not warn on a healthy configuration, and warns on nothing when there are no rules', () => {
      expect(findRailSuppressionAtStartup({ rules: { DE: country }, envCaptureMethod: 'automatic' })).toEqual([]);
      expect(findRailSuppressionAtStartup({})).toEqual([]);
    });

    test('reports each contradicting market separately and leaves healthy ones alone', () => {
      const warnings = findRailSuppressionAtStartup({
        rules: {
          DE: country,
          FR: { euBankTransferCountry: 'FR', setupFutureUsage: 'none' },
          NL: { euBankTransferCountry: 'NL', captureMethod: 'manual' },
        },
        envSetupFutureUsage: 'off_session',
      });

      expect(warnings.map((w) => w.marketKey)).toEqual(['DE', 'NL']);
    });
  });
});
