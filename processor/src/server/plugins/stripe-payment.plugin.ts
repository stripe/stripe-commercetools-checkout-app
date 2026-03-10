import { FastifyInstance } from 'fastify';
import { paymentSDK } from '../../payment-sdk';
import {
  configElementRoutes,
  customerRoutes,
  expressConfigRoutes,
  paymentRoutes,
  stripeWebhooksRoutes,
} from '../../routes/stripe-payment.route';
import { corsAuthHook } from '../../libs/fastify/cors/cors';
import { StripePaymentService } from '../../services/stripe-payment.service';
import { StripeHeaderAuthHook } from '../../libs/fastify/hooks/stripe-header-auth.hook';

export default async function (server: FastifyInstance) {
  const stripePaymentService = new StripePaymentService({
    ctCartService: paymentSDK.ctCartService,
    ctPaymentService: paymentSDK.ctPaymentService,
    ctOrderService: paymentSDK.ctOrderService,
    ctPaymentMethodService: paymentSDK.ctPaymentMethodService,
    ctRecurringPaymentJobService: (paymentSDK as any).ctRecurringPaymentJobService || {
      createRecurringPaymentJobIfApplicable: async () => null,
    },
  });

  await server.register(customerRoutes, {
    paymentService: stripePaymentService,
    sessionHeaderAuthHook: paymentSDK.sessionHeaderAuthHookFn,
  });

  await server.register(paymentRoutes, {
    paymentService: stripePaymentService,
    sessionHeaderAuthHook: paymentSDK.sessionHeaderAuthHookFn,
  });

  const stripeHeaderAuthHook = new StripeHeaderAuthHook();
  await server.register(stripeWebhooksRoutes, {
    paymentService: stripePaymentService,
    stripeHeaderAuthHook: stripeHeaderAuthHook,
  });

  await server.register(configElementRoutes, {
    paymentService: stripePaymentService,
    sessionHeaderAuthHook: paymentSDK.sessionHeaderAuthHookFn,
  });

  await server.register(expressConfigRoutes, {
    paymentService: stripePaymentService,
    corsAuthHook,
  });
}
