import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ConfigResponse, ModifyPayment, StatusResponse } from '../../src/services/types/operation.type';
import { paymentSDK } from '../../src/payment-sdk';
import { DefaultPaymentService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-payment.service';
import { DefaultCartService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-cart.service';
import { DefaultOrderService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-order.service';
import { DefaultPaymentMethodService } from '@commercetools/connect-payments-sdk/dist/commercetools/services/ct-payment-method.service';
import { ErrorResourceNotFound } from '@commercetools/connect-payments-sdk';
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
  mockEvent__paymentIntent_processing,
  mockEvent__paymentIntent_requiresAction_bankTransfer,
  mockEvent__paymentIntent_partiallyFunded_bankTransfer,
  mockEvent__paymentIntent_requiresAction_foreign,
  mockEvent__paymentIntent_processing_foreign,
  mockEvent__refund_failed,
  mockEvent__refund_failed_noMetadata,
  mockEvent__paymentIntent_paymentFailed,
  mockEvent__paymentIntent_canceled,
  mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
  mockEvent__paymentIntent_requiresAction_3ds,
} from '../utils/mock-routes-data';
import {
  mockGetCartResult,
  mockGetCartWithoutCustomerIdResult,
  mockGetCartWithCountry,
  mockGetCartWithBillingCountryOnly,
  mockGetCartWithShippingCountryOnly,
  mockGetCartWithStoreKey,
} from '../utils/mock-cart-data';
import { EU_BANK_TRANSFER_COUNTRIES } from '../../src/mappers/bank-transfer-mapper';
import * as Config from '../../src/config/config';
import * as ConfigModule from '../../src/config/config';
import {
  OrderPaymentState,
  PaymentStatus,
  StripePaymentServiceOptions,
} from '../../src/services/types/stripe-payment.type';
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
import { PaymentModificationStatus, PaymentTransactions } from '../../src/dtos/operations/payment-intents.dto';
import { ClientResponse } from '@commercetools/platform-sdk/dist/declarations/src/generated/shared/utils/common-types';
import {
  mockCreateSessionResult,
  mockCtCustomerData,
  mockCtCustomerWithoutCustomFieldsData,
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

// Mirrors a Stripe error thrown on a customer_balance PaymentIntent: `raw`, `payment_intent`
// and `headers` are own enumerable properties, which is how winston used to end up serializing
// a full PaymentIntent — client_secret and financial_addresses included — into the log.
const makeLeakyStripeError = (message: string) => {
  const err = new Error(message) as Error & {
    type: string;
    code: string;
    statusCode: number;
    raw: unknown;
    payment_intent: unknown;
    headers: unknown;
  };
  err.type = 'StripeInvalidRequestError';
  err.code = 'resource_missing';
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
  err.raw = { message, payment_intent: err.payment_intent };
  return err;
};

const loggedText = (fn: unknown) => JSON.stringify((fn as jest.Mock).mock.calls);

const expectNoSecrets = (text: string) => {
  expect(text).not.toContain('DE89370400440532013000');
  expect(text).not.toContain('BUKBGB22');
  expect(text).not.toContain('payments.stripe.com/bank_transfer_instructions');
  expect(text).not.toContain('pi_bt_11111_secret');
  expect(text).not.toContain('req_leak_11111');
};

describe('stripe-payment.service', () => {
  const opts: StripePaymentServiceOptions = {
    ctCartService: paymentSDK.ctCartService,
    ctPaymentService: paymentSDK.ctPaymentService,
    ctOrderService: paymentSDK.ctOrderService,
    ctPaymentMethodService: paymentSDK.ctPaymentMethodService,
    ctRecurringPaymentJobService:
      (paymentSDK as any).ctRecurringPaymentJobService ||
      ({
        createRecurringPaymentJobIfApplicable: jest.fn<() => Promise<{ id: string } | null>>().mockResolvedValue(null),
      } as any),
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
      expect(result?.express).toHaveLength(1);
      expect(result?.express[0]?.type).toStrictEqual('dropin');
    });

    test('should return dropins and express without affecting each other', async () => {
      const result: SupportedPaymentComponentsSchemaDTO = await paymentService.getSupportedPaymentComponents();
      expect(result?.dropins).toHaveLength(1);
      expect(result?.dropins[0]?.type).toStrictEqual('embedded');
      expect(result?.express).toHaveLength(1);
      expect(result?.express[0]?.type).toStrictEqual('dropin');
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

      const retrieveResult = {
        ...mockStripeRetrievePaymentResult,
        status: 'succeeded' as const,
        amount: mockGetPaymentResult.amountPlanned.centAmount,
        currency: (mockGetPaymentResult.amountPlanned.currencyCode ?? '').toLowerCase(),
        metadata: { ct_payment_id: 'paymentReference' },
      };
      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: {
          retrieve: jest.fn().mockResolvedValue(retrieveResult),
        },
      } as unknown as Stripe);

      const outcome = await stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference');

      expect(outcome).toBe(PaymentModificationStatus.APPROVED);
      expect(getCartMock).toHaveBeenCalled();
      expect(getPaymentMock).toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalled();
      expect(stripeApiMock).toHaveBeenCalled();
    });

    const mockGate = (status: 'succeeded' | 'requires_capture' | 'processing' | 'canceled') => {
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(mockGetCartResult());
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(mockGetPaymentResult);
      const retrieveResult = {
        ...mockStripeRetrievePaymentResult,
        status,
        amount: mockGetPaymentResult.amountPlanned.centAmount,
        currency: (mockGetPaymentResult.amountPlanned.currencyCode ?? '').toLowerCase(),
        metadata: { ct_payment_id: 'paymentReference' },
      };
      jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: { retrieve: jest.fn().mockResolvedValue(retrieveResult) },
      } as unknown as Stripe);
    };

    test('processing -> writes Authorization/Pending, returns PENDING, does NOT throw', async () => {
      mockGate('processing');
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(mockGetPaymentResult);

      const outcome = await stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference');

      expect(outcome).toBe(PaymentModificationStatus.PENDING);
      expect(updatePaymentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          transaction: expect.objectContaining({ type: 'Authorization', state: 'Pending' }),
        }),
      );
    });

    test('processing with an existing Pending authorization -> dedup, does NOT write again', async () => {
      mockGate('processing');
      jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockImplementation(({ transactionType }) => transactionType === 'Authorization');
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(mockGetPaymentResult);

      const outcome = await stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference');

      expect(outcome).toBe(PaymentModificationStatus.PENDING);
      expect(updatePaymentMock).not.toHaveBeenCalled();
    });

    test('requires_capture -> returns APPROVED', async () => {
      mockGate('requires_capture');
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockResolvedValue(mockGetPaymentResult);

      const outcome = await stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference');

      expect(outcome).toBe(PaymentModificationStatus.APPROVED);
    });

    test('status not allowed (canceled) -> throws (validation not relaxed)', async () => {
      mockGate('canceled');
      await expect(
        stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference'),
      ).rejects.toThrow('status "canceled" is not allowed');
    });

    // -----------------------------------------------------------------------
    // requires_action at the synchronous gate — SB3-207 task 026
    //
    // `requires_action` is NOT in the flat allowlist and must not be. It is admitted only when the
    // next_action carries bank transfer instructions; for every other variant the buyer completed
    // nothing and the gate must keep rejecting.
    // -----------------------------------------------------------------------
    const mockGateRequiresAction = (nextAction: unknown) => {
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(mockGetCartResult());
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(mockGetPaymentResult);
      const retrieveResult = {
        ...mockStripeRetrievePaymentResult,
        status: 'requires_action' as const,
        next_action: nextAction,
        amount: mockGetPaymentResult.amountPlanned.centAmount,
        currency: (mockGetPaymentResult.amountPlanned.currencyCode ?? '').toLowerCase(),
        metadata: { ct_payment_id: 'paymentReference' },
      };
      jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: { retrieve: jest.fn().mockResolvedValue(retrieveResult) },
      } as unknown as Stripe);
    };

    const bankTransferNextAction = {
      type: 'display_bank_transfer_instructions',
      display_bank_transfer_instructions: { reference: 'BT-REF-11111', type: 'eu_bank_transfer' },
    };

    // ***** MIRROR ASSERTION *****
    // The release gates below pass just as happily if the gate rejects EVERY requires_action, which
    // is what it did before this task and is the state that puts the buyer on a failure screen.
    test('MIRROR: bank transfer requires_action -> writes Authorization/Pending and returns PENDING', async () => {
      mockGateRequiresAction(bankTransferNextAction);
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(mockGetPaymentResult);

      const outcome = await stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference');

      // PENDING is what makes the route answer 202, which is what lets the enabler report a
      // non-success instead of an error. APPROVED here would claim money that has not moved.
      expect(outcome).toBe(PaymentModificationStatus.PENDING);
      expect(updatePaymentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          transaction: expect.objectContaining({
            type: 'Authorization',
            state: 'Pending',
            amount: mockGetPaymentResult.amountPlanned,
          }),
        }),
      );
    });

    test('bank transfer requires_action with an existing Pending -> dedup, does NOT write again', async () => {
      mockGateRequiresAction(bankTransferNextAction);
      jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockImplementation(({ transactionType }) => transactionType === 'Authorization');
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(mockGetPaymentResult);

      const outcome = await stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference');

      expect(outcome).toBe(PaymentModificationStatus.PENDING);
      expect(updatePaymentMock).not.toHaveBeenCalled();
    });

    // ***** RELEASE GATE *****
    // Card 3DS reaches this gate with status requires_action having authenticated NOTHING. If the
    // allowlist is ever widened to accept the status outright, this writes an authorization for a
    // payment the buyer abandoned.
    test('RELEASE GATE: card 3DS requires_action -> still throws', async () => {
      mockGateRequiresAction({ type: 'use_stripe_sdk', use_stripe_sdk: { type: 'three_d_secure_redirect' } });
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(mockGetPaymentResult);

      await expect(
        stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference'),
      ).rejects.toThrow('status "requires_action" is not allowed');
      expect(updatePaymentMock).not.toHaveBeenCalled();
    });

    // ***** RELEASE GATE *****
    test('RELEASE GATE: Boleto requires_action -> still throws', async () => {
      mockGateRequiresAction({ type: 'boleto_display_details', boleto_display_details: { number: '00000' } });

      await expect(
        stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference'),
      ).rejects.toThrow('status "requires_action" is not allowed');
    });

    // Fails CLOSED: the discriminator matches but the payload Stripe promises alongside it is
    // absent, which is the shape a future API change is most likely to produce.
    test('requires_action with the bank transfer type but no instructions object -> throws', async () => {
      mockGateRequiresAction({ type: 'display_bank_transfer_instructions' });

      await expect(
        stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference'),
      ).rejects.toThrow('status "requires_action" is not allowed');
    });

    test('requires_action with no next_action at all -> throws', async () => {
      mockGateRequiresAction(null);

      await expect(
        stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference'),
      ).rejects.toThrow('status "requires_action" is not allowed');
    });

    test('metadata.ct_payment_id mismatch -> throws', async () => {
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(mockGetCartResult());
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: {
          retrieve: jest.fn().mockResolvedValue({
            ...mockStripeRetrievePaymentResult,
            status: 'processing',
            amount: mockGetPaymentResult.amountPlanned.centAmount,
            currency: (mockGetPaymentResult.amountPlanned.currencyCode ?? '').toLowerCase(),
            metadata: { ct_payment_id: 'someone-else' },
          }),
        },
      } as unknown as Stripe);

      await expect(
        stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference'),
      ).rejects.toThrow('metadata.ct_payment_id does not match');
    });

    test('amount mismatch -> throws', async () => {
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(mockGetCartResult());
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentIntents: {
          retrieve: jest.fn().mockResolvedValue({
            ...mockStripeRetrievePaymentResult,
            status: 'processing',
            amount: mockGetPaymentResult.amountPlanned.centAmount + 100,
            currency: (mockGetPaymentResult.amountPlanned.currencyCode ?? '').toLowerCase(),
            metadata: { ct_payment_id: 'paymentReference' },
          }),
        },
      } as unknown as Stripe);

      await expect(
        stripePaymentService.updatePaymentIntentStripeSuccessful('paymentId', 'paymentReference'),
      ).rejects.toThrow('amount/currency mismatch');
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
        checkoutUrl: '',
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
        paymentInterface: 'checkout-stripe',
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

    test('should create PaymentIntent without shipping but with customer when expressCheckout is true and expressCustomerSession is true', async () => {
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue(mockCtCustomerData);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);
      const createSpy = jest
        .spyOn(Stripe.prototype.paymentIntents, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreatePaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(mockGetCartResult());

      await stripePaymentService.createPaymentIntentStripe(true, true);

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs).not.toHaveProperty('shipping');
      expect(createArgs).toHaveProperty('customer', mockStripeCustomerId);
    });

    test('should create PaymentIntent without shipping and without customer when expressCheckout is true but expressCustomerSession is false (_SetupExpress path)', async () => {
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue(mockCtCustomerData);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);
      const createSpy = jest
        .spyOn(Stripe.prototype.paymentIntents, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreatePaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(mockGetCartResult());

      await stripePaymentService.createPaymentIntentStripe(true, false);

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs).not.toHaveProperty('shipping');
      expect(createArgs).not.toHaveProperty('customer');
      expect(createArgs).not.toHaveProperty('setup_future_usage');
    });

    test('should create PaymentIntent without shipping and without customer when expressCheckout is true and no customer fields exist', async () => {
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(mockGetCartResult()));
      jest
        .spyOn(StripePaymentService.prototype, 'getCtCustomer')
        .mockResolvedValue(mockCtCustomerWithoutCustomFieldsData);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);
      const createSpy = jest
        .spyOn(Stripe.prototype.paymentIntents, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreatePaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(mockGetCartResult());

      await stripePaymentService.createPaymentIntentStripe(true, true);

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs).not.toHaveProperty('shipping');
      expect(createArgs).not.toHaveProperty('customer');
      expect(createArgs).not.toHaveProperty('setup_future_usage');
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

    const processingUpdateData = {
      id: 'paymentId',
      pspReference: 'paymentIntentId',
      paymentMethod: 'payment',
      transactions: [
        {
          type: PaymentTransactions.AUTHORIZATION,
          state: PaymentStatus.PENDING,
          amount: { centAmount: 13200, currencyCode: 'USD' },
        },
      ],
    };

    test('should write Authorization/Pending for payment_intent.processing when no resolving transaction exists', async () => {
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(processingUpdateData);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_processing);

      expect(updatePaymentMock).toHaveBeenCalledTimes(1);
    });

    test('should skip payment_intent.processing when a Charge/Success transaction already exists (dedup)', async () => {
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(processingUpdateData);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_processing);

      expect(updatePaymentMock).not.toHaveBeenCalled();
    });

    test('should skip payment_intent.processing when an Authorization/Pending transaction already exists (dedup)', async () => {
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(processingUpdateData);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_processing);

      expect(updatePaymentMock).not.toHaveBeenCalled();
    });

    test('should re-throw (not swallow) when a payment_intent.processing write fails', async () => {
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(processingUpdateData);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockImplementation(() => {
        throw new Error('ConcurrentModification');
      });

      await expect(stripePaymentService.processStripeEvent(mockEvent__paymentIntent_processing)).rejects.toThrow();
    });

    // -----------------------------------------------------------------------
    // Foreign PaymentIntents — SB3-207 task 025
    //
    // An intent this connector did not create reaches the webhook with no ct_payment_id. Before
    // the guard, getPayment({ id: undefined }) threw and the ASYNC_PENDING_EVENTS re-throw turned
    // it into a 500 that Stripe retries for three days — and sustained 5xx can get the whole
    // endpoint disabled. Both members of that set are covered, because the exposure predates the
    // bank transfer work: payment_intent.processing has had it all along.
    // -----------------------------------------------------------------------
    describe('PaymentIntent with no ct_payment_id in metadata', () => {
      test.each([
        ['payment_intent.requires_action', mockEvent__paymentIntent_requiresAction_foreign],
        ['payment_intent.processing', mockEvent__paymentIntent_processing_foreign],
      ])('returns quietly for %s instead of re-throwing', async (_label, event) => {
        const getPaymentMock = jest.spyOn(DefaultPaymentService.prototype, 'getPayment');
        const updatePaymentMock = jest
          .spyOn(DefaultPaymentService.prototype, 'updatePayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));

        // Resolving, not throwing, is the entire point: a rejection here is the 500 that Stripe
        // retries for three days.
        await expect(stripePaymentService.processStripeEvent(event)).resolves.toBeUndefined();

        // The guard must sit BEFORE the dedup lookup. If it were placed after, this suite would
        // still pass on the resolves() assertion alone while getPayment(undefined) hit the API.
        expect(getPaymentMock).not.toHaveBeenCalled();
        expect(updatePaymentMock).not.toHaveBeenCalled();
      });

      test('logs a warning naming the event type, not an error', async () => {
        jest
          .spyOn(DefaultPaymentService.prototype, 'updatePayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));

        await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_requiresAction_foreign);

        expect(Logger.log.warn).toHaveBeenCalledWith(
          'Skipping event: the PaymentIntent carries no commercetools payment id in its metadata',
          expect.objectContaining({
            eventType: 'payment_intent.requires_action',
            pspReference: 'pi_foreign_11111',
          }),
        );
        // A foreign event is not a fault of ours. Logging it at error level would page someone
        // for another integration's traffic.
        expect(Logger.log.error).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // Bank transfer async settlement — SB3-207 task 005
    //
    // These deliberately use the REAL converter rather than mocking it. Mocking convert() would
    // make the amount a value the test itself supplies, which is exactly the assertion that has to
    // be real here: the whole risk is that `amount_received` (0 until the wire lands) is used
    // instead of `amount`.
    // -----------------------------------------------------------------------
    describe('bank transfer requires_action / partially_funded', () => {
      test('writes ONE Authorization/Pending for the full pi.amount, not amount_received', async () => {
        jest
          .spyOn(DefaultPaymentService.prototype, 'getPayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));
        jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
        const updatePaymentMock = jest
          .spyOn(DefaultPaymentService.prototype, 'updatePayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));

        await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_requiresAction_bankTransfer);

        expect(updatePaymentMock).toHaveBeenCalledTimes(1);
        expect(updatePaymentMock).toHaveBeenCalledWith(
          expect.objectContaining({
            transaction: expect.objectContaining({
              type: PaymentTransactions.AUTHORIZATION,
              state: PaymentStatus.PENDING,
              // 12300 is `amount`. The fixture's `amount_received` is 0 — booking that would be a
              // zero-cent authorization against a real order, with a green suite.
              amount: { centAmount: 12300, currencyCode: 'EUR' },
            }),
          }),
        );
      });

      test('skips a redundant requires_action when a Pending authorization already exists (dedup)', async () => {
        jest
          .spyOn(DefaultPaymentService.prototype, 'getPayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));
        jest
          .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true);
        const updatePaymentMock = jest
          .spyOn(DefaultPaymentService.prototype, 'updatePayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));

        await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_requiresAction_bankTransfer);

        expect(updatePaymentMock).not.toHaveBeenCalled();
      });

      // The dedup guard is what makes this retry safe; without the re-throw a failed write leaves
      // the payment with no record of an authorization while the money is genuinely on its way.
      test('re-throws (does not swallow) when a requires_action write fails', async () => {
        jest
          .spyOn(DefaultPaymentService.prototype, 'getPayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));
        jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
        jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockImplementation(() => {
          throw new Error('ConcurrentModification');
        });

        await expect(
          stripePaymentService.processStripeEvent(mockEvent__paymentIntent_requiresAction_bankTransfer),
        ).rejects.toThrow();
      });

      test('partially_funded persists the interaction with NO transaction', async () => {
        const updatePaymentMock = jest
          .spyOn(DefaultPaymentService.prototype, 'updatePayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));

        await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_partiallyFunded_bankTransfer);

        expect(updatePaymentMock).toHaveBeenCalledTimes(1);
        expect(updatePaymentMock.mock.calls[0][0]).not.toHaveProperty('transaction');
      });

      // ***** RELEASE GATE *****
      // The funds sit in the customer's cash balance, not on the platform balance. Promoting an
      // authorization here would book revenue that does not exist.
      test('RELEASE GATE: partially_funded never promotes an authorization to Success', async () => {
        jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(true);
        const updatePaymentMock = jest
          .spyOn(DefaultPaymentService.prototype, 'updatePayment')
          .mockReturnValue(Promise.resolve(mockGetPaymentResult));

        await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_partiallyFunded_bankTransfer);

        expect(updatePaymentMock).toHaveBeenCalledTimes(1);
        expect(updatePaymentMock).not.toHaveBeenCalledWith(
          expect.objectContaining({
            transaction: expect.objectContaining({ state: PaymentStatus.SUCCESS }),
          }),
        );
      });

      // Deliberately NOT in ASYNC_PENDING_EVENTS: it writes no transaction, so losing it costs an
      // audit line rather than correctness, and re-throwing would cause a retry storm on an event
      // that fires once per instalment.
      test('does NOT re-throw when a partially_funded write fails', async () => {
        jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockImplementation(() => {
          throw new Error('ConcurrentModification');
        });

        await expect(
          stripePaymentService.processStripeEvent(mockEvent__paymentIntent_partiallyFunded_bankTransfer),
        ).resolves.toBeUndefined();
      });
    });

    const succeededUpdateData = {
      id: 'paymentId',
      pspReference: 'paymentIntentId',
      paymentMethod: 'payment',
      transactions: [
        {
          type: PaymentTransactions.CHARGE,
          state: PaymentStatus.SUCCESS,
          amount: { centAmount: 13200, currencyCode: 'USD' },
        },
      ],
    };

    test('should transition a lingering Authorization/Pending to Success on payment_intent.succeeded (crypto)', async () => {
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(succeededUpdateData);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(true);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_succeeded_captureMethodManual);

      // 1 write for the Charge/Success (main loop) + 1 for the Pending->Success transition
      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
      expect(updatePaymentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          transaction: expect.objectContaining({ type: PaymentTransactions.AUTHORIZATION, state: 'Success' }),
        }),
      );
    });

    test('should not throw when the Pending->Success transition fails (best-effort)', async () => {
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(succeededUpdateData);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(true);
      // 1st call (main Charge write) succeeds; 2nd call (transition) throws.
      jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValueOnce(Promise.resolve(mockGetPaymentResult))
        .mockImplementationOnce(() => {
          throw new Error('ConcurrentModification');
        });

      await expect(
        stripePaymentService.processStripeEvent(mockEvent__paymentIntent_succeeded_captureMethodManual),
      ).resolves.toBeUndefined();
    });

    test('should NOT transition on succeeded when no Authorization/Pending exists (card regression)', async () => {
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(succeededUpdateData);
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockReturnValue(Promise.resolve(mockGetPaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_succeeded_captureMethodManual);

      // only the Charge/Success write — no extra transition for a card payment
      expect(updatePaymentMock).toHaveBeenCalledTimes(1);
    });

    test('should write Authorization/Failure on payment_intent.payment_failed (transitions Pending->Failure)', async () => {
      const failedUpdateData = {
        id: 'paymentId',
        pspReference: 'paymentIntentId',
        paymentMethod: 'payment',
        transactions: [
          {
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.FAILURE,
            amount: { centAmount: 13200, currencyCode: 'USD' },
          },
        ],
      };
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(failedUpdateData);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_paymentFailed);

      expect(updatePaymentMock).toHaveBeenCalledTimes(1);
      expect(updatePaymentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          transaction: expect.objectContaining({
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.FAILURE,
          }),
        }),
      );
    });

    test('should write Authorization/Failure + CancelAuthorization/Success on payment_intent.canceled', async () => {
      const canceledUpdateData = {
        id: 'paymentId',
        pspReference: 'paymentIntentId',
        paymentMethod: 'payment',
        transactions: [
          {
            type: PaymentTransactions.AUTHORIZATION,
            state: PaymentStatus.FAILURE,
            amount: { centAmount: 13200, currencyCode: 'USD' },
          },
          {
            type: PaymentTransactions.CANCEL_AUTHORIZATION,
            state: PaymentStatus.SUCCESS,
            amount: { centAmount: 13200, currencyCode: 'USD' },
          },
        ],
      };
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockReturnValue(canceledUpdateData);
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEvent(mockEvent__paymentIntent_canceled);

      expect(updatePaymentMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('method processStripeEventRefundFailed', () => {
    test('writes a Refund/Failure for the refund amount against the stamped commercetools payment', async () => {
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await stripePaymentService.processStripeEventRefundFailed(mockEvent__refund_failed);

      expect(updatePaymentMock).toHaveBeenCalledTimes(1);
      expect(updatePaymentMock).toHaveBeenCalledWith({
        id: 'ct_payment_bt_11111',
        transaction: {
          type: PaymentTransactions.REFUND,
          state: PaymentStatus.FAILURE,
          amount: { centAmount: 12300, currencyCode: 'EUR' },
          interactionId: 're_11111',
        },
      });
    });

    // A Dashboard-issued refund carries no stamp. Nothing was written for it either, so there is
    // nothing to correct — skipping is right, and guessing a payment id would be worse than doing
    // nothing.
    test('skips a refund that carries no ct_payment_id, without throwing', async () => {
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

      await expect(
        stripePaymentService.processStripeEventRefundFailed(mockEvent__refund_failed_noMetadata),
      ).resolves.toBeUndefined();
      expect(updatePaymentMock).not.toHaveBeenCalled();
    });

    // Deliberately different from processStripeEventRefunded, which swallows. Returning 200 after
    // failing to write this correction stops Stripe redelivering it, and the payment keeps
    // claiming a refund that never happened — the exact divergence this method exists to close.
    test('re-throws when the commercetools write fails', async () => {
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockImplementation(() => {
        throw new Error('ConcurrentModification');
      });

      await expect(stripePaymentService.processStripeEventRefundFailed(mockEvent__refund_failed)).rejects.toThrow(
        'ConcurrentModification',
      );
    });

    // Stripe errors expose `raw`, `charge` and `payment_intent` as own enumerable properties and
    // winston serializes own enumerables, so passing the error object whole would write the full
    // payload to the log. Asserted on content, not on shape.
    test('never logs the raw error object when the write fails', async () => {
      const stripeishError = Object.assign(new Error('Request failed'), {
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        raw: { message: 'boom', payment_intent: { client_secret: 'pi_bt_11111_secret_LEAKED' } },
      });
      jest.spyOn(DefaultPaymentService.prototype, 'updatePayment').mockImplementation(() => {
        throw stripeishError;
      });

      await expect(stripePaymentService.processStripeEventRefundFailed(mockEvent__refund_failed)).rejects.toThrow();

      const logged = JSON.stringify((Logger.log.error as unknown as jest.Mock).mock.calls);
      expect(logged).not.toContain('pi_bt_11111_secret_LEAKED');
      // The failure must stay diagnosable — this is the half a pure redaction assertion misses.
      expect(logged).toContain('Request failed');
      expect(logged).toContain('resource_missing');
      expect(logged).toContain('re_11111');
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
      (paymentSDK.ctCartService as any).isRecurringCart = jest.fn().mockReturnValue(false);
      const isRecurringCartMock = (paymentSDK.ctCartService as any).isRecurringCart as jest.Mock;
      const mockCreateCustomer = jest
        .spyOn(Stripe.prototype.customerSessions, 'create')
        .mockReturnValue(Promise.resolve(mockCreateSessionResult));

      const result = await stripePaymentService.createSession(mockStripeCustomerId, mockGetCartResult());

      expect(result).toStrictEqual(mockCreateSessionResult);
      expect(result).toBeDefined();
      expect(mockCreateCustomer).toHaveBeenCalled();
      expect(isRecurringCartMock).toHaveBeenCalled();
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
        list: jest
          .fn<() => Promise<Stripe.ApiList<Stripe.PaymentMethod>>>()
          .mockRejectedValue(new Error('Stripe API error')),
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
        checkoutUrl: '',
        paymentInterface: 'checkout-stripe',
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
          retrieve: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockRetrieveResult),
          capture: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockStripeCapturePaymentResult),
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
        checkoutUrl: '',
        paymentInterface: 'checkout-stripe',
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
          retrieve: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockRetrieveResult),
          capture: jest
            .fn<() => Promise<Stripe.Response<Stripe.PaymentIntent>>>()
            .mockResolvedValue(mockStripeCapturePaymentResult),
        },
      } as unknown as Stripe);

      const result = await paymentService.modifyPayment(modifyPaymentOpts);
      expect(result?.outcome).toStrictEqual('approved');
    });
  });

  describe('method refundPayment — metadata and idempotency (SB3-207 task 006)', () => {
    const paymentWith = (transactions: unknown[]) =>
      ({ ...mockGetPaymentResult, id: 'ct_payment_1', interfaceId: 'pi_11111', transactions }) as never;

    const refundTx = (interactionId: string) => ({ id: 't1', type: 'Refund', state: 'Success', interactionId });

    const arrangeRefund = () => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeEnableMultiOperations: true,
        stripeCaptureMethod: 'automatic',
        projectKey: 'test-project',
      } as never);
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
      return jest.spyOn(Stripe.prototype.refunds, 'create').mockResolvedValue(mockStripeCreateRefundResult as never);
    };

    test('stamps ct_payment_id and sends an entity-derived idempotency key', async () => {
      const createSpy = arrangeRefund();

      await stripePaymentService.refundPayment({
        payment: paymentWith([]),
        amount: { centAmount: 1000, currencyCode: 'USD' },
      });

      const [params, options] = createSpy.mock.calls[0];
      expect(params).toMatchObject({
        payment_intent: 'pi_11111',
        amount: 1000,
        metadata: { ct_payment_id: 'ct_payment_1' },
      });
      // No sequence component: any sequence derived from observed state increments once the first
      // refund succeeds, so a retry could never reproduce the key.
      expect(options).toEqual({ idempotencyKey: 'refund-ct_payment_1-1000' });
    });

    test('rejects and reports when Stripe replays an already-recorded refund', async () => {
      arrangeRefund();

      const result = await stripePaymentService.refundPayment({
        payment: paymentWith([refundTx('re_11111')]),
        amount: { centAmount: 1000, currencyCode: 'USD' },
      });

      expect(result.outcome).toBe('rejected');
      // pspReference carries the existing refund id ON PURPOSE — it is what lets the caller
      // reconcile and discover that the original refund may already exist.
      expect(result.pspReference).toBe('re_11111');

      const logged = JSON.stringify((Logger.log.error as jest.Mock).mock.calls);
      expect(logged).toContain('collapsed by idempotency');
      // The message must carry BOTH readings: a retry whose original refund did go out, and a
      // genuine second refund that did not happen.
      expect(logged).toContain('retry');
      expect(logged).toContain('24h key window');
    });

    // POSITIVE CASES — a detection that fired unconditionally would pass both tests above.
    test('a first refund is received normally', async () => {
      arrangeRefund();

      const result = await stripePaymentService.refundPayment({
        payment: paymentWith([]),
        amount: { centAmount: 1000, currencyCode: 'USD' },
      });

      expect(result.outcome).toBe('received');
      expect(result.pspReference).toBe('re_11111');
      expect(Logger.log.error).not.toHaveBeenCalled();
    });

    test('a second, genuinely different refund is received — not treated as a collapse', async () => {
      arrangeRefund();

      const result = await stripePaymentService.refundPayment({
        payment: paymentWith([refundTx('re_EARLIER')]),
        amount: { centAmount: 1000, currencyCode: 'USD' },
      });

      expect(result.outcome).toBe('received');
      expect(Logger.log.error).not.toHaveBeenCalled();
    });

    // With STRIPE_ENABLE_MULTI_OPERATIONS disabled the handler writes interactionId = the
    // PaymentIntent id, so no re_ value is recorded. Detection cannot fire — but it must fail in the
    // SAFE direction and never produce a false rejection.
    test('a PaymentIntent id recorded as interactionId never triggers a false rejection', async () => {
      arrangeRefund();

      const result = await stripePaymentService.refundPayment({
        payment: paymentWith([refundTx('pi_11111')]),
        amount: { centAmount: 1000, currencyCode: 'USD' },
      });

      expect(result.outcome).toBe('received');
    });

    // `transactions` explicitly removed, not merely left off the spread: mockGetPaymentResult
    // carries one, so a spread alone leaves the field defined and the test proves nothing.
    test('a payment with no transactions array does not throw', async () => {
      arrangeRefund();
      const payment = { ...mockGetPaymentResult, id: 'ct_payment_1', interfaceId: 'pi_11111' } as Record<
        string,
        unknown
      >;
      delete payment.transactions;

      const result = await stripePaymentService.refundPayment({
        payment: payment as never,
        amount: { centAmount: 1000, currencyCode: 'USD' },
      });

      expect(result.outcome).toBe('received');
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
        checkoutUrl: '',
        paymentInterface: 'checkout-stripe',
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

      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

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
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

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
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

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
      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockReturnValue(Promise.resolve(mockGetPaymentResult));

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
        checkoutUrl: '',
        paymentInterface: 'checkout-stripe',
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
        checkoutUrl: '',
        paymentInterface: 'checkout-stripe',
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
        checkoutUrl: '',
        paymentInterface: 'checkout-stripe',
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
        checkoutUrl: '',
        paymentInterface: 'checkout-stripe',
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
        checkoutUrl: '',
        paymentInterface: 'checkout-stripe',
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
        stripeSavedPaymentMethodConfig: {
          payment_method_save: 'disabled',
          payment_method_save_usage: 'on_session',
        } as PaymentFeatures,
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

  describe('method storePaymentMethod', () => {
    test('should skip storage when event has no payment method', async () => {
      // Given
      const mockEvent = {
        id: 'evt_test_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            payment_method: null,
            metadata: {
              ct_customer_id: 'customer_123',
            },
          },
        },
      } as unknown as Stripe.Event;

      // When
      await stripePaymentService.storePaymentMethod(mockEvent);

      // Then - should log skip message and not call any Stripe or CT methods
      expect(Logger.log.info).toHaveBeenCalledWith(
        'No payment method or customer ID found in event metadata, skipping storage.',
        expect.objectContaining({
          eventId: mockEvent.id,
        }),
      );
    });

    test('should skip storage when event has no commercetools customer', async () => {
      // Given
      const mockEvent = {
        id: 'evt_test_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            payment_method: 'pm_test_123',
            metadata: {
              ct_customer_id: null,
            },
          },
        },
      } as unknown as Stripe.Event;

      // When
      await stripePaymentService.storePaymentMethod(mockEvent);

      // Then - should log skip message and not call any Stripe or CT methods
      expect(Logger.log.info).toHaveBeenCalledWith(
        'No payment method or customer ID found in event metadata, skipping storage.',
        expect.objectContaining({
          eventId: mockEvent.id,
        }),
      );
    });

    test('should skip storage when Stripe payment method is not attached to a customer', async () => {
      // Given
      const mockEvent = {
        id: 'evt_test_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            payment_method: 'pm_test_123',
            metadata: {
              ct_customer_id: 'customer_123',
              ct_payment_id: 'payment_123',
            },
          },
        },
      } as unknown as Stripe.Event;

      const mockPaymentMethod = {
        id: 'pm_test_123',
        customer: null,
      } as Stripe.PaymentMethod;

      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentMethods: {
          retrieve: jest.fn<() => Promise<Stripe.PaymentMethod>>().mockResolvedValue(mockPaymentMethod),
        },
      } as unknown as Stripe);

      // When
      await stripePaymentService.storePaymentMethod(mockEvent);

      // Then
      expect(stripeApiMock).toHaveBeenCalled();
      expect(Logger.log.info).toHaveBeenCalledWith(
        'Stripe payment method not attached to a customer, skipping storage',
        expect.objectContaining({
          paymentMethodId: 'pm_test_123',
        }),
      );
    });

    test('should store new payment method successfully', async () => {
      // Given
      const mockEvent = {
        id: 'evt_test_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            payment_method: 'pm_test_123',
            metadata: {
              ct_customer_id: 'customer_123',
              ct_payment_id: 'payment_123',
            },
          },
        },
      } as unknown as Stripe.Event;

      const mockPaymentMethod = {
        id: 'pm_test_123',
        customer: 'cus_test_123',
        type: 'card',
      } as Stripe.PaymentMethod;

      const mockCtPaymentMethod = {
        id: 'ct_pm_123',
        version: 1,
      };

      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentMethods: {
          retrieve: jest.fn<() => Promise<Stripe.PaymentMethod>>().mockResolvedValue(mockPaymentMethod),
        },
      } as unknown as Stripe);

      const getByTokenValueMock = jest
        .spyOn(opts.ctPaymentMethodService, 'getByTokenValue')
        .mockRejectedValue(new ErrorResourceNotFound('customer_123'));

      const savePaymentMethodMock = jest
        .spyOn(opts.ctPaymentMethodService, 'save')
        .mockResolvedValue(mockCtPaymentMethod as any);

      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(mockGetPaymentResult);

      const createRecurringPaymentJobMock = jest
        .spyOn(opts.ctRecurringPaymentJobService, 'createRecurringPaymentJobIfApplicable')
        .mockResolvedValue(null);

      // When
      await stripePaymentService.storePaymentMethod(mockEvent);

      // Then
      expect(stripeApiMock).toHaveBeenCalled();
      expect(getByTokenValueMock).toHaveBeenCalledWith({
        customerId: 'customer_123',
        paymentInterface: expect.any(String),
        tokenValue: 'pm_test_123',
      });
      expect(savePaymentMethodMock).toHaveBeenCalledWith({
        customerId: 'customer_123',
        paymentInterface: expect.any(String),
        token: 'pm_test_123',
        method: 'card',
      });
      expect(updatePaymentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'payment_123',
          paymentMethodInfo: {
            token: {
              value: 'pm_test_123',
            },
          },
        }),
      );
      expect(createRecurringPaymentJobMock).toHaveBeenCalledWith({
        originPayment: {
          id: 'payment_123',
          typeId: 'payment',
        },
        paymentMethod: {
          id: 'ct_pm_123',
          typeId: 'payment-method',
        },
      });
    });

    test('should skip saving when payment method already exists', async () => {
      // Given
      const mockEvent = {
        id: 'evt_test_123',
        type: 'charge.succeeded',
        data: {
          object: {
            payment_method: 'pm_test_123',
            metadata: {
              ct_customer_id: 'customer_123',
              ct_payment_id: 'payment_123',
            },
          },
        },
      } as unknown as Stripe.Event;

      const mockPaymentMethod = {
        id: 'pm_test_123',
        customer: 'cus_test_123',
        type: 'card',
      } as Stripe.PaymentMethod;

      const mockCtPaymentMethod = {
        id: 'ct_pm_existing_123',
        version: 1,
      };

      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentMethods: {
          retrieve: jest.fn<() => Promise<Stripe.PaymentMethod>>().mockResolvedValue(mockPaymentMethod),
        },
      } as unknown as Stripe);

      const getByTokenValueMock = jest
        .spyOn(opts.ctPaymentMethodService, 'getByTokenValue')
        .mockResolvedValue(mockCtPaymentMethod as any);

      const savePaymentMethodMock = jest.spyOn(opts.ctPaymentMethodService, 'save');

      const updatePaymentMock = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue(mockGetPaymentResult);

      const createRecurringPaymentJobMock = jest
        .spyOn(opts.ctRecurringPaymentJobService, 'createRecurringPaymentJobIfApplicable')
        .mockResolvedValue(null);

      // When
      await stripePaymentService.storePaymentMethod(mockEvent);

      // Then
      expect(stripeApiMock).toHaveBeenCalled();
      expect(getByTokenValueMock).toHaveBeenCalled();
      expect(savePaymentMethodMock).not.toHaveBeenCalled();
      expect(updatePaymentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'payment_123',
          paymentMethodInfo: {
            token: {
              value: 'pm_test_123',
            },
          },
        }),
      );
      expect(createRecurringPaymentJobMock).toHaveBeenCalledWith({
        originPayment: {
          id: 'payment_123',
          typeId: 'payment',
        },
        paymentMethod: {
          id: 'ct_pm_existing_123',
          typeId: 'payment-method',
        },
      });
      expect(Logger.log.info).toHaveBeenCalledWith(
        'Payment method already stored for customer',
        expect.objectContaining({
          ctCustomerId: 'customer_123',
          stripePaymentMethod: 'pm_test_123',
        }),
      );
    });

    test('should store payment method without updating payment when ctPaymentId is not present', async () => {
      // Given
      const mockEvent = {
        id: 'evt_test_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            payment_method: 'pm_test_123',
            metadata: {
              ct_customer_id: 'customer_123',
            },
          },
        },
      } as unknown as Stripe.Event;

      const mockPaymentMethod = {
        id: 'pm_test_123',
        customer: 'cus_test_123',
        type: 'card',
      } as Stripe.PaymentMethod;

      const mockCtPaymentMethod = {
        id: 'ct_pm_123',
        version: 1,
      };

      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentMethods: {
          retrieve: jest.fn<() => Promise<Stripe.PaymentMethod>>().mockResolvedValue(mockPaymentMethod),
        },
      } as unknown as Stripe);

      const getByTokenValueMock = jest
        .spyOn(opts.ctPaymentMethodService, 'getByTokenValue')
        .mockRejectedValue(new ErrorResourceNotFound('customer_123'));

      const savePaymentMethodMock = jest
        .spyOn(opts.ctPaymentMethodService, 'save')
        .mockResolvedValue(mockCtPaymentMethod as any);

      const updatePaymentMock = jest.spyOn(DefaultPaymentService.prototype, 'updatePayment');

      const createRecurringPaymentJobMock = jest.spyOn(
        opts.ctRecurringPaymentJobService,
        'createRecurringPaymentJobIfApplicable',
      );

      // When
      await stripePaymentService.storePaymentMethod(mockEvent);

      // Then
      expect(stripeApiMock).toHaveBeenCalled();
      expect(getByTokenValueMock).toHaveBeenCalled();
      expect(savePaymentMethodMock).toHaveBeenCalled();
      expect(updatePaymentMock).not.toHaveBeenCalled();
      expect(createRecurringPaymentJobMock).not.toHaveBeenCalled();
    });

    test('should handle errors gracefully and log them', async () => {
      // Given
      const mockEvent = {
        id: 'evt_test_123',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            payment_method: 'pm_test_123',
            metadata: {
              ct_customer_id: 'customer_123',
              ct_payment_id: 'payment_123',
            },
          },
        },
      } as unknown as Stripe.Event;

      const error = new Error('Stripe API error');

      const stripeApiMock = jest.spyOn(StripeClient, 'stripeApi').mockReturnValue({
        paymentMethods: {
          retrieve: jest.fn<() => Promise<Stripe.PaymentMethod>>().mockRejectedValue(error),
        },
      } as unknown as Stripe);

      // When
      await stripePaymentService.storePaymentMethod(mockEvent);

      // Then
      expect(stripeApiMock).toHaveBeenCalled();
      expect(Logger.log.error).toHaveBeenCalledWith(
        'Error storing payment method in commercetools',
        expect.objectContaining({
          error,
          eventId: 'evt_test_123',
        }),
      );
    });
  });

  describe('initializeCartPayment — STRIPE_PAYMENT_BEHAVIOR_RULES', () => {
    test('no behavior config — uses flat env vars as-is', async () => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeCaptureMethod: 'automatic',
        stripeCollectBillingAddress: 'auto',
        stripePaymentFlow: 'deferred',
        stripePaymentBehaviorRules: undefined,
        stripePaymentIntentSetupFutureUsage: undefined,
        stripeSavedPaymentMethodConfig: {},
      } as never);
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithCountry('MX')));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(result.captureMethod).toBe('automatic');
      expect(result.collectBillingAddress).toBe('auto');
      expect(result.flowType).toBe('deferred');
    });

    test('cart.country match — captureMethod overridden by behavior rule', async () => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeCaptureMethod: 'automatic',
        stripeCollectBillingAddress: 'auto',
        stripePaymentFlow: 'deferred',
        stripePaymentBehaviorRules: { MX: { captureMethod: 'manual' } },
        stripePaymentIntentSetupFutureUsage: undefined,
        stripeSavedPaymentMethodConfig: {},
      } as never);
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithCountry('MX')));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(result.captureMethod).toBe('manual');
      // flat env vars still apply for unspecified fields
      expect(result.collectBillingAddress).toBe('auto');
      expect(result.flowType).toBe('deferred');
    });

    test('cart.country match — flowType overridden to pi_first suppresses setupFutureUsage', async () => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeCaptureMethod: 'automatic',
        stripeCollectBillingAddress: 'auto',
        stripePaymentFlow: 'deferred',
        stripePaymentBehaviorRules: { MX: { flowType: 'pi_first' } },
        stripePaymentIntentSetupFutureUsage: 'off_session',
        stripeSavedPaymentMethodConfig: {},
      } as never);
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithCountry('MX')));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      expect(result.flowType).toBe('pi_first');
      // pi_first suppresses setupFutureUsage regardless of behavior rule
      expect(result.setupFutureUsage).toBeUndefined();
    });

    test('no country match — flat env vars apply', async () => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeCaptureMethod: 'automatic',
        stripeCollectBillingAddress: 'auto',
        stripePaymentFlow: 'deferred',
        stripePaymentBehaviorRules: { MX: { captureMethod: 'manual' } },
        stripePaymentIntentSetupFutureUsage: undefined,
        stripeSavedPaymentMethodConfig: {},
      } as never);
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithCountry('DE')));
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);

      const result = await stripePaymentService.initializeCartPayment('payment');

      // DE is not in the config — flat env vars apply
      expect(result.captureMethod).toBe('automatic');
    });
  });

  describe('createPaymentIntentStripe — STRIPE_PAYMENT_BEHAVIOR_RULES', () => {
    test('no behavior config — flat env vars used for captureMethod and collectBillingAddress', async () => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeCaptureMethod: 'automatic',
        stripeCollectBillingAddress: 'auto',
        stripePaymentFlow: 'deferred',
        stripePaymentBehaviorRules: undefined,
        stripePaymentIntentSetupFutureUsage: undefined,
        stripeSavedPaymentMethodConfig: {},
        projectKey: 'test-project',
        stripeEnableMultiOperations: false,
        merchantReturnUrl: '',
        paymentInterface: 'checkout-stripe',
      } as never);
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithCountry('MX')));
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue(undefined);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);
      const createSpy = jest
        .spyOn(Stripe.prototype.paymentIntents, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreatePaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(mockGetCartResult());
      jest
        .spyOn(Stripe.prototype.paymentIntents, 'update')
        .mockReturnValue(Promise.resolve(mockStripeUpdatePaymentResult));

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.capture_method).toBe('automatic');
      // collectBillingAddress = 'auto' means no billingAddress in response
    });

    test('cart.country match — captureMethod overridden by behavior rule', async () => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeCaptureMethod: 'automatic',
        stripeCollectBillingAddress: 'auto',
        stripePaymentFlow: 'deferred',
        stripePaymentBehaviorRules: { MX: { captureMethod: 'manual' } },
        stripePaymentIntentSetupFutureUsage: undefined,
        stripeSavedPaymentMethodConfig: {},
        projectKey: 'test-project',
        stripeEnableMultiOperations: false,
        merchantReturnUrl: '',
        paymentInterface: 'checkout-stripe',
      } as never);
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithCountry('MX')));
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue(undefined);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);
      const createSpy = jest
        .spyOn(Stripe.prototype.paymentIntents, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreatePaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(mockGetCartResult());
      jest
        .spyOn(Stripe.prototype.paymentIntents, 'update')
        .mockReturnValue(Promise.resolve(mockStripeUpdatePaymentResult));

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.capture_method).toBe('manual');
    });

    test('no country match — flat captureMethod applies', async () => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeCaptureMethod: 'automatic',
        stripeCollectBillingAddress: 'auto',
        stripePaymentFlow: 'deferred',
        stripePaymentBehaviorRules: { MX: { captureMethod: 'manual' } },
        stripePaymentIntentSetupFutureUsage: undefined,
        stripeSavedPaymentMethodConfig: {},
        projectKey: 'test-project',
        stripeEnableMultiOperations: false,
        merchantReturnUrl: '',
        paymentInterface: 'checkout-stripe',
      } as never);
      jest
        .spyOn(DefaultCartService.prototype, 'getCart')
        .mockReturnValue(Promise.resolve(mockGetCartWithCountry('DE')));
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue(undefined);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);
      const createSpy = jest
        .spyOn(Stripe.prototype.paymentIntents, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreatePaymentResult));
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(mockGetCartResult());
      jest
        .spyOn(Stripe.prototype.paymentIntents, 'update')
        .mockReturnValue(Promise.resolve(mockStripeUpdatePaymentResult));

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      // DE not in config — flat env var 'automatic' applies
      expect(createArgs.capture_method).toBe('automatic');
    });
  });

  /**
   * Bank transfer wiring — payment_method_options.customer_balance.
   *
   * WHAT THIS SUITE IS SHAPED TO CATCH, because the shape is not accidental. Task A shipped a
   * validation suite that asserted only what was REJECTED, and it could not detect OVER-rejection:
   * valid merchant values were being silently dropped and the connector fell through to the flat env
   * var, which can be the opposite of what the merchant configured. So every VALID path here gets a
   * positive case — both trusted discriminators, and every one of the four IBAN countries — not just
   * the guards.
   *
   * The two cases that matter most are 'billingAddress-only' and 'shippingAddress-only'. Those are
   * the shopper-supplied discriminators that resolveTrustedPaymentBehavior exists to ignore, and the
   * express enabler writes the shopper's own address to the cart. If someone widens
   * extractTrustedDiscriminator, those two must fail.
   */
  describe('createPaymentIntentStripe — bank transfer (customer_balance)', () => {
    const eur = { ...mockGetPaymentAmount, currencyCode: 'EUR' };
    const usd = { ...mockGetPaymentAmount, currencyCode: 'USD' };

    const expectedCustomerBalance = (country: string) => ({
      funding_type: 'bank_transfer',
      bank_transfer: { type: 'eu_bank_transfer', eu_bank_transfer: { country } },
    });

    const arrange = (args: {
      cart: ReturnType<typeof mockGetCartResult>;
      amount: typeof mockGetPaymentAmount;
      rules: Record<string, Record<string, string>> | undefined;
      multiOperations?: boolean;
      captureMethod?: string;
      setupFutureUsage?: string;
    }) => {
      jest.spyOn(ConfigModule, 'getConfig').mockReturnValue({
        stripeCaptureMethod: args.captureMethod ?? 'automatic',
        stripeCollectBillingAddress: 'auto',
        stripePaymentFlow: 'deferred',
        stripePaymentBehaviorRules: args.rules,
        stripePaymentIntentSetupFutureUsage: args.setupFutureUsage,
        stripeSavedPaymentMethodConfig: {},
        projectKey: 'test-project',
        stripeEnableMultiOperations: args.multiOperations ?? false,
        merchantReturnUrl: '',
        paymentInterface: 'checkout-stripe',
      } as never);
      jest.spyOn(DefaultCartService.prototype, 'getCart').mockReturnValue(Promise.resolve(args.cart));
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue(undefined);
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(args.amount);
      jest.spyOn(DefaultPaymentService.prototype, 'createPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(mockGetCartResult());
      jest
        .spyOn(Stripe.prototype.paymentIntents, 'update')
        .mockReturnValue(Promise.resolve(mockStripeUpdatePaymentResult));
      return jest
        .spyOn(Stripe.prototype.paymentIntents, 'create')
        .mockReturnValue(Promise.resolve(mockStripeCreatePaymentResult));
    };

    // ------------------------------------------------- rail suppression warning (task 014)

    describe('rail suppression warning', () => {
      const warned = () =>
        (Logger.log.warn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('suppress the rail'));

      test.each([
        ['setup_future_usage off_session', { setupFutureUsage: 'off_session' }, true, false],
        ['setup_future_usage on_session', { setupFutureUsage: 'on_session' }, true, false],
        ['capture_method manual', { captureMethod: 'manual' }, false, true],
      ])('warns when the rail is suppressed by %s', async (_label, override, bySfu, byCapture) => {
        arrange({
          cart: mockGetCartWithCountry('DE'),
          amount: eur,
          rules: { DE: { euBankTransferCountry: 'DE' } },
          ...override,
        });

        await stripePaymentService.createPaymentIntentStripe();

        const calls = warned();
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toMatchObject({
          suppressedBySetupFutureUsage: bySfu,
          suppressedByCaptureMethod: byCapture,
        });
      });

      // The market key must never reach this log: it can be resolved from the shopper's own
      // billing/shipping address, and the line already carries cartId.
      test('does not log the market key or the IBAN country', async () => {
        arrange({
          cart: mockGetCartWithCountry('DE'),
          amount: eur,
          rules: { DE: { euBankTransferCountry: 'NL' } },
          setupFutureUsage: 'off_session',
        });

        await stripePaymentService.createPaymentIntentStripe();

        const meta = warned()[0][1] as Record<string, unknown>;
        const serialised = JSON.stringify(meta);

        // The IBAN country AND the market key. The fixture splits them on purpose (key DE, IBAN NL)
        // so neither can pass by borrowing the other's absence. cartId is lowercase-hex, so an
        // uppercase two-letter code cannot collide with it.
        expect(serialised).not.toContain('NL');
        expect(serialised).not.toContain('DE');

        // Exact key set, not just today's values: this is what catches a future field added to the
        // meta object that happens to carry shopper-derived data.
        expect(Object.keys(meta).sort()).toEqual([
          'cartId',
          'suppressedByCaptureMethod',
          'suppressedBySetupFutureUsage',
        ]);
      });

      // POSITIVE CASES — a warning that fires unconditionally would pass every assertion above.
      test.each([
        ['the configuration is healthy', { rules: { DE: { euBankTransferCountry: 'DE' } }, amount: eur }],
        [
          'automatic_async capture, measured not to suppress',
          { rules: { DE: { euBankTransferCountry: 'DE' } }, amount: eur, captureMethod: 'automatic_async' },
        ],
        [
          'no euBankTransferCountry — the rail was never requested',
          { rules: { DE: { captureMethod: 'manual' } }, amount: eur, setupFutureUsage: 'off_session' },
        ],
        ['no behavior rules at all', { rules: undefined, amount: eur, setupFutureUsage: 'off_session' }],
        [
          'a non-EUR cart, which never had the rail',
          { rules: { DE: { euBankTransferCountry: 'DE' } }, amount: usd, setupFutureUsage: 'off_session' },
        ],
      ])('stays silent when %s', async (_label, override) => {
        arrange({ cart: mockGetCartWithCountry('DE'), ...(override as never) });

        await stripePaymentService.createPaymentIntentStripe();

        expect(warned()).toHaveLength(0);
      });
    });

    // ---------------------------------------------------------------- positive cases

    // Every IBAN country, not just one. A membership list that has silently lost a member still
    // compiles and still passes a single-value test — that is exactly how the Task A regression got in.
    test.each(EU_BANK_TRANSFER_COUNTRIES)(
      'EUR cart matching on cart.country sends customer_balance for IBAN country %s',
      async (ibanCountry) => {
        const createSpy = arrange({
          cart: mockGetCartWithCountry('DE'),
          amount: eur,
          rules: { DE: { euBankTransferCountry: ibanCountry } },
        });

        await stripePaymentService.createPaymentIntentStripe();

        const createArgs = createSpy.mock.calls[0][0];
        expect(createArgs.payment_method_options?.customer_balance).toEqual(expectedCustomerBalance(ibanCountry));
      },
    );

    test('EUR cart matching on cart.store.key sends customer_balance', async () => {
      // The second trusted discriminator. Without this case the store-key branch of
      // extractTrustedDiscriminator could be dead and nothing would say so.
      const createSpy = arrange({
        cart: mockGetCartWithStoreKey('store-de'),
        amount: eur,
        rules: { 'store-de': { euBankTransferCountry: 'FR' } },
      });

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.payment_method_options?.customer_balance).toEqual(expectedCustomerBalance('FR'));
    });

    test('store-key rule shadowed by a shopper address on the untrusted path still sends customer_balance', async () => {
      // THE TWO RESOLVERS DIVERGE IN BOTH DIRECTIONS, which is easy to get wrong: their fallback
      // orders differ rather than nest. extractDiscriminator tries billing/shipping BEFORE store.key;
      // extractTrustedDiscriminator skips straight to store.key. So here the untrusted resolver
      // matches on 'US', finds no rule and returns undefined, while the TRUSTED one finds the
      // merchant's store rule.
      //
      // This pins the `if (behaviorRule || trustedBehaviorRule)` guard, which is load-bearing and not
      // defensive: with the narrower `if (behaviorRule)` the log would go silent on exactly this cart.
      // It is also the normal state under express checkout for any merchant using store-key rules,
      // since the express enabler writes the shopper's address to the cart.
      const cart = { ...mockGetCartWithStoreKey('store-de'), shippingAddress: { country: 'US' } };
      const createSpy = arrange({
        cart,
        amount: eur,
        rules: { 'store-de': { euBankTransferCountry: 'IE' } },
      });

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.payment_method_options?.customer_balance).toEqual(expectedCustomerBalance('IE'));

      const infoCall = (Logger.log.info as jest.Mock).mock.calls.find(
        (call) => call[0] === 'Resolved per-cart payment behavior rule.',
      );
      expect(infoCall).toBeDefined();
      const payload = infoCall![1] as Record<string, unknown>;
      // Nothing was refused — the trusted path found MORE than the untrusted one. A symmetric
      // divergence flag would read true here and be permanently true for this merchant.
      // Nothing was steered — the trusted path found MORE than the untrusted one. A symmetric
      // divergence signal would be non-empty here and permanently non-empty for this merchant.
      expect(payload.steeredFields).toEqual([]);
    });

    test('customer_balance is added alongside card options, never instead of them', async () => {
      // Regression guard for the spread. customer_balance is written as a sibling key; a refactor
      // that replaced the whole payment_method_options object would pass every other test here.
      const createSpy = arrange({
        cart: mockGetCartWithCountry('DE'),
        amount: eur,
        rules: { DE: { euBankTransferCountry: 'NL' } },
        multiOperations: true,
      });

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.payment_method_options?.card?.request_multicapture).toBe('if_available');
      expect(createArgs.payment_method_options?.customer_balance).toEqual(expectedCustomerBalance('NL'));
    });

    test('customer_balance is sent on the with-customer path, alongside the customer binding', async () => {
      // Every other case here mocks getCtCustomer -> undefined, so no Stripe customer is bound. That
      // matters more than it looks: measured 2026-08-07, Stripe DISCARDS customer_balance on a PI with
      // no customer, so without this case the suite would only ever assert the shape of a payload
      // production ignores. This is the configuration a real EUR checkout actually sends.
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue({
        ...mockCtCustomerData,
      } as never);
      const createSpy = arrange({
        cart: mockGetCartWithCountry('DE'),
        amount: eur,
        rules: { DE: { euBankTransferCountry: 'DE' } },
      });
      // arrange() re-stubs getCtCustomer to undefined, so re-apply after it.
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue({
        ...mockCtCustomerData,
      } as never);

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.customer).toBeDefined();
      expect(createArgs.payment_method_options?.customer_balance).toEqual(expectedCustomerBalance('DE'));
    });

    // ---------------------------------------------------------------- trust boundary

    test('billingAddress-only country match does NOT send customer_balance', async () => {
      // The untrusted resolver WOULD match this rule. The trusted one must not: billingAddress is
      // shopper-supplied, and euBankTransferCountry decides which of the merchant's IBANs is shown.
      const createSpy = arrange({
        cart: mockGetCartWithBillingCountryOnly('DE'),
        amount: eur,
        rules: { DE: { euBankTransferCountry: 'DE' } },
      });

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.payment_method_options?.customer_balance).toBeUndefined();
    });

    test('shippingAddress-only country match does NOT send customer_balance', async () => {
      // Same boundary, via the path that is shopper-controlled INSIDE this connector: the express
      // enabler writes the shopper's own address to the cart (dropin-express handleShippingAddressChange).
      const createSpy = arrange({
        cart: mockGetCartWithShippingCountryOnly('ES'),
        amount: eur,
        rules: { ES: { euBankTransferCountry: 'FR' } },
      });

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.payment_method_options?.customer_balance).toBeUndefined();
    });

    // ---------------------------------------------------------------- guards

    test('USD cart with a configured IBAN country sends no customer_balance', async () => {
      // euBankTransferCountry is meaningless outside EUR — Stripe derives us_bank_transfer from the
      // currency. Sending eu_bank_transfer here would be a 400.
      const createSpy = arrange({
        cart: mockGetCartWithCountry('DE'),
        amount: usd,
        rules: { DE: { euBankTransferCountry: 'DE' } },
      });

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.payment_method_options?.customer_balance).toBeUndefined();
      expect(createArgs.payment_method_options?.card).toBeDefined();
    });

    test('EUR cart with no behavior rules configured sends no customer_balance', async () => {
      const createSpy = arrange({ cart: mockGetCartWithCountry('DE'), amount: eur, rules: undefined });

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.payment_method_options?.customer_balance).toBeUndefined();
    });

    test('EUR cart whose matching rule has no euBankTransferCountry sends no customer_balance', async () => {
      // Absent is the normal case, not a broken one: Stripe resolves eu_bank_transfer from the
      // currency on its own and defaults to an Irish IBAN.
      const createSpy = arrange({
        cart: mockGetCartWithCountry('DE'),
        amount: eur,
        rules: { DE: { captureMethod: 'manual' } },
      });

      await stripePaymentService.createPaymentIntentStripe();

      const createArgs = createSpy.mock.calls[0][0];
      expect(createArgs.payment_method_options?.customer_balance).toBeUndefined();
    });

    // ---------------------------------------------------------------- observability

    test('divergence is logged as field NAMES, and no shopper-derived country reaches the log', async () => {
      // This log is the diagnostic that separates "the merchant keyed a rule under something carts do
      // not carry" from "someone is steering the discriminator". Untested logging rots, and the
      // privacy constraint below is invisible unless it is pinned.
      arrange({
        cart: mockGetCartWithShippingCountryOnly('ES'),
        amount: eur,
        rules: { ES: { euBankTransferCountry: 'FR', captureMethod: 'manual' } },
      });

      await stripePaymentService.createPaymentIntentStripe();

      const infoCall = (Logger.log.info as jest.Mock).mock.calls.find(
        (call) => call[0] === 'Resolved per-cart payment behavior rule.',
      );
      expect(infoCall).toBeDefined();

      const payload = infoCall![1] as Record<string, unknown>;
      // Covers more than one field now: before 2026-08-13 only euBankTransferCountry resolved through
      // the trusted path, so only it could ever be reported as refused.
      expect((payload.steeredFields as string[]).sort()).toEqual(['captureMethod', 'euBankTransferCountry']);
      expect(payload.trustedEuBankTransferCountry).toBeUndefined();

      // 'ES' is the shopper's own shipping country — the DISCRIMINATOR, not the IBAN country. It must
      // never appear next to cartId, which resolves to an identified customer. 'ES' is deliberately
      // not one of DE/FR/IE/NL, so this assertion cannot be satisfied by coincidence.
      expect(JSON.stringify(payload)).not.toContain('ES');
      // And no VALUES from the rule either — 'manual' and 'FR' were steered, so neither is ours to log.
      expect(JSON.stringify(payload)).not.toContain('manual');
    });

    test('logs the rule as field NAMES, never as the rule object', async () => {
      // Closes 2026-08-07-013. A whole-object spread logs every field LATER added to
      // PaymentBehaviorRule without anyone deciding it should be logged; names cannot leak a value
      // that does not exist yet. Found by a mutation probe: replacing `Object.keys(rule)` with `rule`
      // passed the entire suite, because the only test that inspected this payload used a cart whose
      // rule was steered away — so the field was undefined either way and asserted nothing.
      //
      // Hence a cart the trusted path DOES honour: cart.country is merchant-controlled.
      arrange({
        cart: mockGetCartWithCountry('DE'),
        amount: eur,
        rules: { DE: { euBankTransferCountry: 'NL', captureMethod: 'manual' } },
      });

      await stripePaymentService.createPaymentIntentStripe();

      const payload = (Logger.log.info as jest.Mock).mock.calls.find(
        (call) => call[0] === 'Resolved per-cart payment behavior rule.',
      )![1] as Record<string, unknown>;

      expect((payload.ruleFields as string[]).sort()).toEqual(['captureMethod', 'euBankTransferCountry']);
      // The rule WAS honoured here, so 'manual' is a real value in it — and still must not be logged.
      expect(JSON.stringify(payload.ruleFields)).not.toContain('manual');
      // euBankTransferCountry is the one value deliberately logged, under its own explicit key.
      expect(payload.trustedEuBankTransferCountry).toBe('NL');
    });

    // ---------------------------------------------------------------- the A/B invariant

    /**
     * THE MOST IMPORTANT TEST IN THIS FILE, and the one most likely to be broken by a future change
     * that looks harmless. createPaymentIntentStripe builds the PaymentIntent; initializeCartPayment
     * tells the enabler how to construct the element. Stripe validates the deferred element options
     * against the retrieved intent at confirm, so if the two sites ever resolve a rule differently the
     * confirm is rejected for EVERY cart in that market — a checkout outage, not a cosmetic mismatch.
     * For collectBillingAddress the breakage is directional: an element told to hide the address
     * fields while the processor sends no billing_details is rejected, whereas the inverse is benign.
     *
     * If this fails, one of the two sites has drifted to a different resolver. Fix the site; do not
     * relax the assertion.
     */
    test('both call sites honour the SAME rule for the same cart, across every field — do not weaken this', async () => {
      // A REVIEW FOUND THE FIRST VERSION OF THIS TEST PASSED FOR THE WRONG REASON. It used a cart whose
      // rule was steered away, so both sites returned the env default and every assertion was
      // `toBe('automatic')` — it would have passed just as well if both sites had hardcoded the
      // default and ignored rules entirely, and it only ever looked at captureMethod. Five separate
      // mutations that made one site stop reading a rule field survived it.
      //
      // So: a cart the trusted path DOES honour (cart.country is merchant-controlled), a rule that
      // sets every field to a NON-DEFAULT value, and an assertion on all of them at both sites. Now
      // the values must be equal AND must differ from the env defaults, which is what makes "the two
      // sites agree" mean something.
      const rules = {
        DE: {
          captureMethod: 'manual' as const,
          collectBillingAddress: 'never' as const,
          flowType: 'pi_first' as const,
          // Present so the pi_first assertion below can DISCRIMINATE. Without it the field would be
          // absent whether or not flowType was read, and a mutation making site A ignore flowType
          // survived exactly that way.
          setupFutureUsage: 'off_session' as const,
        },
      };
      arrange({ cart: mockGetCartWithCountry('DE'), amount: eur, rules });
      // A customer must be bound, or setup_future_usage would be absent for an unrelated reason and
      // the pi_first assertion below would pass without pi_first having been read at all.
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue({ ...mockCtCustomerData } as never);

      const result = await stripePaymentService.createPaymentIntentStripe();
      const createArgs = (Stripe.prototype.paymentIntents.create as jest.Mock).mock.calls[0][0] as never as {
        capture_method: string;
        setup_future_usage?: string;
      };
      const configResult = await stripePaymentService.initializeCartPayment('payment');

      // captureMethod — non-default, so the rule was genuinely honoured rather than coincidentally
      // matching the env. Asserted at BOTH sites.
      expect(createArgs.capture_method).toBe('manual');
      expect(configResult.captureMethod).toBe('manual');

      // collectBillingAddress: 'never' is non-default ('auto'), and this is the field whose A/B
      // mismatch is DIRECTIONAL — an element told to hide the address fields while the processor sends
      // no billing_details is rejected by Stripe for every cart in the market. Site A's observable
      // effect is that the response carries a server-derived billingAddress at all.
      expect(result).toHaveProperty('billingAddress');
      expect(configResult.collectBillingAddress).toBe('never');

      // flowType 'pi_first' is non-default ('deferred'). At site B it appears directly; at site A its
      // effect is applyPiFirstOverride stripping setup_future_usage from a PaymentIntent that has a
      // customer bound and would otherwise have carried it.
      expect(createArgs.setup_future_usage).toBeUndefined();
      expect(configResult.flowType).toBe('pi_first');
    });

    test('neither call site honours a rule reachable only through shopper-supplied data', async () => {
      // THE OTHER HALF OF THE INVARIANT, and the two halves cannot be one test.
      //
      // The test above uses a cart WITH cart.country, which is what lets it prove every field is
      // actually wired to the rule — but on such a cart the trusted and untrusted resolvers agree, so
      // it cannot detect a site that switched back to the untrusted one. This one uses a cart they
      // DISAGREE about, which detects exactly that and nothing else. A probe that made site B resolve
      // through the untrusted helper passed the whole suite until this existed.
      const rules = { DE: { captureMethod: 'manual' as const, collectBillingAddress: 'never' as const } };
      arrange({ cart: mockGetCartWithBillingCountryOnly('DE'), amount: eur, rules });

      await stripePaymentService.createPaymentIntentStripe();
      const createArgs = (Stripe.prototype.paymentIntents.create as jest.Mock).mock.calls[0][0] as never as {
        capture_method: string;
      };
      const configResult = await stripePaymentService.initializeCartPayment('payment');

      // Both fall back to the flat env defaults — the shopper's billing country selected nothing.
      expect(createArgs.capture_method).toBe('automatic');
      expect(configResult.captureMethod).toBe('automatic');
      expect(configResult.collectBillingAddress).toBe('auto');
    });

    test('both call sites honour the rule setupFutureUsage when flowType does not strip it', async () => {
      // Separate from the test above because pi_first deliberately discards setup_future_usage, so
      // that cart cannot also prove this field is wired. Two mutations — one per site — survived
      // until this existed.
      arrange({
        cart: mockGetCartWithCountry('DE'),
        amount: eur,
        rules: { DE: { setupFutureUsage: 'off_session' } },
      });
      jest.spyOn(StripePaymentService.prototype, 'getCtCustomer').mockResolvedValue({ ...mockCtCustomerData } as never);

      await stripePaymentService.createPaymentIntentStripe();
      const createArgs = (Stripe.prototype.paymentIntents.create as jest.Mock).mock.calls[0][0] as never as {
        setup_future_usage?: string;
      };
      const configResult = await stripePaymentService.initializeCartPayment('payment');

      expect(createArgs.setup_future_usage).toBe('off_session');
      expect(configResult.setupFutureUsage).toBe('off_session');
    });
  });

  describe('error logging never leaks the Stripe error object', () => {
    // One probe per site. Reverting any of these to `{ error: e }` must turn a test red.
    test.each([['processStripeEvent'], ['processStripeEventRefunded'], ['processStripeEventMultipleCaptured']])(
      '%s logs scalars only, never the error object',
      async (method) => {
        const mockEvent: Stripe.Event = mockEvent__charge_updated_multicapture;
        jest.spyOn(StripeEventConverter.prototype, 'convert').mockImplementation(() => {
          throw makeLeakyStripeError('Conversion error');
        });

        await (stripePaymentService as unknown as Record<string, (e: Stripe.Event) => Promise<void>>)[method](
          mockEvent,
        );

        const text = loggedText(Logger.log.error);
        expectNoSecrets(text);

        // Not merely redacted — strictly more diagnostic than before. The old call logged neither
        // the message (non-enumerable on Error) nor any event identity at all.
        expect(text).toContain('Conversion error');
        expect(text).toContain('StripeInvalidRequestError');
        expect(text).toContain('resource_missing');
        expect(text).toContain(mockEvent.id);
        expect(text).toContain(mockEvent.type);
      },
    );

    // Covers the fallback arm of `err.type ?? err.name` and `err.statusCode ?? err.httpErrorStatus`.
    // This is not a hypothetical shape: wrapStripeError returns the original error untouched when
    // it has no `.raw` (clients/stripe.client.ts:19-27), so a plain Error reaches these catches —
    // it is exactly what the converter throws for an unsupported event type.
    test('falls back to err.name when a plain Error reaches the catch', async () => {
      const mockEvent: Stripe.Event = mockEvent__charge_updated_multicapture;
      jest.spyOn(StripeEventConverter.prototype, 'convert').mockImplementation(() => {
        throw new Error('Unsupported event account.application.deauthorized');
      });

      await stripePaymentService.processStripeEvent(mockEvent);

      const text = loggedText(Logger.log.error);
      expect(text).toContain('Unsupported event account.application.deauthorized');
      expect(text).toContain('Error');
      expect(text).toContain(mockEvent.id);
    });
  });

  // =========================================================================
  // reflectOrderPaymentStateBestEffort — Order.paymentState (task 028, ADR-009)
  //
  // The SECOND state axis. commercetools Checkout creates the order without a paymentState and
  // never revisits it; commercetools never derives that field from Payment transactions. These
  // tests cover the three things that can silently go wrong: writing when we should not (the
  // synchronous-card split), NOT writing when we should (the measured creation race), and
  // downgrading a settled order (redelivery / out-of-order events).
  // =========================================================================
  describe('method reflectOrderPaymentStateBestEffort', () => {
    const BT_PAYMENT_ID = 'ct_payment_bt_11111';

    /**
     * Builds an event of `type` on a PaymentIntent that ACTUALLY CARRIES `metadata.ct_payment_id`.
     *
     * This helper is not convenience — it is a correctness fix. `mockEvent__paymentIntent_paymentFailed`
     * reuses `commonData`, whose `metadata` is `{}`, so every assertion made through it is satisfied by
     * the foreign-PaymentIntent skip long before the logic under test runs. Two tests here passed that
     * way before this helper existed: a downgrade guard that was never reached still reports "does not
     * downgrade". A probe that cannot fail is not a measurement.
     */
    const asEvent = (type: string, paymentIntentOverrides: Record<string, unknown> = {}): Stripe.Event =>
      ({
        ...mockEvent__paymentIntent_requiresAction_bankTransfer,
        type,
        data: {
          object: {
            ...(mockEvent__paymentIntent_requiresAction_bankTransfer.data.object as Record<string, unknown>),
            ...paymentIntentOverrides,
          },
        },
      }) as unknown as Stripe.Event;

    // Guards the helper itself, and by extension every test built on it. If the stamp ever goes
    // missing the suite must say so here rather than silently going vacuous everywhere else.
    test('fixture sanity: the events under test carry a commercetools payment id', () => {
      for (const type of ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled']) {
        const pi = asEvent(type).data.object as Stripe.PaymentIntent;
        expect(pi.metadata?.ct_payment_id).toBe(BT_PAYMENT_ID);
      }
      // And the shared fixture that does NOT — the reason this helper exists.
      expect(
        (mockEvent__paymentIntent_paymentFailed.data.object as Stripe.PaymentIntent).metadata?.ct_payment_id,
      ).toBeUndefined();
    });

    const anOrder = (paymentState?: string, overrides: Record<string, unknown> = {}) =>
      ({ id: 'order_11111', version: 7, paymentState, ...overrides }) as unknown as Order;

    /** Mocks the raw ctAPI orders() write chain and returns the spy on `.post`. */
    const arrangeOrderWrite = (postImpl?: () => Promise<unknown>) => {
      const execute = jest.fn(postImpl ?? (() => Promise.resolve({ body: {}, statusCode: 200 })));
      const post = jest.fn(() => ({ execute }));
      const client = paymentSDK.ctAPI.client;
      client.orders = jest.fn(() => ({ withId: jest.fn(() => ({ post })) })) as never;
      return post;
    };

    /** Removes the real 500ms/1500ms waits — the schedule is asserted separately. */
    const stubDelay = () =>
      jest
        .spyOn(stripePaymentService as unknown as { delay: (ms: number) => Promise<void> }, 'delay')
        .mockResolvedValue(undefined);

    test('writes Pending on an unset order when bank transfer instructions are issued', async () => {
      stubDelay();
      jest.spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId').mockResolvedValue(anOrder(undefined));
      const post = arrangeOrderWrite();

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_requiresAction_bankTransfer,
      );

      expect(post).toHaveBeenCalledWith({
        body: { version: 7, actions: [{ action: 'changePaymentState', paymentState: OrderPaymentState.PENDING }] },
      });
    });

    // ***** RELEASE GATE *****
    // The synchronous split decided on 2026-08-18: a card that settles inline is the site's/
    // merchant's to finalize. Here the order is unset AND the payment has no Authorization/Pending,
    // which is exactly what a plain card payment looks like. If this ever writes, the connector
    // starts claiming order state it agreed not to own.
    test('RELEASE GATE: does NOT write on succeeded for a synchronous card payment', async () => {
      jest.spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId').mockResolvedValue(anOrder(undefined));
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(false);
      const post = arrangeOrderWrite();

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
      );

      expect(post).not.toHaveBeenCalled();
    });

    // ***** MIRROR ASSERTION *****
    // The gate above passes just as happily if the method never writes anything at all. This is the
    // assertion that distinguishes "correctly abstains on card" from "is dead" — the -005/-012
    // lesson about gates written only in the negative.
    test('MIRROR: DOES write Paid on succeeded when the order is already Pending', async () => {
      const getPayment = jest.spyOn(DefaultPaymentService.prototype, 'getPayment');
      jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockResolvedValue(anOrder(OrderPaymentState.PENDING));
      const post = arrangeOrderWrite();

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
      );

      expect(post).toHaveBeenCalledWith({
        body: { version: 7, actions: [{ action: 'changePaymentState', paymentState: OrderPaymentState.PAID }] },
      });
      // Ownership was settled by the order's own state, so the payment lookup is not needed.
      expect(getPayment).not.toHaveBeenCalled();
    });

    // Race recovery. If the Pending write lost the creation race, the order is unset at settlement
    // and signal 1 is unavailable — the Authorization/Pending on the payment is the only thing left
    // saying "this was an async rail". Without this branch a lost Pending write would make the
    // settlement write get skipped too, turning a cosmetic miss into a permanent one.
    test('writes Paid on an unset order when the payment carries an Authorization/Pending', async () => {
      jest.spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId').mockResolvedValue(anOrder(undefined));
      jest.spyOn(DefaultPaymentService.prototype, 'getPayment').mockResolvedValue(mockGetPaymentResult);
      jest.spyOn(DefaultPaymentService.prototype, 'hasTransactionInState').mockReturnValue(true);
      const post = arrangeOrderWrite();

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
      );

      expect(post).toHaveBeenCalledTimes(1);
    });

    // ***** RELEASE GATE *****
    // Stripe redelivers for three days and emits payment_intent.payment_failed when a first card
    // attempt is declined before a later one succeeds on the same PaymentIntent. A Paid order must
    // never be marked Failed — the merchant would stop fulfilling an order that was actually paid.
    test('RELEASE GATE: never downgrades an already Paid order on payment_failed', async () => {
      jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockResolvedValue(anOrder(OrderPaymentState.PAID));
      const post = arrangeOrderWrite();

      await stripePaymentService.reflectOrderPaymentStateBestEffort(asEvent('payment_intent.payment_failed'));

      expect(post).not.toHaveBeenCalled();
    });

    test('writes Failed when a PaymentIntent is canceled on a Pending order', async () => {
      jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockResolvedValue(anOrder(OrderPaymentState.PENDING));
      const post = arrangeOrderWrite();

      await stripePaymentService.reflectOrderPaymentStateBestEffort(mockEvent__paymentIntent_canceled);

      expect(post).toHaveBeenCalledWith({
        body: { version: 7, actions: [{ action: 'changePaymentState', paymentState: OrderPaymentState.FAILED }] },
      });
    });

    // THE MEASURED RACE. commercetools Checkout created the order 883ms AFTER
    // payment_intent.requires_action fired (2026-08-18). The first lookup genuinely loses about half
    // the time, and losing it is not self-correcting: an abandoned transfer produces no further
    // event, so the order would stay unset forever.
    test('retries the order lookup for a Pending target and writes once the order appears', async () => {
      const delay = stubDelay();
      const lookup = jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockRejectedValueOnce(new Error('ErrorReferencedResourceNotFound'))
        .mockResolvedValueOnce(anOrder(undefined));
      const post = arrangeOrderWrite();

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_requiresAction_bankTransfer,
      );

      expect(lookup).toHaveBeenCalledTimes(2);
      expect(delay).toHaveBeenCalledWith(500);
      expect(post).toHaveBeenCalledTimes(1);
    });

    test('gives up after the full retry schedule and never throws', async () => {
      const delay = stubDelay();
      const lookup = jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockRejectedValue(new Error('ErrorReferencedResourceNotFound'));
      const post = arrangeOrderWrite();

      await expect(
        stripePaymentService.reflectOrderPaymentStateBestEffort(mockEvent__paymentIntent_requiresAction_bankTransfer),
      ).resolves.toBeUndefined();

      expect(lookup).toHaveBeenCalledTimes(5);
      expect(delay.mock.calls).toEqual([[500], [1500], [3000], [6000]]);
      expect(post).not.toHaveBeenCalled();
      // Exhausting a Pending write WARNS. It is the only signal that the schedule is too short for
      // the environment, and it was logged at info in the first version — which is exactly why the
      // 2026-08-18 23:12 miss (425ms short) was invisible until the order was inspected by hand.
      expect(Logger.log.warn).toHaveBeenCalledWith(
        'No commercetools order resolved for this payment — skipping the order paymentState write',
        expect.objectContaining({ targetPaymentState: OrderPaymentState.PENDING, attempts: 5 }),
      );
    });

    // A terminal event arrives minutes to days later; the order either exists or the payment never
    // completed through checkout. Waiting would add up to 2s of latency to EVERY settlement webhook
    // to fix nothing, and this route returns 200 only after processing completes.
    test('does NOT retry the lookup for a terminal target', async () => {
      const delay = stubDelay();
      const lookup = jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockRejectedValue(new Error('ErrorReferencedResourceNotFound'));

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
      );

      expect(lookup).toHaveBeenCalledTimes(1);
      expect(delay).not.toHaveBeenCalled();
      // ...and stays at info. A terminal target finding no order is unremarkable — the order may
      // never have been created at all. Only the Pending case is a silent degradation.
      expect(Logger.log.warn).not.toHaveBeenCalledWith(
        'No commercetools order resolved for this payment — skipping the order paymentState write',
        expect.anything(),
      );
    });

    test('re-fetches the fresh version and retries once on a 409 ConcurrentModification', async () => {
      const lookup = jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockResolvedValueOnce(anOrder(OrderPaymentState.PENDING))
        .mockResolvedValueOnce(anOrder(OrderPaymentState.PENDING, { version: 9 }));
      let call = 0;
      const post = arrangeOrderWrite(() => {
        call += 1;
        if (call === 1)
          return Promise.reject({ statusCode: 409, body: { errors: [{ code: 'ConcurrentModification' }] } });
        return Promise.resolve({ body: {}, statusCode: 200 });
      });

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
      );

      expect(lookup).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenNthCalledWith(2, {
        body: { version: 9, actions: [{ action: 'changePaymentState', paymentState: OrderPaymentState.PAID }] },
      });
    });

    // The subtle half of the 409 path: whoever won the race may have RESOLVED the order. Replaying
    // the original body against the fresh version would then downgrade it. Re-reading the version
    // without re-applying the transition guard is the quiet way to reintroduce the exact bug the
    // guard exists to prevent.
    test('re-applies the transition guard after a 409 and abandons if the winner already resolved it', async () => {
      jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockResolvedValueOnce(anOrder(OrderPaymentState.PENDING))
        .mockResolvedValueOnce(anOrder(OrderPaymentState.PAID, { version: 9 }));
      const post = arrangeOrderWrite(() =>
        Promise.reject({ statusCode: 409, body: { errors: [{ code: 'ConcurrentModification' }] } }),
      );

      await stripePaymentService.reflectOrderPaymentStateBestEffort(asEvent('payment_intent.payment_failed'));

      expect(post).toHaveBeenCalledTimes(1);
    });

    test('does not retry a non-409 write failure, and still never throws', async () => {
      jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockResolvedValue(anOrder(OrderPaymentState.PENDING));
      const post = arrangeOrderWrite(() => Promise.reject({ statusCode: 403, message: 'missing manage_orders' }));

      await expect(
        stripePaymentService.reflectOrderPaymentStateBestEffort(
          mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
        ),
      ).resolves.toBeUndefined();

      expect(post).toHaveBeenCalledTimes(1);
    });

    // Same reasoning as the guard in processStripeEvent: a PaymentIntent created outside this
    // connector has no stamp and no order of ours behind it.
    test('skips a foreign PaymentIntent without attempting a lookup', async () => {
      const lookup = jest.spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId');

      await stripePaymentService.reflectOrderPaymentStateBestEffort(mockEvent__paymentIntent_requiresAction_foreign);

      expect(lookup).not.toHaveBeenCalled();
    });

    test('no-ops entirely for an event outside the mapping', async () => {
      const lookup = jest.spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId');

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_partiallyFunded_bankTransfer,
      );

      expect(lookup).not.toHaveBeenCalled();
    });

    // 3DS reaches this method even though the route keeps it away from processStripeEvent — the two
    // gates are deliberately different. This is the positive half of that split; the route spec
    // asserts the negative half (no transaction written).
    test('writes Pending for a card 3DS requires_action — the order axis is not gated by method', async () => {
      stubDelay();
      jest.spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId').mockResolvedValue(anOrder(undefined));
      const post = arrangeOrderWrite();

      await stripePaymentService.reflectOrderPaymentStateBestEffort(mockEvent__paymentIntent_requiresAction_3ds);

      expect(post).toHaveBeenCalledWith({
        body: { version: 7, actions: [{ action: 'changePaymentState', paymentState: OrderPaymentState.PENDING }] },
      });
    });

    // Never hand a CT/Stripe error object to the logger: `body`, `raw`, `payment_intent` and
    // `headers` are own enumerable properties and winston serializes them, which would put the full
    // PaymentIntent — client_secret and financial_addresses included — into the log and defeat the
    // redaction choke point in StripeEventConverter through a different channel. This is the -017
    // defect; the mirror of it must not be reintroduced here.
    test('logs only scalars when the write fails — never the error object', async () => {
      jest
        .spyOn(DefaultOrderService.prototype, 'getOrderByPaymentId')
        .mockResolvedValue(anOrder(OrderPaymentState.PENDING));
      arrangeOrderWrite(() =>
        Promise.reject(
          Object.assign(new Error('boom'), {
            statusCode: 500,
            body: { secret: 'pi_bt_11111_secret', iban: 'DE89370400440532013000' },
          }),
        ),
      );

      await stripePaymentService.reflectOrderPaymentStateBestEffort(
        mockEvent__paymentIntent_succeeded_captureMethodAutomatic,
      );

      const warnCall = (Logger.log.warn as jest.Mock).mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('Could not reflect the payment outcome'),
      );
      expect(warnCall).toBeDefined();
      const payload = JSON.stringify(warnCall?.[1] ?? {});
      expect(payload).not.toContain('pi_bt_11111_secret');
      expect(payload).not.toContain('DE89370400440532013000');
      expect(warnCall?.[1]).toEqual(
        expect.objectContaining({ errorMessage: 'boom', errorStatus: 500, eventType: 'payment_intent.succeeded' }),
      );
    });
  });
  /**
   * resolvePaymentMethodType — the one Stripe read that fills the payment method for asynchronous
   * rails. Reached through the private name because it is an internal seam, not public API.
   *
   * The reason it exists at all: a PaymentIntent payload names its method only by id, so a bank
   * transfer sitting at Pending had NO method recorded in commercetools until the settling Charge
   * arrived days later — or never. Reported by Luis 2026-08-21 against a real Pending order.
   */
  describe('method resolvePaymentMethodType', () => {
    const piEvent = (paymentMethod: unknown): Stripe.Event =>
      ({
        type: 'payment_intent.requires_action',
        data: { object: { id: 'pi_res_1', payment_method: paymentMethod } },
      }) as unknown as Stripe.Event;

    const resolve = (event: Stripe.Event): Promise<string | undefined> =>
      (
        stripePaymentService as unknown as { resolvePaymentMethodType(e: Stripe.Event): Promise<string | undefined> }
      ).resolvePaymentMethodType(event);

    test('retrieves the PaymentMethod and returns its type', async () => {
      Stripe.prototype.paymentMethods = {
        retrieve: jest
          .fn<() => Promise<Stripe.PaymentMethod>>()
          .mockResolvedValue({ id: 'pm_1', type: 'customer_balance' } as unknown as Stripe.PaymentMethod),
      } as unknown as Stripe.PaymentMethodsResource;

      await expect(resolve(piEvent('pm_1'))).resolves.toBe('customer_balance');
    });

    // ***** MIRROR *****
    // The test above passes for a function that returns the bank-transfer string unconditionally.
    // This is what makes it generic across rails, which is the whole reason for choosing a retrieve
    // over reading next_action (which identifies bank transfer for free, and nothing else).
    test('MIRROR: returns whatever type Stripe reports, not a bank-transfer constant', async () => {
      Stripe.prototype.paymentMethods = {
        retrieve: jest
          .fn<() => Promise<Stripe.PaymentMethod>>()
          .mockResolvedValue({ id: 'pm_2', type: 'us_bank_account' } as unknown as Stripe.PaymentMethod),
      } as unknown as Stripe.PaymentMethodsResource;

      await expect(resolve(piEvent('pm_2'))).resolves.toBe('us_bank_account');
    });

    // ***** RELEASE GATE *****
    // This sits in a webhook handler that must return non-2xx when a commercetools update fails so
    // Stripe retries (KI-001). If a cosmetic lookup could throw, a missing label would become a
    // redelivery loop against an update that already succeeded.
    test('RELEASE GATE: never throws when the retrieve fails — resolves undefined', async () => {
      Stripe.prototype.paymentMethods = {
        retrieve: jest.fn<() => Promise<Stripe.PaymentMethod>>().mockRejectedValue(new Error('Stripe API error')),
      } as unknown as Stripe.PaymentMethodsResource;

      await expect(resolve(piEvent('pm_boom'))).resolves.toBeUndefined();
    });

    test('uses an already-expanded PaymentMethod without a second call', async () => {
      const retrieve = jest.fn<() => Promise<Stripe.PaymentMethod>>();
      Stripe.prototype.paymentMethods = { retrieve } as unknown as Stripe.PaymentMethodsResource;

      await expect(resolve(piEvent({ id: 'pm_3', type: 'sepa_debit' }))).resolves.toBe('sepa_debit');
      expect(retrieve).not.toHaveBeenCalled();
    });

    test.each([
      ['no payment_method at all', undefined],
      ['payment_method explicitly null', null],
    ])('%s resolves undefined without calling Stripe', async (_label, paymentMethod) => {
      const retrieve = jest.fn<() => Promise<Stripe.PaymentMethod>>();
      Stripe.prototype.paymentMethods = { retrieve } as unknown as Stripe.PaymentMethodsResource;

      await expect(resolve(piEvent(paymentMethod))).resolves.toBeUndefined();
      expect(retrieve).not.toHaveBeenCalled();
    });

    // A Charge carries the type in its own payload, so spending a Stripe call on it would be waste.
    test('a Charge event resolves undefined without calling Stripe', async () => {
      const retrieve = jest.fn<() => Promise<Stripe.PaymentMethod>>();
      Stripe.prototype.paymentMethods = { retrieve } as unknown as Stripe.PaymentMethodsResource;

      const chargeEvent = {
        type: 'charge.succeeded',
        data: { object: { id: 'ch_1', payment_method: 'pm_9' } },
      } as unknown as Stripe.Event;

      await expect(resolve(chargeEvent)).resolves.toBeUndefined();
      expect(retrieve).not.toHaveBeenCalled();
    });
  });

  describe('method handleTransaction (off-session recurring charge)', () => {
    const draft = {
      cartId: '11111111-1111-1111-1111-111111111111',
      checkoutTransactionItemId: '33333333-3333-3333-3333-333333333333',
      // Present but NOT the idempotency anchor — the anchor is checkoutTransactionItemId only.
      futureOrderNumber: 'order-42',
      // Platform sends the saved method NESTED (Option C accepts this + the flat alias).
      paymentMethod: { id: '22222222-2222-2222-2222-222222222222' },
      type: 'Recurring' as const,
    };

    // Wires every collaborator to the happy path; individual tests override what they exercise.
    const arrangeHappyPath = (overrides?: {
      createResolves?: unknown;
      createThrows?: unknown;
      existingPayments?: unknown[];
      stripePmCustomer?: string | null;
      hasFailure?: boolean;
      existingTransaction?: boolean;
    }) => {
      setupMockConfig({ paymentInterface: 'checkout-stripe', projectKey: 'test-project' });

      jest.spyOn(DefaultCartService.prototype, 'getCart').mockResolvedValue(mockGetCartResult());
      jest.spyOn(DefaultCartService.prototype, 'getPaymentAmount').mockResolvedValue(mockGetPaymentAmount);
      jest.spyOn(DefaultCartService.prototype, 'addPayment').mockResolvedValue(mockGetCartResult());

      // Dedupe now queries the unique CT Payment.key (raw where=key CT query). `existingPayments` remains an
      // array override for compatibility; the helper returns the single first match (or undefined).
      const dedupe = jest
        .spyOn(
          stripePaymentService as unknown as { findPaymentByKey: () => Promise<unknown> },
          'findPaymentByKey',
        )
        .mockResolvedValue((overrides?.existingPayments?.[0]) as never);
      const createPayment = jest
        .spyOn(DefaultPaymentService.prototype, 'createPayment')
        .mockResolvedValue({ id: 'ct-payment-1', transactions: [] } as never);
      const updatePayment = jest
        .spyOn(DefaultPaymentService.prototype, 'updatePayment')
        .mockResolvedValue({ id: 'ct-payment-1' } as never);
      jest
        .spyOn(DefaultPaymentService.prototype, 'hasTransactionInState')
        .mockReturnValue(Boolean(overrides?.hasFailure) || Boolean(overrides?.existingTransaction));

      const get = jest
        .spyOn(DefaultPaymentMethodService.prototype, 'get')
        .mockResolvedValue({ id: 'pm-ct-1', token: { value: 'pm_saved_1' } } as never);
      const find = jest
        .spyOn(DefaultPaymentMethodService.prototype, 'find')
        .mockResolvedValue({ results: [{ id: 'pm-ct-1', token: { value: 'pm_saved_1' } }] } as never);

      jest.spyOn(stripePaymentService, 'getCtCustomer').mockResolvedValue(mockCtCustomerData);
      jest.spyOn(stripePaymentService, 'retrieveOrCreateStripeCustomerId').mockResolvedValue(mockStripeCustomerId);

      const retrieve = jest.fn<() => Promise<Stripe.PaymentMethod>>().mockResolvedValue({
        id: 'pm_saved_1',
        customer: overrides?.stripePmCustomer === undefined ? mockStripeCustomerId : overrides.stripePmCustomer,
      } as unknown as Stripe.PaymentMethod);
      Stripe.prototype.paymentMethods = { retrieve } as unknown as Stripe.PaymentMethodsResource;

      const create = jest.fn<() => Promise<Stripe.PaymentIntent>>();
      if (overrides?.createThrows) {
        create.mockRejectedValue(overrides.createThrows);
      } else {
        create.mockResolvedValue(
          (overrides?.createResolves ?? { id: 'pi_1', status: 'succeeded' }) as unknown as Stripe.PaymentIntent,
        );
      }
      Stripe.prototype.paymentIntents = {
        create,
        update: jest.fn(),
        cancel: jest.fn(),
        capture: jest.fn(),
      } as unknown as Stripe.PaymentIntentsResource;

      return { create, retrieve, updatePayment, get, find, createPayment, dedupe };
    };

    test('succeeded PaymentIntent → Completed, books Charge/Success, resolves the nested paymentMethod.id, key anchored on checkoutTransactionItemId', async () => {
      const { create, updatePayment, get, createPayment } = arrangeHappyPath();

      const result = await stripePaymentService.handleTransaction(draft);

      expect(result.transactionStatus.state).toStrictEqual('Completed');
      expect(result.transactionStatus.errors).toStrictEqual([]);
      expect(result.paymentId).toStrictEqual('ct-payment-1');
      // metadata.ct_payment_id inline in create; off-session confirm params; installment-anchored key.
      const [params, options] = create.mock.calls[0] as [Stripe.PaymentIntentCreateParams, { idempotencyKey: string }];
      expect(params.off_session).toBe(true);
      expect(params.confirm).toBe(true);
      expect(params.capture_method).toStrictEqual('automatic');
      expect(params.automatic_payment_methods).toStrictEqual({ enabled: true, allow_redirects: 'never' });
      expect(params.metadata?.ct_payment_id).toStrictEqual('ct-payment-1');
      // Sole anchor: checkoutTransactionItemId (NOT futureOrderNumber, which is also present on the draft).
      expect(options.idempotencyKey).toStrictEqual('charge-33333333-3333-3333-3333-333333333333');
      // Nested paymentMethod.id resolved via ctPaymentMethodService.get (no find fallback).
      expect(get).toHaveBeenCalledWith(
        expect.objectContaining({ id: '22222222-2222-2222-2222-222222222222' }),
      );
      // Native SDK 1.2.x linkage (checkoutTransactionItemId) PLUS the unique dedupe handle (key), both set to
      // the installment id; interfaceId is NOT set here (stamped with the real PI id after the charge).
      expect(createPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          key: '33333333-3333-3333-3333-333333333333',
          checkoutTransactionItemId: '33333333-3333-3333-3333-333333333333',
        }),
      );
      expect(createPayment).toHaveBeenCalledWith(expect.not.objectContaining({ interfaceId: expect.anything() }));
      // Synchronous capture books Charge/Success so the order-subscriber recognizes it as Paid, and stamps
      // interfaceId with the REAL PaymentIntent id (pspReference), never the installment key.
      expect(updatePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          pspReference: 'pi_1',
          transaction: expect.objectContaining({ type: PaymentTransactions.CHARGE, state: PaymentStatus.SUCCESS }),
        }),
      );
    });

    test('processing PaymentIntent → Pending, books Authorization/Pending (async path unchanged)', async () => {
      const { updatePayment } = arrangeHappyPath({ createResolves: { id: 'pi_1', status: 'processing' } });
      const result = await stripePaymentService.handleTransaction(draft);
      expect(result.transactionStatus.state).toStrictEqual('Pending');
      expect(updatePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          pspReference: 'pi_1',
          transaction: expect.objectContaining({ type: PaymentTransactions.AUTHORIZATION, state: PaymentStatus.PENDING }),
        }),
      );
    });

    test('StripeCardError decline → 201-shaped Failed result, books Authorization/Failure once, never throws', async () => {
      const cardError = Object.assign(new Error('Your card was declined.'), {
        type: 'StripeCardError',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        raw: { payment_intent: { id: 'pi_declined' } },
      });
      const { updatePayment } = arrangeHappyPath({ createThrows: cardError });

      const result = await stripePaymentService.handleTransaction(draft);

      expect(result.transactionStatus.state).toStrictEqual('Failed');
      expect(result.transactionStatus.errors).toStrictEqual([{ code: 'PaymentRejected', message: 'card_declined' }]);
      expect(updatePayment).toHaveBeenCalledWith(
        expect.objectContaining({ transaction: expect.objectContaining({ state: PaymentStatus.FAILURE }) }),
      );
    });

    test('decline dedup guard: skips the Failure write when one already exists (webhook collision)', async () => {
      const cardError = Object.assign(new Error('declined'), { type: 'StripeCardError', code: 'card_declined' });
      const { updatePayment } = arrangeHappyPath({ createThrows: cardError, hasFailure: true });

      const result = await stripePaymentService.handleTransaction(draft);

      expect(result.transactionStatus.state).toStrictEqual('Failed');
      expect(updatePayment).not.toHaveBeenCalled();
    });

    test('IDOR guard: rejects when the Stripe payment method belongs to a different customer, no charge', async () => {
      const { create } = arrangeHappyPath({ stripePmCustomer: 'cus_someone_else' });

      await expect(stripePaymentService.handleTransaction(draft)).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    });

    test('installment dedupe: short-circuits when a payment already exists for the installment', async () => {
      const { create, dedupe } = arrangeHappyPath({
        existingPayments: [
          { id: 'ct-existing', transactions: [{ type: PaymentTransactions.CHARGE, state: 'Success' }] },
        ],
      });

      const result = await stripePaymentService.handleTransaction(draft);

      expect(result.paymentId).toStrictEqual('ct-existing');
      expect(result.transactionStatus.state).toStrictEqual('Completed');
      expect(create).not.toHaveBeenCalled();
      // Dedupe is keyed on the installment's unique CT Payment.key (= checkoutTransactionItemId), not interfaceId.
      expect(dedupe).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333');
    });

    test('fails closed when no installment identity is provided', async () => {
      arrangeHappyPath();
      await expect(
        stripePaymentService.handleTransaction({ cartId: draft.cartId, type: 'Recurring' } as never),
      ).rejects.toThrow();
    });

    test('rejects a currency mismatch between the requested amount and the cart', async () => {
      const { create } = arrangeHappyPath();
      await expect(
        stripePaymentService.handleTransaction({
          ...draft,
          amount: { centAmount: 100, currencyCode: 'EUR' },
        }),
      ).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    });

    test('ignores a caller-supplied idempotencyKey; the Stripe key stays installment-anchored', async () => {
      const { create } = arrangeHappyPath();
      await stripePaymentService.handleTransaction({ ...draft, idempotencyKey: 'attacker-supplied' });
      const [, options] = create.mock.calls[0] as [unknown, { idempotencyKey: string }];
      expect(options.idempotencyKey).toStrictEqual('charge-33333333-3333-3333-3333-333333333333');
    });

    test('returned requires_action status → Failed, routed through the dedup guard (skips write when already failed)', async () => {
      const { updatePayment } = arrangeHappyPath({
        createResolves: { id: 'pi_ra', status: 'requires_action' },
        hasFailure: true,
      });
      const result = await stripePaymentService.handleTransaction(draft);
      expect(result.transactionStatus.state).toStrictEqual('Failed');
      expect(updatePayment).not.toHaveBeenCalled();
    });

    test('reuses an installment payment stuck at Authorization/Initial and drives the charge (never re-creates → no under-charge, no DuplicateField)', async () => {
      const { create, createPayment } = arrangeHappyPath({
        existingPayments: [
          { id: 'ct-orphan', transactions: [{ type: PaymentTransactions.AUTHORIZATION, state: 'Initial' }] },
        ],
      });
      const result = await stripePaymentService.handleTransaction(draft);
      // Not short-circuited (Initial is unresolved) but NOT re-created either: under the unique key a fresh
      // create would DuplicateField. The stuck payment is reused and the charge is driven to completion.
      expect(createPayment).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(result.paymentId).toStrictEqual('ct-orphan');
      expect(result.transactionStatus.state).toStrictEqual('Completed');
    });

    test('concurrent duplicate-key create → returns the winner outcome idempotently, no 2nd Stripe charge', async () => {
      const { create, createPayment, dedupe } = arrangeHappyPath();
      // step 5 sees nothing; the concurrent winner surfaces only on the post-DuplicateField re-fetch.
      dedupe.mockReset();
      dedupe
        .mockResolvedValueOnce(undefined as never)
        .mockResolvedValueOnce({
          id: 'ct-winner',
          customer: { typeId: 'customer', id: mockCtCustomerId },
          transactions: [{ type: PaymentTransactions.CHARGE, state: 'Success' }],
        } as never);
      // CT's ts-client throws an Error carrying statusCode + body (mirror it, not a plain object).
      createPayment.mockRejectedValue(
        Object.assign(new Error('A duplicate value exists for field key.'), {
          statusCode: 400,
          body: { errors: [{ code: 'DuplicateField', field: 'key' }] },
        }) as never,
      );

      const result = await stripePaymentService.handleTransaction(draft);

      expect(result.paymentId).toStrictEqual('ct-winner');
      expect(result.transactionStatus.state).toStrictEqual('Completed');
      // The loser never charges — the winner owns the charge (and the shared Stripe idempotency key).
      expect(create).not.toHaveBeenCalled();
    });

    test('duplicate-key winner belonging to a different customer → rethrows, never returns another customer payment', async () => {
      const { createPayment, dedupe } = arrangeHappyPath();
      dedupe.mockReset();
      dedupe
        .mockResolvedValueOnce(undefined as never)
        .mockResolvedValueOnce({
          id: 'ct-other',
          customer: { typeId: 'customer', id: 'someone-else' },
          transactions: [{ type: PaymentTransactions.CHARGE, state: 'Success' }],
        } as never);
      createPayment.mockRejectedValue(
        Object.assign(new Error('A duplicate value exists for field key.'), {
          statusCode: 400,
          body: { errors: [{ code: 'DuplicateField', field: 'key' }] },
        }) as never,
      );

      await expect(stripePaymentService.handleTransaction(draft)).rejects.toThrow();
    });

    test('a non-duplicate CT create error is NOT masked as an installment race (rethrows)', async () => {
      const { createPayment } = arrangeHappyPath();
      createPayment.mockRejectedValue(
        Object.assign(new Error('InvalidField amountPlanned'), {
          statusCode: 400,
          body: { errors: [{ code: 'InvalidField', field: 'amountPlanned' }] },
        }) as never,
      );
      await expect(stripePaymentService.handleTransaction(draft)).rejects.toThrow();
    });

    test('accepts the flat paymentMethodId alias (reference-compatible shape)', async () => {
      const { get } = arrangeHappyPath();
      await stripePaymentService.handleTransaction({
        cartId: draft.cartId,
        checkoutTransactionItemId: draft.checkoutTransactionItemId,
        paymentMethodId: '22222222-2222-2222-2222-222222222222',
        type: 'Recurring',
      } as never);
      expect(get).toHaveBeenCalledWith(
        expect.objectContaining({ id: '22222222-2222-2222-2222-222222222222' }),
      );
    });

    test('fails closed when neither paymentMethod.id nor paymentMethodId is present, never falls back to find()', async () => {
      const { create, find } = arrangeHappyPath();
      await expect(
        stripePaymentService.handleTransaction({
          cartId: draft.cartId,
          checkoutTransactionItemId: draft.checkoutTransactionItemId,
          type: 'Recurring',
        } as never),
      ).rejects.toThrow();
      expect(find).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    test('sync-success Charge/Success dedup: skips the Charge write when one already exists (webhook collision)', async () => {
      const { updatePayment } = arrangeHappyPath({ existingTransaction: true });
      const result = await stripePaymentService.handleTransaction(draft);
      expect(result.transactionStatus.state).toStrictEqual('Completed');
      expect(updatePayment).not.toHaveBeenCalled();
    });

    test('fails closed when checkoutTransactionItemId is not a uuid (no CT query, no charge)', async () => {
      const { create, dedupe } = arrangeHappyPath();
      await expect(
        stripePaymentService.handleTransaction({ ...draft, checkoutTransactionItemId: 'not-a-uuid" or 1=1' }),
      ).rejects.toThrow();
      expect(dedupe).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    describe('findPaymentByKey (unique-key dedupe query)', () => {
      type ClientStub = { payments: () => { get: (args: unknown) => { execute: () => Promise<unknown> } } };
      type Svc = { findPaymentByKey: (id: string) => Promise<unknown> };
      const id = '33333333-3333-3333-3333-333333333333';

      test('issues the exact key predicate and returns the single match', async () => {
        const execute = jest.fn<() => Promise<unknown>>().mockResolvedValue({ body: { results: [{ id: 'ct-x' }] } });
        const get = jest.fn().mockReturnValue({ execute });
        const payments = jest.fn().mockReturnValue({ get });
        (paymentSDK.ctAPI.client as unknown as ClientStub).payments = payments as never;

        const res = await (stripePaymentService as unknown as Svc).findPaymentByKey(id);

        expect(get).toHaveBeenCalledWith({
          queryArgs: { where: `key="${id}"`, limit: 1 },
        });
        expect(res).toStrictEqual({ id: 'ct-x' });
      });

      test('returns undefined when no payment carries the key', async () => {
        const execute = jest.fn<() => Promise<unknown>>().mockResolvedValue({ body: { results: [] } });
        const get = jest.fn().mockReturnValue({ execute });
        const payments = jest.fn().mockReturnValue({ get });
        (paymentSDK.ctAPI.client as unknown as ClientStub).payments = payments as never;

        const res = await (stripePaymentService as unknown as Svc).findPaymentByKey(id);
        expect(res).toBeUndefined();
      });

      test('fails closed: a CT query error propagates (never a false-empty result)', async () => {
        const execute = jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('InvalidInput'));
        const get = jest.fn().mockReturnValue({ execute });
        const payments = jest.fn().mockReturnValue({ get });
        (paymentSDK.ctAPI.client as unknown as ClientStub).payments = payments as never;

        await expect((stripePaymentService as unknown as Svc).findPaymentByKey(id)).rejects.toThrow();
      });
    });
  });
});
