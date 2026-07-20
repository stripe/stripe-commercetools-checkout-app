import { describe, test, expect, jest } from '@jest/globals';
import { parseJSON, parsePaymentElementOptions } from '../../src/utils';

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
