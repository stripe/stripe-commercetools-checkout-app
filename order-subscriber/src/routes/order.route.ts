import { FastifyInstance } from 'fastify';
import { orderCreatedHandler } from '../controllers/order.controller';

/**
 * The endpoint commercetools Connect routes Pub/Sub pushes to. Must match `endpoint` in connect.yaml.
 */
export const orderSubscriberRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/', orderCreatedHandler);
};
