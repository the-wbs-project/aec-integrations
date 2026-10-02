/**
 * `lib/alert-bands.ts` (AECI-854, generalised by AECI-862).
 *
 * This arithmetic is the only thing standing between an operator and 96 emails a
 * day, and every bug in it is silent: too loose and the mailbox floods, too tight
 * and a genuinely stuck row is never reported. The tiling property is the one
 * worth pinning — walking a row forward one cadence at a time must produce
 * exactly one send per band, never zero and never two.
 */

import { describe, expect, it } from 'vitest';

import { bandDigestKey, bandIndex, crossedBand } from './alert-bands';

/** The AECI-862 claim-staleness configuration: one band at 24h, then daily. */
const STALE_BANDS = [1440] as const;
const STALE_REPEAT = 1440;
const STALE_CADENCE = 360; // six hours

/** The AECI-854 reconciliation-sweep configuration. */
const SWEEP_BANDS = [60, 360] as const;
const SWEEP_REPEAT = 1440;
const SWEEP_CADENCE = 15;

describe('crossedBand', () => {
  it('fires on the run that carries the row past a band, not before', () => {
    // 24h band, 6h cadence: the run that sees age 1440 is the first to cover it.
    expect(crossedBand(1439, STALE_CADENCE, STALE_BANDS, STALE_REPEAT)).toBe(false);
    expect(crossedBand(1440, STALE_CADENCE, STALE_BANDS, STALE_REPEAT)).toBe(true);
  });

  it('does not re-fire on the next run after a band', () => {
    expect(crossedBand(1440 + STALE_CADENCE, STALE_CADENCE, STALE_BANDS, STALE_REPEAT)).toBe(false);
  });

  it('is silent for a row younger than the first band', () => {
    // The day-0 repeat boundary must not catch a young row — that guard is the
    // subtle half of the implementation.
    for (const age of [0, 60, 359, 720, 1439]) {
      expect(crossedBand(age, STALE_CADENCE, STALE_BANDS, STALE_REPEAT)).toBe(false);
    }
  });

  it('tiles a full week into exactly one send per day after the band', () => {
    // Walk 7 days at the real cadence and count. 24h band + daily repeat = 7.
    let sends = 0;
    for (let age = STALE_CADENCE; age <= 7 * 1440; age += STALE_CADENCE) {
      if (crossedBand(age, STALE_CADENCE, STALE_BANDS, STALE_REPEAT)) sends++;
    }
    expect(sends).toBe(7);
  });

  it('tiles the sweep configuration into 60m, 6h, then daily', () => {
    // The AECI-854 shape, at its 15-minute cadence, over 48 hours:
    // one at 60m, one at 6h, one at each day boundary = 4.
    let sends = 0;
    const hits: number[] = [];
    for (let age = SWEEP_CADENCE; age <= 2 * 1440; age += SWEEP_CADENCE) {
      if (crossedBand(age, SWEEP_CADENCE, SWEEP_BANDS, SWEEP_REPEAT)) {
        sends++;
        hits.push(age);
      }
    }
    expect(hits).toEqual([60, 360, 1440, 2880]);
    expect(sends).toBe(4);
  });

  it('never double-sends for a single band within one window', () => {
    // A cadence wider than the gap between two bands still sends once per band,
    // not once per window — this is what stops a slow cron collapsing bands.
    const hits: number[] = [];
    for (let age = 720; age <= 2880; age += 720) {
      if (crossedBand(age, 720, SWEEP_BANDS, SWEEP_REPEAT)) hits.push(age);
    }
    // 720 covers (0,720]: crosses both 60 and 360, but that is ONE email.
    // 2160 is absent on purpose — it sits INSIDE day 1, so no daily boundary is
    // crossed. The repeat is per calendar-width, not per run past the last band.
    expect(hits).toEqual([720, 1440, 2880]);
  });

  it('returns false for an empty band list rather than throwing', () => {
    expect(crossedBand(9999, 360, [], 1440)).toBe(false);
  });
});

describe('bandIndex (AECI-1203)', () => {
  const SWEEP = [60, 360] as const;
  const STALE = [1440] as const;
  const DAY = 1440;

  it('is null below the first band', () => {
    expect(bandIndex(0, SWEEP, DAY)).toBeNull();
    expect(bandIndex(59, SWEEP, DAY)).toBeNull();
    expect(bandIndex(1439, STALE, DAY)).toBeNull();
  });

  it('numbers the fixed bands from 0, boundaries inclusive', () => {
    expect(bandIndex(60, SWEEP, DAY)).toBe(0);
    expect(bandIndex(359, SWEEP, DAY)).toBe(0);
    expect(bandIndex(360, SWEEP, DAY)).toBe(1);
    expect(bandIndex(1439, SWEEP, DAY)).toBe(1);
  });

  it('adds one per daily boundary past the last band', () => {
    expect(bandIndex(1440, SWEEP, DAY)).toBe(2);
    expect(bandIndex(2879, SWEEP, DAY)).toBe(2);
    expect(bandIndex(2880, SWEEP, DAY)).toBe(3);
    expect(bandIndex(10 * DAY + 5, SWEEP, DAY)).toBe(11);
  });

  it('treats a repeat boundary that coincides with the last band as that band', () => {
    expect(bandIndex(1440, STALE, DAY)).toBe(0);
    expect(bandIndex(2879, STALE, DAY)).toBe(0);
    expect(bandIndex(2880, STALE, DAY)).toBe(1);
    expect(bandIndex(4320, STALE, DAY)).toBe(2);
  });

  it('is null for an empty band list', () => {
    expect(bandIndex(5000, [], DAY)).toBeNull();
  });

  it('starts a new index at every age crossedBand emails, and at no other', () => {
    // Walk two weeks in sweep-sized steps. Each email must land on a fresh index, and
    // each index change must come with an email: one key per email, one email per key.
    for (const [bands, since] of [
      [SWEEP, 15],
      [STALE, 360],
    ] as const) {
      let previous: number | null = null;
      for (let age = 0; age <= 14 * DAY; age += since) {
        const index = bandIndex(age, bands, DAY);
        const emails = crossedBand(age, since, bands, DAY);
        expect(emails).toBe(index !== previous);
        previous = index;
      }
    }
  });
});

describe('bandDigestKey (AECI-1203)', () => {
  it('is {template}:{requestId}:{band} for one row', () => {
    expect(bandDigestKey('stuck-request-alert', [{ requestId: 'r1', band: 2 }])).toBe(
      'stuck-request-alert:r1:2',
    );
  });

  it('sorts the rows, so read order cannot change the key', () => {
    const a = bandDigestKey('t', [
      { requestId: 'b', band: 0 },
      { requestId: 'a', band: 1 },
    ]);
    const b = bandDigestKey('t', [
      { requestId: 'a', band: 1 },
      { requestId: 'b', band: 0 },
    ]);
    expect(a).toBe('t:a:1,b:0');
    expect(b).toBe(a);
  });

  it('changes when any row moves to a new band', () => {
    expect(bandDigestKey('t', [{ requestId: 'a', band: 1 }])).not.toBe(
      bandDigestKey('t', [{ requestId: 'a', band: 2 }]),
    );
  });
});
