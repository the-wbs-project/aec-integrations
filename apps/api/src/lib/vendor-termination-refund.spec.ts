import { describe, expect, it } from 'vitest';

import {
  allocateRefunds,
  buildTerminationStatement,
  grossRefundCents,
  type CostLogLine,
  type RefundablePayment,
} from './vendor-termination-refund';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const YEAR = { periodStart: at('2026-01-01T00:00:00Z'), periodEnd: at('2027-01-01T00:00:00Z') };

const annual = (paidCents = 25_000, key = 'a'): RefundablePayment => ({
  key,
  source: 'stripe',
  paidCents,
  lines: [{ amountCents: 25_000, ...YEAR }],
});

describe('grossRefundCents', () => {
  it('refunds paid x unused days / term days on an annual', () => {
    // 31 days used of 365: 334 unused. 25000 x 334 / 365 = 22876.7
    expect(grossRefundCents(annual(), at('2026-02-01T09:30:00Z'))).toBe(22877);
  });

  it('refunds a monthly the same way', () => {
    const monthly: RefundablePayment = {
      key: 'm',
      source: 'stripe',
      paidCents: 2_500,
      lines: [
        {
          amountCents: 2_500,
          periodStart: at('2026-03-01T00:00:00Z'),
          periodEnd: at('2026-03-31T00:00:00Z'),
        },
      ],
    };
    expect(grossRefundCents(monthly, at('2026-03-16T00:00:00Z'))).toBe(1_250);
  });

  it('refunds a renewal charged inside the window in full (ruling 3)', () => {
    const renewal: RefundablePayment = {
      key: 'r',
      source: 'stripe',
      paidCents: 25_000,
      lines: [
        {
          amountCents: 25_000,
          periodStart: at('2026-11-08T00:00:00Z'),
          periodEnd: at('2027-11-08T00:00:00Z'),
        },
      ],
    };
    expect(grossRefundCents(renewal, at('2026-11-05T12:00:00Z'))).toBe(25_000);
  });

  it('prorates what is left after an earlier partial refund', () => {
    expect(grossRefundCents(annual(10_000), at('2026-07-02T00:00:00Z'))).toBe(5_014);
  });

  it('weights a mid-term addition by its own period', () => {
    const payment: RefundablePayment = {
      key: 'p',
      source: 'stripe',
      paidCents: 12_500,
      lines: [
        {
          amountCents: 12_500,
          periodStart: at('2026-07-01T00:00:00Z'),
          periodEnd: at('2027-01-01T00:00:00Z'),
        },
      ],
    };
    // 184-day line, 92 used: half of it.
    expect(grossRefundCents(payment, at('2026-10-01T00:00:00Z'))).toBe(6_250);
  });

  it('keeps tax proportional: the share applies to the whole amount paid', () => {
    expect(
      grossRefundCents(
        { ...annual(26_750), lines: [{ amountCents: 25_000, ...YEAR }] },
        at('2026-07-02T00:00:00Z'),
      ),
    ).toBe(13_412);
  });

  it('gives a credit line no weight and refunds nothing on a period already over', () => {
    const payment: RefundablePayment = {
      key: 'c',
      source: 'stripe',
      paidCents: 1_000,
      lines: [
        { amountCents: 1_000, ...YEAR },
        { amountCents: -500, ...YEAR },
      ],
    };
    expect(grossRefundCents(payment, at('2027-02-01T00:00:00Z'))).toBe(0);
  });

  it('refunds nothing on a payment with nothing paid', () => {
    expect(grossRefundCents(annual(0), at('2026-02-01T00:00:00Z'))).toBe(0);
  });
});

describe('allocateRefunds', () => {
  const when = at('2026-01-01T00:00:00Z');

  it('takes the cost from the largest payment first', () => {
    const rows = allocateRefunds([annual(10_000, 'small'), annual(20_000, 'large')], when, 5_000);
    expect(rows.map((r) => [r.payment.key, r.refundCents])).toEqual([
      ['small', 10_000],
      ['large', 15_000],
    ]);
  });

  it('spills into the next payment, and never goes negative', () => {
    const rows = allocateRefunds([annual(10_000, 'small'), annual(20_000, 'large')], when, 99_000);
    expect(rows.map((r) => r.refundCents)).toEqual([0, 0]);
    expect(rows.map((r) => r.costAppliedCents)).toEqual([10_000, 20_000]);
  });
});

describe('buildTerminationStatement', () => {
  const line = (over: Partial<CostLogLine>): CostLogLine => ({
    kind: 'staff',
    workDate: '2026-02-01',
    description: 'Review the edits',
    minutes: null,
    amountCents: null,
    loggedAt: '2026-02-01T10:00:00.000Z',
    ...over,
  });
  const costs: CostLogLine[] = [
    line({ minutes: 90 }),
    line({ kind: 'third_party', description: 'Chargeback fee', amountCents: 1_500 }),
  ];

  it('itemizes staff time at $150 an hour and costs paid to others', () => {
    const { statement } = buildTerminationStatement({
      payments: [annual()],
      costLog: costs,
      suspendedAt: '2026-02-01T09:30:00.000Z',
      currency: 'usd',
    });
    expect(statement.costs.map((c) => c.cents)).toEqual([22_500, 1_500]);
    expect(statement.cost_total_cents).toBe(24_000);
    expect(statement.gross_cents).toBe(22_877);
    // The cost is capped at the pre-cost refund, so the statement is never negative.
    expect(statement.cost_applied_cents).toBe(22_877);
    expect(statement.refund_cents).toBe(0);
  });

  it('credits a recovery against the cost, floored at zero', () => {
    const { statement } = buildTerminationStatement({
      payments: [annual()],
      costLog: [
        line({ minutes: 60 }),
        line({ kind: 'recovery', description: 'Chargeback won', amountCents: 20_000 }),
      ],
      suspendedAt: '2026-02-01T09:30:00.000Z',
      currency: 'usd',
    });
    expect(statement.costs.map((c) => c.cents)).toEqual([15_000, -20_000]);
    expect(statement.cost_total_cents).toBe(0);
    expect(statement.refund_cents).toBe(22_877);
  });

  it('refunds the whole gross with no cost', () => {
    const { statement } = buildTerminationStatement({
      payments: [annual()],
      costLog: [],
      suspendedAt: '2026-02-01T09:30:00.000Z',
      currency: 'usd',
    });
    expect(statement.refund_cents).toBe(22_877);
  });

  it('states zero with no paid subscription', () => {
    const { statement, allocations } = buildTerminationStatement({
      payments: [],
      costLog: costs,
      suspendedAt: '2026-02-01T09:30:00.000Z',
      currency: 'usd',
    });
    expect(allocations).toEqual([]);
    expect(statement.refund_cents).toBe(0);
    expect(statement.cost_applied_cents).toBe(0);
  });
});
