import { eq, like } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { statsCache } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV } from '../test/helpers';
import { HOME_STATS_REFRESHED_KEY } from './home-stats';
import {
  HOME_STATS_DEBOUNCE_SECONDS,
  requestHomeStatsRefresh,
  runDebouncedHomeStats,
  shouldRunDebounced,
  type HomeStatsRefreshCtx,
} from './home-stats-refresh';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function ctxWith(over: Partial<Env> = {}): HomeStatsRefreshCtx {
  return {
    env: { ...TEST_ENV, ...over } as Env,
    waitUntil: () => {},
    request: new Request('https://api.local/api/promote', { method: 'POST' }),
  };
}

const queueWith = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as Env['STATS_QUEUE'];
const purgeWith = (send: ReturnType<typeof vi.fn>) =>
  ({ send }) as unknown as Env['CACHE_PURGE_QUEUE'];

const homeRows = () => t.db.select().from(statsCache).where(like(statsCache.key, 'home.%'));
const stampOf = async (key: string) =>
  (
    (await t.db.query.statsCache.findFirst({ where: eq(statsCache.key, key) }))?.value as
      | { at: string }
      | undefined
  )?.at;

describe('shouldRunDebounced (AECI-1509)', () => {
  it.each([
    ['never refreshed', '2026-10-28T10:00:00.000Z', null, true],
    ['unparseable request time', 'x', '2026-10-28T10:00:00.000Z', true],
    [
      'request newer than the last run',
      '2026-10-28T10:00:01.000Z',
      '2026-10-28T10:00:00.000Z',
      true,
    ],
    ['request equal to the last run', '2026-10-28T10:00:00.000Z', '2026-10-28T10:00:00.000Z', true],
    [
      'request covered by a later run',
      '2026-10-28T10:00:00.000Z',
      '2026-10-28T10:00:01.000Z',
      false,
    ],
  ])('%s', (_label, requested, refreshed, expected) => {
    expect(shouldRunDebounced(requested, refreshed)).toBe(expected);
  });
});

describe('requestHomeStatsRefresh (AECI-1509)', () => {
  it('sends one delayed promote message carrying the request time, without recomputing', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const purge = vi.fn().mockResolvedValue(undefined);

    await requestHomeStatsRefresh(
      ctxWith({ STATS_QUEUE: queueWith(send), CACHE_PURGE_QUEUE: purgeWith(purge) }),
      t.db,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      job: 'stats',
      trigger: 'promote',
      enqueuedAt: expect.any(String),
    });
    expect(send.mock.calls[0]![1]).toEqual({ delaySeconds: HOME_STATS_DEBOUNCE_SECONDS });
    // The recompute and the home purge belong to the consumer now.
    expect(await homeRows()).toEqual([]);
    expect(purge).not.toHaveBeenCalled();
  });

  it('refreshes inline when no STATS_QUEUE is bound (local dev)', async () => {
    const purge = vi.fn().mockResolvedValue(undefined);

    await requestHomeStatsRefresh(ctxWith({ CACHE_PURGE_QUEUE: purgeWith(purge) }), t.db);

    expect((await homeRows()).length).toBeGreaterThan(0);
    expect(purge).toHaveBeenCalledWith({ tags: ['index:home'], source: 'promote' });
  });

  it('falls back to the inline refresh when the send rejects, and never throws', async () => {
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));

    await expect(
      requestHomeStatsRefresh(ctxWith({ STATS_QUEUE: queueWith(send) }), t.db),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect((await homeRows()).length).toBeGreaterThan(0);
  });
});

describe('runDebouncedHomeStats (AECI-1509)', () => {
  const stamp = (key: string, at: string) =>
    t.db.insert(statsCache).values({ key, value: { at }, computedAt: at });

  it('runs a pending request and records the run START as the refreshed stamp', async () => {
    const before = new Date().toISOString();

    expect(await runDebouncedHomeStats(ctxWith(), t.db, '2020-01-01T00:00:00.000Z')).toBe('ran');

    const refreshed = await stampOf(HOME_STATS_REFRESHED_KEY);
    expect(refreshed! >= before).toBe(true);
    expect((await homeRows()).length).toBeGreaterThan(0);
    // The same request is now covered: the next message of the burst coalesces.
    expect(await runDebouncedHomeStats(ctxWith(), t.db, '2020-01-01T00:00:00.000Z')).toBe(
      'coalesced',
    );
  });

  it('coalesces without recomputing or purging when a later run covers the request', async () => {
    await stamp(HOME_STATS_REFRESHED_KEY, '2026-10-28T10:00:05.000Z');
    const purge = vi.fn().mockResolvedValue(undefined);

    expect(
      await runDebouncedHomeStats(
        ctxWith({ CACHE_PURGE_QUEUE: purgeWith(purge) }),
        t.db,
        '2026-10-28T10:00:00.000Z',
      ),
    ).toBe('coalesced');

    expect(await homeRows()).toEqual([]);
    expect(purge).not.toHaveBeenCalled();
  });

  it('runs about once per delay window during a sustained burst', async () => {
    // Promotes every 10 s for 5 min; each message is consumed 60 s after its
    // request. Requests keep arriving between runs, which is the case a shared
    // "latest request" stamp got wrong: every message ran.
    vi.useFakeTimers();
    try {
      const t0 = Date.parse('2026-10-28T10:00:00.000Z');
      let runs = 0;
      for (let i = 0; i <= 30; i++) {
        const requestedAt = new Date(t0 + i * 10_000).toISOString();
        vi.setSystemTime(t0 + i * 10_000 + HOME_STATS_DEBOUNCE_SECONDS * 1000);
        if ((await runDebouncedHomeStats(ctxWith(), t.db, requestedAt)) === 'ran') runs++;
      }
      // Runs at the requests of t=0, 60, 120, 180, 240 and 300 s.
      expect(runs).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
