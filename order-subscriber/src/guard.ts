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
export const shouldWritePending = (currentPaymentState: string | undefined | null): boolean => !currentPaymentState;

/**
 * The subset of a commercetools Payment this module reads.
 *
 * `amount` carries the PER-TRANSACTION money (`centAmount` + `currencyCode`), which the coverage
 * invariant below needs. It is already present on an expanded payment — the caller expands
 * `paymentInfo.payments[*]`, so no extra expand is required to read it.
 */
export type PaymentLike = {
  transactions?: Array<{
    type?: string;
    state?: string;
    amount?: { centAmount?: number; currencyCode?: string };
  }>;
};

/** The states this module writes. `BalanceDue` and `CreditOwed` are deliberately not among them. */
export type TargetPaymentState = 'Paid' | 'Pending';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COVERAGE INVARIANT — closes the cross-cart binding exploit.
//
// WHY IT EXISTS. A shopper can create a Stripe PaymentIntent + commercetools Payment on a cheap
// cart, re-point that Payment at a more expensive cart via `/me/carts` before settlement, then pay
// the cheap amount. Without comparing the settled amount against the order's gross total, the small
// settlement is enough to stamp the big order `Paid`.
//
// TWO PARTS, ONE SHARED AND ONE CONTEXT-SPECIFIC:
//
//  1. `amountCoversOrderTotal` — the PURE comparison rule. DUPLICATED BYTE-IDENTICAL in
//     `processor/src/utils.ts`. The two Connect apps genuinely cannot share code: commercetools
//     Connect builds each `deployAs` entry as an independent unit and the processor's tsconfig pins
//     `rootDir: ./src`, so a relative import across the app boundary does not compile (a shared
//     package would be the only way, and it is not worth it for one small pure function). The
//     duplication is intentional; if you change one, change the other identically.
//
//  2. The SOURCE of the settled amount, which is context-specific and therefore NOT shared:
//       • This module (the synchronous card path) runs on `OrderCreated`, AFTER the settling
//         `Charge/Success` is already persisted on the payment — so it sums those charges
//         (`sumSuccessfulCharges` → `chargesCoverOrderTotal`).
//       • The processor's async-rail guard runs on the settlement webhook, BEFORE
//         `processStripeEvent` writes the `Charge/Success` — so summing the persisted transactions
//         would read a stale (empty) set. It sources the settled amount from the settling
//         PaymentIntent's `amount_received` instead. See `processor/src/utils.ts`.
//     Both then feed the SAME pure rule below, so the accept/reject decision is identical.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The pure coverage rule — a settled amount covers the order's TAX-INCLUSIVE gross only when it is in
 * the SAME currency (checked FIRST — a cross-currency comparison is meaningless) AND is at least the
 * gross (`>=`, so legitimate overpayment still covers). Currency is compared case-insensitively so a
 * Stripe lowercase code (`usd`) and a commercetools uppercase code (`USD`) match.
 *
 * DUPLICATED BYTE-IDENTICAL in `processor/src/utils.ts`. Only the SOURCE of `settledCentAmount` /
 * `settledCurrencyCode` differs by context (see the block comment above); this rule does not.
 */
export const amountCoversOrderTotal = (
  settledCentAmount: number,
  settledCurrencyCode: string,
  orderGrossTotal: { centAmount: number; currencyCode: string },
): boolean =>
  settledCurrencyCode.toLowerCase() === orderGrossTotal.currencyCode.toLowerCase() &&
  settledCentAmount >= orderGrossTotal.centAmount;

/**
 * The sum, in cents, of every `Charge/Success` transaction denominated in `currencyCode`.
 *
 * NEVER sums across currencies: a transaction whose `amount.currencyCode` differs is skipped
 * entirely rather than coerced or rate-converted, because adding centAmounts across currencies is
 * meaningless. A transaction with no amount contributes 0.
 */
export const sumSuccessfulCharges = (payments: readonly PaymentLike[], currencyCode: string): number =>
  payments
    .flatMap((payment) => payment.transactions ?? [])
    .filter((t) => t.type === 'Charge' && t.state === 'Success' && t.amount?.currencyCode === currencyCode)
    .reduce((sum, t) => sum + (t.amount?.centAmount ?? 0), 0);

/**
 * Do the order's settled charges cover its TAX-INCLUSIVE gross total?
 *
 * This is the SYNCHRONOUS-PATH sourcing: it sums the already-persisted `Charge/Success` transactions
 * (in the order's own currency) and feeds the total to the shared `amountCoversOrderTotal` rule. The
 * processor sources its settled amount differently — see the block comment above.
 *
 * COVERAGE IS MEASURED OVER ALL THE ORDER'S PAYMENTS, not only this connector's. A legitimately
 * split-tendered order — e.g. a gift card charged through another connector plus a `checkout-stripe`
 * card — is fully paid even though our card alone does not reach the gross. Whether we WRITE at all is
 * still gated on OUR involvement (see `resolveTargetPaymentState`); this function only answers "is the
 * order, in total, covered". Pass the order's full expanded payment set.
 *
 * WHY SUMMING EVERY `Charge/Success` IS SAFE against the cross-cart exploit: a shopper CANNOT forge a
 * `Charge/Success`. The public `/me` API creates transactions via `MyTransactionDraft`, which has NO
 * `state` field — only a connector holding `manage_payments` can write `state: 'Success'`. So an
 * attacker cannot inject a fake covering charge from another "payment"; every summed Success is one a
 * trusted connector actually settled. The exploit (a small real charge re-pointed onto a big order)
 * stays closed because that small charge still does not sum to the gross.
 */
export const chargesCoverOrderTotal = (
  payments: readonly PaymentLike[],
  orderGrossTotal: { centAmount: number; currencyCode: string },
): boolean =>
  amountCoversOrderTotal(
    sumSuccessfulCharges(payments, orderGrossTotal.currencyCode),
    orderGrossTotal.currencyCode,
    orderGrossTotal,
  );

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
 * A SETTLED CHARGE THAT DOES NOT COVER THE GROSS TOTAL ALSO RETURNS undefined — this module is the
 * single financial judge of the `Paid` write, so the coverage decision is consolidated here rather
 * than split between the guard and the caller. A shopper can create a Payment on a cheap cart,
 * re-point it at a more expensive order before settlement, and pay the small amount; the resulting
 * `Charge/Success` is real but does not cover the order. `Paid` would be a lie, and `Pending` is
 * NOT the fallback — the money has settled, so `Pending` ("awaiting the shopper") misdescribes it
 * exactly as it does the manual-capture case. Leaving it unset routes it to manual review, which is
 * the honest owner of a settled-but-short payment. See `chargesCoverOrderTotal`. The comparison is
 * against the caller-supplied gross, which MUST be the tax-inclusive
 * `order.taxedPrice?.totalGross ?? order.totalPrice` — Stripe charges tax-inclusive, so comparing
 * against a pre-tax total would leave a tax-sized hole the exploit could still slip through.
 *
 * NEVER USED TO CHANGE AN EXISTING STATE. The caller only reaches this after `shouldWritePending`
 * has established that `paymentState` is unset, so this function reflects onto an empty field and
 * never transitions. That is why the processor's full transition lattice
 * (`shouldTransitionOrderPaymentState`) does not need to be duplicated here, and the warning above
 * about terminal states does not bite: there is no matrix to drift, only "what is true right now".
 * If this module ever gains the ability to overwrite a state, that changes and the lattice has to
 * come with it — by extraction into a shared package, not by copy-paste.
 *
 * INVOLVEMENT IS DECIDED ON OURS, COVERAGE ON ALL. We only ever write a state for an order WE settled
 * a charge on (`ourPayments`), but whether that order is *paid* is judged across ALL its payments
 * (`allPayments`), so a split-tendered order — our card plus, say, a gift card charged through another
 * connector — correctly reaches `Paid` even though our charge alone does not cover the gross. The
 * Pending and manual-capture branches stay on OURS: those describe the state of our own rail, which a
 * sibling connector's transactions must not influence.
 *
 * @param ourPayments The order's payments **belonging to this connector**, expanded. See the caller.
 * @param orderGrossTotal The order's TAX-INCLUSIVE gross, `order.taxedPrice?.totalGross ?? order.totalPrice`.
 * @param allPayments EVERY expanded payment on the order (ours and siblings'), for the coverage sum.
 *   Defaults to `ourPayments` for the single-connector case where the two sets are identical.
 */
export const resolveTargetPaymentState = (
  ourPayments: readonly PaymentLike[],
  orderGrossTotal: { centAmount: number; currencyCode: string },
  allPayments: readonly PaymentLike[] = ourPayments,
): TargetPaymentState | undefined => {
  const ourTransactions = ourPayments.flatMap((payment) => payment.transactions ?? []);

  // Involvement: we only consider `Paid` once WE have a settled charge on the order. Coverage is then
  // judged across ALL the order's charges (split tender). An our-charge that, together with any
  // sibling charges, still does NOT cover the gross — the cross-cart binding exploit — returns
  // undefined (manual review), never `Pending`: the money settled, so `Pending` would misdescribe it.
  // This branch does not fall through to the pending authorization below, by design.
  if (ourTransactions.some((t) => t.type === 'Charge' && t.state === 'Success')) {
    return chargesCoverOrderTotal(allPayments, orderGrossTotal) ? 'Paid' : undefined;
  }
  if (ourTransactions.some((t) => t.type === 'Authorization' && t.state === 'Pending')) return 'Pending';
  return undefined;
};
