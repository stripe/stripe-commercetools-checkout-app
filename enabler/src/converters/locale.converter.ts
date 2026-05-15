import type { StripeElementLocale } from '@stripe/stripe-js';

/**
 * Subset of Stripe-supported `StripeElementLocale` values excluding `"auto"`.
 *
 * Source of truth: `StripeElementLocale` exported from `@stripe/stripe-js`.
 * Listed explicitly (rather than derived) so the array is iterable at runtime
 * and the type system enforces that every entry is a valid Stripe locale.
 *
 * If the installed `@stripe/stripe-js` adds or removes locales, this array
 * must be updated to match. TypeScript will surface mismatches at compile time.
 */
const supportedLocales: ReadonlyArray<Exclude<StripeElementLocale, 'auto'>> = [
  'ar',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'en-AU',
  'en-CA',
  'en-NZ',
  'en-GB',
  'es',
  'es-ES',
  'es-419',
  'et',
  'fi',
  'fil',
  'fr',
  'fr-CA',
  'fr-FR',
  'he',
  'hu',
  'hr',
  'id',
  'it',
  'it-IT',
  'ja',
  'ko',
  'lt',
  'lv',
  'ms',
  'mt',
  'nb',
  'nl',
  'no',
  'pl',
  'pt',
  'pt-BR',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'th',
  'tr',
  'vi',
  'zh',
  'zh-HK',
  'zh-TW',
];

/**
 * Optional explicit mapping from arbitrary host locale strings to Stripe locales.
 *
 * Kept empty by default — extension point matching the Adyen connector pattern.
 * Add entries here when a host locale needs to map to a specific Stripe locale
 * that the algorithm below would not pick (e.g. mapping `"es-MX"` to `"es-419"`
 * if Latin-American Spanish becomes the preferred default for LATAM inputs).
 */
const localeToStripeLocaleMapping: Readonly<Record<string, StripeElementLocale>> = {};

/**
 * Converts an arbitrary locale string from the host storefront into a valid
 * `StripeElementLocale` for `stripeSDK.elements({ locale })`.
 *
 * Input format: BCP-47-ish. Accepts `xx`, `xx-YY`, `xx_YY`, any case
 * (`"es"`, `"es-MX"`, `"ES_mx"`, `"EN-gb"`).
 *
 * Output: always a valid `StripeElementLocale`. When the input cannot be
 * matched, returns `"auto"` — Stripe's native fallback that defers to the
 * browser's locale. `"auto"` is intentional (behavior-preserving): omitting
 * `locale` from `elements()` produces the same `"auto"` behavior, so
 * unrecognized inputs do not regress existing behavior.
 *
 * Resolution order:
 *   1. Falsy or whitespace-only input → `"auto"`.
 *   2. Explicit `localeToStripeLocaleMapping` entry (case-insensitive).
 *   3. Exact case-insensitive match in `supportedLocales` (returns the
 *      canonical-cased supported code, e.g. `"EN-gb"` → `"en-GB"`).
 *   4. Base-language exact match (e.g. `"de_DE"` → `"de"`, `"es-MX"` → `"es"`).
 *      This step preferences region-less variants so `"es-MX"` resolves to
 *      `"es"` (predictable Adyen-pattern parity) rather than `"es-419"`.
 *   5. Region-prefix scan: first supported locale whose lowercased form
 *      starts with `baseLocale + "-"` (e.g. `"zh-CN"` would match `"zh-HK"`
 *      if `"zh"` were not in the list — in practice step 4 catches this).
 *   6. Fallback → `"auto"`.
 *
 * @param locale - Host locale string (e.g. `"es-MX"`, `"fr_FR"`, `"pt"`).
 * @returns A valid `StripeElementLocale`, defaulting to `"auto"`.
 */
export const convertToStripeLocale = (locale?: string): StripeElementLocale => {
  if (!locale || !locale.trim()) {
    return 'auto';
  }

  const normalized = locale.trim().replace(/_/g, '-').toLowerCase();

  const explicit = localeToStripeLocaleMapping[normalized];
  if (explicit) {
    return explicit;
  }

  const exact = supportedLocales.find((code) => code.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }

  const baseLocale = normalized.split('-')[0];
  const baseExact = supportedLocales.find((code) => code.toLowerCase() === baseLocale);
  if (baseExact) {
    return baseExact;
  }

  const prefix = `${baseLocale}-`;
  const prefixMatch = supportedLocales.find((code) => code.toLowerCase().startsWith(prefix));
  if (prefixMatch) {
    return prefixMatch;
  }

  return 'auto';
};
