import { PaymentRequestSchemaDTO } from '../../dtos/stripe-payment.dto';
import {
  CommercetoolsCartService,
  CommercetoolsOrderService,
  CommercetoolsPaymentMethodService,
  CommercetoolsPaymentService,
  TransactionData,
} from '@commercetools/connect-payments-sdk';
import { PSPInteraction } from '@commercetools/connect-payments-sdk/dist/commercetools/types/payment.type';

// CommercetoolsRecurringPaymentJobService may not be available in all SDK versions
type CommercetoolsRecurringPaymentJobService = {
  createRecurringPaymentJobIfApplicable: (params: {
    originPayment: { id: string; typeId: string };
    paymentMethod: { id: string; typeId: string };
  }) => Promise<{ id: string } | null>;
};

export type PaymentMethodInfoDraft = {
  method?: string;
  token?: {
    value: string;
  };
};

export type StripePaymentServiceOptions = {
  ctCartService: CommercetoolsCartService;
  ctPaymentService: CommercetoolsPaymentService;
  ctOrderService: CommercetoolsOrderService;
  ctPaymentMethodService: CommercetoolsPaymentMethodService;
  ctRecurringPaymentJobService: CommercetoolsRecurringPaymentJobService;
};

export type CreatePayment = {
  data: PaymentRequestSchemaDTO;
};
export type CaptureMethod = 'automatic' | 'automatic_async' | 'manual';

export type StripeEventUpdatePayment = {
  id: string;
  pspReference?: string;
  transactions: TransactionData[];
  paymentMethod?: string;
  paymentMethodInfo?: PaymentMethodInfoDraft;
  pspInteraction?: PSPInteraction;
};

export enum StripeEvent {
  PAYMENT_INTENT__SUCCEEDED = 'payment_intent.succeeded',
  PAYMENT_INTENT__CANCELED = 'payment_intent.canceled',
  PAYMENT_INTENT__REQUIRED_ACTION = 'payment_intent.requires_action',
  PAYMENT_INTENT__PAYMENT_FAILED = 'payment_intent.payment_failed',
  CHARGE__REFUNDED = 'charge.refunded',
  CHARGE__SUCCEEDED = 'charge.succeeded',
  CHARGE__UPDATED = 'charge.updated',
}

export enum PaymentStatus {
  FAILURE = 'Failure',
  SUCCESS = 'Success',
  PENDING = 'Pending',
  INITIAL = 'Initial',
}
