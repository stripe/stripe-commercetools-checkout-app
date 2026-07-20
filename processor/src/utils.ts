import { Value } from '@sinclair/typebox/value';
import { PaymentElementBehaviorOptionsDTO, PaymentElementBehaviorOptionsSchema } from './dtos/stripe-payment-element-options.dto';

export const parseJSON = <T extends object | []>(json?: string): T => {
  try {
    return JSON.parse(json || '{}');
  } catch (error) {
    console.error('Error parsing JSON', error);
    return {} as T;
  }
};

export const isValidUUID = (uuid: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

/**
 * Parses and validates STRIPE_BEHAVIOR_PAYMENT_ELEMENT.
 * A malformed value never breaks checkout: invalid JSON falls back to `{}`, and an
 * individual key that fails schema validation is dropped on its own — the rest of the
 * object is still applied.
 */
export const parsePaymentElementOptions = (raw?: string): Partial<PaymentElementBehaviorOptionsDTO> => {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('Invalid JSON in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring', error);
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('STRIPE_BEHAVIOR_PAYMENT_ELEMENT must be a JSON object, ignoring');
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const keySchema = PaymentElementBehaviorOptionsSchema.properties[key as keyof typeof PaymentElementBehaviorOptionsSchema.properties];
    if (!keySchema) {
      console.warn(`Unknown key "${key}" in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring`);
      continue;
    }
    if (Value.Check(keySchema, value)) {
      result[key] = value;
    } else {
      console.warn(`Invalid value for "${key}" in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring key`);
    }
  }
  return result as Partial<PaymentElementBehaviorOptionsDTO>;
};
