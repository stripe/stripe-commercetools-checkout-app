import Stripe from 'stripe';
import { SessionHeaderAuthenticationHook } from '@commercetools/connect-payments-sdk';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { FastifyRequest, FastifyReply } from 'fastify';
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
const getRegionFromRequest = (request: any): 'US' | 'CA' | 'EU' => {
  const header = (request.headers['x-gmsb-region'] as string)?.toUpperCase();
  if (header === 'CA') return 'CA';
  if (header === 'EU') return 'EU';
  return 'US'; // default
};
const getRegionFromWebhookSecret = (): 'US' | 'CA' | 'EU' => {
  const secret = getConfig().stripeWebhookSigningSecret;
 
  if (secret === getConfig().stripeSecretKeyUS) return 'US';
  if (secret === getConfig().stripeSecretKeyCA) return 'CA';
  if (secret === getConfig().stripeSecretKeyEU) return 'EU';
 
  throw new Error('Unable to determine Stripe region from webhook secret');
};

export const customerRoutes = async (fastify: FastifyInstance, opts: FastifyPluginOptions & PaymentRoutesOptions) => {
  fastify.get<{ Reply: CustomerResponseSchemaDTO }>(
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
    async (_, reply: FastifyReply) => {
      const resp = await opts.paymentService.getCustomerSession();
      if (!resp) {
        return reply.status(204).send(resp);
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
async (
  request: FastifyRequest,
  reply: FastifyReply
) => {

  const region = getRegionFromRequest(request);
  const resp = await opts.paymentService.createPaymentIntentStripe(region);

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
async (
  request: FastifyRequest,
  reply: FastifyReply
) => {

  const { id } = request.params;
  const region = getRegionFromRequest(request);
 
  try {
    await opts.paymentService.updatePaymentIntentStripeSuccessful(
      request.body.paymentIntent,
      id,
      region
    );
 
    return reply.status(200).send({ outcome: PaymentModificationStatus.APPROVED });
  } catch (error) {
    return reply.status(400).send({
      outcome: PaymentModificationStatus.REJECTED,
      error: JSON.stringify(error),
    });
  }
},
  );
};

const registerStripeWebhook = (
  fastify: FastifyInstance,
  opts: StripeRoutesOptions,
  region: 'US' | 'CA' | 'EU',
) => {
  fastify.post<{ Body: string }>(
    `/stripe/webhooks/${region.toLowerCase()}`,
    {
      preHandler: [opts.stripeHeaderAuthHook.authenticate()],
      config: { rawBody: true },
    },
async (
  request: FastifyRequest,
  reply: FastifyReply
) => {

      const signature = request.headers['stripe-signature'] as string;

      let event: Stripe.Event;

      try {
        event = stripeApi(region).webhooks.constructEvent(
          request.rawBody as string,
          signature,
          getConfig().stripeWebhookSigningSecret,
        );
      } catch (err) {
        log.error(err);
        return reply.status(400).send(`Webhook Error`);
      }

      await opts.paymentService.processStripeEvent(event, region);
      return reply.status(200).send();
    },
  );
};

export const stripeWebhooksRoutes = async (
  fastify: FastifyInstance,
  opts: StripeRoutesOptions,
) => {
  registerStripeWebhook(fastify, opts, 'US');
  registerStripeWebhook(fastify, opts, 'CA');
  registerStripeWebhook(fastify, opts, 'EU');
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
async (
  request: FastifyRequest,
  reply: FastifyReply
) => {

      const { paymentComponent } = request.params;
      const region = getRegionFromRequest(request);
      const resp = await opts.paymentService.initializeCartPayment(
        paymentComponent,
        region
      );


      return reply.status(200).send(resp);
    },
  );
  fastify.get<{ Reply: string }>('/applePayConfig', async (
  request: FastifyRequest,
  reply: FastifyReply
) => {

    const resp = opts.paymentService.applePayConfig();
    return reply.status(200).send(resp);
  });
};
