import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ConfigResponse, ModifyPayment, StatusResponse } from '../../src/services/types/operation.type';
import { paymentSDK } from '../../src/payment-sdk';
import { DefaultPaymentService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-payment.service';
import { DefaultCartService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-cart.service';
import {
  mockGetPaymentAmount,
  mockGetPaymentResult,
  mockStripeCancelPaymentResult,
  mockStripeCreatePaymentResult,
  mockStripeCreateRefundResult,
  mockStripePaymentMethodsList,
  mockStripeRetrievePaymentResult,
  mockStripeUpdatePaymentResult,
  mockUpdatePaymentResult,
  mockStripeCapturePaymentResult,
  mockStripeCapturePaymentErrorResult,
} from '../utils/mock-payment-results';
import { mockEvent__paymentIntent_succeeded_captureMethodManual } from '../utils/mock-routes-data';
import { mockCtCustomerId, mockGetCartResult, mockGetCartWithoutCustomerIdResult } from '../utils/mock-cart-data';
import * as Config from '../../src/config/config';
import { PaymentStatus, StripePaymentServiceOptions } from '../../src/services/types/stripe-payment.type';
import { AbstractPaymentService } from '../../src/services/abstract-payment.service';
import { StripePaymentService } from '../../src/services/stripe-payment.service';
import * as StatusHandler from '@commercetools/connect-payments-sdk/dist/api/handlers/status.handler';
import { HealthCheckResult } from '@commercetools/connect-payments-sdk';
import * as Logger from '../../src/libs/logger/index';

import Stripe from 'stripe';
import * as StripeClient from '../../src/clients/stripe.client';
import { SupportedPaymentComponentsSchemaDTO } from '../../src/dtos/operations/payment-componets.dto';
import { StripeEventConverter } from '../../src/services/converters/stripeEventConverter';
import { PaymentTransactions } from '../../src/dtos/operations/payment-intents.dto';
import { ClientResponse } from '@commercetools/platform-sdk/dist/declarations/src/generated/shared/utils/common-types';
import {
  mockCreateSessionResult,
  mockCtCustomerData,
  mockCtCustomerWithoutCustomFieldsData,
  mockCustomerData,
  mockEphemeralKeyResult,
  mockEphemeralKeySecret,
  mockSearchCustomerResponse,
  mockStripeCustomerId,
} from '../utils/mock-customer-data';
import { Customer } from '@commercetools/platform-sdk';

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    paymentIntents: {
      cancel: jest
        .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
        .mockResolvedValue(mockStripeCancelPaymentResult),
      retrieve: jest
        .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
        .mockResolvedValue(mockStripeRetrievePaymentResult),
      create: jest
        .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
        .mockResolvedValue(mockStripeCreatePaymentResult),
      update: jest
        .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
        .mockResolvedValue(mockStripeUpdatePaymentResult),
      capture: jest
        .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
        .mockResolvedValue(mockStripeCapturePaymentResult),
    },
    refunds: {
      create: jest.fn<() => Promise<Stripe.Response<Stripe.Refund>>>().mockResolvedValue(mockStripeCreateRefundResult),
    },
    paymentMethods: {
      list: jest
        .fn<() => Promise<Stripe.ApiList<Stripe.PaymentMethod>>>()
        .mockResolvedValue(mockStripePaymentMethodsList),
    },
  })),
}));
jest.mock('../../src/libs/logger');

interface FlexibleConfig {
  [key: string]: string; // Adjust the type according to your config values
}

function setupMockConfig(keysAndValues: Record<string, string>) {
  const mockConfig: FlexibleConfig = {};
  Object.keys(keysAndValues).forEach((key) => {
    mockConfig[key] = keysAndValues[key];
  });

  jest.spyOn(Config, 'getConfig').mockReturnValue(mockConfig as any);
}

describe('stripe-payment.service', () => {
  const opts: StripePaymentServiceOptions = {
    ctCartService: paymentSDK.ctCartService,
    ctPaymentService: paymentSDK.ctPaymentService,
    ctOrderService: paymentSDK.ctOrderService,
  };
  const paymentService: AbstractPaymentService = new StripePaymentService(opts);
  const stripePaymentService: StripePaymentService = new StripePaymentService(opts);

  beforeEach(() => {
    jest.setTimeout(10000);
    jest.resetAllMocks();
    Stripe.prototype.paymentIntents = {
      create: jest.fn(),
      update: jest.fn(),
      cancel: jest.fn(),
      capture: jest.fn(),
    } as unknown as Stripe.PaymentIntentsResource;
    Stripe.prototype.refunds = {
      create: jest.fn(),
    } as unknown as Stripe.RefundsResource;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('method getConfig', () => {
    test('should return the Stripe configuration successfully', async () => {
      // Setup mock config for a system using `clientKey`
      setupMockConfig({ stripePublishableKey: '', mockEnvironment: 'TEST' });

      const result: ConfigResponse = await paymentService.config();

      // Assertions can remain the same or be adapted based on the abstracted access
      expect(result?.publishableKey).toStrictEqual('');
      expect(result?.environment).toStrictEqual('TEST');
    });
  });

  describe('method getSupportedPaymentComponents', () => {
    test('should return supported payment components successfully', async () => {
      const result: SupportedPaymentComponentsSchemaDTO = await paymentService.getSupportedPaymentComponents();
      expect(result?.dropins).toHaveLength(1);
      expect(result?.dropins[0]?.type).toStrictEqual('embedded');
    });
  });

  describe('method status', () => {
    test('should return Stripe status successfully', async () => {
      const mockHealthCheckFunction: () => Promise<HealthCheckResult> = async () => {
        const result: HealthCheckResult = {
          name: 'CoCo Permissions',
          status: 'DOWN',
          message: 'CoCo Permissions are not available',
          details: {},
        };
        return result;
      };
      Stripe.prototype.paymentMethods = {
        list: jest
          .fn<() => Promise<Stripe.ApiList<Stripe.PaymentMethod>>>()
          .mockResolvedValue(mockStripePaymentMethodsList),
      } as unknown as Stripe.PaymentMethodsResource;

      jest.spyOn(StatusHandler, 'healthCheckCommercetoolsPermissions').mockReturnValue(mockHealthCheckFunction);
      const paymentService: AbstractPaymentService = new StripePaymentService(opts);
      const result: StatusResponse = await paymentService.status();

      expect(result?.status).toBeDefined();
      expect(result?.checks).toHaveLength(2);
      expect(result?.status).toStrictEqual('Partially Available');
      expect(result?.checks[0]?.name).toStrictEqual('CoCo Permissions');
      expect(result?.checks[0]?.status).toStrictEqual('DOWN');
      expect(result?.checks[0]?.details).toStrictEqual({});
      expect(result?.checks[0]?.message).toBeDefined();
      expect(result?.checks[1]?.name).toStrictEqual('Stripe Status check');
      expect(result?.checks[1]?.status).toStrictEqual('UP');
      expect(result?.checks[1]?.details).toBeDefined();
      expect(result?.checks[1]?.message).toBeDefined();
    });
  });

  describe('method modifyPayment', () => {
    test('should cancel a payment successfully', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'cancelPayment',
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockUpdatePaymentResult));
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.paymentIntents, 'cancel')
        .mockReturnValue(Promise.resolve(mockStripeCancelPaymentResult));

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('approved');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should cancel a payment rejected', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'cancelPayment',
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockUpdatePaymentResult));
      const stripeApiMock = jest.spyOn(Stripe.prototype.paymentIntents, 'cancel').mockImplementation(() => {
        throw new Error('Unexpected error calling Stripe API');
      });

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('rejected');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should capture a payment successfully', async () => {
      //Given
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'capturePayment',
              amount: {
                centAmount: 150000,
                currencyCode: 'USD',
              },
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.paymentIntents, 'capture')
        .mockReturnValue(Promise.resolve(mockStripeCapturePaymentResult));

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('approved');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should capture a payment with log erro', async () => {
      //Given
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'capturePayment',
              amount: {
                centAmount: 150000,
                currencyCode: 'USD',
              },
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.paymentIntents, 'capture')
        .mockReturnValue(Promise.resolve(mockStripeCapturePaymentErrorResult));

      const result = await paymentService.modifyPayment(modifyPaymentOpts);

      expect(Logger.log.warn).toBeCalled();
      expect(result?.outcome).toStrictEqual('rejected');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should capture a payment rejected', async () => {
      //Given
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'capturePayment',
              amount: {
                centAmount: 150000,
                currencyCode: 'USD',
              },
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const stripeApiMock = jest.spyOn(Stripe.prototype.paymentIntents, 'capture').mockImplementation(() => {
        throw new Error('Unexpected error calling Stripe API');
      });

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('rejected');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should refund a payment successfully', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'refundPayment',
              amount: {
                centAmount: 150000,
                currencyCode: 'USD',
              },
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockUpdatePaymentResult));
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.refunds, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreateRefundResult));

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('received');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should refund a payment rejected', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'refundPayment',
              amount: {
                centAmount: 150000,
                currencyCode: 'USD',
              },
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockUpdatePaymentResult));
      const stripeApiMock = jest.spyOn(Stripe.prototype.refunds, 'create').mockImplementation(() => {
        throw new Error('Unexpected error calling Stripe API');
      });

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('rejected');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
      expect(stripeApiMock).toHaveBeenCalled();
    });
  });

  describe('method updatePaymentIntentStripeSuccessful', () => {
    test('should update the commercetools payment "Authorization" from "Initial" to "Success"', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference');

      expect(getCartMock).toHaveBeenCalled();
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalled();
    });
  });

  describe('method createPaymentIntentStripe', () => {
    test('should createPaymentIntent successful', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getPaymentAmountMock = jest
        .spyOn(DefaultCartService.prototype, 'getPaymentAmount')
        .mockResolvedValue(mockGetPaymentAmount);
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.paymentIntents, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreatePaymentResult));
      const createPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'createPayment')
        .mockResolvedValue(mockGetPaymentResult);
      const addPaymentMock = jest
        .spyOn(DefaultCartService.prototype, 'addPayment')
        .mockResolvedValue(mockGetCartResult());
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'getStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);

      const result = await stripePaymentService.createPaymentIntentStripe();

      expect(result.sClientSecret).toStrictEqual(mockStripeCreatePaymentResult.client_secret);
      expect(result).toBeDefined();

      // Or check that the relevant mocks have been called
      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(getPaymentAmountMock).toHaveBeenCalled();
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
      expect(createPaymentMock).toHaveBeenCalled();
      expect(addPaymentMock).toHaveBeenCalled();
    });

    test('should fail to create the payment intent', async () => {
      const error = new Error('Unexpected error calling Stripe API');
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getPaymentAmountMock = jest
        .spyOn(DefaultCartService.prototype, 'getPaymentAmount')
        .mockResolvedValue(mockGetPaymentAmount);
      const stripeApiMock = jest.spyOn(Stripe.prototype.paymentIntents, 'create').mockImplementation(() => {
        throw error;
      });
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const wrapStripeError = jest.spyOn(StripeClient, 'wrapStripeError').mockReturnValue(error);
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'getStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);
      try {
        await stripePaymentService.createPaymentIntentStripe();
      } catch (e) {
        expect(wrapStripeError).toHaveBeenCalledWith(e);
      }

      // Or check that the relevant mocks have been called
      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(0);
      expect(getPaymentAmountMock).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(0);
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
    });
  });

  describe('method initializeCartPayment', () => {
    test('should return the configuration element and create in the cart a payment "Authorization" as "Initial"', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getPaymentAmountMock = jest
        .spyOn(DefaultCartService.prototype, 'getPaymentAmount')
        .mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(result.cartInfo.currency).toStrictEqual(mockGetPaymentAmount.currencyCode);
      expect(result.cartInfo.amount).toStrictEqual(mockGetPaymentAmount.centAmount);
      expect(result).toBeDefined();

      // Or check that the relevant mocks have been called
      expect(getCartMock).toHaveBeenCalled();
      expect(getPaymentAmountMock).toHaveBeenCalled();
      expect(Logger.log.info).toBeCalled();
    });
  });

  describe('method processStripeEvent', () => {
    test('should call updatePayment for a payment_intent succeeded manual event', async () => {
      const mockEvent: Stripe.Event = mockEvent__paymentIntent_succeeded_captureMethodManual;

      const test = {
        id: 'paymentId',
        pspReference: 'paymentIntentId',
        paymentMethod: 'payment',
        transactions: [
          {
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.FAILURE,
            amount: {
              centAmount: 1232,
              currencyCode: 'USD',
            },
          },
        ],
      };
      const mockStripeEventConverter = jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(test);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent);

      expect(mockStripeEventConverter).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(1);
    });

    test('should NOT call updatePayment for a payment_intent succeeded manual event', async () => {
      const mockEvent: Stripe.Event = mockEvent__paymentIntent_succeeded_captureMethodManual;

      const test = {
        id: 'paymentId',
        pspReference: 'paymentIntentId',
        paymentMethod: 'payment',
        transactions: [],
      };
      const mockStripeEventConverter = jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(test);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent);

      expect(mockStripeEventConverter).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(0);
    });
  });

  describe('method getCustomerSession', () => {
    test('should return the customer session', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getIsStripeCustomerIdFieldPresent = jest
        .spyOn(StripePaymentService.prototype, 'isStripeCustomerIdFieldPresent')
        .mockResolvedValue(true);
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'getStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);
      const saveCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'saveStripeCustomerId')
        .mockResolvedValue(true);
      const createEphemeralKeyMock = jest
        .spyOn(StripePaymentService.prototype, 'createEphemeralKey')
        .mockResolvedValue(mockEphemeralKeySecret);
      const createSessionMock = jest
        .spyOn(StripePaymentService.prototype, 'createSession')
        .mockResolvedValue(mockCreateSessionResult);

      const result = await stripePaymentService.getCustomerSession();

      expect(result).toStrictEqual({
        stripeCustomerId: mockStripeCustomerId,
        ephemeralKey: mockEphemeralKeySecret,
        sessionId: mockCreateSessionResult.client_secret,
      });
      expect(result).toBeDefined();

      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(getIsStripeCustomerIdFieldPresent).toHaveBeenCalled();
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
      expect(saveCustomerMock).toHaveBeenCalled();
      expect(createEphemeralKeyMock).toHaveBeenCalled();
      expect(createSessionMock).toHaveBeenCalled();
    });

    test('should return undefined to get found customer id on cart', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithoutCustomerIdResult()));

      await stripePaymentService.getCustomerSession();

      expect(Logger.log.warn).toBeCalled();
      expect(getCartMock).toHaveBeenCalled();
    });

    test('should return undefined to get stripeCustomerId from customer custom field', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerWithoutCustomFieldsData);
      const getIsStripeCustomerIdFieldPresent = jest
        .spyOn(StripePaymentService.prototype, 'isStripeCustomerIdFieldPresent')
        .mockResolvedValue(false);

      const response = await stripePaymentService.getCustomerSession();

      expect(response).toBeUndefined();
      expect(Logger.log.warn).toBeCalled();
      expect(getCartMock).toHaveBeenCalled();
      expect(getIsStripeCustomerIdFieldPresent).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
    });

    test('should fail to get stripe customer id', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getIsStripeCustomerIdFieldPresent = jest
        .spyOn(StripePaymentService.prototype, 'isStripeCustomerIdFieldPresent')
        .mockResolvedValue(true);
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'getStripeCustomerId')
        .mockResolvedValue(undefined);

      try {
        await stripePaymentService.getCustomerSession();
      } catch (e) {
        expect(e).toStrictEqual('Failed to get stripe customer id.');
      }

      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(getIsStripeCustomerIdFieldPresent).toHaveBeenCalled();
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
    });

    test('should fail to save stripe customer id', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getIsStripeCustomerIdFieldPresent = jest
        .spyOn(StripePaymentService.prototype, 'isStripeCustomerIdFieldPresent')
        .mockResolvedValue(true);
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'getStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);
      const saveCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'saveStripeCustomerId')
        .mockResolvedValue(false);

      try {
        await stripePaymentService.getCustomerSession();
      } catch (e) {
        expect(e).toStrictEqual('Failed to save stripe customer id.');
      }

      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(getIsStripeCustomerIdFieldPresent).toHaveBeenCalled();
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
      expect(saveCustomerMock).toHaveBeenCalled();
    });

    test('should fail to create ephemeral key', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getIsStripeCustomerIdFieldPresent = jest
        .spyOn(StripePaymentService.prototype, 'isStripeCustomerIdFieldPresent')
        .mockResolvedValue(true);
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'getStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);
      const saveCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'saveStripeCustomerId')
        .mockResolvedValue(true);
      const createEphemeralKeyMock = jest
        .spyOn(StripePaymentService.prototype, 'createEphemeralKey')
        .mockResolvedValue(undefined);

      try {
        await stripePaymentService.getCustomerSession();
      } catch (e) {
        expect(e).toStrictEqual('Failed to create ephemeral key.');
      }

      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(getIsStripeCustomerIdFieldPresent).toHaveBeenCalled();
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
      expect(saveCustomerMock).toHaveBeenCalled();
      expect(createEphemeralKeyMock).toHaveBeenCalled();
    });

    test('should fail to create session', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getIsStripeCustomerIdFieldPresent = jest
        .spyOn(StripePaymentService.prototype, 'isStripeCustomerIdFieldPresent')
        .mockResolvedValue(true);
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'getStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);
      const saveCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'saveStripeCustomerId')
        .mockResolvedValue(true);
      const createEphemeralKeyMock = jest
        .spyOn(StripePaymentService.prototype, 'createEphemeralKey')
        .mockResolvedValue(mockEphemeralKeySecret);
      const createSessionMock = jest
        .spyOn(StripePaymentService.prototype, 'createSession')
        .mockResolvedValue(undefined);

      try {
        await stripePaymentService.getCustomerSession();
      } catch (e) {
        expect(e).toStrictEqual('Failed to create session.');
      }

      expect(getCartMock).toHaveBeenCalled();
      expect(getCustomerMock).toHaveBeenCalled();
      expect(getIsStripeCustomerIdFieldPresent).toHaveBeenCalled();
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
      expect(saveCustomerMock).toHaveBeenCalled();
      expect(createEphemeralKeyMock).toHaveBeenCalled();
      expect(createSessionMock).toHaveBeenCalled();
    });
  });

  describe('method getStripeCustomerId', () => {
    test('should have a valid stripe customer id', async () => {
      const cart = mockGetCartResult();

      const validateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'validateStripeCustomerId')
        .mockResolvedValue(true);

      const result = await stripePaymentService.getStripeCustomerId(cart, mockCtCustomerData);

      expect(result).toStrictEqual(mockStripeCustomerId);
      expect(result).toBeDefined();
      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
    });

    test('should save stripe customer id successfully', async () => {
      const cart = mockGetCartResult();

      const validateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'validateStripeCustomerId')
        .mockResolvedValue(true);

      const result = await stripePaymentService.getStripeCustomerId(cart, mockCtCustomerData);

      expect(result).toStrictEqual(mockStripeCustomerId);
      expect(result).toBeDefined();
      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
    });

    test('should fail because customer is already created', async () => {
      const cart = mockGetCartResult();

      const validateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'validateStripeCustomerId')
        .mockResolvedValue(false);

      const findCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'findStripeCustomer')
        .mockResolvedValue(mockCustomerData);

      const result = await stripePaymentService.getStripeCustomerId(cart, mockCtCustomerData);

      expect(result).toStrictEqual(mockStripeCustomerId);
      expect(result).toBeDefined();
      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
      expect(findCustomerMock).toHaveBeenCalled();
    });

    test('should create customer successfully', async () => {
      const cart = mockGetCartResult();

      const validateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'validateStripeCustomerId')
        .mockResolvedValue(false);

      const findCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'findStripeCustomer')
        .mockResolvedValue(undefined);

      const createStripeCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'createStripeCustomer')
        .mockResolvedValue(mockCustomerData);

      const result = await stripePaymentService.getStripeCustomerId(cart, mockCtCustomerData);

      expect(result).toStrictEqual(mockStripeCustomerId);
      expect(result).toBeDefined();
      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
      expect(findCustomerMock).toHaveBeenCalled();
      expect(createStripeCustomerMock).toHaveBeenCalled();
    });

    test('should fail when creating customer', async () => {
      const cart = mockGetCartResult();

      const validateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'validateStripeCustomerId')
        .mockResolvedValue(false);

      const findCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'findStripeCustomer')
        .mockResolvedValue(undefined);

      const createStripeCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'createStripeCustomer')
        .mockResolvedValue(undefined);

      try {
        await stripePaymentService.getStripeCustomerId(cart, mockCtCustomerData);
      } catch (e) {
        expect(e).toStrictEqual('Failed to create stripe customer.');
      }

      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
      expect(findCustomerMock).toHaveBeenCalled();
      expect(createStripeCustomerMock).toHaveBeenCalled();
    });
  });

  describe('method validateStripeCustomerId', () => {
    test('should validate stripe customer successfully', async () => {
      Stripe.prototype.customers = {
        retrieve: jest.fn(),
      } as unknown as Stripe.CustomersResource;
      const mockRetrieveCustomer = jest
        .spyOn(Stripe.prototype.customers, 'retrieve')
        .mockReturnValue(Promise.resolve(mockCustomerData));

      const result = await stripePaymentService.validateStripeCustomerId(mockStripeCustomerId, mockCtCustomerId);

      expect(result).toStrictEqual(true);
      expect(result).toBeDefined();
      expect(mockRetrieveCustomer).toHaveBeenCalled();
    });

    test('should not find stripe customer, it does not exists', async () => {
      Stripe.prototype.customers = {
        retrieve: jest.fn(),
      } as unknown as Stripe.CustomersResource;
      const mockRetrieveCustomer = jest
        .spyOn(Stripe.prototype.customers, 'retrieve')
        .mockReturnValue(Promise.reject(new Error('No such customer')));

      try {
        await stripePaymentService.validateStripeCustomerId(mockStripeCustomerId, 'failedCustomerId');
      } catch (e) {
        expect(e).toStrictEqual(false);
      }
      expect(mockRetrieveCustomer).toHaveBeenCalled();
    });

    test('should fail when retrieving customer', async () => {
      Stripe.prototype.customers = {
        retrieve: jest.fn(),
      } as unknown as Stripe.CustomersResource;
      const mockRetrieveCustomer = jest
        .spyOn(Stripe.prototype.customers, 'retrieve')
        .mockReturnValue(Promise.reject(new Error('Something failed')));

      try {
        await stripePaymentService.validateStripeCustomerId(mockStripeCustomerId, 'failedCustomerId');
      } catch (e) {
        expect(e).toBeDefined();
      }
      expect(mockRetrieveCustomer).toHaveBeenCalled();
    });
  });

  describe('method findStripeCustomer', () => {
    test('should find stripe customer', async () => {
      Stripe.prototype.customers = {
        search: jest.fn(),
      } as unknown as Stripe.CustomersResource;
      const mockRetrieveCustomer = jest
        .spyOn(Stripe.prototype.customers, 'search')
        .mockReturnValue(Promise.resolve(mockSearchCustomerResponse) as Stripe.ApiSearchResultPromise<Stripe.Customer>);

      const result = await stripePaymentService.findStripeCustomer('test@example.com', mockCtCustomerId);

      expect(result).toStrictEqual(mockCustomerData);
      expect(result).toBeDefined();
      expect(mockRetrieveCustomer).toHaveBeenCalled();
    });
  });

  describe('method createStripeCustomer', () => {
    test('should create stripe customer', async () => {
      Stripe.prototype.customers = {
        create: jest.fn(),
      } as unknown as Stripe.CustomersResource;
      const mockCreateCustomer = jest
        .spyOn(Stripe.prototype.customers, 'create')
        .mockReturnValue(Promise.resolve(mockCustomerData));

      const result = await stripePaymentService.createStripeCustomer(
        mockGetCartResult(),
        'test@example.com',
        mockCtCustomerData,
      );

      expect(result).toStrictEqual(mockCustomerData);
      expect(result).toBeDefined();
      expect(mockCreateCustomer).toHaveBeenCalled();
    });
  });

  // describe('method saveStripeCustomerId', () => {
  //   test('should not save stripe customer', async () => {
  //     const result = await stripePaymentService.saveStripeCustomerId(mockStripeCustomerId, mockGetCartResult());

  //     expect(result).toStrictEqual(true);
  //     expect(result).toBeDefined();
  //   });

  //   test('should save stripe customer id successfully', async () => {
  //     const mockCart = mockGetCartResult();
  //     const mockUpdatedCartResponse: ClientResponse<Cart> = {
  //       body: mockCart,
  //       statusCode: 200,
  //       headers: {},
  //     };
  //     const executeMock = jest.fn().mockReturnValue(mockUpdatedCartResponse);
  //     const client = paymentSDK.ctAPI.client;
  //     client.carts = jest.fn(() => ({
  //       withId: jest.fn(() => ({
  //         post: jest.fn(() => ({
  //           execute: executeMock,
  //         })),
  //       })),
  //     })) as never;

  //     const result = await stripePaymentService.saveStripeCustomerId('mockStripeCustomerId', mockCart);

  //     expect(executeMock).toHaveBeenCalled();
  //     expect(result).toEqual(true);
  //   });
  // });

  describe('method createSession', () => {
    test('should create stripe customer', async () => {
      Stripe.prototype.customerSessions = {
        create: jest.fn(),
      } as unknown as Stripe.CustomerSessionsResource;
      const mockCreateCustomer = jest
        .spyOn(Stripe.prototype.customerSessions, 'create')
        .mockReturnValue(Promise.resolve(mockCreateSessionResult));

      const result = await stripePaymentService.createSession(mockStripeCustomerId);

      expect(result).toStrictEqual(mockCreateSessionResult);
      expect(result).toBeDefined();
      expect(mockCreateCustomer).toHaveBeenCalled();
    });
  });

  describe('method createEphemeralKey', () => {
    test('should create ehpemeral key', async () => {
      Stripe.prototype.ephemeralKeys = {
        create: jest.fn(),
      } as unknown as Stripe.EphemeralKeysResource;
      const mockCreateEphemeralKey = jest
        .spyOn(Stripe.prototype.ephemeralKeys, 'create')
        .mockReturnValue(Promise.resolve(mockEphemeralKeyResult));

      const result = await stripePaymentService.createEphemeralKey(mockStripeCustomerId);

      expect(result).toStrictEqual(mockEphemeralKeySecret);
      expect(result).toBeDefined();
      expect(mockCreateEphemeralKey).toHaveBeenCalled();
    });
  });

  describe('method getCtCustomer', () => {
    test('should return ct customer successfully', async () => {
      const mockCtCustomerResponse: ClientResponse<Customer> = {
        body: mockCtCustomerData,
        statusCode: 200,
        headers: {},
      };
      const executeMock = jest.fn().mockReturnValue(mockCtCustomerResponse);
      const client = paymentSDK.ctAPI.client;
      client.customers = jest.fn(() => ({
        withId: jest.fn(() => ({
          get: jest.fn(() => ({
            execute: executeMock,
          })),
        })),
      })) as never;

      const result = await stripePaymentService.getCtCustomer(mockCtCustomerId);

      expect(executeMock).toHaveBeenCalled();
      expect(result).toEqual(mockCtCustomerData);
    });
  });
});
