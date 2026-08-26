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
  PAYMENT_INTENT__PROCESSING = 'payment_intent.processing',
  PAYMENT_INTENT__CANCELED = 'payment_intent.canceled',
  PAYMENT_INTENT__REQUIRED_ACTION = 'payment_intent.requires_action',
  PAYMENT_INTENT__PAYMENT_FAILED = 'payment_intent.payment_failed',
  CHARGE__REFUNDED = 'charge.refunded',
  CHARGE__SUCCEEDED = 'charge.succeeded',
  CHARGE__UPDATED = 'charge.updated',
  PAYMENT_INTENT__PARTIALLY_FUNDED = 'payment_intent.partially_funded',
  CUSTOMER_CASH_BALANCE_TRANSACTION__CREATED = 'customer_cash_balance_transaction.created',
  REFUND__UPDATED = 'refund.updated',
  REFUND__FAILED = 'refund.failed',
}

export enum PaymentStatus {
  FAILURE = 'Failure',
  SUCCESS = 'Success',
  PENDING = 'Pending',
  INITIAL = 'Initial',
}

/**
 * The subset of commercetools `Order.paymentState` this connector writes.
 *
 * READ THIS BEFORE ADDING A MEMBER. commercetools defines five values —
 * `BalanceDue | Failed | Pending | CreditOwed | Paid`. The two absent here are absent on purpose:
 *
 * - **`BalanceDue`** means "an amount is owed", which is indistinguishable from the unset state
 *   this connector deliberately leaves on synchronous card orders (see
 *   `reflectOrderPaymentStateBestEffort`). Writing it would claim ownership of an order the
 *   merchant's own process is supposed to finalize.
 * - **`CreditOwed`** is the refund/chargeback outcome. Whether a partially refunded order stays
 *   `Paid` or becomes `CreditOwed` is a merchant business decision, not a Stripe fact — it was
 *   raised and explicitly deferred in the 2026-08-18 session. The refund events remain a
 *   Payment-transaction concern only (`business-rules/refunds-reversals.md`).
 *
 * DO NOT widen this enum to "match commercetools". The narrowness is the contract: every member
 * here is a state the connector can derive from a Stripe event with no merchant policy input.
 * See `business-rules/order-payment-state.md` and `decisions/adr-009-*.md`.
 */
export enum OrderPaymentState {
  PENDING = 'Pending',
  PAID = 'Paid',
  FAILED = 'Failed',
}
