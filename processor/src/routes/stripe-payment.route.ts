import Stripe from 'stripe';
import { SessionHeaderAuthenticationHook } from '@commercetools/connect-payments-sdk';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import {
  ConfigElementResponseSchema,
  ConfigElementResponseSchemaDTO,
  CustomerResponseSchema,
  CustomerResponseSchemaDTO,
  GetExpressPaymentDataResponseSchema,
  GetExpressPaymentDataResponseSchemaDTO,
  PaymentResponseSchema,
  PaymentResponseSchemaDTO,
} from '../dtos/stripe-payment.dto';
import { ConfigResponseSchema, ConfigResponseSchemaDTO } from '../dtos/operations/config.dto';
import { corsAuthHook } from '../libs/fastify/cors/cors';
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
import { isBankTransferNextAction } from '../utils';

type PaymentRoutesOptions = {
  paymentService: StripePaymentService;
  sessionHeaderAuthHook: SessionHeaderAuthenticationHook;
};

type StripeRoutesOptions = {
  paymentService: StripePaymentService;
  stripeHeaderAuthHook: StripeHeaderAuthHook;
};

type ExpressConfigRoutesOptions = {
  paymentService: StripePaymentService;
  corsAuthHook: typeof corsAuthHook;
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
        request.headers['x-express-checkout'] === 'true' || request.headers['x-express-checkout'] === '1';
      const isExpressCustomerSession = request.headers['x-express-customer-session'] === 'true';
      const resp = await opts.paymentService.createPaymentIntentStripe(isExpressCheckout, isExpressCustomerSession);
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
          202: PaymentIntentResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params; // paymentReference
      try {
        const outcome = await opts.paymentService.updatePaymentIntentStripeSuccessful(request.body.paymentIntent, id);

        // Async settlement still processing -> 202 (not a success). Synchronous success -> 200.
        const statusCode = outcome === PaymentModificationStatus.PENDING ? 202 : 200;
        return reply.status(statusCode).send({ outcome });
      } catch (error) {
        // Do not leak internal error detail to the browser (the service already logs the cause).
        //
        // And do not leak it to the log either: Stripe errors expose `raw`, `payment_intent`,
        // `charge` and `headers` as own enumerable properties, so passing `error` whole put the
        // full PaymentIntent — `client_secret` and bank transfer `financial_addresses` included —
        // into the log whenever updatePaymentIntentStripeSuccessful rejected on a
        // customer_balance PI. Scalars only. `paymentReference` is what makes this traceable.
        const err = error as Error & { type?: string; code?: string; statusCode?: number; httpErrorStatus?: number };
        log.warn('confirmPayments rejected', {
          paymentReference: id,
          errorType: err.type ?? err.name,
          errorMessage: err.message,
          errorCode: err.code,
          errorStatus: err.statusCode ?? err.httpErrorStatus,
        });
        return reply
          .status(400)
          .send({ outcome: PaymentModificationStatus.REJECTED, error: 'Payment confirmation failed' });
      }
    },
  );

  fastify.get<{ Reply: GetExpressPaymentDataResponseSchemaDTO }>(
    '/express-payment-data',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        response: {
          200: GetExpressPaymentDataResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const resp = await opts.paymentService.getExpressPaymentData();
      return reply.status(200).send(resp);
    },
  );
};

/**
 * Records a customer cash balance transaction. Observability only — this event is never routed to
 * processStripeEvent, and StripeEventConverter.convert() rejects it outright so that invariant is
 * enforced on both sides rather than by this switch alone.
 *
 * The event object is customer-scoped: it carries no `ct_payment_id`, and deciding which
 * commercetools transaction a reversal should write when the order may already have shipped is a
 * design of its own (deferred past v1). `funding_reversed` and `adjusted_for_overdraft` are
 * nonetheless the only signal that money was withdrawn AFTER we credited the payment, so they are
 * raised at error level to be alertable.
 *
 * THE LOG PAYLOAD IS BUILT FIELD BY FIELD ON PURPOSE. The raw event carries `sender_name`,
 * `iban_last4`, `account_number_last4` and `sort_code` under `funded.bank_transfer`. Never log the
 * event or `event.data.object` here — not even "temporarily" while debugging.
 */
const logCustomerCashBalanceTransaction = (event: Stripe.Event): void => {
  const cashTransaction = event.data.object as Stripe.CustomerCashBalanceTransaction;
  // `applied_to_payment` is populated only on transactions of that type. Neither alertable type
  // carries a PaymentIntent: `funding_reversed` has no sub-object at all, and
  // `adjusted_for_overdraft` carries only balance_transaction / linked_transaction. The cash
  // balance transaction id and the linked transaction are therefore logged too — without them an
  // alert has nothing but a customer id to trace which order lost its money.
  const appliedPaymentIntent = cashTransaction.applied_to_payment?.payment_intent;
  const linkedTransaction = cashTransaction.adjusted_for_overdraft?.linked_transaction;
  const details = {
    eventId: event.id,
    eventType: event.type,
    cashBalanceTransactionId: cashTransaction.id,
    transactionType: cashTransaction.type,
    customerId: typeof cashTransaction.customer === 'string' ? cashTransaction.customer : cashTransaction.customer?.id,
    centAmount: cashTransaction.net_amount,
    currencyCode: cashTransaction.currency?.toUpperCase(),
    paymentIntentId: typeof appliedPaymentIntent === 'string' ? appliedPaymentIntent : appliedPaymentIntent?.id,
    linkedTransactionId: typeof linkedTransaction === 'string' ? linkedTransaction : linkedTransaction?.id,
  };

  if (cashTransaction.type === 'funding_reversed' || cashTransaction.type === 'adjusted_for_overdraft') {
    log.error('Cash balance funds withdrawn after the payment was credited — commercetools is not updated', details);
    return;
  }
  log.info('Received customer cash balance transaction', details);
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
        const err = error as Error & { type?: string };
        // NEVER serialize the error object here. stripe-node's StripeSignatureVerificationError
        // sets `payload` — the full raw request body — and `header` as own enumerable properties
        // (stripe/cjs/Error.js:157-163), so JSON.stringify(err) wrote the entire webhook body to
        // the log. For a bank transfer event that is the merchant IBAN/BIC, the unauthenticated
        // hosted_instructions_url and a live client_secret, landing in a sink that is typically
        // readable by more people than Merchant Center payment-read users — and bypassing the
        // redaction choke point in StripeEventConverter entirely. This triggers on legitimate
        // events, not just attacker probes: a signing-secret rotation or clock skew is enough.
        //
        // `message` is safe and is the diagnostically useful part. stripe-node throws this error
        // from seven sites (stripe/cjs/Webhooks.js:86,104,113,118,138,147,159), each with a fixed
        // string; none embeds the payload, and between them they distinguish the causes that
        // matter: missing signature header, misconfigured signing secret, clock skew, and a raw
        // body mangled in transit (or a rawBody misconfiguration, at :138).
        //
        // Note the old JSON.stringify(err) did not even log `message`: it is non-enumerable on
        // Error and stays non-enumerable when StripeError reassigns it. So this narrows what is
        // logged AND adds the one field that was actually diagnostic.
        //
        // `header` is deliberately omitted: it carries the HMAC, and the timestamp that would be
        // needed to diagnose skew is already conveyed by the "Timestamp outside the tolerance
        // zone" message. `type` is read rather than `name` because StripeError sets `type` and
        // never sets `name`, so `name` would report the useless literal "Error".
        log.error('Stripe webhook signature verification failed', {
          errorType: err.type ?? err.name,
          errorMessage: err.message,
        });
        return reply.status(400).send(`Webhook Error: ${err.message}`);
      }

      switch (event.type) {
        case StripeEvent.PAYMENT_INTENT__SUCCEEDED:
        case StripeEvent.CHARGE__SUCCEEDED:
          log.info(`Received: ${event.type} event of ${event.data.object.id}`);
          // BEFORE processStripeEvent, and the order is load-bearing rather than stylistic.
          // `reflectOrderPaymentStateBestEffort` decides ownership partly from the presence of an
          // `Authorization/Pending` on the CT payment, and `processStripeEvent` →
          // `transitionPendingAuthorizationToSuccess` flips exactly that transaction to `Success`.
          // Called afterwards, the signal is gone and every async order would be read as a
          // synchronous card payment and left unset. `charge.succeeded` is a no-op here — it is not
          // in ORDER_PAYMENT_STATE_BY_EVENT — so this costs nothing on that branch.
          await opts.paymentService.reflectOrderPaymentStateBestEffort(event);
          await opts.paymentService.processStripeEvent(event);
          // Stores payment method in commercetools if customer opted-in during checkout
          await opts.paymentService.storePaymentMethod(event);
          break;
        case StripeEvent.PAYMENT_INTENT__PROCESSING:
        case StripeEvent.PAYMENT_INTENT__CANCELED:
        case StripeEvent.PAYMENT_INTENT__PAYMENT_FAILED:
          log.info(`Received: ${event.type} event of ${event.data.object.id}`);
          await opts.paymentService.reflectOrderPaymentStateBestEffort(event);
          await opts.paymentService.processStripeEvent(event);
          break;
        case StripeEvent.PAYMENT_INTENT__REQUIRED_ACTION:
        case StripeEvent.PAYMENT_INTENT__PARTIALLY_FUNDED: {
          // Bank transfers only. Card 3DS (`use_stripe_sdk`) and Boleto (`boleto_display_details`)
          // emit payment_intent.requires_action too, and both must keep the log-only path exactly
          // as it reads below — routing them would write an Authorization/Pending to commercetools
          // for every 3DS payment, which is the most severe regression this feature can cause.
          // Guarded by release-gate tests with dedicated 3DS and Boleto regression fixtures.
          //
          // Until this commit `requires_action` sat in the unguarded group above and reached
          // processStripeEvent for every payment method. That was harmless only because the
          // converter returned no transactions for it; now that it returns a pending
          // authorization, this predicate is the only thing standing between 3DS and a booked
          // authorization.
          //
          // NO SUBSCRIPTION GATE HERE, and its absence is deliberate rather than an omission. The
          // sibling connector skips subscription-invoice money at this point because it owns
          // recurrence; in checkout recurrence is commercetools-owned, so there is no
          // isFromSubscriptionInvoice symbol in this connector and none should be introduced.
          //
          // NO CART FREEZE HERE either, for a different reason: connect-payments-sdk exposes no
          // freeze capability, so the sibling's freezeCartForBankTransfer is hand-rolled and
          // porting it is new work rather than a port. The consequence is live and worth knowing:
          // between the shopper receiving wire instructions and the funds landing, the cart stays
          // mutable, and commercetools neither blocks completing an order whose payment does not
          // cover the cart nor serialises concurrent checkout attempts on one cart. Nothing here
          // may assume otherwise.
          // THE ORDER PAYMENT STATE IS A SEPARATE AXIS AND IT IS NOT GATED. This call sits ABOVE
          // the bank-transfer predicate on purpose, so it runs for card 3DS, Boleto, Blik and every
          // other `next_action` variant as well.
          //
          // That asymmetry is the 2026-08-18 team decision, not a leak past the gate. A
          // `requires_action` means the shopper committed to pay and something intermediate stands
          // in the way, which makes the ORDER pending for every method; whether a pending
          // AUTHORIZATION should also be booked on the Payment is the narrower question the
          // predicate below answers, and there the answer is still "bank transfer only".
          //
          // `partially_funded` shares this case block but is absent from
          // ORDER_PAYMENT_STATE_BY_EVENT, so it no-ops here — a partially funded transfer is still
          // pending and the order already says so.
          //
          // Non-blocking by contract: this method never throws, so it cannot disturb the
          // ASYNC_PENDING_EVENTS rethrow path below (KI-001).
          await opts.paymentService.reflectOrderPaymentStateBestEffort(event);

          if (!isBankTransferNextAction(event.data.object as Stripe.PaymentIntent)) {
            log.info(`Received: ${event.type} event of ${event.data.object.id}`);
            break;
          }
          log.info(`Processing Stripe payment event: ${event.type}`);
          await opts.paymentService.processStripeEvent(event);
          break;
        }
        case StripeEvent.CUSTOMER_CASH_BALANCE_TRANSACTION__CREATED:
          logCustomerCashBalanceTransaction(event);
          break;
        case StripeEvent.REFUND__UPDATED:
        case StripeEvent.REFUND__FAILED: {
          // ONLY the failed outcome is acted on here, and the asymmetry is deliberate rather than
          // half-finished work.
          //
          // charge.refunded already writes Refund/Success, so handling success here too would book
          // the same refund twice. Failure, on the other hand, is currently written NOWHERE: a
          // refund that Stripe later rejects stays recorded in commercetools as successful forever,
          // and the merchant sees money returned that never left. That gap is what this closes.
          //
          // The asymmetry is a stopgap, not the end state. On a delayed rail a refund is created
          // `pending` and resolves minutes to days later, so refund.updated — which fires with the
          // terminal status on every rail — is the natural single owner of the Refund transaction.
          // charge.refunded cannot be, because its payload omits the refunds sublist entirely and
          // so cannot tell pending from succeeded. Moving ownership changes card behaviour too, so
          // it is a separate decision.
          //
          // Until then a bank-transfer refund is optimistically Success while genuinely pending,
          // and is corrected only if it fails.
          const refund = event.data.object as Stripe.Refund;
          if (refund.status !== 'failed' && refund.status !== 'canceled') {
            log.info(`Received: ${event.type} with status ${refund.status} — no commercetools change.`);
            break;
          }
          log.info(`Processing failed refund: ${event.type} (${refund.status})`);
          await opts.paymentService.processStripeEventRefundFailed(event);
          break;
        }
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

/**
 * Express config route: public config for rendering Express buttons without session.
 * Secured by CORS (Origin validation) only; no session required.
 */
export const expressConfigRoutes = async (
  fastify: FastifyInstance,
  opts: FastifyPluginOptions & ExpressConfigRoutesOptions,
) => {
  fastify.post<{ Reply: ConfigResponseSchemaDTO }>(
    '/express-config',
    {
      preHandler: [opts.corsAuthHook()],
      schema: {
        response: {
          200: ConfigResponseSchema,
        },
      },
    },
    async (_, reply) => {
      const config = await opts.paymentService.config();
      return reply.status(200).send(config);
    },
  );
};
