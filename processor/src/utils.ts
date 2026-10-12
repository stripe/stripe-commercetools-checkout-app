import Stripe from 'stripe';
import { Value } from '@sinclair/typebox/value';
import {
  PaymentElementBehaviorOptionsDTO,
  PaymentElementBehaviorOptionsSchema,
} from './dtos/stripe-payment-element-options.dto';
import { OrderPaymentState, StripeEvent } from './services/types/stripe-payment.type';

export const parseJSON = <T extends object | []>(json?: string): T => {
  try {
    return JSON.parse(json || '{}');
  } catch (error) {
    console.error('Error parsing JSON', error);
    return {} as T;
  }
};

export const isValidUUID = (uuid: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

/**
 * Parses and validates STRIPE_BEHAVIOR_PAYMENT_ELEMENT.
 * A malformed value never breaks checkout: invalid JSON falls back to `{}`, and an
 * individual key that fails schema validation is dropped on its own — the rest of the
 * object is still applied.
 */
export const parsePaymentElementOptions = (raw?: string): Partial<PaymentElementBehaviorOptionsDTO> => {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('Invalid JSON in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring', error);
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('STRIPE_BEHAVIOR_PAYMENT_ELEMENT must be a JSON object, ignoring');
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const keySchema =
      PaymentElementBehaviorOptionsSchema.properties[
        key as keyof typeof PaymentElementBehaviorOptionsSchema.properties
      ];
    if (!keySchema) {
      console.warn(`Unknown key "${key}" in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring`);
      continue;
    }
    if (Value.Check(keySchema, value)) {
      result[key] = value;
    } else {
      console.warn(`Invalid value for "${key}" in STRIPE_BEHAVIOR_PAYMENT_ELEMENT, ignoring key`);
    }
  }
  return result as Partial<PaymentElementBehaviorOptionsDTO>;
};

export const BANK_TRANSFER_NEXT_ACTION_TYPE = 'display_bank_transfer_instructions';

/**
 * Narrow predicate: true only for a PaymentIntent that is awaiting a bank transfer.
 *
 * `payment_intent.requires_action` is NOT specific to bank transfers — card 3DS
 * (`use_stripe_sdk`), Boleto (`boleto_display_details`) and redirect-based methods emit the same
 * event. Routing that event without this predicate would write an Authorization/Pending to
 * commercetools on every 3DS payment, which is the most severe regression this feature can cause.
 * Guarded by release-gate tests with dedicated 3DS and Boleto regression fixtures.
 *
 * Strict equality on the literal plus a presence check on the instructions object, so an
 * unexpected Stripe payload fails CLOSED rather than re-opening the 3DS path. Both halves are
 * load-bearing: `next_action.type` alone would be satisfied by a future variant that reuses the
 * name, and the object alone would be satisfied by any payload that happens to carry the key.
 *
 * Consumed by the webhook route only. The confirmation gate
 * (`updatePaymentIntentStripeSuccessful`) must reuse this exact predicate rather than adding
 * `requires_action` to its status allowlist wholesale — that is a later stage of this feature.
 */
export const isBankTransferNextAction = (paymentIntent: Stripe.PaymentIntent): boolean => {
  const nextAction = paymentIntent.next_action;
  return nextAction?.type === BANK_TRANSFER_NEXT_ACTION_TYPE && !!nextAction.display_bank_transfer_instructions;
};

/**
 * Stripe event → commercetools `Order.paymentState`. The ONLY mapping for this axis.
 *
 * THIS IS A SECOND, INDEPENDENT AXIS — do not conflate it with the event→transaction mapping in
 * `stripeEventConverter.populateTransactions()`. They answer different questions about different
 * commercetools objects and they are deliberately gated differently:
 *
 * | | `Payment.transactions[].state` | `Order.paymentState` (this map) |
 * |---|---|---|
 * | owner | the converter | `reflectOrderPaymentStateBestEffort()` |
 * | `requires_action` | **bank transfer only** (`isBankTransferNextAction` at the route) | **every method** |
 *
 * That asymmetry is the decision of the 2026-08-18 session, not an oversight. A `requires_action`
 * means the shopper has committed to pay and an intermediate step stands in the way — true of card
 * 3DS, Boleto, Blik and bank transfer alike — so the ORDER is pending for all of them. Whether a
 * pending AUTHORIZATION should also be booked is a separate, narrower question, and the answer is
 * still "bank transfer only": booking one for every 3DS payment is the most severe regression this
 * feature can cause. Do not "unify" the two gates.
 *
 * An event absent from this map writes nothing. That is why the map is exhaustive-by-omission
 * rather than a switch with a default: `charge.*`, the refund events, `partially_funded` and
 * `customer_cash_balance_transaction.created` all fall through to no order write, each for a reason
 * recorded in `business-rules/order-payment-state.md`.
 *
 * `partially_funded` in particular must NOT be added: a bank transfer funded in instalments is
 * still pending, and the order is already `Pending` from `requires_action`, so the write would be a
 * no-op that reads like a state change.
 */
export const ORDER_PAYMENT_STATE_BY_EVENT: Readonly<Partial<Record<StripeEvent, OrderPaymentState>>> = {
  [StripeEvent.PAYMENT_INTENT__REQUIRED_ACTION]: OrderPaymentState.PENDING,
  [StripeEvent.PAYMENT_INTENT__PROCESSING]: OrderPaymentState.PENDING,
  [StripeEvent.PAYMENT_INTENT__SUCCEEDED]: OrderPaymentState.PAID,
  [StripeEvent.PAYMENT_INTENT__PAYMENT_FAILED]: OrderPaymentState.FAILED,
  [StripeEvent.PAYMENT_INTENT__CANCELED]: OrderPaymentState.FAILED,
};

/**
 * Guarded, idempotent, monotonic transition for `Order.paymentState`.
 *
 * Stripe guarantees neither delivery order nor exactly-once delivery, so this must be safe under
 * redelivery AND under reordering. The rule is a precedence lattice, not a state machine:
 *
 * | current ↓ / target → | `Pending` | `Paid` | `Failed` |
 * |---|---|---|---|
 * | unset      | ✅ | ✅ | ✅ |
 * | `Pending`  | ❌ no-op | ✅ | ✅ |
 * | `Failed`   | ❌ | ✅ late settlement wins | ❌ no-op |
 * | `Paid`     | ❌ | ❌ no-op | ❌ **never downgraded** |
 *
 * The three load-bearing cells:
 *
 * 1. **`Paid` is terminal and authoritative.** Money arrived. A `payment_failed` redelivered after
 *    settlement — or the `payment_failed` that Stripe emits when a shopper's *first* card attempt
 *    is declined before a later attempt succeeds on the same PaymentIntent — must not mark a paid
 *    order as failed. This cell is the reason the function exists.
 * 2. **`Failed` → `Paid` is allowed.** The reverse of the above: a bank transfer whose instructions
 *    expired (`canceled` → `Failed`) can still be funded if the wire was already in flight. The
 *    money is the fact; the earlier timeout was a prediction.
 * 3. **`Pending` only onto an unset order.** It is the weakest state, so it can never overwrite a
 *    resolved one. This also makes the ownership check unnecessary for `Pending`: an order that
 *    already has any state is left alone.
 *
 * Pure and total on purpose — no I/O, no clock, no `Stripe.Event`. It is the piece worth exhaustive
 * unit tests, and the caller is the piece worth integration tests.
 */
export const shouldTransitionOrderPaymentState = (current: string | undefined, target: OrderPaymentState): boolean => {
  if (current === target) return false;
  if (current === OrderPaymentState.PAID) return false;
  if (target === OrderPaymentState.PENDING) return !current;
  return true;
};

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
//     `order-subscriber/src/guard.ts`. The two Connect apps genuinely cannot share code:
//     commercetools Connect builds each `deployAs` entry as an independent unit and this app's
//     tsconfig pins `rootDir: ./src`, so a relative import across the app boundary does not compile
//     (a shared package would be the only way, and it is not worth it for one small pure function).
//     The duplication is intentional; if you change one, change the other identically.
//
//  2. The SOURCE of the settled amount, which is context-specific and therefore NOT shared:
//       • The order-subscriber (the synchronous card path) runs on `OrderCreated`, AFTER the
//         settling `Charge/Success` is already persisted — so it sums those charges.
//       • This module's async-rail guard (`reflectOrderPaymentStateBestEffort`) runs on the
//         settlement webhook, which the route dispatches BEFORE `processStripeEvent` writes the
//         `Charge/Success` (see `stripe-payment.route.ts` and `stripeEventConverter`). Summing the
//         persisted transactions there would read a STALE, empty set and wrongly skip every
//         legitimate async `Paid`. So it sources the settled amount from the settling PaymentIntent's
//         `amount_received` instead — which is also independent of write ordering and leaves the
//         `Authorization/Pending` transaction read (ownership signal 2) untouched.
//     Both then feed the SAME pure rule below, so the accept/reject decision is identical.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The pure coverage rule — a settled amount covers the order's TAX-INCLUSIVE gross only when it is in
 * the SAME currency (checked FIRST — a cross-currency comparison is meaningless) AND is at least the
 * gross (`>=`, so legitimate overpayment still covers). Currency is compared case-insensitively so a
 * Stripe lowercase code (`usd`) and a commercetools uppercase code (`USD`) match.
 *
 * DUPLICATED BYTE-IDENTICAL in `order-subscriber/src/guard.ts`. Only the SOURCE of `settledCentAmount`
 * / `settledCurrencyCode` differs by context (see the block comment above); this rule does not.
 */
export const amountCoversOrderTotal = (
  settledCentAmount: number,
  settledCurrencyCode: string,
  orderGrossTotal: { centAmount: number; currencyCode: string },
): boolean =>
  settledCurrencyCode.toLowerCase() === orderGrossTotal.currencyCode.toLowerCase() &&
  settledCentAmount >= orderGrossTotal.centAmount;
