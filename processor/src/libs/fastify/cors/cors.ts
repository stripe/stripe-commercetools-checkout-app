import { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../../../config/config';

/**
 * Returns a preHandler that validates the request Origin header against allowedOrigins.
 * Used to secure POST /express-config (no session): only requests from allowed origins are accepted.
 *
 * @returns PreHandler function that rejects with 403 when Origin is not in the allowed list.
 */
export function corsAuthHook() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const allowed = getConfig().allowedOrigins?.trim();
    if (!allowed) {
      return;
    }
    const origin = request.headers.origin;
    if (!origin) {
      await reply.status(403).send({
        error: 'Forbidden',
        message: 'CORS origin not allowed.',
      });
      return;
    }
    const origins = allowed.split(',').map((o) => o.trim()).filter(Boolean);
    if (!origins.includes(origin)) {
      await reply.status(403).send({
        error: 'Forbidden',
        message: 'CORS origin not allowed.',
      });
      return;
    }
  };
}
