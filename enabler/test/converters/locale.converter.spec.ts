import { describe, test, expect } from '@jest/globals';
import { convertToStripeLocale } from '../../src/converters/locale.converter';

describe('convertToStripeLocale', () => {
  describe('exact match', () => {
    test.each([
      ['en-GB', 'en-GB'],
      ['pt-BR', 'pt-BR'],
      ['zh-HK', 'zh-HK'],
      ['fr-CA', 'fr-CA'],
      ['es-419', 'es-419'],
    ])('preserves canonical case for %s', (input, expected) => {
      expect(convertToStripeLocale(input)).toBe(expected);
    });
  });

  describe('case insensitive', () => {
    test('lowercases input then matches canonical-cased supported code', () => {
      expect(convertToStripeLocale('EN-gb')).toBe('en-GB');
    });

    test('matches base-language code case-insensitively', () => {
      expect(convertToStripeLocale('EN')).toBe('en');
    });
  });

  describe('underscore normalization', () => {
    test('treats underscore as hyphen and resolves to base when region not supported', () => {
      // Stripe has no `de-DE`, so `de_DE` should fall back to base-language `de`.
      expect(convertToStripeLocale('de_DE')).toBe('de');
    });

    test('treats underscore as hyphen for exact-supported region variants', () => {
      // Stripe supports `fr-CA`, so `fr_CA` should match it exactly.
      expect(convertToStripeLocale('fr_CA')).toBe('fr-CA');
    });
  });

  describe('base-language match', () => {
    test.each([
      ['de', 'de'],
      ['fr', 'fr'],
      ['es', 'es'],
      ['zh', 'zh'],
    ])('resolves bare language code %s to itself', (input, expected) => {
      expect(convertToStripeLocale(input)).toBe(expected);
    });
  });

  describe('region fallback to base language', () => {
    test.each([
      // `es-MX` and `fr-BE` fall back to `es` / `fr` even though `es-ES` / `fr-FR` exist:
      // base-exact match runs before region-prefix scan to preserve Adyen-pattern parity.
      ['es-MX', 'es'],
      ['fr-BE', 'fr'],
      ['pt-PT', 'pt'],
      ['zh-CN', 'zh'],
    ])('resolves %s to %s', (input, expected) => {
      expect(convertToStripeLocale(input)).toBe(expected);
    });
  });

  describe('unknown input', () => {
    test('returns "auto" for unrecognized region code with no matching base', () => {
      expect(convertToStripeLocale('xx-YY')).toBe('auto');
    });

    test('returns "auto" for arbitrary string', () => {
      expect(convertToStripeLocale('klingon')).toBe('auto');
    });
  });

  describe('falsy and whitespace input', () => {
    test('returns "auto" for empty string', () => {
      expect(convertToStripeLocale('')).toBe('auto');
    });

    test('returns "auto" for undefined', () => {
      expect(convertToStripeLocale(undefined)).toBe('auto');
    });

    test('returns "auto" for whitespace-only string', () => {
      expect(convertToStripeLocale('  ')).toBe('auto');
    });
  });
});
