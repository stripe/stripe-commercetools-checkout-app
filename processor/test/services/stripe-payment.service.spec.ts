import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ConfigResponse, ModifyPayment, StatusResponse } from '../../src/services/types/operation.type';
import { paymentSDK } from '../../src/payment-sdk';
import { DefaultPaymentService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-payment.service';
import { DefaultCartService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-cart.service';
import {
  mockGetPaymentAmount,
  mockGetPaymentResult,
  mockStripeCancelPaymentResult,
  mockStripeCapturePaymentErrorResult,
  mockStripeCapturePaymentResult,
  mockStripeCreatePaymentResult,
  mockStripeCreateRefundResult,
  mockStripePaymentMethodsList,
  mockStripeRetrievePaymentResult,
  mockStripeUpdatePaymentResult,
  mockUpdatePaymentResult,
} from '../utils/mock-payment-results';
import {
  mockEvent__paymentIntent_succeeded_captureMethodManual,
  mockEvent__charge_refund_captured,
  mockEvent__paymentIntent_succeeded_multicapture,
  mockEvent__charge_updated_multicapture,
  mockEvent__charge_updated_already_captured,
  mockEvent__charge_updated_no_amount_change,
} from '../utils/mock-routes-data';
import { mockGetCartResult, mockGetCartWithoutCustomerIdResult } from '../utils/mock-cart-data';
import * as Config from '../../src/config/config';
import * as ConfigModule from '../../src/config/config';
import { PaymentStatus, StripePaymentServiceOptions } from '../../src/services/types/stripe-payment.type';
import { AbstractPaymentService } from '../../src/services/abstract-payment.service';
import { StripePaymentService } from '../../src/services/stripe-payment.service';
import * as StatusHandler from '@commercetools/connect-payments-sdk/dist/api/handlers/status.handler';
import { HealthCheckResult } from '@commercetools/connect-payments-sdk';
import * as Logger from '../../src/libs/logger/index';
import * as CustomerClient from '../../src/services/commerce-tools/customerClient';
import * as CustomTypeHelper from '../../src/services/commerce-tools/customTypeHelper';
import Stripe from 'stripe';
import * as StripeClient from '../../src/clients/stripe.client';
import { SupportedPaymentComponentsSchemaDTO } from '../../src/dtos/operations/payment-componets.dto';
import { StripeEventConverter } from '../../src/services/converters/stripeEventConverter';
import { PaymentTransactions } from '../../src/dtos/operations/payment-intents.dto';
import { ClientResponse } from '@commercetools/platform-sdk/dist/declarations/src/generated/shared/utils/common-types';
import {
  mockCreateSessionResult,
  mockCtCustomerData,
  mockCtCustomerId,
  mockCustomerData,
  mockEphemeralKeyResult,
  mockEphemeralKeySecret,
  mockSearchCustomerResponse,
  mockStripeCustomerId,
} from '../utils/mock-customer-data';
import { Customer } from '@commercetools/platform-sdk';
import { mock_SetCustomTypeActions } from '../utils/mock-actions-data';

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
      list: jest.fn<() => Promise<Stripe.ApiList<Stripe.Refund>>>(),
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

  jest.spyOn(Config, 'getConfig').mockReturnValue(mockConfig as never);
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
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.paymentIntents, 'cancel')
        .mockReturnValue(Promise.resolve(mockStripeCancelPaymentResult));

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('approved');
      expect(getPaymentMock).toHaveBeenCalled();
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
      expect(updatePaymentMock).toHaveBeenCalledTimes(0);
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should cancel a payment successfully', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'reversePayment',
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.paymentIntents, 'cancel')
        .mockReturnValue(Promise.resolve(mockStripeCancelPaymentResult));
      const mockHasTransactionInState = jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockImplementation(({ payment, transactionType, states }) => {
          if (transactionType === PaymentTransactions.CHARGE) {
            return false;
          } else if (transactionType === PaymentTransactions.REFUND) {
            return false;
          } else if (transactionType === PaymentTransactions.CANCEL_AUTHORIZATION) {
            return false;
          } else if (transactionType === PaymentTransactions.AUTHORIZATION) {
            return true;
          }
          console.log(`${payment} ${transactionType} ${states}`);
          return false;
        });

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('approved');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
      expect(mockHasTransactionInState).toHaveBeenCalledTimes(4);
    });

    test('should cancel a payment rejected', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'reversePayment',
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const stripeApiMock = jest.spyOn(Stripe.prototype.paymentIntents, 'cancel').mockImplementation(() => {
        throw new Error('Unexpected error calling Stripe API');
      });
      const mockHasTransactionInState = jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockImplementation(({ payment, transactionType, states }) => {
          if (transactionType === PaymentTransactions.CHARGE) {
            return false;
          } else if (transactionType === PaymentTransactions.REFUND) {
            return false;
          } else if (transactionType === PaymentTransactions.CANCEL_AUTHORIZATION) {
            return false;
          } else if (transactionType === PaymentTransactions.AUTHORIZATION) {
            return true;
          }
          console.log(`${payment} ${transactionType} ${states}`);
          return false;
        });

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('rejected');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
      expect(mockHasTransactionInState).toHaveBeenCalledTimes(4);
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
      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: {
          retrieve: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockStripeRetrievePaymentResult),
          capture: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockStripeCapturePaymentResult),
        },
      } as unknown as Stripe);

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('approved');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should capture a payment requires_action', async () => {
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
      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: {
          retrieve: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockStripeRetrievePaymentResult),
          capture: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockStripeCapturePaymentErrorResult),
        },
      } as unknown as Stripe);

      const result = await paymentService.modifyPayment(modifyPaymentOpts);

      expect(result?.outcome).toStrictEqual('approved');
      expect(getPaymentMock).toHaveBeenCalled();
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
      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: {
          retrieve: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockStripeRetrievePaymentResult),
          capture: jest.fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>().mockImplementation(() => {
            throw new Error('Unexpected error calling Stripe API');
          }),
        },
      } as unknown as Stripe);

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('rejected');
      expect(getPaymentMock).toHaveBeenCalled();
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
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.refunds, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreateRefundResult));

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('received');
      expect(getPaymentMock).toHaveBeenCalled();
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
      expect(updatePaymentMock).toHaveBeenCalledTimes(0);
      expect(stripeApiMock).toHaveBeenCalled();
    });

    test('should reverse refund a payment successfully', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'reversePayment',
            },
          ],
        },
      };

      const getPaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'getPayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));
      const stripeApiMock = jest
        .spyOn(Stripe.prototype.refunds, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreateRefundResult));
      const mockHasTransactionInState = jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockImplementation(({ payment, transactionType, states }) => {
          if (transactionType === PaymentTransactions.CHARGE) {
            return true;
          } else if (transactionType === PaymentTransactions.REFUND) {
            return false;
          } else if (transactionType === PaymentTransactions.CANCEL_AUTHORIZATION) {
            return false;
          }
          console.log(`${payment} ${transactionType} ${states}`);
          return false;
        });

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('received');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
      expect(mockHasTransactionInState).toHaveBeenCalledTimes(4);
    });

    test('should reverse refund a payment rejected', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'reversePayment',
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
      const mockHasTransactionInState = jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockImplementation(({ payment, transactionType, states }) => {
          if (transactionType === PaymentTransactions.CHARGE) {
            return true;
          } else if (transactionType === PaymentTransactions.REFUND) {
            return false;
          } else if (transactionType === PaymentTransactions.CANCEL_AUTHORIZATION) {
            return false;
          }
          console.log(`${payment} ${transactionType} ${states}`);
          return false;
        });

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('rejected');
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(0);
      expect(stripeApiMock).toHaveBeenCalled();
      expect(mockHasTransactionInState).toHaveBeenCalledTimes(4);
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

      const result = await stripePaymentService.createPaymentIntentStripe();

      expect(result.sClientSecret).toStrictEqual(mockStripeCreatePaymentResult.client_secret);
      expect(result).toBeDefined();

      // Or check that the relevant mocks have been called
      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(getPaymentAmountMock).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
      expect(createPaymentMock).toHaveBeenCalled();
      expect(addPaymentMock).toHaveBeenCalled();
    });

    test('should createPaymentIntent with billing information successful', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled' } as PaymentFeatures,
        stripeCollectBillingAddress: 'never',
        stripeEnableMultiOperations: false,
        stripePaymentIntentSetupFutureUsage: undefined,
      });

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

      const result = await stripePaymentService.createPaymentIntentStripe();

      expect(result.sClientSecret).toStrictEqual(mockStripeCreatePaymentResult.client_secret);
      expect(result).toBeDefined();

      // Or check that the relevant mocks have been called
      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(getPaymentAmountMock).toHaveBeenCalled();
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
      expect(Logger.log.info).toHaveBeenCalled();
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

  describe('method processStripeEventRefunded', () => {
    test('should call updatePayment for a charge.refunded event', async () => {
      const mockEvent: Stripe.Event = mockEvent__charge_refund_captured;

      const test = {
        id: 'paymentId',
        pspReference: 'refundId',
        paymentMethod: 'payment',
        transactions: [
          {
            type: PaymentTransactions.REFUND,
            state: PaymentStatus.SUCCESS,
            amount: {
              centAmount: 34500,
              currencyCode: 'MXN',
            },
            interactionId: 'refundId',
          },
        ],
      };

      const mockRefund = {
        id: 'refundId',
        amount: 34500,
        currency: 'mxn',
        charge: 'ch_11111',
        created: 1717531265,
        status: 'succeeded',
      };

      const mockStripeEventConverter = jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(test);
      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        refunds: {
          list: jest.fn().mockReturnValue(
            Promise.resolve({
              data: [mockRefund],
              has_more: false,
              object: 'list',
              url: '/v1/refunds',
            }),
          ),
        },
      } as unknown as Stripe);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEventRefunded(mockEvent);

      expect(mockStripeEventConverter).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledTimes(1);
    });

    test('should NOT call updatePayment when no refund is found', async () => {
      const mockEvent: Stripe.Event = mockEvent__charge_refund_captured;

      const test = {
        id: 'paymentId',
        pspReference: 'refundId',
        paymentMethod: 'payment',
        transactions: [
          {
            type: PaymentTransactions.REFUND,
            state: PaymentStatus.SUCCESS,
            amount: {
              centAmount: 34500,
              currencyCode: 'MXN',
            },
            interactionId: 'refundId',
          },
        ],
      };

      const mockStripeEventConverter = jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(test);
      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        refunds: {
          list: jest.fn().mockReturnValue(
            Promise.resolve({
              data: [],
              has_more: false,
              object: 'list',
              url: '/v1/refunds',
            }),
          ),
        },
      } as unknown as Stripe);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEventRefunded(mockEvent);

      expect(mockStripeEventConverter).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
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
      const retrieveOrCreateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'retrieveOrCreateStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);
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
      expect(retrieveOrCreateStripeCustomerIdMock).toHaveBeenCalled();
      expect(createEphemeralKeyMock).toHaveBeenCalled();
      expect(createSessionMock).toHaveBeenCalled();
    });

    test('should return undefined to get found customer id on cart', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithoutCustomerIdResult()));

      await stripePaymentService.getCustomerSession();

      expect(Logger.log.warn).toHaveBeenCalled();
      expect(getCartMock).toHaveBeenCalled();
    });

    test('should fail to get stripe customer id', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const retrieveOrCreateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'retrieveOrCreateStripeCustomerId')
        .mockResolvedValue(undefined);

      try {
        await stripePaymentService.getCustomerSession();
      } catch (e) {
        expect(e).toStrictEqual('Failed to get stripe customer id.');
      }

      expect(getCartMock).toHaveBeenCalled();
      expect(getCtCustomerMock).toHaveBeenCalled();
      expect(retrieveOrCreateStripeCustomerIdMock).toHaveBeenCalled();
    });

    test('should fail to create ephemeral key', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCtCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'retrieveOrCreateStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);
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
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
      expect(createEphemeralKeyMock).toHaveBeenCalled();
    });

    test('should fail to create session', async () => {
      const getCartMock = jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartResult()));
      const getCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerData);
      const getStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'retrieveOrCreateStripeCustomerId')
        .mockResolvedValue(mockStripeCustomerId);
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
      expect(getStripeCustomerIdMock).toHaveBeenCalled();
      expect(createEphemeralKeyMock).toHaveBeenCalled();
      expect(createSessionMock).toHaveBeenCalled();
    });
  });

  describe('method retrieveOrCreateStripeCustomerId', () => {
    test('should have a valid stripe customer id', async () => {
      const cart = mockGetCartResult();

      const validateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'validateStripeCustomerId')
        .mockResolvedValue(true);

      const result = await stripePaymentService.retrieveOrCreateStripeCustomerId(cart, mockCtCustomerData);

      expect(result).toStrictEqual(mockStripeCustomerId);
      expect(result).toBeDefined();
      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
    });

    test('should save stripe customer id successfully', async () => {
      const cart = mockGetCartResult();

      const validateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'validateStripeCustomerId')
        .mockResolvedValue(true);

      const result = await stripePaymentService.retrieveOrCreateStripeCustomerId(cart, mockCtCustomerData);

      expect(result).toStrictEqual(mockStripeCustomerId);
      expect(result).toBeDefined();
      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
    });

    test('should find the Stripe customer and update the ctCustomer', async () => {
      const cart = mockGetCartResult();

      const validateStripeCustomerIdMock = jest
        .spyOn(StripePaymentService.prototype, 'validateStripeCustomerId')
        .mockResolvedValue(false);
      const findCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'findStripeCustomer')
        .mockResolvedValue(mockCustomerData);
      const saveCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'saveStripeCustomerId')
        .mockReturnValue(Promise.resolve());

      const result = await stripePaymentService.retrieveOrCreateStripeCustomerId(cart, mockCtCustomerData);

      expect(result).toStrictEqual(mockStripeCustomerId);
      expect(result).toBeDefined();
      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
      expect(findCustomerMock).toHaveBeenCalled();
      expect(saveCustomerMock).toHaveBeenCalled();
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
      const saveCustomerMock = jest
        .spyOn(StripePaymentService.prototype, 'saveStripeCustomerId')
        .mockReturnValue(Promise.resolve());

      const result = await stripePaymentService.retrieveOrCreateStripeCustomerId(cart, mockCtCustomerData);

      expect(result).toStrictEqual(mockStripeCustomerId);
      expect(result).toBeDefined();
      expect(validateStripeCustomerIdMock).toHaveBeenCalled();
      expect(findCustomerMock).toHaveBeenCalled();
      expect(createStripeCustomerMock).toHaveBeenCalled();
      expect(saveCustomerMock).toHaveBeenCalled();
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
        await stripePaymentService.retrieveOrCreateStripeCustomerId(cart, mockCtCustomerData);
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

      const result = await stripePaymentService.findStripeCustomer(mockCtCustomerId);

      expect(result).toStrictEqual(mockCustomerData);
      expect(result).toBeDefined();
      expect(mockRetrieveCustomer).toHaveBeenCalled();
    });

    test('should return undefined due to incorrect ctCustomerId', async () => {
      const result = await stripePaymentService.findStripeCustomer('wrongId');
      expect(Logger.log.warn).toHaveBeenCalled();
      expect(result).toBeUndefined();
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

      const result = await stripePaymentService.createStripeCustomer(mockGetCartResult(), mockCtCustomerData);

      expect(result).toStrictEqual(mockCustomerData);
      expect(result).toBeDefined();
      expect(mockCreateCustomer).toHaveBeenCalled();
    });
  });

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
      //const executeMock = jest.fn().mockResolvedValue(mockCtCustomerResponse);
      const executeMock = jest.fn<() => Promise<ClientResponse<Customer>>>().mockResolvedValue(mockCtCustomerResponse);

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

    test('should fail to retrieve customer', async () => {
      const mockCtCustomerResponse = {
        body: null,
        statusCode: 404,
        headers: {},
      };
      const executeMock = jest.fn<() => Promise<ClientResponse<Customer>>>().mockRejectedValue(mockCtCustomerResponse);
      const client = paymentSDK.ctAPI.client;
      client.customers = jest.fn(() => ({
        withId: jest.fn(() => ({
          get: jest.fn(() => ({
            execute: executeMock,
          })),
        })),
      })) as never;

      try {
        await stripePaymentService.getCtCustomer(mockCtCustomerId);
      } catch (e) {
        expect(e).toEqual(`Customer with ID ${mockCtCustomerId} not found`);
      }
      expect(Logger.log.warn).toHaveBeenCalled();
      expect(executeMock).toHaveBeenCalled();
    });
  });

  describe('method saveStripeCustomerId', () => {
    test('should save stripe customer id successfully', async () => {
      // const mockUpdatedCustomerResponse: ClientResponse<Customer> = {
      //   body: mockCtCustomerData,
      //   statusCode: 200,
      //   headers: {},
      // };

      // const getCtCustomerMock = jest
      //   .spyOn(StripePaymentService.prototype, 'getCtCustomer')
      //   .mockResolvedValue(mockCtCustomerData);

      // const executeMock = jest.fn().mockReturnValue(mockUpdatedCustomerResponse);
      // const client = paymentSDK.ctAPI.client;
      // client.customers = jest.fn(() => ({
      //   withId: jest.fn(() => ({
      //     post: jest.fn(() => ({
      //       execute: executeMock,
      //     })),
      //   })),
      // })) as never;

      const getCustomFieldUpdateActionsMock = jest
        .spyOn(CustomTypeHelper, 'getCustomFieldUpdateActions')
        .mockResolvedValue(mock_SetCustomTypeActions);
      const updateCustomerByIdMock = jest
        .spyOn(CustomerClient, 'updateCustomerById')
        .mockResolvedValue(mockCtCustomerData);

      await stripePaymentService.saveStripeCustomerId('mockStripeCustomerId', mockCtCustomerData);

      expect(getCustomFieldUpdateActionsMock).toHaveBeenCalled();
      expect(updateCustomerByIdMock).toHaveBeenCalled();
      expect(Logger.log.info).toHaveBeenCalled();
    });
  });

  describe('method status - Stripe DOWN', () => {
    test('should return Stripe status DOWN when Stripe API fails', async () => {
      const mockHealthCheckFunction: () => Promise<HealthCheckResult> = async () => {
        const result: HealthCheckResult = {
          name: 'CoCo Permissions',
          status: 'UP',
          message: 'CoCo Permissions are available',
          details: {},
        };
        return result;
      };
      Stripe.prototype.paymentMethods = {
        list: jest.fn<() => Promise<Stripe.ApiList<Stripe.PaymentMethod>>>().mockRejectedValue(new Error('Stripe API error')),
      } as unknown as Stripe.PaymentMethodsResource;

      jest.spyOn(StatusHandler, 'healthCheckCommercetoolsPermissions').mockReturnValue(mockHealthCheckFunction);
      const paymentServiceLocal: AbstractPaymentService = new StripePaymentService(opts);
      const result: StatusResponse = await paymentServiceLocal.status();

      expect(result?.status).toBeDefined();
      expect(result?.checks).toHaveLength(2);
      expect(result?.checks[1]?.name).toStrictEqual('Stripe Status check');
      expect(result?.checks[1]?.status).toStrictEqual('DOWN');
    });
  });

  describe('method capturePayment - partial capture scenarios', () => {
    test('should reject partial capture when STRIPE_ENABLE_MULTI_OPERATIONS is disabled', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled' } as PaymentFeatures,
        stripeCollectBillingAddress: 'never',
        stripeEnableMultiOperations: false,
        stripePaymentIntentSetupFutureUsage: undefined,
      });

      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'capturePayment',
              amount: {
                centAmount: 50000,
                currencyCode: 'USD',
              },
            },
          ],
        },
      };

      const mockPaymentWithAmount = {
        ...mockGetPaymentResult,
        amountPlanned: {
          type: 'centPrecision' as const,
          currencyCode: 'USD',
          centAmount: 150000,
          fractionDigits: 2,
        },
      };

      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockPaymentWithAmount));

      const mockRetrieveResult = {
        ...mockStripeRetrievePaymentResult,
        amount_received: 0,
      };

      jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: {
          retrieve: jest.fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>().mockResolvedValue(mockRetrieveResult),
          capture: jest.fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>().mockResolvedValue(mockStripeCapturePaymentResult),
        },
      } as unknown as Stripe);

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('rejected');
    });

    test('should approve partial capture when STRIPE_ENABLE_MULTI_OPERATIONS is enabled', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled' } as PaymentFeatures,
        stripeCollectBillingAddress: 'never',
        stripeEnableMultiOperations: true,
        stripePaymentIntentSetupFutureUsage: undefined,
      });

      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'capturePayment',
              amount: {
                centAmount: 50000,
                currencyCode: 'USD',
              },
            },
          ],
        },
      };

      const mockPaymentWithAmount = {
        ...mockGetPaymentResult,
        amountPlanned: {
          type: 'centPrecision' as const,
          currencyCode: 'USD',
          centAmount: 150000,
          fractionDigits: 2,
        },
      };

      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockPaymentWithAmount));

      const mockRetrieveResult = {
        ...mockStripeRetrievePaymentResult,
        amount_received: 0,
      };

      jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: {
          retrieve: jest.fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>().mockResolvedValue(mockRetrieveResult),
          capture: jest.fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>().mockResolvedValue(mockStripeCapturePaymentResult),
        },
      } as unknown as Stripe);

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('approved');
    });
  });

  describe('method refundPayment - multiple refunds scenarios', () => {
    test('should warn when multiple refunds attempted without STRIPE_ENABLE_MULTI_OPERATIONS', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled' } as PaymentFeatures,
        stripeCollectBillingAddress: 'never',
        stripeEnableMultiOperations: false,
        stripePaymentIntentSetupFutureUsage: undefined,
      });

      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'refundPayment',
              amount: {
                centAmount: 50000,
                currencyCode: 'USD',
              },
            },
          ],
        },
      };

      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(true);
      jest.spyOn(Stripe.prototype.refunds, 'create').mockReturnValue(Promise.resolve(mockStripeCreateRefundResult));

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('received');
      expect(Logger.log.warn).toHaveBeenCalled();
    });
  });

  describe('method reversePayment - no successful transaction', () => {
    test('should throw error when there is no successful payment transaction to reverse', async () => {
      const modifyPaymentOpts: ModifyPayment = {
        paymentId: 'dummy-paymentId',
        data: {
          actions: [
            {
              action: 'reversePayment',
            },
          ],
        },
      };

      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);

      try {
        await paymentService.modifyPayment(modifyPaymentOpts);
        fail('Expected an error to be thrown');
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe('method getCustomerSession - customer not found', () => {
    test('should return undefined when customer is not found', async () => {
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue(undefined);

      const result = await stripePaymentService.getCustomerSession();

      expect(result).toBeUndefined();
      expect(Logger.log.info).toHaveBeenCalled();
    });
  });

  describe('method processStripeEvent - multicapture scenarios', () => {
    test('should handle multicapture payment with multiple balance transactions', async () => {
      const mockEvent: Stripe.Event = mockEvent__paymentIntent_succeeded_multicapture;

      const test = {
        id: 'ct_payment_multicapture',
        pspReference: 'pi_multicapture',
        paymentMethod: 'card',
        transactions: [
          {
            type: PaymentTransactions.CHARGE,
            state: PaymentStatus.SUCCESS,
            amount: {
              centAmount: 50000,
              currencyCode: 'USD',
            },
          },
        ],
      };

      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(test);
      jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        balanceTransactions: {
          list: jest.fn().mockReturnValue(
            Promise.resolve({
              data: [
                { id: 'txn_1', amount: 25000, currency: 'usd' },
                { id: 'txn_2', amount: 25000, currency: 'usd' },
              ],
              has_more: false,
              object: 'list',
              url: '/v1/balance_transactions',
            }),
          ),
        },
      } as unknown as Stripe);

      const updatePaymentMock = jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent);

      expect(updatePaymentMock).toHaveBeenCalled();
    });

    test('should handle processStripeEvent error gracefully', async () => {
      const mockEvent: Stripe.Event = mockEvent__paymentIntent_succeeded_captureMethodManual;

      jest.spyOn(StripeEventConverter.prototype, 'convert').mockImplementation(() => {
        throw new Error('Conversion error');
      });

      await stripePaymentService.processStripeEvent(mockEvent);
      expect(Logger.log.error).toHaveBeenCalled();
    });
  });

  describe('method processStripeEventMultipleCaptured', () => {
    test('should update payment for a valid multicapture charge.updated event', async () => {
      const mockEvent: Stripe.Event = mockEvent__charge_updated_multicapture;

      const test = {
        id: 'ct_payment_multicapture',
        pspReference: 'txn_multicapture',
        paymentMethod: 'card',
        transactions: [
          {
            type: PaymentTransactions.CHARGE,
            state: PaymentStatus.SUCCESS,
            amount: {
              centAmount: 25000,
              currencyCode: 'USD',
            },
          },
        ],
      };

      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(test);
      const updatePaymentMock = jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEventMultipleCaptured(mockEvent);

      expect(updatePaymentMock).toHaveBeenCalled();
    });

    test('should skip when charge is already captured', async () => {
      const mockEvent: Stripe.Event = mockEvent__charge_updated_already_captured;

      const test = {
        id: 'ct_payment_captured',
        pspReference: 'txn_captured',
        paymentMethod: 'card',
        transactions: [],
      };

      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(test);
      const updatePaymentMock = jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEventMultipleCaptured(mockEvent);

      expect(Logger.log.warn).toHaveBeenCalled();
      expect(updatePaymentMock).not.toHaveBeenCalled();
    });

    test('should skip when amount_captured did not increase', async () => {
      const mockEvent: Stripe.Event = mockEvent__charge_updated_no_amount_change;

      const test = {
        id: 'ct_payment_no_change',
        pspReference: 'txn_no_change',
        paymentMethod: 'card',
        transactions: [],
      };

      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(test);
      const updatePaymentMock = jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEventMultipleCaptured(mockEvent);

      expect(Logger.log.warn).toHaveBeenCalled();
      expect(updatePaymentMock).not.toHaveBeenCalled();
    });

    test('should handle processStripeEventMultipleCaptured error gracefully', async () => {
      const mockEvent: Stripe.Event = mockEvent__charge_updated_multicapture;

      jest.spyOn(StripeEventConverter.prototype, 'convert').mockImplementation(() => {
        throw new Error('Conversion error');
      });

      await stripePaymentService.processStripeEventMultipleCaptured(mockEvent);
      expect(Logger.log.error).toHaveBeenCalled();
    });
  });

  describe('method getStripeCustomerAddress', () => {
    test('should return undefined when both addresses are undefined', () => {
      const result = stripePaymentService.getStripeCustomerAddress(undefined, undefined);
      expect(result).toBeUndefined();
    });

    test('should use fallback address when prioritized address is undefined', () => {
      const fallbackAddress = {
        firstName: 'Jane',
        lastName: 'Doe',
        streetNumber: '456',
        streetName: 'Fallback St',
        city: 'Fallback City',
        postalCode: '54321',
        state: 'NY',
        country: 'US',
        phone: '+1234567890',
      };

      const result = stripePaymentService.getStripeCustomerAddress(undefined, fallbackAddress);

      expect(result).toBeDefined();
      expect(result?.name).toStrictEqual('Jane Doe');
      expect(result?.address?.city).toStrictEqual('Fallback City');
    });
  });

  describe('method getBillingAddress', () => {
    test('should return undefined when cart has no billing or shipping address', () => {
      const cartWithoutAddress = {
        ...mockGetCartResult(),
        billingAddress: undefined,
        shippingAddress: undefined,
      };

      const result = stripePaymentService.getBillingAddress(cartWithoutAddress);
      expect(result).toBeUndefined();
    });
  });

  describe('method initializeCartPayment - setup_future_usage scenarios', () => {
    test('should return setupFutureUsage as undefined when override is empty string', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled' } as PaymentFeatures,
        stripeCollectBillingAddress: 'auto',
        stripeEnableMultiOperations: false,
        stripePaymentIntentSetupFutureUsage: '',
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(result.setupFutureUsage).toBeUndefined();
    });

    test('should return setupFutureUsage as undefined when override is none', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled' } as PaymentFeatures,
        stripeCollectBillingAddress: 'auto',
        stripeEnableMultiOperations: false,
        stripePaymentIntentSetupFutureUsage: 'none',
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(result.setupFutureUsage).toBeUndefined();
    });

    test('should return setupFutureUsage as off_session when override is off_session', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled' } as PaymentFeatures,
        stripeCollectBillingAddress: 'auto',
        stripeEnableMultiOperations: false,
        stripePaymentIntentSetupFutureUsage: 'off_session',
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(result.setupFutureUsage).toStrictEqual('off_session');
    });

    test('should return setupFutureUsage as on_session when override is on_session', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled' } as PaymentFeatures,
        stripeCollectBillingAddress: 'auto',
        stripeEnableMultiOperations: false,
        stripePaymentIntentSetupFutureUsage: 'on_session',
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(result.setupFutureUsage).toStrictEqual('on_session');
    });

    test('should fallback to default when override is invalid value', async () => {
      type PaymentFeatures = Stripe.CustomerSessionCreateParams.Components.PaymentElement.Features;
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        apiUrl: '',
        authUrl: '',
        clientId: '',
        clientSecret: '',
        healthCheckTimeout: 0,
        jwksUrl: '',
        jwtIssuer: '',
        loggerLevel: '',
        mockClientKey: '',
        mockEnvironment: '',
        sessionUrl: '',
        stripeApiVersion: '',
        stripeApplePayWellKnown: '',
        stripeLayout: '',
        stripePaymentElementAppearance: '',
        stripePublishableKey: '',
        stripeSecretKey: '',
        stripeWebhookSigningSecret: '',
        stripeCaptureMethod: 'manual',
        merchantReturnUrl: 'https://merchant.example.com/return',
        projectKey: 'your-project-key',
        stripeSavedPaymentMethodConfig: { payment_method_save: 'disabled', payment_method_save_usage: 'on_session' } as PaymentFeatures,
        stripeCollectBillingAddress: 'auto',
        stripeEnableMultiOperations: false,
        stripePaymentIntentSetupFutureUsage: 'invalid_value',
      });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(Logger.log.warn).toHaveBeenCalled();
      expect(result.setupFutureUsage).toStrictEqual('on_session');
    });
  });

  describe('method processStripeEventRefunded - error handling', () => {
    test('should handle processStripeEventRefunded error gracefully', async () => {
      const mockEvent: Stripe.Event = mockEvent__charge_refund_captured;

      jest.spyOn(StripeEventConverter.prototype, 'convert').mockImplementation(() => {
        throw new Error('Conversion error');
      });

      await stripePaymentService.processStripeEventRefunded(mockEvent);
      expect(Logger.log.error).toHaveBeenCalled();
    });
  });
});
