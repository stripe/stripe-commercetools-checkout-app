import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// The client module builds a real commercetools API client at import time (credentials, ts-client).
// Replacing it with a mock keeps this a pure unit test of the wiring in `resolveOrderForWrite` — no
// network, no env, no SDK — and lets each test hand back a crafted order.
jest.mock('../src/clients/ct.client', () => ({
  apiRoot: { orders: jest.fn() },
}));

import { resolveOrderForWrite } from '../src/clients/order.client';
import { apiRoot } from '../src/clients/ct.client';
import { log } from '../src/logger';
import { PAYMENT_INTERFACE } from '../src/constants';

/** cents helper so the money literals read as amounts, not magic numbers. */
const money = (centAmount: number, currencyCode: string) => ({
  type: 'centPrecision',
  centAmount,
  currencyCode,
  fractionDigits: 2,
});

type Tx = { type: string; state: string; amount?: { centAmount: number; currencyCode: string } };
type PaymentSpec = { paymentInterface?: string; transactions?: Tx[] };

/**
 * Builds the expanded order shape `resolveOrderForWrite` reads: `paymentInfo.payments[*].obj` carries
 * the interface (for the ownership filter) and the transactions (for the coverage decision). The
 * caller expands `paymentInfo.payments[*]`, so `obj` is always populated in production.
 */
const anOrder = (opts: {
  paymentState?: string;
  totalPrice?: { centAmount: number; currencyCode: string };
  taxedPriceGross?: { centAmount: number; currencyCode: string };
  payments?: PaymentSpec[];
}) => ({
  id: 'order-1',
  version: 3,
  paymentState: opts.paymentState,
  totalPrice: opts.totalPrice ?? money(50000, 'USD'),
  ...(opts.taxedPriceGross ? { taxedPrice: { totalGross: opts.taxedPriceGross } } : {}),
  paymentInfo: {
    payments: (opts.payments ?? []).map((p, i) => ({
      typeId: 'payment',
      id: `pay-${i}`,
      obj: {
        id: `pay-${i}`,
        paymentMethodInfo: { paymentInterface: p.paymentInterface ?? PAYMENT_INTERFACE },
        transactions: p.transactions ?? [],
      },
    })),
  },
});

/** Arranges `apiRoot.orders().withId().get().execute()` to resolve the given order body. */
const arrangeOrderGet = (order: unknown) => {
  const execute = jest.fn<() => Promise<{ body: unknown }>>().mockResolvedValue({ body: order });
  const get = jest.fn(() => ({ execute }));
  const withId = jest.fn(() => ({ get }));
  (apiRoot.orders as jest.Mock).mockReturnValue({ withId });
};

const chargeSuccess = (centAmount: number, currencyCode = 'USD'): Tx => ({
  type: 'Charge',
  state: 'Success',
  amount: { centAmount, currencyCode },
});

describe('resolveOrderForWrite — gross-total wiring and the coverage decision', () => {
  beforeEach(() => {
    jest.spyOn(log, 'info').mockImplementation(() => undefined);
    jest.spyOn(log, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (apiRoot.orders as jest.Mock).mockReset();
  });

  // ***** RELEASE GATE — the cross-cart binding exploit, at the wiring level *****
  // A settled charge that does NOT cover the order's gross must NOT produce a `Paid` target. The
  // function returns undefined (manual review) rather than Paid or Pending.
  test('RELEASE GATE: a settled charge that undercovers the gross returns undefined, never Paid', async () => {
    arrangeOrderGet(
      anOrder({
        paymentState: undefined,
        totalPrice: money(100000, 'USD'),
        payments: [{ transactions: [chargeSuccess(50000)] }],
      }),
    );

    const result = await resolveOrderForWrite('order-1');

    expect(result).toBeUndefined();
    // ...and undercoverage is logged at WARN (a security signal, alertable), distinct from the INFO
    // manual-capture case — the P4 level split.
    expect(log.warn).toHaveBeenCalledWith(
      'Order paymentState not written: settled charges do not cover the order gross total',
      expect.objectContaining({
        reason: expect.stringContaining('cross-cart'),
        orderGrossCentAmount: 100000,
        orderCurrency: 'USD',
      }),
    );
    expect(log.info).not.toHaveBeenCalledWith(
      'No payment state follows from these transactions — leaving it to the merchant process',
      expect.anything(),
    );
  });

  // ***** MIRROR ***** — exact coverage and overpayment must still resolve to Paid.
  test('MIRROR: a charge that exactly covers the gross resolves to Paid', async () => {
    arrangeOrderGet(anOrder({ totalPrice: money(50000, 'USD'), payments: [{ transactions: [chargeSuccess(50000)] }] }));

    const result = await resolveOrderForWrite('order-1');

    expect(result).toEqual(expect.objectContaining({ id: 'order-1', version: 3, targetPaymentState: 'Paid' }));
  });

  test('overpayment (charge exceeds the gross) resolves to Paid', async () => {
    arrangeOrderGet(anOrder({ totalPrice: money(50000, 'USD'), payments: [{ transactions: [chargeSuccess(50001)] }] }));

    const result = await resolveOrderForWrite('order-1');

    expect(result?.targetPaymentState).toBe('Paid');
  });

  // ***** RELEASE GATE — split tender (P1 regression fix) *****
  // Coverage sums across ALL the order's payments, not only ours. Our card ($100) plus a gift card
  // charged through ANOTHER connector ($320) cover the $420 gross; our charge alone does not. Before
  // the fix this legitimately-paid order was wrongly left unpaid.
  test('split tender: our card + a sibling-connector gift card together cover the gross -> Paid', async () => {
    arrangeOrderGet(
      anOrder({
        totalPrice: money(42000, 'USD'),
        payments: [
          { transactions: [chargeSuccess(10000)] }, // ours (checkout-stripe)
          { paymentInterface: 'other-connector', transactions: [chargeSuccess(32000)] }, // sibling
        ],
      }),
    );

    const result = await resolveOrderForWrite('order-1');

    expect(result?.targetPaymentState).toBe('Paid');
  });

  // ...but a sibling charge CANNOT substitute for our involvement: if we never settled a charge, the
  // big sibling charge does not make us stamp Paid.
  test('split tender: a sibling charge with no charge of ours writes nothing (involvement gate)', async () => {
    arrangeOrderGet(
      anOrder({
        totalPrice: money(42000, 'USD'),
        payments: [
          { transactions: [{ type: 'Authorization', state: 'Success' }] }, // ours — auth only, no charge
          { paymentInterface: 'other-connector', transactions: [chargeSuccess(60000)] }, // sibling covers alone
        ],
      }),
    );

    const result = await resolveOrderForWrite('order-1');

    expect(result).toBeUndefined();
  });

  // ***** RELEASE GATE — the gross is TAX-INCLUSIVE *****
  // When `taxedPrice` is present, the gross MUST be `taxedPrice.totalGross`, not the pre-tax
  // `totalPrice`. A charge covering only the net leaves a tax-sized hole the exploit would slip through.
  test('RELEASE GATE: uses taxedPrice.totalGross over totalPrice when taxedPrice is present', async () => {
    arrangeOrderGet(
      anOrder({
        totalPrice: money(10000, 'USD'), // pre-tax
        taxedPriceGross: money(12000, 'USD'), // tax-inclusive gross
        payments: [{ transactions: [chargeSuccess(10000)] }], // covers net, NOT gross
      }),
    );

    const result = await resolveOrderForWrite('order-1');

    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Order paymentState not written: settled charges do not cover the order gross total',
      expect.objectContaining({ orderGrossCentAmount: 12000, orderCurrency: 'USD' }),
    );
  });

  // ***** MIRROR ***** — without taxedPrice, the gross falls back to totalPrice.
  test('MIRROR: falls back to totalPrice when the order has no taxedPrice', async () => {
    arrangeOrderGet(
      anOrder({
        totalPrice: money(12000, 'USD'),
        taxedPriceGross: undefined,
        payments: [{ transactions: [chargeSuccess(12000)] }],
      }),
    );

    const result = await resolveOrderForWrite('order-1');

    expect(result?.targetPaymentState).toBe('Paid');
  });

  // The other branch of the reason split: an authorization with no charge is ordinary manual capture,
  // and its log must NOT read as undercoverage.
  test('an authorization with no charge logs the manual-capture reason, not undercoverage', async () => {
    arrangeOrderGet(anOrder({ payments: [{ transactions: [{ type: 'Authorization', state: 'Success' }] }] }));

    const result = await resolveOrderForWrite('order-1');

    expect(result).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      'No payment state follows from these transactions — leaving it to the merchant process',
      expect.objectContaining({ reason: expect.stringContaining('manual capture') }),
    );
  });

  // A pending authorization (bank transfer awaiting funds) still resolves to Pending — the gross is
  // computed and passed, but an unsettled rail is not subject to the coverage gate.
  test('a pending authorization resolves to Pending regardless of gross', async () => {
    arrangeOrderGet(
      anOrder({
        totalPrice: money(50000, 'USD'),
        payments: [{ transactions: [{ type: 'Authorization', state: 'Pending' }] }],
      }),
    );

    const result = await resolveOrderForWrite('order-1');

    expect(result?.targetPaymentState).toBe('Pending');
  });

  // Coverage is judged only over THIS connector's payments: a sibling connector's charge, however
  // large, never contributes — an order with only a foreign payment is not ours to write at all.
  test('a charge on a sibling connector payment does not count toward coverage', async () => {
    arrangeOrderGet(
      anOrder({
        totalPrice: money(50000, 'USD'),
        payments: [{ paymentInterface: 'stripe', transactions: [chargeSuccess(999999)] }],
      }),
    );

    const result = await resolveOrderForWrite('order-1');

    // Not ours → skipped before the coverage decision is even reached.
    expect(result).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      'Order is not paid through this connector — skipping',
      expect.objectContaining({ orderId: 'order-1' }),
    );
  });
});
