import { Static, Type } from '@sinclair/typebox';

/**
 * Request body for POST /operations/transactions — a server-to-server, off-session recurring charge.
 *
 * This endpoint is authenticated with OAuth2 (`oauth2AuthHook`), under which there is NO
 * `SessionAuthentication` principal, so every identifier is carried on the body rather than the
 * request context. The service reads these fields and fails closed when a required one is absent.
 *
 * `checkoutTransactionItemId` is REQUIRED and is the SOLE idempotency anchor (matches the reference
 * DTO). Anchoring on anything else — e.g. falling back to `futureOrderNumber` — could shift the Stripe
 * idempotency key and the CT interfaceId dedupe across retries and double-charge.
 *
 * The saved method arrives NESTED as `paymentMethod: { id }` (confirmed against the real example
 * payload); `paymentMethodId` is retained as a flat, reference-compatible alias. Exactly one of the two
 * is required at resolution — the service fails closed (`ErrorRequiredField`) when neither is present.
 * `futureOrderNumber` is a separate optional field, NOT an idempotency anchor.
 */
export const TransactionDraft = Type.Object({
  cartId: Type.String({ format: 'uuid' }),
  checkoutTransactionItemId: Type.String({ format: 'uuid' }),
  futureOrderNumber: Type.Optional(Type.String()),
  paymentInterface: Type.Optional(Type.String()),
  paymentMethod: Type.Optional(Type.Object({ id: Type.String({ format: 'uuid' }) })),
  paymentMethodId: Type.Optional(Type.String({ format: 'uuid' })),
  amount: Type.Optional(
    Type.Object({
      // Defense-in-depth: integer cents only (hub cents rule). The charged value is always the cart's
      // getPaymentAmount, re-asserted integer > 0 in the service — this just rejects garbage early.
      centAmount: Type.Integer({ minimum: 1 }),
      currencyCode: Type.String(),
    }),
  ),
  idempotencyKey: Type.Optional(Type.String()),
  type: Type.Union([Type.Literal('Recurring')]),
});

const TransactionStatePending = Type.Literal('Pending', {
  description: 'The authorization/capture has not happened yet. Most likely because we need to receive notification.',
});

const TransactionStateFailed = Type.Literal('Failed', {
  description: "Any error that occured for which the system can't recover automatically from.",
});

const TransactionStateComplete = Type.Literal('Completed', {
  description: 'If there is a successful authorization/capture on the payment-transaction.',
});

export const TransactionStatusState = Type.Union([
  TransactionStateComplete,
  TransactionStateFailed,
  TransactionStatePending,
]);

export const TransactionResponse = Type.Object({
  transactionStatus: Type.Object({
    state: TransactionStatusState,
    errors: Type.Array(
      Type.Object({
        code: Type.Literal('PaymentRejected'),
        message: Type.String(),
      }),
    ),
  }),
  paymentId: Type.Optional(Type.String()),
});

export type TransactionDraftDTO = Static<typeof TransactionDraft>;
export type TransactionResponseDTO = Static<typeof TransactionResponse>;
