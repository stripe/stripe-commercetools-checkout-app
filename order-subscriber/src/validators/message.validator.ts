import { MESSAGE_TYPES, NOTIFICATION_TYPE_RESOURCE_CREATED } from '../constants';

/** The subset of a commercetools subscription message this module reads. */
export type OrderMessage = {
  type?: string;
  notificationType?: string;
  resource?: { typeId?: string; id?: string };
};

export type Verdict = { act: true; orderId: string } | { act: false; reason: string };

/**
 * Decides whether a decoded Pub/Sub message is an `OrderCreated` we should act on.
 *
 * Returns a verdict rather than throwing, and the difference matters for the caller's HTTP status: a
 * message we deliberately ignore is a **success** (ack it, Pub/Sub must not redeliver), while a
 * message we failed to handle is a failure (nack, retry). Throwing for both would conflate them and
 * turn every ignored message into a redelivery loop.
 */
export const classify = (message: OrderMessage | undefined): Verdict => {
  if (!message) return { act: false, reason: 'empty message body' };

  // The subscription's own creation test message. commercetools sends it once, right after the
  // Subscription is created, and it carries no order. Not an error — just not for us.
  if (message.notificationType === NOTIFICATION_TYPE_RESOURCE_CREATED) {
    return { act: false, reason: 'subscription creation test message' };
  }

  if (!message.type || !(MESSAGE_TYPES as readonly string[]).includes(message.type)) {
    return { act: false, reason: `unhandled message type ${message.type ?? 'undefined'}` };
  }

  if (message.resource?.typeId !== 'order' || !message.resource?.id) {
    return { act: false, reason: 'message carries no order id' };
  }

  // NOTE what is deliberately NOT decided here: whether the order is ours, and whether it already has
  // a paymentState. Both need a fresh read of the order — the payload's own `paymentState` is a stale
  // snapshot and using it is the race this whole module exists to avoid. See clients/order.client.ts.
  return { act: true, orderId: message.resource.id };
};

/** Pub/Sub delivers the message body base64-encoded inside `message.data`. */
export const decode = (encoded: string): OrderMessage => {
  const decoded = Buffer.from(encoded, 'base64').toString().trim();
  return JSON.parse(decoded) as OrderMessage;
};
