export const parseJSON = <T extends object | []>(json: string): T => {
  try {
    return JSON.parse(json || "{}");
  } catch (error) {
    console.error("Error parsing JSON", error);
    return {} as T;
  }
};

export const BANK_TRANSFER_NEXT_ACTION_TYPE = "display_bank_transfer_instructions";

/**
 * Narrow predicate: true only for a PaymentIntent awaiting a bank transfer.
 *
 * DELIBERATELY DUPLICATED from the processor's `utils.ts`, which has the same function under the
 * same name. The enabler is a separate Vite bundle shipped to the browser and cannot import from
 * the processor, so sharing would mean a third package — more machinery than a five-line predicate
 * justifies. The duplication is safe in the direction that matters: both sides fail CLOSED, so a
 * drift makes bank transfer stop working (loud, caught by tests) rather than letting card 3DS
 * through (silent, and the most expensive regression this feature can cause).
 *
 * `payment_intent.requires_action` is NOT specific to bank transfers — card 3DS
 * (`use_stripe_sdk`), Boleto (`boleto_display_details`) and redirect-based methods produce the
 * same status. Those MUST keep raising an error to the host: for them the buyer genuinely has not
 * completed anything. A bank transfer is the opposite — the buyer has done all they can do inside
 * checkout, and the money is days away.
 */
export const isBankTransferNextAction = (paymentIntent: {
  next_action?: { type?: string; display_bank_transfer_instructions?: unknown } | null;
}): boolean => {
  const nextAction = paymentIntent?.next_action;
  return nextAction?.type === BANK_TRANSFER_NEXT_ACTION_TYPE && !!nextAction.display_bank_transfer_instructions;
};
