import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { PaymentBehaviorConfig } from '../../src/services/payment-behavior-resolver';

/**
 * Coverage for STRIPE_PAYMENT_BEHAVIOR_RULES parsing and validation.
 *
 * Before this file NOTHING in the repo exercised getPaymentBehaviorConfig: every test that touches
 * config mocks getConfig() wholesale, so the parser had zero coverage. This is the first.
 *
 * The parser runs at MODULE LOAD, so each case must set the env var and then re-load the module with
 * a clean registry — hence jest.resetModules() plus require(). A dynamic import() would need
 * --experimental-vm-modules, which this project does not enable; require() is what works under
 * ts-jest's CommonJS output and keeps every assertion synchronous.
 */

const ENV_KEY = 'STRIPE_PAYMENT_BEHAVIOR_RULES';

let consoleErrorSpy: ReturnType<typeof jest.spyOn>;
let originalValue: string | undefined;

const loadRules = (raw?: string): PaymentBehaviorConfig | undefined => {
  if (raw === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = raw;
  }
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../src/config/config');
  return mod.config.stripePaymentBehaviorRules;
};

const errorText = (): string => consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n');

beforeEach(() => {
  originalValue = process.env[ENV_KEY];
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  if (originalValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalValue;
  }
});

describe('getPaymentBehaviorConfig', () => {
  describe('absent or empty', () => {
    test('returns undefined when the env var is not set', () => {
      expect(loadRules(undefined)).toBeUndefined();
    });

    test('returns undefined for an empty string', () => {
      expect(loadRules('')).toBeUndefined();
    });

    test('returns undefined for a whitespace-only value instead of aborting startup', () => {
      // The CT Connect config UI can return '  ' for an optional variable with no default. Without
      // the trim this reaches JSON.parse and kills the deploy — the one remaining path where a
      // harmless input bricks startup.
      expect(loadRules('   ')).toBeUndefined();
    });

    test('tolerates surrounding whitespace around a valid value', () => {
      expect(loadRules('  {"MX":{"captureMethod":"manual"}}  ')).toEqual({ MX: { captureMethod: 'manual' } });
    });
  });

  describe('structural failures still ABORT startup', () => {
    // The degrade-not-abort policy is deliberately scoped to FIELD VALUES only. There is no
    // sensible per-field fallback when the entire map is unreadable, so these keep throwing.

    test('malformed JSON throws', () => {
      expect(() => loadRules('{"MX":')).toThrow(/contains invalid JSON/);
    });

    test('a JSON array throws', () => {
      expect(() => loadRules('[{"captureMethod":"manual"}]')).toThrow(/must be a JSON object/);
    });

    test('a JSON scalar throws', () => {
      expect(() => loadRules('5')).toThrow(/must be a JSON object/);
    });

    test('null throws', () => {
      expect(() => loadRules('null')).toThrow(/must be a JSON object/);
    });

    test('a rule whose value is a scalar throws and names the key', () => {
      expect(() => loadRules('{"MX":"manual"}')).toThrow(/\["MX"\] must be an object rule/);
    });

    test('a rule whose value is an array throws', () => {
      expect(() => loadRules('{"MX":["manual"]}')).toThrow(/\["MX"\] must be an object rule/);
    });
  });

  describe('valid configuration passes through', () => {
    test('a fully valid rule survives intact', () => {
      const rules = loadRules(
        '{"MX":{"captureMethod":"manual","flowType":"pi_first","collectBillingAddress":"never"}}',
      );
      expect(rules).toEqual({
        MX: { captureMethod: 'manual', flowType: 'pi_first', collectBillingAddress: 'never' },
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    test('an empty rule object is accepted', () => {
      expect(loadRules('{"MX":{}}')).toEqual({ MX: {} });
    });

    test('an empty map is accepted', () => {
      expect(loadRules('{}')).toEqual({});
    });
  });

  describe('every valid value SURVIVES — over-rejection guard', () => {
    // This block exists because its absence let a real regression through a green suite.
    //
    // The first version of this file asserted only what gets REJECTED. A validator suite built that
    // way cannot detect OVER-rejection: dropping setupFutureUsage:'OFF_SESSION' — a value that had
    // always worked — produced no failure anywhere, because no test ever asserted that a valid
    // value survives. Every field therefore needs a positive case, not just a negative one.
    //
    // The stakes are asymmetric and that is the point: a dropped field does NOT mean "no override",
    // it means "fall back to the flat env var", which can be the opposite of what the merchant
    // configured.

    test.each(['deferred', 'pi_first'])('flowType %p survives', (value) => {
      expect(loadRules(`{"MX":{"flowType":"${value}"}}`)).toEqual({ MX: { flowType: value } });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    test.each(['automatic', 'automatic_async', 'manual'])('captureMethod %p survives', (value) => {
      expect(loadRules(`{"MX":{"captureMethod":"${value}"}}`)).toEqual({ MX: { captureMethod: value } });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    test.each(['off_session', 'on_session', '', 'none', 'null', 'undefined'])(
      'setupFutureUsage %p survives',
      (value) => {
        expect(loadRules(`{"MX":{"setupFutureUsage":"${value}"}}`)).toEqual({ MX: { setupFutureUsage: value } });
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      },
    );

    test.each(['auto', 'never', 'if_required'])('collectBillingAddress %p survives', (value) => {
      expect(loadRules(`{"MX":{"collectBillingAddress":"${value}"}}`)).toEqual({
        MX: { collectBillingAddress: value },
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('setupFutureUsage canonicalisation', () => {
    // The ONLY rule field whose consumer already normalises: getPaymentIntentSetupFutureUsage in
    // stripe-payment.service.ts lowercases before comparing. So these spellings were accepted long
    // before this validation existed and must keep working. flowType, captureMethod and
    // collectBillingAddress stay case-SENSITIVE on purpose — their consumers compare literals or
    // forward straight to Stripe, so 'PI_FIRST' is a different value, not a casing variant.

    test.each([
      ['OFF_SESSION', 'off_session'],
      [' off_session ', 'off_session'],
      ['None', 'none'],
      ['NULL', 'null'],
      ['On_Session', 'on_session'],
    ])('%p canonicalises to %p', (input, expected) => {
      expect(loadRules(`{"MX":{"setupFutureUsage":"${input}"}}`)).toEqual({ MX: { setupFutureUsage: expected } });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    test('a rule disabling the mandate is NOT dropped into the flat env var default', () => {
      // The concrete regression this guards. With STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE=off_session
      // a rule of {"setupFutureUsage":"None"} exists precisely to disable the mandate for that
      // market. Dropping it would hand every shopper in that market the mandate the merchant
      // explicitly turned off — and would also silence the log.warn that exists to flag exactly
      // that downgrade, since that guard only fires when the resolved value is not undefined.
      const rules = loadRules('{"MX":{"setupFutureUsage":"None"}}');
      expect(rules?.MX.setupFutureUsage).toBe('none');
      expect(rules?.MX.setupFutureUsage).not.toBeUndefined();
    });
  });

  describe('euBankTransferCountry', () => {
    test.each(['DE', 'FR', 'IE', 'NL'])('accepts %s and carries it through', (country) => {
      const rules = loadRules(`{"DE":{"euBankTransferCountry":"${country}"}}`);
      expect(rules?.DE.euBankTransferCountry).toBe(country);
    });

    test('canonicalises casing and surrounding whitespace', () => {
      // Case-INSENSITIVE unlike the other fields, and the asymmetry is reasoned: an ISO country
      // code has one conventional casing, so 'de' is a typo of the same value.
      const rules = loadRules('{"DE":{"euBankTransferCountry":"  de  "}}');
      expect(rules?.DE.euBankTransferCountry).toBe('DE');
    });

    test('an unsupported country is DROPPED and reported, and startup continues', () => {
      const rules = loadRules('{"DE":{"euBankTransferCountry":"US"}}');
      expect(rules).toEqual({ DE: {} });
      expect(errorText()).toMatch(/euBankTransferCountry must be one of DE, FR, IE, NL/);
    });

    test('a non-string value is DROPPED and reported', () => {
      const rules = loadRules('{"DE":{"euBankTransferCountry":1}}');
      expect(rules).toEqual({ DE: {} });
      expect(errorText()).toMatch(/euBankTransferCountry must be a string/);
    });

    test('is accepted on its own with no companion field', () => {
      expect(loadRules('{"DE":{"euBankTransferCountry":"DE"}}')).toEqual({
        DE: { euBankTransferCountry: 'DE' },
      });
    });
  });

  describe('field-level degrade — BEHAVIOR CHANGE, pinned deliberately', () => {
    // Before this change {"MX":{"captureMethod":"banana"}} started cleanly and then failed at the
    // till for every MX shopper, because the value was blind-cast and reached Stripe. It now
    // degrades to the flat env var default. This is an intentional behavior change for a
    // MISCONFIGURED merchant, not a bug fix, and these tests exist to pin it.

    test('an invalid captureMethod is dropped instead of reaching Stripe', () => {
      const rules = loadRules('{"MX":{"captureMethod":"banana"}}');
      expect(rules).toEqual({ MX: {} });
      expect(errorText()).toMatch(/captureMethod must be one of/);
      expect(errorText()).toMatch(/Startup continues/);
    });

    test('an invalid flowType is dropped', () => {
      // Case-SENSITIVE here on purpose: 'PI_FIRST' is not a casing variant, it is a different
      // behavior, so it is not silently accepted the way a country code is.
      const rules = loadRules('{"MX":{"flowType":"PI_FIRST"}}');
      expect(rules).toEqual({ MX: {} });
      expect(errorText()).toMatch(/flowType must be one of/);
    });

    test('an invalid setupFutureUsage is dropped', () => {
      const rules = loadRules('{"MX":{"setupFutureUsage":"whenever"}}');
      expect(rules).toEqual({ MX: {} });
      expect(errorText()).toMatch(/setupFutureUsage must be one of/);
    });

    test('a non-string setupFutureUsage is dropped without throwing', () => {
      // Guards the typeof check that has to run BEFORE canonicalisation: .trim() on a number is a
      // TypeError. Pre-validation this exact input crashed at the till rather than at startup.
      const rules = loadRules('{"MX":{"setupFutureUsage":1}}');
      expect(rules).toEqual({ MX: {} });
      expect(errorText()).toMatch(/setupFutureUsage must be a string/);
    });

    test('a null setupFutureUsage is dropped without throwing', () => {
      const rules = loadRules('{"MX":{"setupFutureUsage":null}}');
      expect(rules).toEqual({ MX: {} });
      expect(errorText()).toMatch(/setupFutureUsage must be a string/);
    });

    test('an invalid collectBillingAddress is dropped', () => {
      const rules = loadRules('{"MX":{"collectBillingAddress":"sometimes"}}');
      expect(rules).toEqual({ MX: {} });
      expect(errorText()).toMatch(/collectBillingAddress must be one of/);
    });

    test('a bad field does not take down the other fields in the SAME rule', () => {
      const rules = loadRules('{"MX":{"captureMethod":"banana","flowType":"pi_first"}}');
      expect(rules).toEqual({ MX: { flowType: 'pi_first' } });
    });

    test('a bad rule does not take down OTHER rules in the map', () => {
      const rules = loadRules(
        '{"DE":{"euBankTransferCountry":"DE","captureMethod":"manual"},"MX":{"captureMethod":"banana"}}',
      );
      expect(rules).toEqual({
        DE: { euBankTransferCountry: 'DE', captureMethod: 'manual' },
        MX: {},
      });
    });

    test('the report names the rule key so an operator can find it', () => {
      loadRules('{"MX":{"captureMethod":"banana"}}');
      expect(errorText()).toMatch(/STRIPE_PAYMENT_BEHAVIOR_RULES\["MX"\]/);
    });
  });

  describe('unknown fields', () => {
    test('an unknown field is dropped and reported', () => {
      const rules = loadRules('{"MX":{"notARealField":1}}');
      expect(rules).toEqual({ MX: {} });
      expect(errorText()).toMatch(/has unknown field 'notARealField'/);
    });

    test('the unknown-field report lists every supported field', () => {
      // If a field is added to the validator and not to this message, a correct config reads to an
      // operator as a typo. This assertion is what keeps the two in step.
      loadRules('{"MX":{"notARealField":1}}');
      expect(errorText()).toMatch(
        /Supported: flowType, captureMethod, setupFutureUsage, collectBillingAddress, euBankTransferCountry/,
      );
    });
  });
});

/**
 * The startup rail-suppression warning, exercised through the REAL module-load path.
 *
 * The pure function behind it has its own tests in bank-transfer-mapper.spec.ts. This file covers
 * what those cannot: the wiring. All four arguments are `string | undefined`, so passing
 * stripePaymentFlow where stripeCaptureMethod belongs compiles cleanly and silently disables the
 * check forever — a defect no unit test of the pure function could ever see.
 */
describe('bank transfer rail suppression warning at startup — SB3-207 task 014', () => {
  const RULES = 'STRIPE_PAYMENT_BEHAVIOR_RULES';
  const SFU = 'STRIPE_PAYMENT_INTENT_SETUP_FUTURE_USAGE';
  const CAPTURE = 'STRIPE_CAPTURE_METHOD';
  const SAVED = 'STRIPE_SAVED_PAYMENT_METHODS_CONFIG';

  let warnSpy: ReturnType<typeof jest.spyOn>;
  let saved: Record<string, string | undefined>;

  const loadWith = (env: Record<string, string | undefined>): string => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/config/config');
    return warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  };

  beforeEach(() => {
    saved = Object.fromEntries([RULES, SFU, CAPTURE, SAVED].map((k) => [k, process.env[k]]));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    warnSpy.mockRestore();
  });

  test('warns, naming the market and the config to type, when the env var binds a mandate', () => {
    const text = loadWith({
      [RULES]: '{"DE":{"euBankTransferCountry":"DE"}}',
      [SFU]: 'off_session',
      [CAPTURE]: undefined,
      [SAVED]: undefined,
    });

    expect(text).toContain('STRIPE_PAYMENT_BEHAVIOR_RULES["DE"]');
    expect(text).toContain('"setupFutureUsage":"none"');
  });

  // Pins the captureMethod argument specifically. Wired to the wrong config field, this stays silent.
  test('warns when STRIPE_CAPTURE_METHOD is manual', () => {
    const text = loadWith({
      [RULES]: '{"DE":{"euBankTransferCountry":"DE"}}',
      [SFU]: undefined,
      [CAPTURE]: 'manual',
      [SAVED]: undefined,
    });

    expect(text).toContain('capture_method');
    expect(text).toContain('"captureMethod":"automatic"');
  });

  // Pins the savedPaymentMethodSaveUsage argument — the fifth source, and the easiest to omit.
  test('warns when only the saved-payment-methods default binds the mandate', () => {
    const text = loadWith({
      [RULES]: '{"DE":{"euBankTransferCountry":"DE"}}',
      [SFU]: undefined,
      [CAPTURE]: undefined,
      [SAVED]: '{"payment_method_save":"enabled","payment_method_save_usage":"off_session"}',
    });

    expect(text).toContain('STRIPE_SAVED_PAYMENT_METHODS_CONFIG.payment_method_save_usage');
  });

  // POSITIVE CASES — a loop wired to warn unconditionally would pass all three tests above.
  test.each([
    ['the configuration is healthy', { [RULES]: '{"DE":{"euBankTransferCountry":"DE"}}' }],
    ['capture is automatic_async', { [RULES]: '{"DE":{"euBankTransferCountry":"DE"}}', [CAPTURE]: 'automatic_async' }],
    ['the market never asked for the rail', { [RULES]: '{"DE":{"captureMethod":"manual"}}', [SFU]: 'off_session' }],
    ['there are no behavior rules at all', { [RULES]: undefined, [SFU]: 'off_session' }],
  ])('stays silent when %s', (_label, env) => {
    const text = loadWith({ [SFU]: undefined, [CAPTURE]: undefined, [SAVED]: undefined, ...env });

    expect(text).not.toContain('euBankTransferCountry');
  });
});
