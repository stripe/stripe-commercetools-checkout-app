import { Order, Payment } from '@commercetools/platform-sdk';
import { apiRoot } from './ct.client';
import { PAYMENT_INTERFACE } from '../constants';
import { resolveTargetPaymentState, shouldWritePending, TargetPaymentState } from '../guard';
import { log } from '../logger';

export type OrderForWrite = {
  id: string;
  version: number;
  paymentState?: string;
  /** What to write, resolved from the payment's own transactions. See `resolveTargetPaymentState`. */
  targetPaymentState: TargetPaymentState;
};

/**
 * Reads the order FRESH, with its payments expanded, and decides whether we own it.
 *
 * TWO READS ARE HAPPENING HERE FOR TWO DIFFERENT REASONS, and collapsing them is the bug this
 * function exists to prevent.
 *
 * 1. **Freshness.** The Pub/Sub payload carries a full order snapshot, `paymentState` included, and on
 *    an `OrderCreated` message that value is always empty — which makes it look like a free
 *    idempotency check. It is not. The payload is a snapshot of when the message was CREATED. Between
 *    then and now, the Stripe webhook for a synchronous card payment can already have written `Paid`
 *    (`payment_intent.succeeded` arrives within seconds for a card). Guarding against the payload
 *    would see empty, write `Pending`, and **overwrite a real `Paid`** — the exact race the guard
 *    exists to prevent, reintroduced by reading the convenient field. The payload is good for the
 *    order id and for cheap rejection. Never for deciding the write.
 *
 * 2. **Expansion.** The payload's `paymentInfo.payments[]` are references only — `{typeId, id}`, no
 *    object — so `paymentInterface` is not in the message. Filtering needs the expanded payment. The
 *    tax connector's order-syncer resolves the same way, for the same reason.
 *
 * Returns `undefined` when the order is not ours, already has a state, or cannot be read. Every
 * `undefined` is logged with its reason, because "did nothing" and "did nothing for a good reason"
 * must not look the same in a log.
 */
export const resolveOrderForWrite = async (orderId: string): Promise<OrderForWrite | undefined> => {
  let order: Order;
  try {
    const res = await apiRoot
      .orders()
      .withId({ ID: orderId })
      .get({ queryArgs: { expand: ['paymentInfo.payments[*]'] } })
      .execute();
    order = res.body;
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    log.warn('Could not read the order — skipping', {
      orderId,
      errorType: e.name,
      errorMessage: e.message,
      errorStatus: e.statusCode,
    });
    return undefined;
  }

  // The guard, against the FRESH value. See guard.ts.
  if (!shouldWritePending(order.paymentState)) {
    log.info('Order already has a paymentState — leaving it alone', {
      orderId,
      currentPaymentState: order.paymentState,
    });
    return undefined;
  }

  const ours = ourPayments(order);
  if (ours.length === 0) {
    log.info('Order is not paid through this connector — skipping', {
      orderId,
      interfaces: paymentInterfacesOf(order),
    });
    return undefined;
  }

  // Only now, on OUR payments, ask what is true about the money. Asking before the interface filter
  // would decide our write from a sibling connector's rail. See resolveTargetPaymentState.
  const targetPaymentState = resolveTargetPaymentState(ours);
  const transactionStates = ours.flatMap((p) => (p.transactions ?? []).map((t) => `${t.type}/${t.state}`));

  if (!targetPaymentState) {
    // Reached by an authorization with no charge — manual capture, where the merchant is the actor
    // and so the merchant's process is the honest owner. Logged with the states that produced the
    // decision, because "wrote nothing" and "wrote nothing for a good reason" must not look alike.
    log.info('No payment state follows from these transactions — leaving it to the merchant process', {
      orderId,
      transactionStates,
    });
    return undefined;
  }

  return { id: order.id, version: order.version, paymentState: order.paymentState, targetPaymentState };
};

/**
 * The order's payments that belong to THIS connector.
 *
 * `OrderCreated` is delivered for every order in the project, so this filter is not optional.
 * Returning *all* matches rather than the first is deliberate: a retried checkout leaves several
 * payments on one order, and picking `payments[0]` would judge the order by whichever attempt happens
 * to be first — which for a retry is the failed one.
 *
 * An empty result means "not ours, or not classifiable yet" (an unexpanded payment lands here too).
 * Both are the conservative answer — better to skip an order we cannot classify than to stamp a state
 * onto someone else's.
 */
const ourPayments = (order: Order): Payment[] =>
  (order.paymentInfo?.payments ?? [])
    .map((ref) => ref.obj)
    .filter((p): p is Payment => p?.paymentMethodInfo?.paymentInterface === PAYMENT_INTERFACE);

const paymentInterfacesOf = (order: Order): string[] =>
  (order.paymentInfo?.payments ?? [])
    .map((ref) => ref.obj?.paymentMethodInfo?.paymentInterface ?? 'unexpanded')
    .filter((v, i, a) => a.indexOf(v) === i);

/**
 * Writes the resolved `paymentState`, retrying once on a concurrent modification.
 *
 * commercetools needs the current `version` on every update and does not retry optimistic locking for
 * us. On a 409 the order must be **re-resolved**, not replayed: whoever won the race may have set a
 * real state, and `resolveOrderForWrite` re-applies the guard against that. Replaying the original
 * body with a fresh version is how the guard gets quietly bypassed.
 *
 * The retry re-resolves the TARGET too, not just the version. Between the two attempts the payment
 * may have moved on — a bank transfer funding turns `Pending` into `Paid` — so reusing the original
 * target would write a state that was true when we started and is stale by the time it lands.
 */
export const writeOrderPaymentState = async (order: OrderForWrite): Promise<void> => {
  let written = order.targetPaymentState;
  try {
    await post(order.id, order.version, order.targetPaymentState);
  } catch (err) {
    if (!isConcurrentModification(err)) throw err;

    const fresh = await resolveOrderForWrite(order.id);
    if (!fresh) {
      log.info('Concurrent write resolved the order first — nothing to do', { orderId: order.id });
      return;
    }
    written = fresh.targetPaymentState;
    await post(fresh.id, fresh.version, fresh.targetPaymentState);
  }

  log.info('Order paymentState written', { orderId: order.id, paymentState: written });
};

const post = async (orderId: string, version: number, paymentState: TargetPaymentState): Promise<void> => {
  await apiRoot
    .orders()
    .withId({ ID: orderId })
    .post({ body: { version, actions: [{ action: 'changePaymentState', paymentState }] } })
    .execute();
};

/**
 * Detects a commercetools optimistic-locking conflict across the shapes it arrives in. The raw
 * platform client surfaces the status on `statusCode` or only on `body.statusCode`, and the code
 * inside `body.errors[]`; checking both means neither a shape change nor a status-only response turns
 * a retryable conflict into a swallowed warning.
 */
const isConcurrentModification = (error: unknown): boolean => {
  const err = error as {
    statusCode?: number;
    code?: string;
    body?: { statusCode?: number; errors?: Array<{ code?: string }> };
  };
  if ((err?.statusCode ?? err?.body?.statusCode) === 409) return true;
  return err?.code === 'ConcurrentModification' || (err?.body?.errors ?? []).some((e) => e?.code === 'ConcurrentModification');
};
