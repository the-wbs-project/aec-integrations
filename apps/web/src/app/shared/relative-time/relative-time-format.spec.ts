/**
 * AECI-694 — the arithmetic behind `<aec-relative-time>`.
 *
 * Boundary cases carry the weight here. Every threshold is a place where the
 * stamp changes unit, and an off-by-one at one of them means the audit trail
 * says "60m" where it should say "1h", or rounds a two-day-old row to "1d". The
 * component's own spec covers how a span is spelled; this one covers which span
 * it is.
 *
 * A plain Vitest spec (not `*.component.spec.ts`) precisely because this module
 * has no Angular and no `$localize` in it. That split is the reason the labels
 * live in the component rather than here.
 */
import { describe, expect, it } from 'vitest';

import { relativeSpan } from './relative-time-format';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

/** `nowMs` minus the given whole milliseconds, as an ISO string. */
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('relativeSpan', () => {
  it('collapses anything under a minute to "now"', () => {
    expect(relativeSpan(ago(0), NOW)).toEqual({ unit: 'now', value: 0, future: false });
    expect(relativeSpan(ago(59 * SECOND), NOW)).toEqual({ unit: 'now', value: 0, future: false });
  });

  it('switches unit exactly at each boundary, never one tick early or late', () => {
    // Each pair is (last instant in the old unit, first instant in the new one).
    expect(relativeSpan(ago(MINUTE), NOW)).toMatchObject({ unit: 'minute', value: 1 });
    expect(relativeSpan(ago(HOUR - SECOND), NOW)).toMatchObject({ unit: 'minute', value: 59 });

    expect(relativeSpan(ago(HOUR), NOW)).toMatchObject({ unit: 'hour', value: 1 });
    expect(relativeSpan(ago(DAY - SECOND), NOW)).toMatchObject({ unit: 'hour', value: 23 });

    expect(relativeSpan(ago(DAY), NOW)).toMatchObject({ unit: 'day', value: 1 });
    expect(relativeSpan(ago(WEEK - SECOND), NOW)).toMatchObject({ unit: 'day', value: 6 });

    expect(relativeSpan(ago(WEEK), NOW)).toMatchObject({ unit: 'week', value: 1 });
    expect(relativeSpan(ago(29 * DAY), NOW)).toMatchObject({ unit: 'week', value: 4 });

    // Months are 30 days flat and weeks give way at 30, not at a calendar month:
    // a compact stamp is a staleness signal, not an interval calculation.
    expect(relativeSpan(ago(30 * DAY), NOW)).toMatchObject({ unit: 'month', value: 1 });
    expect(relativeSpan(ago(364 * DAY), NOW)).toMatchObject({ unit: 'month', value: 12 });

    expect(relativeSpan(ago(365 * DAY), NOW)).toMatchObject({ unit: 'year', value: 1 });
  });

  it('floors rather than rounds, so a stamp never claims more age than it has', () => {
    // 47 hours is one day and change. Rounding would print "2d" for a row that
    // has not been there two days.
    expect(relativeSpan(ago(47 * HOUR), NOW)).toMatchObject({ unit: 'day', value: 1 });
  });

  it('flags a future instant instead of reporting it as past', () => {
    // Clock skew between a Worker and a browser is routinely a second or two, so
    // a just-written row can arrive "ahead" of the reader.
    expect(relativeSpan(ago(-3 * DAY), NOW)).toEqual({ unit: 'day', value: 3, future: true });
  });

  it('absorbs small skew into "now" rather than announcing the future', () => {
    expect(relativeSpan(ago(-2 * SECOND), NOW)).toEqual({ unit: 'now', value: 0, future: false });
  });

  it('returns null for an unparseable value so the caller can render it raw', () => {
    // `audit_log` is excluded from the retention prune and `created_at` is a bare
    // `z.string()`, so a historical row is allowed to hold something odd.
    expect(relativeSpan('not a date', NOW)).toBeNull();
    expect(relativeSpan('', NOW)).toBeNull();
  });
});
