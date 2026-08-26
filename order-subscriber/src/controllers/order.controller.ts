import { FastifyReply, FastifyRequest } from 'fastify';
import { classify, decode } from '../validators/message.validator';
import { resolveOrderForWrite, writeOrderPaymentState } from '../clients/order.client';
import { log } from '../logger';

type PubSubBody = { message?: { data?: string; messageId?: string; publishTime?: string } };

/**
 * Handles one Pub/Sub push of a commercetools `OrderCreated` message.
 *
 * THE STATUS CODES CARRY MEANING, so read them before changing one. Pub/Sub retries on any non-2xx,
 * so:
 *   - 204 — handled, or deliberately ignored. Both are "do not send this again".
 *   - 500 — we failed and a retry could plausibly succeed.
 *
 * Answering 500 for a message we simply do not care about would put Pub/Sub into a redelivery loop on
 * every order in the project, most of which are not ours. Answering 204 for a genuine failure loses
 * the `Pending` write silently. The classify/act split exists to keep those two apart.
 */
export const orderCreatedHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
  const body = request.body as PubSubBody | undefined;
  const encoded = body?.message?.data;

  if (!encoded) {
    log.warn('Push with no message data — acknowledging so it is not redelivered');
    return reply.status(204).send();
  }

  let verdict;
  try {
    verdict = classify(decode(encoded));
  } catch (err) {
    const e = err as Error;
    // Undecodable payload. A retry cannot fix malformed base64 or JSON, so acknowledge it rather than
    // looping — but at error level, because it means something upstream changed shape.
    log.error('Could not decode the message — acknowledging, a retry cannot fix this', {
      messageId: body?.message?.messageId,
      errorType: e.name,
      errorMessage: e.message,
    });
    return reply.status(204).send();
  }

  if (!verdict.act) {
    log.info('Message ignored', { reason: verdict.reason, messageId: body?.message?.messageId });
    return reply.status(204).send();
  }

  try {
    const order = await resolveOrderForWrite(verdict.orderId);
    if (order) await writeOrderPaymentState(order);
    return reply.status(204).send();
  } catch (err) {
    const e = err as Error & { statusCode?: number; code?: string };
    // Scalars only — never the error object. See logger.ts.
    log.error('Failed to set the order paymentState', {
      orderId: verdict.orderId,
      errorType: e.name,
      errorMessage: e.message,
      errorCode: e.code,
      errorStatus: e.statusCode,
    });
    return reply.status(500).send();
  }
};
