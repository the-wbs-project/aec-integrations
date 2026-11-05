/**
 * The termination refund (AECI-1623, rulings 2 and 3 of 2026-11-05). Pure, integer cents.
 *
 *   refund = paid x unused days / term days, minus cost, floored at zero
 *
 * "The fees for the period used" in the Managed plan agreement name the same split, so
 * nothing is deducted twice. The period used ends on the suspension date, because the
 * vendor could not use the portal after it: a period that starts on or after that date
 * is fully unused, so a renewal charged inside the window comes back in full before cost.
 * Cost is capped at the pre-cost refund, so the refund never goes negative. Only a
 * logged cost the breach caused counts, recoveries are credited, and nothing else is
 * kept: the balance of the unused term always goes back (counsel's Q13 follow-up).
 */

import { ABUSE_STAFF_CENTS_PER_MINUTE, type TerminationStatement } from '@aeci/shared';

const SECONDS_PER_DAY = 86_400;

/** One invoice line, or the whole term of an invoice-paid subscription. */
export interface RefundLine {
  amountCents: number;
  /** Unix seconds. */
  periodStart: number;
  periodEnd: number;
}

/** One payment that may be refunded. */
export interface RefundablePayment {
  key: string;
  source: 'stripe' | 'invoice';
  /** What the vendor paid, net of anything already refunded on it. */
  paidCents: number;
  lines: readonly RefundLine[];
  licenseId?: string;
  stripeSubscriptionId?: string | null;
  stripeInvoiceId?: string;
  stripePaymentIntentId?: string;
}

export interface RefundAllocation {
  payment: RefundablePayment;
  grossCents: number;
  costAppliedCents: number;
  refundCents: number;
}

const utcDay = (seconds: number): number => Math.floor(seconds / SECONDS_PER_DAY);

/** A line's unused share, in whole UTC days. The suspension day itself is unused. */
export function unusedShare(line: RefundLine, suspendedAtSeconds: number): number {
  const termDays = Math.max(1, utcDay(line.periodEnd) - utcDay(line.periodStart));
  const usedDays = Math.min(
    termDays,
    Math.max(0, utcDay(suspendedAtSeconds) - utcDay(line.periodStart)),
  );
  return (termDays - usedDays) / termDays;
}

/**
 * The pre-cost refund of one payment. Each line's unused share is weighted by its
 * amount, so tax, a coupon and a mid-term addition stay proportional. A credit line
 * carries no weight.
 */
export function grossRefundCents(payment: RefundablePayment, suspendedAtSeconds: number): number {
  if (payment.paidCents <= 0) return 0;
  const charged = payment.lines.filter((l) => l.amountCents > 0);
  const total = charged.reduce((sum, l) => sum + l.amountCents, 0);
  if (total <= 0) return 0;
  const unused = charged.reduce(
    (sum, l) => sum + l.amountCents * unusedShare(l, suspendedAtSeconds),
    0,
  );
  return Math.min(payment.paidCents, Math.round((payment.paidCents * unused) / total));
}

/** One live entry of the abuse cost log. */
export interface CostLogLine {
  kind: 'staff' | 'third_party' | 'recovery';
  workDate: string;
  description: string;
  minutes: number | null;
  amountCents: number | null;
  loggedAt: string;
}

/** What one log line counts for. Staff time is $150 an hour. A recovery is credited. */
export function costLineCents(line: CostLogLine): number {
  if (line.kind === 'staff') return (line.minutes ?? 0) * ABUSE_STAFF_CENTS_PER_MINUTE;
  const amount = line.amountCents ?? 0;
  return line.kind === 'recovery' ? -amount : amount;
}

/** The log's total, recoveries credited, floored at zero. */
export function costTotalCents(lines: readonly CostLogLine[]): number {
  return Math.max(
    0,
    lines.reduce((sum, l) => sum + costLineCents(l), 0),
  );
}

/**
 * Splits the applied cost across the payments, largest refund first, so the fewest
 * refunds shrink. The applied cost is `min(total cost, total gross)`.
 */
export function allocateRefunds(
  payments: readonly RefundablePayment[],
  suspendedAtSeconds: number,
  costTotalCents: number,
): RefundAllocation[] {
  const rows = payments.map((payment) => ({
    payment,
    grossCents: grossRefundCents(payment, suspendedAtSeconds),
    costAppliedCents: 0,
    refundCents: 0,
  }));
  const gross = rows.reduce((sum, r) => sum + r.grossCents, 0);
  let left = Math.min(Math.max(0, costTotalCents), gross);
  const order = [...rows].sort(
    (a, b) => b.grossCents - a.grossCents || (a.payment.key < b.payment.key ? -1 : 1),
  );
  for (const row of order) {
    const take = Math.min(left, row.grossCents);
    row.costAppliedCents = take;
    left -= take;
  }
  for (const row of rows) row.refundCents = row.grossCents - row.costAppliedCents;
  return rows;
}

const isoFromSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString();

function linePeriod(payment: RefundablePayment): { start: string | null; end: string | null } {
  if (payment.lines.length === 0) return { start: null, end: null };
  return {
    start: isoFromSeconds(Math.min(...payment.lines.map((l) => l.periodStart))),
    end: isoFromSeconds(Math.max(...payment.lines.map((l) => l.periodEnd))),
  };
}

/** The statement rows of a set of allocations. Shared by the preview and the statement. */
export function statementPayments(
  allocations: readonly RefundAllocation[],
): TerminationStatement['payments'] {
  return allocations.map((a) => {
    const period = linePeriod(a.payment);
    return {
      key: a.payment.key,
      source: a.payment.source,
      period_start: period.start,
      period_end: period.end,
      paid_cents: a.payment.paidCents,
      gross_cents: a.grossCents,
      cost_applied_cents: a.costAppliedCents,
      refund_cents: a.refundCents,
    };
  });
}

/** The whole calculation, with the itemized statement the vendor is sent. */
export function buildTerminationStatement(p: {
  payments: readonly RefundablePayment[];
  costLog: readonly CostLogLine[];
  suspendedAt: string;
  currency: string;
}): { allocations: RefundAllocation[]; statement: TerminationStatement } {
  const suspendedAtSeconds = Math.floor(Date.parse(p.suspendedAt) / 1000);
  const costs = p.costLog.map((line) => ({
    kind: line.kind,
    date: line.workDate,
    description: line.description,
    minutes: line.minutes,
    cents: costLineCents(line),
    logged_at: line.loggedAt,
  }));
  const costTotal = costTotalCents(p.costLog);
  const allocations = allocateRefunds(p.payments, suspendedAtSeconds, costTotal);
  const gross = allocations.reduce((sum, a) => sum + a.grossCents, 0);
  const applied = allocations.reduce((sum, a) => sum + a.costAppliedCents, 0);
  return {
    allocations,
    statement: {
      currency: p.currency,
      period_used_ends: p.suspendedAt,
      payments: statementPayments(allocations),
      costs,
      gross_cents: gross,
      cost_total_cents: costTotal,
      cost_applied_cents: applied,
      refund_cents: gross - applied,
    },
  };
}
