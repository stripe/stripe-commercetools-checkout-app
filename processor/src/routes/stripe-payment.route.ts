import Stripe from 'stripe';
import { SessionHeaderAuthenticationHook } from '@commercetools/connect-payments-sdk';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import {
  ConfigElementResponseSchema,
  ConfigElementResponseSchemaDTO,
  CustomerResponseSchema,
  CustomerResponseSchemaDTO,
  PaymentResponseSchema,
  PaymentResponseSchemaDTO,
} from '../dtos/stripe-payment.dto';
import { log } from '../libs/logger';
import { stripeApi } from '../clients/stripe.client';
import { StripePaymentService } from '../services/stripe-payment.service';
import { StripeHeaderAuthHook } from '../libs/fastify/hooks/stripe-header-auth.hook';
import { Type } from '@sinclair/typebox';
import { getConfig } from '../config/config';
import {
  PaymentIntenConfirmRequestSchemaDTO,
  PaymentIntentConfirmRequestSchema,
  PaymentIntentConfirmResponseSchemaDTO,
  PaymentIntentResponseSchema,
  PaymentModificationStatus,
} from '../dtos/operations/payment-intents.dto';
import { StripeEvent } from '../services/types/stripe-payment.type';

type PaymentRoutesOptions = {
  paymentService: StripePaymentService;
  sessionHeaderAuthHook: SessionHeaderAuthenticationHook;
};

type StripeRoutesOptions = {
  paymentService: StripePaymentService;
  stripeHeaderAuthHook: StripeHeaderAuthHook;
};

export const customerRoutes = async (fastify: FastifyInstance, opts: FastifyPluginOptions & PaymentRoutesOptions) => {
  fastify.get<{ Reply: CustomerResponseSchemaDTO | null }>(
    '/customer/session',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        response: {
          200: CustomerResponseSchema,
          204: Type.Null(),
        },
      },
    },
    async (_, reply) => {
      const resp = await opts.paymentService.getCustomerSession();
      if (!resp) {
        return reply.status(204).send(null);
      }
      return reply.status(200).send(resp);
    },
  );
};

/**
 * MVP if additional information needs to be included in the payment intent, this method should be supplied with the necessary data.
 *
 */
export const paymentRoutes = async (fastify: FastifyInstance, opts: FastifyPluginOptions & PaymentRoutesOptions) => {
  fastify.get<{ Reply: PaymentResponseSchemaDTO }>(
    '/payments',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        response: {
          200: PaymentResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const isExpressCheckout =
        request.headers['x-express-checkout'] === 'true' ||
        request.headers['x-express-checkout'] === '1';
      const resp = await opts.paymentService.createPaymentIntentStripe(isExpressCheckout);
      return reply.status(200).send(resp);
    },
  );
  fastify.post<{
    Body: PaymentIntenConfirmRequestSchemaDTO;
    Reply: PaymentIntentConfirmResponseSchemaDTO;
    Params: { id: string };
  }>(
    '/confirmPayments/:id',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        params: {
          $id: 'paramsSchema',
          type: 'object',
          properties: {
            id: Type.String(),
          },
          required: ['id'],
        },
        body: PaymentIntentConfirmRequestSchema,
        response: {
          200: PaymentIntentResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params; // paymentReference
      try {
        await opts.paymentService.updatePaymentIntentStripeSuccessful(request.body.paymentIntent, id);

        return reply.status(200).send({ outcome: PaymentModificationStatus.APPROVED });
      } catch (error) {
        return reply.status(400).send({ outcome: PaymentModificationStatus.REJECTED, error: JSON.stringify(error) });
      }
    },
  );
};

export const stripeWebhooksRoutes = async (fastify: FastifyInstance, opts: StripeRoutesOptions) => {
  fastify.post<{ Body: string }>(
    '/stripe/webhooks',
    {
      preHandler: [opts.stripeHeaderAuthHook.authenticate()],
      config: { rawBody: true },
    },
    async (request, reply) => {
      const signature = request.headers['stripe-signature'] as string;

      let event: Stripe.Event;

      try {
        event = await stripeApi().webhooks.constructEvent(
          request.rawBody as string,
          signature,
          getConfig().stripeWebhookSigningSecret,
        );
      } catch (error) {
        const err = error as Error;
        log.error(JSON.stringify(err));
        return reply.status(400).send(`Webhook Error: ${err.message}`);
      }

      switch (event.type) {
        case StripeEvent.PAYMENT_INTENT__SUCCEEDED:
        case StripeEvent.CHARGE__SUCCEEDED:
          log.info(`Received: ${event.type} event of ${event.data.object.id}`);
          await opts.paymentService.processStripeEvent(event);
          // Stores payment method in commercetools if customer opted-in during checkout
          await opts.paymentService.storePaymentMethod(event);
          break;
        case StripeEvent.PAYMENT_INTENT__CANCELED:
        case StripeEvent.PAYMENT_INTENT__REQUIRED_ACTION:
        case StripeEvent.PAYMENT_INTENT__PAYMENT_FAILED:
          log.info(`Received: ${event.type} event of ${event.data.object.id}`);
          await opts.paymentService.processStripeEvent(event);
          break;
        case StripeEvent.CHARGE__REFUNDED:
          if (getConfig().stripeEnableMultiOperations) {
            log.info(`Processing Stripe multirefund event with enhanced tracking: ${event.type}`);
            await opts.paymentService.processStripeEventRefunded(event);
          } else {
            log.info(`Processing Stripe refund event with basic tracking (multi-operations disabled): ${event.type}`);
            await opts.paymentService.processStripeEvent(event);
          }
          break;
        case StripeEvent.CHARGE__UPDATED:
          if (getConfig().stripeEnableMultiOperations) {
            log.info(`Processing Stripe multicapture event: ${event.type}`);
            await opts.paymentService.processStripeEventMultipleCaptured(event);
          } else {
            log.info(`Multi-operations disabled, skipping multicapture: ${event.type}`);
          }
          break;
        default:
          log.info(`--->>> This Stripe event is not supported: ${event.type}`);
          break;
      }

      return reply.status(200).send();
    },
  );
};

export const configElementRoutes = async (
  fastify: FastifyInstance,
  opts: FastifyPluginOptions & PaymentRoutesOptions,
) => {
  fastify.get<{ Reply: ConfigElementResponseSchemaDTO; Params: { paymentComponent: string } }>(
    '/config-element/:paymentComponent',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        params: {
          $id: 'paramsSchema',
          type: 'object',
          properties: {
            paymentComponent: Type.String(),
          },
          required: ['paymentComponent'],
        },
        response: {
          200: ConfigElementResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { paymentComponent } = request.params;
      const resp = await opts.paymentService.initializeCartPayment(paymentComponent);

      return reply.status(200).send(resp);
    },
  );
  fastify.get<{ Reply: string }>('/applePayConfig', async (request, reply) => {
    const resp = opts.paymentService.applePayConfig();
    return reply.status(200).send(resp);
  });
};
