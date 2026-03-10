import fastify from 'fastify';
import { describe, beforeAll, afterAll, test, expect, jest } from '@jest/globals';
import { StripePaymentService } from '../../src/services/stripe-payment.service';
import { expressConfigRoutes } from '../../src/routes/stripe-payment.route';
import { corsAuthHook } from '../../src/libs/fastify/cors/cors';
import * as configModule from '../../src/config/config';

describe('POST /express-config', () => {
  const app = fastify({ logger: false });
  const mockConfig = { environment: 'TEST', publishableKey: 'pk_test_xxx' };

  const spiedPaymentService = {
    config: jest.fn().mockResolvedValue(mockConfig),
  } as unknown as StripePaymentService;

  beforeAll(async () => {
    await app.register(expressConfigRoutes, {
      paymentService: spiedPaymentService,
      corsAuthHook,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  test('should return 403 when Origin is not in allowed origins', async () => {
    jest.spyOn(configModule, 'getConfig').mockReturnValue({ allowedOrigins: 'https://allowed.com' } as ReturnType<typeof configModule.getConfig>);

    const res = await app.inject({
      method: 'POST',
      url: '/express-config',
      headers: { 'Content-Type': 'application/json', origin: 'https://disallowed.com' },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'Forbidden', message: 'CORS origin not allowed.' });
  });

  test('should return 200 and config when Origin is allowed', async () => {
    jest.spyOn(configModule, 'getConfig').mockReturnValue({ allowedOrigins: 'https://allowed.com' } as ReturnType<typeof configModule.getConfig>);

    const res = await app.inject({
      method: 'POST',
      url: '/express-config',
      headers: { 'Content-Type': 'application/json', origin: 'https://allowed.com' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(mockConfig);
    expect(spiedPaymentService.config).toHaveBeenCalled();
  });
});
