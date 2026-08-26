/**
 * Minimal structured logger.
 *
 * NEVER hand an error object straight to it. commercetools and Stripe errors expose `body`, `raw`,
 * `payment_intent` and `headers` as own enumerable properties, so serializing one leaks whole
 * payloads — for a bank transfer that means the merchant IBAN and a live client_secret. Extract
 * scalars at the call site. This is a defect the sibling processor already had to fix (task -017).
 */
type Fields = Record<string, string | number | boolean | string[] | undefined>;

const emit = (level: 'info' | 'warn' | 'error', message: string, fields?: Fields): void => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level, message, ...(fields ?? {}) }));
};

export const log = {
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
};
