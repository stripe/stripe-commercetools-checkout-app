import Stripe from 'stripe';
import fastify from 'fastify';
import { describe, beforeAll, afterAll, test, expect, jest, afterEach, beforeEach } from '@jest/globals';
import {
  CommercetoolsCartService,
  CommercetoolsOrderService,
  CommercetoolsPaymentMethodService,
  CommercetoolsPaymentService,
  ContextProvider,
  JWTAuthenticationHook,
  Oauth2AuthenticationHook,
  RequestContextData,
  SessionHeaderAuthenticationHook,
  SessionHeaderAuthenticationManager,
} from '@commercetools/connect-payments-sdk';

// CommercetoolsRecurringPaymentJobService may not be available in all SDK versions
type CommercetoolsRecurringPaymentJobService = {
  createRecurringPaymentJobIfApplicable: (params: {
    originPayment: { id: string; typeId: string };
    paymentMethod: { id: string; typeId: string };
  }) => Promise<{ id: string } | null>;
};
import { IncomingHttpHeaders } from 'node:http';
import {
  configElementRoutes,
  customerRoutes,
  paymentRoutes,
  stripeWebhooksRoutes,
} from '../../src/routes/stripe-payment.route';
import { StripePaymentService } from '../../src/services/stripe-payment.service';
import { PaymentModificationStatus } from '../../src/dtos/operations/payment-intents.dto';
import {
  mockEvent__paymentIntent_processing,
  mockEvent__paymentIntent_paymentFailed,
  mockEvent__paymentIntent_succeeded_captureMethodManual,
  mockEvent__charge_refund_captured,
  mockEvent__paymentIntent_canceled,
  mockRoute__payments_succeed,
  mockRoute__get_config_element_succeed,
  mockEvent__charge_capture_succeeded_notCaptured,
  mockEvent__paymentIntent_requiresAction,
  mockEvent__paymentIntent_requiresAction_3ds,
  mockEvent__paymentIntent_requiresAction_boleto,
  mockEvent__paymentIntent_requiresAction_bankTransfer,
  mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
  mockEvent__paymentIntent_partiallyFunded_bankTransfer,
  mockEvent__customerCashBalanceTransaction_appliedToPayment,
  mockEvent__customerCashBalanceTransaction_fundingReversed,
  mockEvent__refund_failed,
  mockEvent__refund_updated_succeeded,
  mockEvent__refund_updated_canceled,
  mockRoute__well_know__succeed,
  mockRoute__customer_session_succeed,
} from '../utils/mock-routes-data';
import * as Config from '../../src/config/config';
import * as Logger from '../../src/libs/logger/index';
import { StripeHeaderAuthHook } from '../../src/libs/fastify/hooks/stripe-header-auth.hook';
import { appLogger } from '../../src/payment-sdk';

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: jest.fn<() => Stripe.Event>().mockReturnValue(mockEvent__charge_capture_succeeded_notCaptured),
    },
  })),
}));
jest.mock('../../src/services/stripe-payment.service');
jest.mock('../../src/libs/logger/index');

interface FlexibleConfig {
  [key: string]: string | boolean; // Adjust the type according to your config values
}
function setupMockConfig(keysAndValues: Record<string, string | boolean>) {
  const mockConfig: FlexibleConfig = {};
  Object.keys(keysAndValues).forEach((key) => {
    const value = keysAndValues[key];
    // Convert 'true'/'false' strings to actual booleans for stripeEnableMultiOperations
    if (key === 'stripeEnableMultiOperations' && typeof value === 'string') {
      mockConfig[key] = value === 'true';
    } else {
      mockConfig[key] = value;
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jest.spyOn(Config, 'getConfig').mockReturnValue(mockConfig as any);
}

describe('Stripe Payment APIs', () => {
  const fastifyApp = fastify({ logger: false });
  const token = 'token';
  const jwtToken = 'jwtToken';
  const sessionId = 'session-id';

  const spyAuthenticateJWT = jest
    .spyOn(JWTAuthenticationHook.prototype, 'authenticate')
    .mockImplementationOnce(() => async (request: { headers: IncomingHttpHeaders }) => {
      expect(request.headers['authorization']).toContain(`Bearer ${jwtToken}`);
    });

  const spyAuthenticateOauth2 = jest
    .spyOn(Oauth2AuthenticationHook.prototype, 'authenticate')
    .mockImplementationOnce(() => async (request: { headers: IncomingHttpHeaders }) => {
      expect(request.headers['authorization']).toContain(`Bearer ${token}`);
    });

  const spyAuthenticateSession = jest
    .spyOn(SessionHeaderAuthenticationHook.prototype, 'authenticate')
    .mockImplementation(() => async (request: { headers: IncomingHttpHeaders }) => {
      expect(request.headers['x-session-id']).toContain('session-id');
    });

  const spyStripeHeaderAuthHook = jest
    .spyOn(SessionHeaderAuthenticationHook.prototype, 'authenticate')
    .mockImplementation(() => async () => {
      expect('stripe-signature').toEqual('stripe-signature');
    });

  const spiedSessionHeaderAuthenticationHook = new SessionHeaderAuthenticationHook({
    logger: appLogger,
    authenticationManager: jest.fn() as unknown as SessionHeaderAuthenticationManager,
    contextProvider: jest.fn() as unknown as ContextProvider<RequestContextData>,
  });

  const spiedPaymentService = new StripePaymentService({
    ctCartService: jest.fn() as unknown as CommercetoolsCartService,
    ctPaymentService: jest.fn() as unknown as CommercetoolsPaymentService,
    ctOrderService: jest.fn() as unknown as CommercetoolsOrderService,
    ctPaymentMethodService: jest.fn() as unknown as CommercetoolsPaymentMethodService,
    ctRecurringPaymentJobService: jest.fn() as unknown as CommercetoolsRecurringPaymentJobService,
  });

  const spiedStripeHeaderAuthHook = new StripeHeaderAuthHook();

  const originalEnv = process.env;

  beforeAll(async () => {
    await fastifyApp.register(stripeWebhooksRoutes, {
      stripeHeaderAuthHook: spiedStripeHeaderAuthHook,
      paymentService: spiedPaymentService,
    });

    await fastifyApp.register(paymentRoutes, {
      prefix: '/',
      sessionHeaderAuthHook: spiedSessionHeaderAuthenticationHook,
      paymentService: spiedPaymentService,
    });

    await fastifyApp.register(configElementRoutes, {
      prefix: '/',
      sessionHeaderAuthHook: spiedSessionHeaderAuthenticationHook,
      paymentService: spiedPaymentService,
    });

    await fastifyApp.register(customerRoutes, {
      prefix: '/',
      sessionHeaderAuthHook: spiedSessionHeaderAuthenticationHook,
      paymentService: spiedPaymentService,
    });
  });

  beforeEach(() => {
    jest.setTimeout(10000);
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'STRIPE_WEBHOOK_SIGNING_SECRET';
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    spyAuthenticateJWT.mockClear();
    spyAuthenticateOauth2.mockClear();
    spyAuthenticateSession.mockClear();
    spyStripeHeaderAuthHook.mockClear();
    await fastifyApp.ready();
    process.env = originalEnv;
  });

  afterAll(async () => {
    await fastifyApp.close();
  });

  describe('POST /stripe/webhooks', () => {
    test('it should handle a payment_intent.succeeded event gracefully.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest
        .spyOn(Stripe.prototype.webhooks, 'constructEvent')
        .mockReturnValue(mockEvent__paymentIntent_succeeded_captureMethodManual);

      jest.spyOn(StripePaymentService.prototype, 'processStripeEvent').mockReturnValue(Promise.resolve());
      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalled();
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalledTimes(1);
    });

    test('it should route a payment_intent.processing event to processStripeEvent.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });

      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockEvent__paymentIntent_processing);
      jest.spyOn(StripePaymentService.prototype, 'processStripeEvent').mockReturnValue(Promise.resolve());

      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalledTimes(1);
    });

    test('it should handle a charge.refunded event gracefully with enhanced multirefund tracking.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
        stripeEnableMultiOperations: 'true',
      });

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockEvent__charge_refund_captured);
      jest.spyOn(StripePaymentService.prototype, 'processStripeEventRefunded').mockReturnValue(Promise.resolve());

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEventRefunded).toHaveBeenCalled();
    });

    test('it should handle a charge.refunded event with basic tracking when multi-operations disabled.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
        stripeEnableMultiOperations: 'false',
      });

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockEvent__charge_refund_captured);
      jest.spyOn(StripePaymentService.prototype, 'processStripeEvent').mockReturnValue(Promise.resolve());

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalled();
      expect(spiedPaymentService.processStripeEventRefunded).not.toHaveBeenCalled();
    });

    test('it should handle a charge.updated event and route to multicapture handler when enabled.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
        stripeEnableMultiOperations: 'true',
      });

      const mockChargeUpdatedEvent: Stripe.Event = {
        id: 'evt_charge_updated',
        object: 'event',
        type: 'charge.updated',
        created: Date.now(),
        api_version: '2024-04-10',
        livemode: false,
        pending_webhooks: 0,
        request: null,
        data: {
          object: {
            id: 'ch_123',
            object: 'charge',
            amount_captured: 50000,
            captured: true,
            currency: 'usd',
            balance_transaction: 'txn_123',
            payment_intent: 'pi_123',
          } as Stripe.Charge,
          previous_attributes: {
            amount_captured: 30000,
          } as Partial<Stripe.Charge>,
        },
      } as Stripe.Event;

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockChargeUpdatedEvent);
      jest
        .spyOn(StripePaymentService.prototype, 'processStripeEventMultipleCaptured')
        .mockReturnValue(Promise.resolve());

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEventMultipleCaptured).toHaveBeenCalled();
    });

    test('it should skip charge.updated event when multi-operations disabled.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
        stripeEnableMultiOperations: 'false',
      });

      const mockChargeUpdatedEvent: Stripe.Event = {
        id: 'evt_charge_updated',
        object: 'event',
        type: 'charge.updated',
        created: Date.now(),
        api_version: '2024-04-10',
        livemode: false,
        pending_webhooks: 0,
        request: null,
        data: {
          object: {
            id: 'ch_123',
            object: 'charge',
            amount_captured: 50000,
            captured: true,
            currency: 'usd',
            balance_transaction: 'txn_123',
            payment_intent: 'pi_123',
          } as Stripe.Charge,
          previous_attributes: {
            amount_captured: 30000,
          } as Partial<Stripe.Charge>,
        },
      } as Stripe.Event;

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockChargeUpdatedEvent);
      jest
        .spyOn(StripePaymentService.prototype, 'processStripeEventMultipleCaptured')
        .mockReturnValue(Promise.resolve());

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEventMultipleCaptured).not.toHaveBeenCalled();
    });

    test('it should handle a payment_intent.canceled event gracefully.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockEvent__paymentIntent_canceled);
      jest.spyOn(StripePaymentService.prototype, 'processStripeEvent').mockReturnValue(Promise.resolve());

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalled();
    });

    test('it should handle a payment_intent.payment_failed event gracefully.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockEvent__paymentIntent_paymentFailed);

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(Logger.log.info).toHaveBeenCalled();
    });

    test('it should handle a payment_intent.requires_action event gracefully.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockEvent__paymentIntent_requiresAction);

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(Logger.log.info).toHaveBeenCalled();
    });

    test('it should return a 400 status error when the request body is not a valid Stripe event.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockImplementation(() => {
        throw new Error('Error creating Stripe Event from webhook payload');
      });

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(400);
      expect(Logger.log.error).toHaveBeenCalled();
    });

    // A StripeSignatureVerificationError carries the full raw request body as an own enumerable
    // `payload` property and the signature header as `header`. The route used to log
    // JSON.stringify(err), which wrote the entire body — for a bank transfer that is the merchant
    // IBAN/BIC, the unauthenticated instructions URL and a live client_secret — to a sink that is
    // typically readable by more people than Merchant Center payment-read users, bypassing the
    // redaction choke point in StripeEventConverter. Asserted on content, not on shape, so the
    // test still bites if the log call is restructured.
    test('it should never log the raw webhook payload when signature verification fails.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });

      const rawBodyWithSecrets = JSON.stringify({
        id: 'evt_bt_11111',
        data: {
          object: {
            client_secret: 'pi_bt_11111_secret',
            next_action: {
              display_bank_transfer_instructions: {
                financial_addresses: [{ iban: { iban: 'DE89370400440532013000', bic: 'BUKBGB22' } }],
                hosted_instructions_url: 'https://payments.stripe.com/bank_transfer_instructions/test_11111',
              },
            },
          },
        },
      });

      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockImplementation(() => {
        // Mirrors stripe-node's StripeSignatureVerificationError: `header` and `payload` are set
        // as own enumerable properties (stripe/cjs/Error.js:157-163).
        const err = new Error('Timestamp outside the tolerance zone') as Error & {
          type: string;
          header: string;
          payload: string;
        };
        err.type = 'StripeSignatureVerificationError';
        err.header = 't=123123123,v1=gk2j34gk2j34g2k3j4';
        err.payload = rawBodyWithSecrets;
        throw err;
      });

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
          'content-type': 'application/json',
        },
        payload: rawBodyWithSecrets,
      });

      //Then
      expect(response.statusCode).toEqual(400);
      expect(Logger.log.error).toHaveBeenCalled();

      const logged = JSON.stringify((Logger.log.error as jest.Mock).mock.calls);
      expect(logged).not.toContain('DE89370400440532013000');
      expect(logged).not.toContain('BUKBGB22');
      expect(logged).not.toContain('payments.stripe.com/bank_transfer_instructions');
      expect(logged).not.toContain('pi_bt_11111_secret');
      expect(logged).not.toContain('v1=gk2j34gk2j34g2k3j4');

      // The fix must not trade a leak for a lost night: the failure has to stay diagnosable.
      // These five messages are the only ones stripe-node throws here, and they are what
      // distinguishes a misconfigured signing secret from clock skew from a mangled raw body.
      expect(logged).toContain('Timestamp outside the tolerance zone');
      expect(logged).toContain('StripeSignatureVerificationError');
    });

    test('it should print a log when the Stripe event received is not supported.', async () => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });

      // Set mocked functions to Stripe and spyOn to set the result expected
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(mockEvent__paymentIntent_processing);

      //When
      const response = await fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: {
          'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4',
        },
      });

      //Then
      expect(response.statusCode).toEqual(200);
      expect(Logger.log.info).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Bank transfers (customer_balance) — SB3-207 task 005
    //
    // These test the ROUTE's narrowing, which is the only thing standing between card 3DS and a
    // booked Authorization/Pending now that the converter returns one unconditionally for
    // payment_intent.requires_action.
    // -----------------------------------------------------------------------
    const postWebhook = () =>
      fastifyApp.inject({
        method: 'POST',
        url: `/stripe/webhooks`,
        headers: { 'stripe-signature': 't=123123123,v1=gk2j34gk2j34g2k3j4' },
      });

    const arrangeWebhook = (event: Stripe.Event) => {
      setupMockConfig({
        stripeSecretKey: 'stripeSecretKey',
        stripeWebhookSigningSecret: 'stripeWebhookSigningSecret',
        authUrl: 'https://auth.europe-west1.gcp.commercetools.com',
      });
      Stripe.prototype.webhooks = { constructEvent: jest.fn() } as unknown as Stripe.Webhooks;
      jest.spyOn(Stripe.prototype.webhooks, 'constructEvent').mockReturnValue(event);
      jest.spyOn(StripePaymentService.prototype, 'processStripeEvent').mockReturnValue(Promise.resolve());
      jest.spyOn(StripePaymentService.prototype, 'processStripeEventRefundFailed').mockReturnValue(Promise.resolve());
      jest
        .spyOn(StripePaymentService.prototype, 'reflectOrderPaymentStateBestEffort')
        .mockReturnValue(Promise.resolve());
    };

    // ***** RELEASE GATE *****
    // Card 3DS emits payment_intent.requires_action too. If the next_action predicate is ever
    // removed or widened, every 3DS payment would get an Authorization/Pending written to
    // commercetools. This test must fail if that happens.
    test('RELEASE GATE: a card 3DS requires_action event is logged only and never processed', async () => {
      arrangeWebhook(mockEvent__paymentIntent_requiresAction_3ds);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).not.toHaveBeenCalled();
      expect(Logger.log.info).toHaveBeenCalledWith('Received: payment_intent.requires_action event of pi_3ds_11111');
    });

    // ***** RELEASE GATE *****
    test('RELEASE GATE: a Boleto requires_action event is logged only and never processed', async () => {
      arrangeWebhook(mockEvent__paymentIntent_requiresAction_boleto);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).not.toHaveBeenCalled();
      expect(Logger.log.info).toHaveBeenCalledWith('Received: payment_intent.requires_action event of pi_boleto_11111');
    });

    // ***** MIRROR ASSERTION *****
    // The two gates above pass just as happily if the predicate rejects EVERYTHING. Without this
    // test the whole feature can be silently dead with a green suite — which is the failure mode
    // a release gate written only in the negative cannot see.
    test('MIRROR: a bank transfer requires_action event IS routed to processStripeEvent', async () => {
      arrangeWebhook(mockEvent__paymentIntent_requiresAction_bankTransfer);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalledTimes(1);
    });

    // ***** MIRROR ASSERTION *****
    test('MIRROR: a bank transfer partially_funded event IS routed to processStripeEvent', async () => {
      arrangeWebhook(mockEvent__paymentIntent_partiallyFunded_bankTransfer);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalledTimes(1);
    });

    // -----------------------------------------------------------------------
    // The two-axis gate split — SB3-207 task 028 / ADR-009
    //
    // `Order.paymentState` and `Payment.transactions[].state` are separate axes with DIFFERENT
    // gates, and that is the decision of the 2026-08-18 session rather than an oversight:
    // `requires_action` reflects a pending ORDER for every payment method, while only a bank
    // transfer books a pending AUTHORIZATION. These tests pin both halves, because a future reader
    // seeing 3DS "leak past" the predicate will otherwise be tempted to unify the two.
    // -----------------------------------------------------------------------

    // ***** RELEASE GATE *****
    test('GATE SPLIT: card 3DS reflects the ORDER state but books NO transaction', async () => {
      arrangeWebhook(mockEvent__paymentIntent_requiresAction_3ds);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.reflectOrderPaymentStateBestEffort).toHaveBeenCalledTimes(1);
      expect(spiedPaymentService.processStripeEvent).not.toHaveBeenCalled();
    });

    // ***** RELEASE GATE *****
    test('GATE SPLIT: Boleto reflects the ORDER state but books NO transaction', async () => {
      arrangeWebhook(mockEvent__paymentIntent_requiresAction_boleto);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.reflectOrderPaymentStateBestEffort).toHaveBeenCalledTimes(1);
      expect(spiedPaymentService.processStripeEvent).not.toHaveBeenCalled();
    });

    // ***** MIRROR ASSERTION *****
    // Without this, the two gates above are equally satisfied by a route that calls NEITHER method.
    test('MIRROR: a bank transfer requires_action drives BOTH axes', async () => {
      arrangeWebhook(mockEvent__paymentIntent_requiresAction_bankTransfer);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.reflectOrderPaymentStateBestEffort).toHaveBeenCalledTimes(1);
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalledTimes(1);
    });

    // ***** ORDERING ASSERTION *****
    // The one invariant no other test can see. Ownership of an order is decided partly from the
    // presence of an `Authorization/Pending` on the CT payment, and `processStripeEvent` →
    // `transitionPendingAuthorizationToSuccess` flips exactly that transaction to `Success`. Swap
    // these two calls and every async order silently reads as a synchronous card payment and is
    // left unset — with no other test going red.
    test('ORDERING: the order state is reflected BEFORE processStripeEvent on succeeded', async () => {
      arrangeWebhook(mockEvent__paymentIntent_succeeded_captureMethodAutomatic);
      jest.spyOn(StripePaymentService.prototype, 'storePaymentMethod').mockReturnValue(Promise.resolve());
      const callOrder: string[] = [];
      (spiedPaymentService.reflectOrderPaymentStateBestEffort as jest.Mock).mockImplementation(() => {
        callOrder.push('reflect');
        return Promise.resolve();
      });
      (spiedPaymentService.processStripeEvent as jest.Mock).mockImplementation(() => {
        callOrder.push('process');
        return Promise.resolve();
      });

      await postWebhook();

      expect(callOrder).toEqual(['reflect', 'process']);
    });

    test('partially_funded does not touch the order state axis', async () => {
      arrangeWebhook(mockEvent__paymentIntent_partiallyFunded_bankTransfer);

      await postWebhook();

      // Routed for the transaction axis, but the reflection call itself no-ops on this event type
      // because it is absent from ORDER_PAYMENT_STATE_BY_EVENT. The route calls it anyway (the two
      // event types share a case block), so this asserts the reflection is a no-op by MAPPING and
      // not by routing — see the service spec for the mapping assertion.
      expect(spiedPaymentService.processStripeEvent).toHaveBeenCalledTimes(1);
    });

    test('customer_cash_balance_transaction.created is never routed to processStripeEvent', async () => {
      arrangeWebhook(mockEvent__customerCashBalanceTransaction_appliedToPayment);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).not.toHaveBeenCalled();
      expect(Logger.log.info).toHaveBeenCalledWith(
        'Received customer cash balance transaction',
        expect.objectContaining({
          cashBalanceTransactionId: 'ccsbtxn_11111',
          transactionType: 'applied_to_payment',
          paymentIntentId: 'pi_bt_11111',
        }),
      );
    });

    test('customer_cash_balance_transaction.created with funding_reversed raises an alertable error', async () => {
      arrangeWebhook(mockEvent__customerCashBalanceTransaction_fundingReversed);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEvent).not.toHaveBeenCalled();
      expect(Logger.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Cash balance funds withdrawn'),
        expect.objectContaining({
          transactionType: 'funding_reversed',
          cashBalanceTransactionId: 'ccsbtxn_22222',
          customerId: 'cus_11111',
          centAmount: -12300,
          currencyCode: 'EUR',
        }),
      );
    });

    // The handler builds its payload field by field precisely so this holds. Asserted on content
    // rather than on shape, so it still bites if someone "simplifies" the log call into passing
    // the event — which is the change that would leak, and which no structural assertion catches.
    test('the cash balance log never emits sender_name, iban_last4 or sort_code', async () => {
      arrangeWebhook(mockEvent__customerCashBalanceTransaction_fundingReversed);

      await postWebhook();

      const logged = JSON.stringify(
        (Logger.log.error as unknown as jest.Mock).mock.calls.concat(
          (Logger.log.info as unknown as jest.Mock).mock.calls,
        ),
      );
      expect(logged).not.toContain('Erika Mustermann');
      expect(logged).not.toContain('iban_last4');
      expect(logged).not.toContain('BUKBGB22');
    });

    test('refund.updated with a succeeded status changes nothing in commercetools', async () => {
      arrangeWebhook(mockEvent__refund_updated_succeeded);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEventRefundFailed).not.toHaveBeenCalled();
      expect(Logger.log.info).toHaveBeenCalledWith(
        'Received: refund.updated with status succeeded — no commercetools change.',
      );
    });

    test('refund.failed is routed to processStripeEventRefundFailed', async () => {
      arrangeWebhook(mockEvent__refund_failed);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEventRefundFailed).toHaveBeenCalledTimes(1);
    });

    // A refund canceled after creation leaves the same false Refund/Success behind as a failed
    // one, so it takes the same correction path.
    test('refund.updated with a canceled status is routed to processStripeEventRefundFailed', async () => {
      arrangeWebhook(mockEvent__refund_updated_canceled);

      const response = await postWebhook();

      expect(response.statusCode).toEqual(200);
      expect(spiedPaymentService.processStripeEventRefundFailed).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /payment', () => {
    test('should call /payment and return valid information', async () => {
      //Given
      jest.spyOn(spiedPaymentService, 'createPaymentIntentStripe').mockResolvedValue(mockRoute__payments_succeed);

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'GET',
        url: `/payments`,
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(200);
      expect(responseGetConfig.json()).toEqual(mockRoute__payments_succeed);
      expect(spiedPaymentService.createPaymentIntentStripe).toHaveBeenCalled();
    });

    test('should call createPaymentIntentStripe with true when x-express-checkout header is present', async () => {
      jest.spyOn(spiedPaymentService, 'createPaymentIntentStripe').mockResolvedValue(mockRoute__payments_succeed);

      await fastifyApp.inject({
        method: 'GET',
        url: `/payments`,
        headers: {
          'x-session-id': sessionId,
          'x-express-checkout': 'true',
          'content-type': 'application/json',
        },
      });

      expect(spiedPaymentService.createPaymentIntentStripe).toHaveBeenCalledWith(true, false);
    });
  });

  describe('POST /confirmPayments/:id', () => {
    test('should call /confirmPayments/:id and return valid information', async () => {
      //Given
      jest
        .spyOn(spiedPaymentService, 'updatePaymentIntentStripeSuccessful')
        .mockResolvedValue(PaymentModificationStatus.APPROVED);

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'POST',
        url: `/confirmPayments/id`,
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ paymentIntent: 'paymentId' }),
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(200);
      expect(responseGetConfig.body).toEqual(JSON.stringify({ outcome: 'approved' }));
      expect(spiedPaymentService.updatePaymentIntentStripeSuccessful).toHaveBeenCalled();
    });

    test('should return 202 with outcome "pending" when the PaymentIntent is still processing', async () => {
      //Given
      jest
        .spyOn(spiedPaymentService, 'updatePaymentIntentStripeSuccessful')
        .mockResolvedValue(PaymentModificationStatus.PENDING);

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'POST',
        url: `/confirmPayments/id`,
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ paymentIntent: 'paymentId' }),
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(202);
      expect(responseGetConfig.body).toEqual(JSON.stringify({ outcome: 'pending' }));
    });

    test('should call /confirmPayments/:id and NOT leak internal error detail to the client', async () => {
      //Given
      jest.spyOn(spiedPaymentService, 'updatePaymentIntentStripeSuccessful').mockImplementation(() => {
        throw new Error('Invalid PaymentIntent: metadata.ct_payment_id does not match this payment');
      });

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'POST',
        url: `/confirmPayments/id`,
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ paymentIntent: 'paymentId' }),
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(400);
      expect(responseGetConfig.body).toEqual(
        JSON.stringify({ outcome: 'rejected', error: 'Payment confirmation failed' }),
      );
      // The internal error message must not appear in the response body.
      expect(responseGetConfig.body).not.toContain('metadata.ct_payment_id');
      expect(spiedPaymentService.updatePaymentIntentStripeSuccessful).toHaveBeenCalled();
    });

    // Sibling of the test above: not leaking to the client is only half of it. The catch used to
    // pass the whole error to the logger, and Stripe errors expose `raw`, `payment_intent`,
    // `charge` and `headers` as own enumerable properties — so a rejection on a customer_balance
    // PaymentIntent wrote the full PI, client_secret and financial_addresses included, to the log.
    test('should call /confirmPayments/:id and NOT leak the Stripe error object to the log', async () => {
      //Given
      jest.spyOn(spiedPaymentService, 'updatePaymentIntentStripeSuccessful').mockImplementation(() => {
        const err = new Error('PaymentIntent is not in a confirmable state') as Error & {
          type: string;
          code: string;
          statusCode: number;
          raw: unknown;
          payment_intent: unknown;
          headers: unknown;
        };
        err.type = 'StripeInvalidRequestError';
        err.code = 'payment_intent_unexpected_state';
        err.statusCode = 400;
        err.headers = { 'request-id': 'req_leak_11111' };
        err.payment_intent = {
          id: 'pi_bt_11111',
          client_secret: 'pi_bt_11111_secret',
          next_action: {
            display_bank_transfer_instructions: {
              financial_addresses: [{ iban: { iban: 'DE89370400440532013000', bic: 'BUKBGB22' } }],
              hosted_instructions_url: 'https://payments.stripe.com/bank_transfer_instructions/test_11111',
            },
          },
        };
        err.raw = { message: err.message, payment_intent: err.payment_intent };
        throw err;
      });

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'POST',
        url: `/confirmPayments/id`,
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ paymentIntent: 'paymentId' }),
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(400);
      expect(Logger.log.warn).toHaveBeenCalled();

      const logged = JSON.stringify((Logger.log.warn as jest.Mock).mock.calls);
      expect(logged).not.toContain('DE89370400440532013000');
      expect(logged).not.toContain('BUKBGB22');
      expect(logged).not.toContain('payments.stripe.com/bank_transfer_instructions');
      expect(logged).not.toContain('pi_bt_11111_secret');
      expect(logged).not.toContain('req_leak_11111');

      // Diagnosis must survive: the paymentReference is what makes this traceable, and the
      // message was never actually logged before (non-enumerable on Error).
      expect(logged).toContain('PaymentIntent is not in a confirmable state');
      expect(logged).toContain('payment_intent_unexpected_state');
      expect(logged).toContain('StripeInvalidRequestError');
      expect(logged).toContain('paymentReference');
    });
  });

  describe('GET /express-payment-data', () => {
    test('should call getExpressPaymentData and return totalPrice, currencyCode and lineItems (Express / CT shape)', async () => {
      const mockExpressPaymentData = {
        totalPrice: { centAmount: 2500, currencyCode: 'EUR', fractionDigits: 2 },
        currencyCode: 'EUR',
        lineItems: [
          { name: 'Subtotal', amount: { centAmount: 2000, currencyCode: 'EUR', fractionDigits: 2 }, type: 'SUBTOTAL' },
          { name: 'Shipping', amount: { centAmount: 500, currencyCode: 'EUR', fractionDigits: 2 }, type: 'SHIPPING' },
        ],
      };
      jest.spyOn(spiedPaymentService, 'getExpressPaymentData').mockResolvedValue(mockExpressPaymentData);

      const response = await fastifyApp.inject({
        method: 'GET',
        url: '/express-payment-data',
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
      });

      expect(response.statusCode).toEqual(200);
      expect(response.json()).toEqual(mockExpressPaymentData);
      expect(spiedPaymentService.getExpressPaymentData).toHaveBeenCalled();
    });
  });

  describe('GET /config-element', () => {
    test('should call /config-element', async () => {
      //Given
      jest.spyOn(spiedPaymentService, 'initializeCartPayment').mockResolvedValue(mockRoute__get_config_element_succeed);

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'GET',
        url: `/config-element/payment`,
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(200);
      expect(responseGetConfig.json()).toEqual(mockRoute__get_config_element_succeed);
      expect(spiedPaymentService.initializeCartPayment).toHaveBeenCalled();
    });
  });

  describe('GET /applePayConfig', () => {
    test('should call /applePayConfig', async () => {
      //Given
      jest.spyOn(spiedPaymentService, 'applePayConfig').mockReturnValue(mockRoute__well_know__succeed);

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'GET',
        url: `/applePayConfig`,
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(200);
      expect(responseGetConfig.body).toEqual(mockRoute__well_know__succeed);
      expect(spiedPaymentService.applePayConfig).toHaveBeenCalled();
    });
  });

  describe('GET /customer/session', () => {
    test('should call /customer/session and return valid information', async () => {
      //Given
      jest.spyOn(spiedPaymentService, 'getCustomerSession').mockResolvedValue(mockRoute__customer_session_succeed);

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'GET',
        url: `/customer/session`,
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(200);
      expect(responseGetConfig.json()).toEqual(mockRoute__customer_session_succeed);
      expect(spiedPaymentService.getCustomerSession).toHaveBeenCalled();
    });

    test('should call /customer/session and return undefined', async () => {
      //Given
      jest.spyOn(spiedPaymentService, 'getCustomerSession').mockResolvedValue(undefined);

      //When
      const responseGetConfig = await fastifyApp.inject({
        method: 'GET',
        url: `/customer/session`,
        headers: {
          'x-session-id': sessionId,
          'content-type': 'application/json',
        },
      });

      //Then
      expect(responseGetConfig.statusCode).toEqual(204);
      expect(spiedPaymentService.getCustomerSession).toHaveBeenCalled();
    });
  });
});
