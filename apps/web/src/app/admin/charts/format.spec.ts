/**
 * AECI-578 / Phase 8.3 P1.4 — number + date formatting for the operator console.
 *
 * The date half is the §11 acceptance criterion: "UTC boundary tests, including
 * the WIB presentation offset". The invariant under test is §9.5's — **a view
 * that lands in a different day under UTC+7 must still aggregate by UTC**. That
 * is not a formatting nicety: if the console ever rebucketed by WIB it would
 * disagree with the 05:00 digest email about the same rows, and the two are meant
 * to be the same numbers seen two ways.
 *
 * Plain Vitest (node), not `ng test` — `format.ts` imports nothing from Angular.
 */
import { describe, expect, it } from 'vitest';

import {
  WIB_OFFSET_MINUTES,
  axisLabelIndices,
  dayKeyParts,
  formatCompact,
  formatInstant,
  formatPercent,
  formatRate,
  formatThousands,
  utcDayKey,
  zonedParts,
} from './format';

describe('WIB_OFFSET_MINUTES', () => {
  it('is a fixed UTC+7 — Indonesia has no DST', () => {
    expect(WIB_OFFSET_MINUTES).toBe(7 * 60);
  });
});

describe('utcDayKey — the bucket key never moves', () => {
  it('returns the UTC calendar day', () => {
    expect(utcDayKey('2026-08-05T12:00:00.000Z')).toBe('2026-08-05');
  });

  it('keeps a 17:30Z view in its UTC day even though WIB already calls it tomorrow', () => {
    // 2026-08-05T17:30Z is 2026-08-06 00:30 in Jakarta. The digest, every cron,
    // and `strftime('%Y-%m-%d', created_at)` all put this row in 2026-08-05.
    const instant = '2026-08-05T17:30:00.000Z';
    expect(utcDayKey(instant)).toBe('2026-08-05');
    expect(zonedParts(instant, 'WIB')!.day).toBe(6);
  });

  it('holds at the exact UTC+7 rollover instant', () => {
    // 17:00Z is midnight in Jakarta — the first moment the two calendars differ.
    expect(utcDayKey('2026-08-05T17:00:00.000Z')).toBe('2026-08-05');
    expect(zonedParts('2026-08-05T17:00:00.000Z', 'WIB')).toMatchObject({
      day: 6,
      hour: 0,
      minute: 0,
    });
    // One minute earlier the two agree.
    expect(zonedParts('2026-08-05T16:59:00.000Z', 'WIB')!.day).toBe(5);
  });

  it('holds across a month boundary', () => {
    expect(utcDayKey('2026-07-31T20:00:00.000Z')).toBe('2026-07-31');
    expect(zonedParts('2026-07-31T20:00:00.000Z', 'WIB')).toMatchObject({ month: 8, day: 1 });
  });

  it('holds across a year boundary', () => {
    expect(utcDayKey('2026-12-31T18:00:00.000Z')).toBe('2026-12-31');
    expect(zonedParts('2026-12-31T18:00:00.000Z', 'WIB')).toMatchObject({
      year: 2027,
      month: 1,
      day: 1,
    });
  });

  it('is unchanged at midnight UTC, the API window boundary', () => {
    expect(utcDayKey('2026-08-05T00:00:00.000Z')).toBe('2026-08-05');
    expect(utcDayKey('2026-08-05T23:59:59.999Z')).toBe('2026-08-05');
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(utcDayKey(new Date('2026-08-05T17:30:00.000Z'))).toBe('2026-08-05');
  });

  it('returns an empty string for an unparseable instant rather than "Invalid Date"', () => {
    expect(utcDayKey('not-a-date')).toBe('');
  });
});

describe('zonedParts', () => {
  it('is the identity for UTC', () => {
    expect(zonedParts('2026-08-05T17:30:00.000Z', 'UTC')).toEqual({
      year: 2026,
      month: 8,
      day: 5,
      hour: 17,
      minute: 30,
    });
  });

  it('shifts by exactly seven hours for WIB', () => {
    expect(zonedParts('2026-08-05T09:15:00.000Z', 'WIB')).toEqual({
      year: 2026,
      month: 8,
      day: 5,
      hour: 16,
      minute: 15,
    });
  });

  it('returns null for an unparseable instant', () => {
    expect(zonedParts('nope', 'WIB')).toBeNull();
  });
});

describe('formatInstant', () => {
  it('always carries the zone label — §9.5 requires it, unconditionally', () => {
    expect(formatInstant('2026-08-05T17:30:00.000Z', 'UTC')).toBe('2026-08-05 17:30 UTC');
    expect(formatInstant('2026-08-05T17:30:00.000Z', 'WIB')).toBe('2026-08-06 00:30 WIB');
  });

  it('zero-pads single-digit parts', () => {
    expect(formatInstant('2026-01-02T03:04:00.000Z', 'UTC')).toBe('2026-01-02 03:04 UTC');
  });

  it('returns an empty string for an unparseable instant', () => {
    expect(formatInstant('nope', 'UTC')).toBe('');
  });
});

describe('dayKeyParts', () => {
  it('splits a well-formed bucket key', () => {
    expect(dayKeyParts('2026-08-05')).toEqual({ year: 2026, month: 8, day: 5 });
  });

  it('rejects anything that is not a bucket key', () => {
    for (const bad of ['2026-8-5', '2026-08-05T00:00:00Z', '', 'yesterday', '26-08-05']) {
      expect(dayKeyParts(bad)).toBeNull();
    }
  });

  it('rejects a well-formed but non-existent date', () => {
    expect(dayKeyParts('2026-02-30')).toBeNull();
    expect(dayKeyParts('2026-13-01')).toBeNull();
  });

  it('accepts a real leap day', () => {
    expect(dayKeyParts('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
  });
});

describe('axisLabelIndices', () => {
  it('labels every slot when they all fit', () => {
    expect(axisLabelIndices(5, 7)).toEqual([0, 1, 2, 3, 4]);
  });

  it('thins the labels and always includes first and last', () => {
    const indices = axisLabelIndices(30, 7);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(29);
    expect(indices.length).toBeLessThanOrEqual(8);
  });

  it('never places two labels a fraction of a step apart', () => {
    for (const count of [7, 8, 13, 30, 31, 90, 91, 400]) {
      const indices = axisLabelIndices(count, 7);
      const step = Math.ceil(count / 7);
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]! - indices[i - 1]!).toBeGreaterThanOrEqual(step / 2);
      }
    }
  });

  it('returns nothing for an empty series', () => {
    expect(axisLabelIndices(0)).toEqual([]);
  });
});

describe('formatThousands', () => {
  it('groups by three', () => {
    expect(formatThousands(0)).toBe('0');
    expect(formatThousands(999)).toBe('999');
    expect(formatThousands(1000)).toBe('1,000');
    expect(formatThousands(1_284)).toBe('1,284');
    expect(formatThousands(24_119)).toBe('24,119');
    expect(formatThousands(1_000_000)).toBe('1,000,000');
  });

  it('handles negatives (a delta can be one)', () => {
    expect(formatThousands(-1234)).toBe('-1,234');
  });

  it('returns "0" rather than "NaN" for a non-finite input', () => {
    expect(formatThousands(NaN)).toBe('0');
  });
});

describe('formatCompact', () => {
  it('leaves values under a thousand alone', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(999)).toBe('999');
  });

  it('abbreviates thousands and millions, trimming a trailing .0', () => {
    expect(formatCompact(1000)).toBe('1k');
    expect(formatCompact(1284)).toBe('1.3k');
    expect(formatCompact(24_119)).toBe('24.1k');
    expect(formatCompact(2_400_000)).toBe('2.4M');
  });

  it('returns "0" for a non-finite input', () => {
    expect(formatCompact(Infinity)).toBe('0');
  });
});

describe('formatPercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatPercent(38, 100)).toBe('38%');
    expect(formatPercent(1, 3)).toBe('33%');
  });

  it('returns 0% rather than NaN% for an empty window', () => {
    expect(formatPercent(0, 0)).toBe('0%');
    expect(formatPercent(5, 0)).toBe('0%');
  });
});

describe('formatRate — AECI-586', () => {
  it('renders a fraction as a percentage, trimming a bare .0', () => {
    expect(formatRate(0.375)).toBe('37.5%');
    expect(formatRate(0.5)).toBe('50%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(0)).toBe('0%');
  });

  it('keeps one decimal, because at these volumes it is the only precision there is', () => {
    // One opt-out from eight subscribers. Rounding to 13% throws that away.
    expect(formatRate(1 / 8)).toBe('12.5%');
    expect(formatRate(2 / 3)).toBe('66.7%');
  });

  it('propagates null rather than returning 0%', () => {
    // The whole reason this is not `formatPercent`: 0% churn over an empty
    // mailing list is a clean bill of health nobody measured (§5.1). Null rather
    // than a placeholder because this module is Angular-free and cannot own the
    // localized words for it.
    expect(formatRate(null)).toBeNull();
    expect(formatPercent(0, 0)).toBe('0%'); // the contrast, stated
  });

  it('never emits NaN or Infinity', () => {
    expect(formatRate(Number.NaN)).toBeNull();
    expect(formatRate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
