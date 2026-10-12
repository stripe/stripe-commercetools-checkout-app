import { describe, expect, test } from '@jest/globals';
import { PaymentLike, resolveTargetPaymentState, shouldWritePending } from '../src/guard';
import { buildSubscriptionKey, SUBSCRIPTION_KEY_BASE } from '../src/constants';

/**
 * The order's tax-inclusive gross that a settled charge must cover to resolve `Paid`. Every
 * `resolveTargetPaymentState` call in this file passes this unless it is probing the coverage guard
 * itself, and the covering charges below are denominated to match it.
 */
const GROSS = { centAmount: 50000, currencyCode: 'USD' };

/**
 * Terse transaction builder — `tx('Authorization', 'Pending')`, or with a per-transaction amount
 * `tx('Charge', 'Success', { centAmount: 50000, currencyCode: 'USD' })`. A `Charge/Success` needs an
 * amount to count toward coverage; authorizations and failures never do, so their amount is optional.
 */
const tx = (type: string, state: string, amount?: { centAmount: number; currencyCode: string }) => ({
  type,
  state,
  ...(amount ? { amount } : {}),
});
/** A `Charge/Success` that exactly covers GROSS — the shape a fully-settled card leaves behind. */
const coveringCharge = () => tx('Charge', 'Success', GROSS);
const payment = (
  ...transactions: Array<{
    type: string;
    state: string;
    amount?: { centAmount: number; currencyCode: string };
  }>
): PaymentLike => ({ transactions });

/**
 * The rails as they actually came back from commercetools on 2026-08-20, against the deployed
 * connector, read at the moment `OrderCreated` fired. These are transcriptions of real orders, not
 * invented shapes — the first version of this guard was wrong precisely because every invented
 * fixture looked like the bank transfer.
 */
const REAL = {
  // orders f6aed02a / 2d1c5104 — customer_balance. At OrderCreated the authorization was still
  // pending; the charge appeared 61 s and 604 s later respectively, when the transfer was funded.
  bankTransferAwaitingFunds: payment(tx('Authorization', 'Pending')),
  // order 56b9b31c — card, no 3DS. Charge landed 877 ms BEFORE the order existed. Its Charge covers
  // the order gross, which is what a legitimately-paid card looks like (and what the cross-cart
  // exploit fails to produce).
  cardNo3ds: payment(tx('Authorization', 'Success'), coveringCharge()),
  // order 547df304 — card, 3DS challenge completed and authenticated. Charge landed 701 ms BEFORE.
  card3ds: payment(tx('Authorization', 'Success'), coveringCharge()),
  // order e47dd1a0 — card through the deployed build. Charge landed 333 ms BEFORE.
  cardDeployed: payment(tx('Authorization', 'Success'), coveringCharge()),
  // payment d85f2640 — a REDIRECT rail (crypto) the shopper never came back from. Stripe left the
  // PaymentIntent in requires_action/redirect_to_url and commercetools never created an order, but
  // the CT payment survives on a still-Active cart carrying only Authorization/Initial. Observed
  // 2026-08-21; `Initial` appears on no other rail tested and was missing from these fixtures until
  // a real run produced it.
  abandonedRedirect: payment(tx('Authorization', 'Initial')),
  // order 564070df — card + 3DS challenge authenticated. The order was created from the cart the
  // abandoned crypto attempt above had left Active, so it carries BOTH payments, and the abandoned
  // one is FIRST. This is the shape that makes `ourPayments` returning every match load-bearing
  // rather than tidy: judged by payments[0] alone the order resolves to nothing, and a charged card
  // ends up with no payment state at all.
  card3dsBehindAbandonedRedirect: [
    payment(tx('Authorization', 'Initial')),
    payment(tx('Authorization', 'Success'), coveringCharge()),
  ],
};

describe('shouldWritePending', () => {
  // The whole rule: write only onto an order with no state. Everything else is someone else's write
  // and must survive untouched.
  test.each([
    [undefined, true],
    [null, true],
    ['', true],
    ['Pending', false],
    ['Paid', false],
    ['Failed', false],
    ['BalanceDue', false],
    ['CreditOwed', false],
  ])('current=%s -> %s', (current, expected) => {
    expect(shouldWritePending(current as string | undefined | null)).toBe(expected);
  });

  // ***** RELEASE GATE *****
  // The single cell that matters. A synchronous card's payment_intent.succeeded can write Paid before
  // this app processes the OrderCreated message. If this ever returns true, the subscriber overwrites
  // a real Paid with Pending — money marked unpaid.
  test('RELEASE GATE: never writes over an existing Paid', () => {
    expect(shouldWritePending('Paid')).toBe(false);
  });

  // ***** MIRROR *****
  // The gate above is equally satisfied by a function that always returns false, which would make the
  // whole module dead. This is what distinguishes "correctly refuses" from "refuses everything".
  test('MIRROR: still writes onto an unset order', () => {
    expect(shouldWritePending(undefined)).toBe(true);
  });
});

describe('resolveTargetPaymentState', () => {
  // ***** RELEASE GATE 1 — the reason this module exists at all *****
  // For a card the order is created AFTER the money settles (333/701/877 ms, three real runs), so
  // payment_intent.succeeded reaches the processor with no order to write and no later event ever
  // arrives. If these stop returning Paid, a settled card is recorded as unpaid by nobody.
  test.each([
    ['card, no 3DS (56b9b31c)', REAL.cardNo3ds],
    ['card, 3DS authenticated (547df304)', REAL.card3ds],
    ['card, deployed build (e47dd1a0)', REAL.cardDeployed],
  ])('RELEASE GATE: a settled %s resolves to Paid', (_label, p) => {
    expect(resolveTargetPaymentState([p], GROSS)).toBe('Paid');
  });

  // ***** RELEASE GATE 2 *****
  // The gate above is satisfied by a function that always returns Paid — which would mark an
  // unfunded bank transfer as paid, the most expensive possible failure of this module.
  test('RELEASE GATE: a bank transfer awaiting funds resolves to Pending, never Paid', () => {
    expect(resolveTargetPaymentState([REAL.bankTransferAwaitingFunds], GROSS)).toBe('Pending');
  });

  // ***** MIRROR *****
  // Both gates are satisfied by a function that returns a state for everything. This is the
  // assertion that keeps the manual-capture case genuinely unwritten rather than guessed at.
  test('MIRROR: an authorization with no charge resolves to nothing', () => {
    expect(resolveTargetPaymentState([payment(tx('Authorization', 'Success'))], GROSS)).toBeUndefined();
  });

  test.each([
    ['charge success only', [payment(coveringCharge())], 'Paid'],
    ['pending authorization only', [payment(tx('Authorization', 'Pending'))], 'Pending'],
    [
      'pending authorization + failed charge',
      [payment(tx('Authorization', 'Pending'), tx('Charge', 'Failure'))],
      'Pending',
    ],
    ['authorization success only (manual capture)', [payment(tx('Authorization', 'Success'))], undefined],
    ['authorization failure only', [payment(tx('Authorization', 'Failure'))], undefined],
    ['authorization initial only (abandoned redirect)', [REAL.abandonedRedirect], undefined],
    ['charge failure only', [payment(tx('Charge', 'Failure'))], undefined],
    ['no transactions at all', [payment()], undefined],
    ['no payments at all', [], undefined],
    ['payment with no transactions field', [{}], undefined],
  ])('%s -> %s', (_label, payments, expected) => {
    expect(resolveTargetPaymentState(payments as PaymentLike[], GROSS)).toBe(expected);
  });

  // Paid outranks Pending, and for a retried checkout that precedence is the whole point: an
  // abandoned bank transfer leaves its pending authorization on the order forever, so ranking the
  // other way would freeze a subsequently-paid order as pending while the money sat in the account.
  test('Paid outranks Pending on the same payment', () => {
    expect(resolveTargetPaymentState([payment(tx('Authorization', 'Pending'), coveringCharge())], GROSS)).toBe('Paid');
  });

  test('Paid outranks Pending across a retried checkout, whatever the order of attempts', () => {
    const abandonedTransfer = payment(tx('Authorization', 'Pending'));
    const laterCard = payment(tx('Authorization', 'Success'), coveringCharge());
    expect(resolveTargetPaymentState([abandonedTransfer, laterCard], GROSS)).toBe('Paid');
    expect(resolveTargetPaymentState([laterCard, abandonedTransfer], GROSS)).toBe('Paid');
  });

  // The reason ourPayments() returns every match instead of the first: for a retry the first is the
  // failed attempt, and judging the order by it would miss the live one.
  test('finds the pending attempt behind an earlier failure', () => {
    const payments = [payment(tx('Authorization', 'Failure')), payment(tx('Authorization', 'Pending'))];
    expect(resolveTargetPaymentState(payments, GROSS)).toBe('Pending');
  });

  // ***** RELEASE GATE — transcribed from order 564070df, 2026-08-21 *****
  // An abandoned redirect leaves its CT payment on a still-Active cart, so the next order built from
  // that cart carries the dead payment FIRST and the real one second. Judged by payments[0] this
  // resolves to nothing and a charged 3DS card silently gets no payment state. This is the only
  // release gate here produced by an accident rather than by design, which is exactly why it stays.
  test('RELEASE GATE: a settled card behind an abandoned redirect payment still resolves to Paid', () => {
    expect(resolveTargetPaymentState(REAL.card3dsBehindAbandonedRedirect, GROSS)).toBe('Paid');
  });

  // ***** MIRROR *****
  // The gate above passes for a function that ignores position entirely — including one that would
  // also return Paid when the ONLY payment is the dead redirect. This separates "looks past the dead
  // payment" from "ignores the dead payment's meaning".
  test('MIRROR: the abandoned redirect payment on its own still resolves to nothing', () => {
    expect(resolveTargetPaymentState([REAL.abandonedRedirect], GROSS)).toBeUndefined();
  });

  // Order independence: nothing may depend on which attempt commercetools happens to list first.
  test('resolves the same whichever attempt is listed first', () => {
    const [dead, live] = REAL.card3dsBehindAbandonedRedirect;
    expect(resolveTargetPaymentState([dead, live], GROSS)).toBe('Paid');
    expect(resolveTargetPaymentState([live, dead], GROSS)).toBe('Paid');
  });

  // ***** RELEASE GATE — the cross-cart binding exploit (fix/checkout-XX) *****
  // A Payment created on a cheap cart, re-pointed at an expensive order before settlement, settles
  // for the cheap amount. The Charge/Success is REAL, but it does not cover the order's gross. Before
  // this guard the settled charge alone stamped the big order Paid. It must now resolve to nothing
  // (manual review) — and specifically NOT to Pending: the money settled, so Pending would lie.
  test('RELEASE GATE: a settled charge that undercovers the gross resolves to nothing, never Paid', () => {
    const underCoveringCharge = payment(
      tx('Authorization', 'Success'),
      tx('Charge', 'Success', { centAmount: 500, currencyCode: 'USD' }),
    );
    expect(resolveTargetPaymentState([underCoveringCharge], GROSS)).toBeUndefined();
  });

  // Even with a pending authorization also present, undercoverage does NOT fall through to Pending.
  test('an undercovering charge does not fall through to Pending even with a pending authorization', () => {
    const p = payment(
      tx('Authorization', 'Pending'),
      tx('Charge', 'Success', { centAmount: 500, currencyCode: 'USD' }),
    );
    expect(resolveTargetPaymentState([p], GROSS)).toBeUndefined();
  });

  // ***** MIRROR *****
  // The gate above is satisfied by a function that never returns Paid. Exact coverage and legitimate
  // overpayment must still resolve to Paid, or the fix would break every real card payment.
  test('MIRROR: a charge that exactly covers the gross resolves to Paid', () => {
    const p = payment(
      tx('Authorization', 'Success'),
      tx('Charge', 'Success', {
        centAmount: GROSS.centAmount,
        currencyCode: 'USD',
      }),
    );
    expect(resolveTargetPaymentState([p], GROSS)).toBe('Paid');
  });

  test('overpayment (charge exceeds the gross) still resolves to Paid', () => {
    const p = payment(
      tx('Authorization', 'Success'),
      tx('Charge', 'Success', {
        centAmount: GROSS.centAmount + 1,
        currencyCode: 'USD',
      }),
    );
    expect(resolveTargetPaymentState([p], GROSS)).toBe('Paid');
  });

  // Coverage may be spread across a retried checkout's several payments — the sum, not any single
  // charge, is what counts.
  test('charges spread across two payments sum to cover the gross', () => {
    const half = () =>
      payment(
        tx('Charge', 'Success', {
          centAmount: GROSS.centAmount / 2,
          currencyCode: 'USD',
        }),
      );
    expect(resolveTargetPaymentState([half(), half()], GROSS)).toBe('Paid');
  });

  // ***** RELEASE GATE — currency safety *****
  // centAmounts are NEVER summed across currencies. A charge denominated in another currency does not
  // count toward coverage no matter how large its number, so it can never cover the order.
  test('RELEASE GATE: a charge in a different currency never counts toward coverage', () => {
    const wrongCurrency = payment(tx('Charge', 'Success', { centAmount: 999999, currencyCode: 'JPY' }));
    expect(resolveTargetPaymentState([wrongCurrency], GROSS)).toBeUndefined();
  });

  // ─── Split tender — involvement on OURS, coverage on ALL (P1 regression fix) ───

  // ***** MIRROR / regression gate *****
  // A legitimately split-tendered order: our card ($100) plus a gift card charged through ANOTHER
  // connector ($320), gross $420. Our charge alone does not cover, but together they do — and before
  // this fix the all-ours coverage sum wrongly left such orders unpaid.
  test('split tender: our charge + a sibling connector charge together cover the gross -> Paid', () => {
    const ourCard = payment(
      tx('Authorization', 'Success'),
      tx('Charge', 'Success', { centAmount: 10000, currencyCode: 'USD' }),
    );
    const giftCard = payment(tx('Charge', 'Success', { centAmount: 40000, currencyCode: 'USD' }));
    // ours alone (10000) < 50000; ours + sibling (50000) >= 50000.
    expect(resolveTargetPaymentState([ourCard], GROSS, [ourCard, giftCard])).toBe('Paid');
  });

  // ***** RELEASE GATE — involvement is still required *****
  // We only write for an order WE settled a charge on. A big sibling charge with NO charge of ours
  // (just an abandoned authorization) must NOT make us stamp Paid — that order is not ours to judge.
  test('split tender: a sibling charge with no charge of ours writes nothing (involvement gate)', () => {
    const ourAuthOnly = payment(tx('Authorization', 'Success'));
    const giftCard = payment(tx('Charge', 'Success', { centAmount: 60000, currencyCode: 'USD' }));
    expect(resolveTargetPaymentState([ourAuthOnly], GROSS, [ourAuthOnly, giftCard])).toBeUndefined();
  });

  // ***** RELEASE GATE — exploit stays closed under split-tender coverage *****
  // Our real small charge ($5) plus a real sibling charge ($10) still fall short of the $500 gross:
  // the attacker cannot reach coverage because they cannot forge a Success (MyTransactionDraft has no
  // state field), and every real Success summed here is small.
  test('split tender: our charge + siblings still undercovering the gross -> undefined', () => {
    const ourCard = payment(tx('Charge', 'Success', { centAmount: 500, currencyCode: 'USD' }));
    const sibling = payment(tx('Charge', 'Success', { centAmount: 1000, currencyCode: 'USD' }));
    expect(resolveTargetPaymentState([ourCard], GROSS, [ourCard, sibling])).toBeUndefined();
  });
});

describe('the two guards answer independent questions', () => {
  // shouldWritePending asks about the ORDER ("is the field free"), resolveTargetPaymentState about
  // the PAYMENT ("what is true"). Collapsing them is how this module first shipped wrong: an unset
  // order is necessary but NOT sufficient, and taking it as sufficient stamped Pending on everything.
  test('an unset order is not on its own a reason to write Pending', () => {
    expect(shouldWritePending(undefined)).toBe(true);
    expect(resolveTargetPaymentState([REAL.cardNo3ds], GROSS)).not.toBe('Pending');
  });

  // The order guard still protects a state someone else already wrote, whatever the payment says.
  test('an order already Paid is never revisited, even mid-flight', () => {
    expect(shouldWritePending('Paid')).toBe(false);
  });
});

describe('buildSubscriptionKey', () => {
  test('is unique per topic, so two deployments cannot delete each other', () => {
    const a = buildSubscriptionKey('projects/p/topics/connect-aaa-order');
    const b = buildSubscriptionKey('projects/p/topics/connect-bbb-order');
    expect(a).not.toBe(b);
  });

  test('is stable for the same topic, so a redeploy reuses its own key', () => {
    expect(buildSubscriptionKey('connect-abc')).toBe(buildSubscriptionKey('connect-abc'));
  });

  // commercetools rejects keys outside [A-Za-z0-9_-], and a GCP topic path contains slashes.
  test('sanitises characters commercetools rejects', () => {
    expect(buildSubscriptionKey('projects/p/topics/t')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('stays within the 256-char key limit', () => {
    expect(buildSubscriptionKey('x'.repeat(400)).length).toBeLessThanOrEqual(256);
  });

  // Sharing a key with the tax connector would make each deploy wipe the other's subscription.
  test('does not collide with the tax connector key', () => {
    expect(SUBSCRIPTION_KEY_BASE).not.toContain('tax');
  });
});
