import Fastify from 'fastify';
import { orderSubscriberRoutes } from './routes/order.route';
import { config } from './config';
import { log } from './logger';

const start = async (): Promise<void> => {
  const server = Fastify({ logger: false });
  await server.register(orderSubscriberRoutes, { prefix: '/orderSubscriber' });

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
    log.info('order-subscriber listening', { port: config.port });
  } catch (err) {
    const e = err as Error;
    log.error('order-subscriber failed to start', { errorType: e.name, errorMessage: e.message });
    process.exit(1);
  }
};

void start();
