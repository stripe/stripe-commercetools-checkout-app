import { describe, expect, test } from '@jest/globals';
import { classify, decode } from '../src/validators/message.validator';

const encode = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');

describe('decode', () => {
  test('reads the base64 body Pub/Sub delivers', () => {
    expect(decode(encode({ type: 'OrderCreated' }))).toEqual({ type: 'OrderCreated' });
  });

  test('throws on a malformed payload so the caller can acknowledge it deliberately', () => {
    expect(() => decode('not-base64-json')).toThrow();
  });
});

describe('classify', () => {
  test('acts on an OrderCreated carrying an order id', () => {
    const v = classify({ type: 'OrderCreated', resource: { typeId: 'order', id: 'ord-1' } });
    expect(v).toEqual({ act: true, orderId: 'ord-1' });
  });

  // commercetools sends this once when the Subscription is created. Acting on it would mean processing
  // a payload with no order in it.
  test('ignores the subscription creation test message', () => {
    const v = classify({ notificationType: 'ResourceCreated', type: 'OrderCreated' });
    expect(v).toEqual({ act: false, reason: 'subscription creation test message' });
  });

  test.each([
    [{ type: 'OrderStateChanged', resource: { typeId: 'order', id: 'o' } }, 'unhandled message type'],
    [{ type: 'OrderCreated', resource: { typeId: 'cart', id: 'c' } }, 'carries no order id'],
    [{ type: 'OrderCreated' }, 'carries no order id'],
    [undefined, 'empty message body'],
  ])('ignores %j', (message, reasonFragment) => {
    const v = classify(message as never);
    expect(v.act).toBe(false);
    if (!v.act) expect(v.reason).toContain(reasonFragment);
  });

  // The classifier deliberately does NOT decide ownership or idempotency: both need a fresh read of
  // the order, because the payload's paymentState is a stale snapshot. Pinning it here so nobody
  // "optimises" the fresh read away by moving those checks into the validator.
  test('does not use the payload paymentState to decide anything', () => {
    const withPaid = classify({
      type: 'OrderCreated',
      resource: { typeId: 'order', id: 'ord-2' },
      ...({ order: { paymentState: 'Paid' } } as object),
    });
    expect(withPaid).toEqual({ act: true, orderId: 'ord-2' });
  });
});
