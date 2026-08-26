/**
 * The one guard this module needs, and the reason it is one condition rather than a matrix.
 *
 * The processor owns a full transition lattice (`shouldTransitionOrderPaymentState` in
 * `processor/src/utils.ts`): `Paid` is authoritative and never downgraded, `Failed → Paid` is allowed
 * because a wire already in flight beats an expiry prediction, `Pending` only lands on unset.
 *
 * **This module only ever writes the weakest state**, so it needs exactly that last row. That is not
 * a duplicated matrix — it is the subscriber's own single rule, and it agrees with the processor's by
 * construction rather than by copying.
 *
 * The two apps genuinely cannot share code: commercetools Connect builds each `deployAs` entry as an
 * independent unit, and the processor's `tsconfig` pins `rootDir: ./src`, so a relative import across
 * app boundaries does not compile. Sharing would need a published package. For one condition, that
 * trade is not worth it.
 *
 * ⚠️ IF THIS MODULE EVER WRITES A TERMINAL STATE, this function is no longer sufficient and the full
 * lattice has to come with it — by extraction into a shared package, not by copy-paste. Two copies of
 * a transition matrix drift, and the drift is invisible until money is involved.
 *
 * @param currentPaymentState The order's paymentState as read **fresh from commercetools**, never the
 *   value carried in the Pub/Sub payload. The caller enforces this; see `resolveOrderForWrite`.
 */
export const shouldWritePending = (currentPaymentState: string | undefined | null): boolean =>
  !currentPaymentState;

/** The subset of a commercetools Payment this module reads. */
export type PaymentLike = {
  transactions?: Array<{ type?: string; state?: string }>;
};

/** The states this module writes. `BalanceDue` and `CreditOwed` are deliberately not among them. */
export type TargetPaymentState = 'Paid' | 'Pending';

/**
 * What is true about this order's money at the moment the order comes into existence?
 *
 * WHY THE SUBSCRIBER ANSWERS THIS AND NOT THE PROCESSOR, which is the whole reason this module
 * exists. For a card, commercetools Checkout creates the order AFTER the money has settled —
 * measured three times on 2026-08-20 at 333 ms, 701 ms and 877 ms after `Charge/Success`. So
 * `payment_intent.succeeded` reaches the processor while no order exists to write, terminal targets
 * get a single lookup attempt with no retry, and the write is skipped. No later event ever arrives.
 * The order is therefore born already final and with nobody left to record it — except this module,
 * which runs on `OrderCreated` and reads the payment fresh.
 *
 * `Paid` OUTRANKS `Pending` rather than being checked after it, and the precedence is load-bearing
 * for a retried checkout: an abandoned bank transfer leaves an `Authorization/Pending` on the order
 * forever, and if the shopper then pays by card the truthful answer is `Paid`. Ranking the other way
 * would freeze such an order as pending while the money sat in the account.
 *
 * AN AUTHORIZATION WITHOUT A CHARGE RETURNS undefined, and that is a decision rather than an
 * oversight. Under `STRIPE_CAPTURE_METHOD=manual` a card arrives here authorized but not captured:
 * `Paid` would be false, and `Pending` misdescribes it too — nothing is being awaited from the
 * shopper, the merchant simply has not captured yet. This is the one case where "the merchant
 * process decides" is the honest answer, because the merchant is the actor. `BalanceDue` is the
 * commercetools state that fits best and is deliberately out of this connector's scope; adding it
 * is a product decision, not a fix. This deployment runs `automatic`, but the value is configurable,
 * so the case is reachable in the field.
 *
 * NEVER USED TO CHANGE AN EXISTING STATE. The caller only reaches this after `shouldWritePending`
 * has established that `paymentState` is unset, so this function reflects onto an empty field and
 * never transitions. That is why the processor's full transition lattice
 * (`shouldTransitionOrderPaymentState`) does not need to be duplicated here, and the warning above
 * about terminal states does not bite: there is no matrix to drift, only "what is true right now".
 * If this module ever gains the ability to overwrite a state, that changes and the lattice has to
 * come with it — by extraction into a shared package, not by copy-paste.
 *
 * @param payments The order's payments **belonging to this connector**, expanded. See the caller.
 */
export const resolveTargetPaymentState = (payments: readonly PaymentLike[]): TargetPaymentState | undefined => {
  const transactions = payments.flatMap((payment) => payment.transactions ?? []);

  if (transactions.some((t) => t.type === 'Charge' && t.state === 'Success')) return 'Paid';
  if (transactions.some((t) => t.type === 'Authorization' && t.state === 'Pending')) return 'Pending';
  return undefined;
};
