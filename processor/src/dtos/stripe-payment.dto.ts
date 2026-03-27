import { Static, Type } from '@sinclair/typebox';
import { PaymentMethodType, PaymentOutcomeSchema } from './mock-payment.dto';

export const CreatePaymentMethodSchema = Type.Object({
  type: Type.Union([Type.Enum(PaymentMethodType), Type.String()]),
  poNumber: Type.Optional(Type.String()),
  invoiceMemo: Type.Optional(Type.String()),
  confirmationToken: Type.Optional(Type.String()),
});

export const PaymentRequestSchema = Type.Object({
  paymentMethod: Type.Composite([CreatePaymentMethodSchema]),
  cart: Type.Optional(
    Type.Object({
      id: Type.String(),
    }),
  ),
  paymentIntent: Type.Optional(
    Type.Object({
      id: Type.String(),
    }),
  ),
  paymentOutcome: Type.Optional(PaymentOutcomeSchema),
});

export enum PaymentOutcome {
  AUTHORIZED = 'Authorized',
  REJECTED = 'Rejected',
  INITIAL = 'Initial',
}

export const PaymentResponseSchema = Type.Object({
  sClientSecret: Type.String(),
  paymentReference: Type.String(),
  merchantReturnUrl: Type.String(),
  cartId: Type.String(),
  billingAddress: Type.Optional(Type.String()),
});

export enum CollectBillingAddressOptions {
  AUTO = 'auto',
  NEVER = 'never',
  IF_REQUIRED = 'if_required',
}

export const ConfigElementResponseSchema = Type.Object({
  cartInfo: Type.Object({
    amount: Type.Number(),
    currency: Type.String(),
  }),
  appearance: Type.Optional(Type.String()),
  captureMethod: Type.String(),
  setupFutureUsage: Type.Optional(Type.String()),
  layout: Type.String(),
  collectBillingAddress: Type.Enum(CollectBillingAddressOptions),
});

export const CtPaymentSchema = Type.Object({
  ctPaymentReference: Type.String(),
});

export const CustomerResponseSchema = Type.Optional(
  Type.Object({
    stripeCustomerId: Type.String(),
    ephemeralKey: Type.String(),
    sessionId: Type.String(),
  }),
);

/**
 * Amount in commercetools format (used inside Express line items).
 */
export const ExpressPaymentDataAmountSchema = Type.Object({
  centAmount: Type.Number(),
  currencyCode: Type.String(),
  fractionDigits: Type.Number(),
});

/**
 * Line item for Express Checkout (amount as commercetools-style object, type for display).
 */
export const ExpressPaymentDataLineItemSchema = Type.Object({
  name: Type.String(),
  amount: ExpressPaymentDataAmountSchema,
  type: Type.String(),
});

/**
 * Total price in commercetools cart style (`totalPrice`).
 */
export const ExpressPaymentDataTotalPriceSchema = Type.Object({
  centAmount: Type.Number(),
  currencyCode: Type.String(),
  fractionDigits: Type.Number(),
});

/**
 * Response for GET /express-payment-data (commercetools-oriented shape for Express).
 * totalPrice, currencyCode at root, lineItems with amount object and type.
 * Used by the enabler after shipping address/method changes to get the current cart total and line items.
 */
export const GetExpressPaymentDataResponseSchema = Type.Object({
  totalPrice: ExpressPaymentDataTotalPriceSchema,
  currencyCode: Type.String(),
  lineItems: Type.Array(ExpressPaymentDataLineItemSchema),
});

export type PaymentRequestSchemaDTO = Static<typeof PaymentRequestSchema>;
export type PaymentResponseSchemaDTO = Static<typeof PaymentResponseSchema>;
export type ConfigElementResponseSchemaDTO = Static<typeof ConfigElementResponseSchema>;
export type CtPaymentSchemaDTO = Static<typeof CtPaymentSchema>;
export type CustomerResponseSchemaDTO = Static<typeof CustomerResponseSchema>;
export type GetExpressPaymentDataResponseSchemaDTO = Static<typeof GetExpressPaymentDataResponseSchema>;
