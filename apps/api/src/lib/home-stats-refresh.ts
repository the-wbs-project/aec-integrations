/**
 * The event-driven home-stats refresh (AECI-305), debounced since AECI-1509.
 *
 * A successful promote used to run `runHomeStats` (eleven `stats_cache` upserts and
 * the three heaviest queries left on the database) once per promote, so a burst of
 * 235 promotes in 8 h ran it 235 times. Now the promote only **requests** a refresh:
 *
 *   1. `requestHomeStatsRefresh` (the promote's post-commit hook) sends one
 *      `{ job: 'stats', trigger: 'promote', enqueuedAt }` message onto
 *      `STATS_QUEUE` with a {@link HOME_STATS_DEBOUNCE_SECONDS} delay.
 *   2. `runDebouncedHomeStats` (the `STATS_QUEUE` consumer, `scheduled.ts`) runs
 *      only when no debounced run has started since that message's `enqueuedAt`.
 *      `stats_cache['home_stats_refreshed_at']` holds the START time of the last
 *      debounced run. Every message a run already covers acks without work, so a
 *      burst shorter than the delay costs one run and a longer one about one per
 *      delay. Queues have no dedupe; the watermark row is the dedupe.
 *
 * The comparison is against the message's OWN request time, never a shared
 * "latest request" stamp: during a sustained burst a shared stamp is always newer
 * than the last run, so every message would run. The refreshed stamp is the run's
 * START, not its end, so a promote that commits while the compute is running sorts
 * after it and earns its own run.
 *
 * The `index:home` purge moves with the debounced run, still AFTER the recompute
 * (`docs/CACHE_STRATEGY.md`). The daily cron never touches the watermark: if it
 * advanced the refreshed stamp, a pending promote message would skip and the
 * home page would never be purged.
 *
 * With no `STATS_QUEUE` bound (local dev, tests) or when the `send` throws, the
 * promote falls back to the old inline refresh, so a request is never dropped.
 *
 * No `audit_log` row: `stats_cache` is derived bookkeeping (ADR 0022), the same
 * class as the Algolia watermark.
 */

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { statsCache } from '../db/schema';
import type { Env, ScheduledJobMessage } from '../env';
import {
  logBatchToPosthog,
  logToPosthog,
  submitCount,
  submitMetricsBatch,
  type PosthogLogEvent,
  type PosthogMetricPoint,
} from '../posthog';
import { HOME_STATS_REFRESHED_KEY, runHomeStats, type HomeStatsResult } from './home-stats';
import { emitHomeStatsMetrics, type StatsMetricSink } from './home-stats-metrics';

/** The edge-cache tag the home page (`/`) carries — the SSR emitter is
 *  `apps/web/src/server/cache-tags.ts` → `cacheTagInputsForPath('/')`. Kept in
 *  lockstep with that side per `docs/CACHE_STRATEGY.md` §2: purging it evicts the
 *  cached home HTML so it repaints with the fresh counts. */
export const HOME_CACHE_TAG = 'index:home';

/** How long a promote's refresh request waits on the queue. Promotes inside this
 *  window collapse into one run; the last promote of a burst is reflected within
 *  about this long. */
export const HOME_STATS_DEBOUNCE_SECONDS = 60;

/** What the refresh needs from its caller. A `PromoteRunCtx` and the consumer's
 *  adapter over `ExecutionContext` both satisfy it. */
export type HomeStatsRefreshCtx = {
  env: Env;
  waitUntil(promise: Promise<unknown>): void;
  request: Request;
};

/** The `source` the refresh's logs carry: the promote's inline path, or the
 *  debounced queue consumer. */
type RefreshSource = 'review-app-promote' | 'stats-debounce';

type Stamp = { at: string };

async function readStamp(db: Db, key: string): Promise<string | null> {
  const row = await db.query.statsCache.findFirst({ where: eq(statsCache.key, key) });
  const at = (row?.value as Partial<Stamp> | undefined)?.at;
  return typeof at === 'string' ? at : null;
}

async function writeStamp(db: Db, key: string, at: string): Promise<void> {
  const value: Stamp = { at };
  await db
    .insert(statsCache)
    .values({ key, value, computedAt: at })
    .onConflictDoUpdate({ target: statsCache.key, set: { value, computedAt: at } });
}

/**
 * Does a queued request still need a run? A missing refreshed row runs (first
 * ever). An unparseable request time runs (a hand-pushed message). Otherwise run
 * unless the last run started strictly after the request: an equal stamp runs,
 * because a duplicate run is cheap and a skipped one leaves the home page stale.
 * Pure, exported for the spec.
 */
export function shouldRunDebounced(requestedAt: string, refreshedAt: string | null): boolean {
  if (refreshedAt === null) return true;
  const requested = Date.parse(requestedAt);
  const refreshed = Date.parse(refreshedAt);
  if (Number.isNaN(requested) || Number.isNaN(refreshed)) return true;
  return refreshed <= requested;
}

/**
 * Recompute the `home.*` `stats_cache` keys, THEN enqueue the `index:home` purge.
 *
 * Ordering is load-bearing: refresh `stats_cache` first, purge `/` second, so any
 * render after the purge reads the already-fresh cache and never re-caches stale
 * HTML for another edge TTL. Never throws. The metrics keep `trigger:promote` on
 * both callers, so the dashboards and the trigger-agnostic failure monitor see the
 * same series they always did.
 */
export async function refreshHomeStatsAndPurgeHome(
  rc: HomeStatsRefreshCtx,
  db: Db,
  source: RefreshSource = 'review-app-promote',
): Promise<void> {
  const started = Date.now();
  let result: HomeStatsResult;
  try {
    result = await runHomeStats(db, new Date());
  } catch (error) {
    // `runHomeStats` is per-key best-effort and never throws on a compute/write
    // failure, so reaching here is a pre-compute crash. Count an outright failure +
    // error-log; never rethrow — the promote already committed.
    submitCount(rc, rc.env, rc.request, 'aeci.stats.compute', 1, [
      'trigger:promote',
      'outcome:failed',
    ]);
    logToPosthog(rc, rc.env, rc.request, {
      level: 'error',
      message: 'aeci.stats.compute.crashed',
      source,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // One metrics request and one logs request for the whole refresh, never one per
  // stats key (AECI-1112, the AECI-666 connection limit).
  const points: PosthogMetricPoint[] = [];
  const sink: StatsMetricSink = {
    count: (metric, value, tags) => void points.push({ kind: 'count', metric, value, tags }),
    distribution: (metric, value, tags) =>
      void points.push({ kind: 'distribution', metric, value, tags }),
  };
  emitHomeStatsMetrics(sink, 'promote', result, Date.now() - started);
  submitMetricsBatch(rc, rc.env, rc.request, points);
  logBatchToPosthog(
    rc,
    rc.env,
    rc.request,
    result.keys
      .filter((k) => k.status === 'failed')
      .map(
        (k): PosthogLogEvent => ({
          level: 'warn',
          message: `aeci.stats.compute ${k.key} status=failed`,
          source,
          key: k.key,
          ...(k.error ? { reason: k.error } : {}),
        }),
      ),
  );

  // No queue producer (local) means no edge cache to purge. Wrapped so a
  // `queue.send` throw can't reject this task — recorded, never rethrown.
  const queue = rc.env.CACHE_PURGE_QUEUE;
  if (!queue) return;
  try {
    await queue.send({ tags: [HOME_CACHE_TAG], source: 'promote' });
  } catch (error) {
    logToPosthog(rc, rc.env, rc.request, {
      level: 'warn',
      message: 'aeci.api.promote.cache_purge_enqueue_failed',
      source,
      reason: error instanceof Error ? error.message : String(error),
      tags: HOME_CACHE_TAG,
      tags_count: 1,
    });
  }
}

/**
 * The promote's post-commit hook: send one delayed `STATS_QUEUE` message whose
 * `enqueuedAt` is the request time the consumer debounces on. Never throws.
 *
 * - No `STATS_QUEUE` (local dev, tests) runs the refresh inline, as before AECI-1509.
 * - A failed `send` is logged and falls back to the inline refresh, so the
 *   request is never dropped (the same rule as `enqueueOrRun`).
 */
export async function requestHomeStatsRefresh(rc: HomeStatsRefreshCtx, db: Db): Promise<void> {
  const queue = rc.env.STATS_QUEUE;
  if (!queue) {
    await refreshHomeStatsAndPurgeHome(rc, db);
    return;
  }
  const message: ScheduledJobMessage = {
    job: 'stats',
    trigger: 'promote',
    enqueuedAt: new Date().toISOString(),
  };
  try {
    await queue.send(message, { delaySeconds: HOME_STATS_DEBOUNCE_SECONDS });
    submitCount(rc, rc.env, rc.request, 'aeci.stats.refresh_requested', 1, ['outcome:queued']);
  } catch (error) {
    submitCount(rc, rc.env, rc.request, 'aeci.stats.refresh_requested', 1, ['outcome:inline']);
    logToPosthog(rc, rc.env, rc.request, {
      level: 'error',
      message: 'aeci.stats.enqueue_failed',
      source: 'review-app-promote',
      reason: error instanceof Error ? error.message : String(error),
    });
    await refreshHomeStatsAndPurgeHome(rc, db);
  }
}

/**
 * The `STATS_QUEUE` consumer body for a `trigger: 'promote'` message, given that
 * message's `enqueuedAt`. Runs the refresh only when no debounced run has started
 * since the request, then records this run's START as the refreshed stamp.
 * Returns what it did, for the caller's log.
 *
 * Throws only when the watermark read or write throws, so the consumer can
 * `retry()` the message. The refresh itself never throws.
 */
export async function runDebouncedHomeStats(
  rc: HomeStatsRefreshCtx,
  db: Db,
  requestedAt: string,
): Promise<'ran' | 'coalesced'> {
  const refreshedAt = await readStamp(db, HOME_STATS_REFRESHED_KEY);
  if (!shouldRunDebounced(requestedAt, refreshedAt)) {
    submitCount(rc, rc.env, rc.request, 'aeci.stats.debounce', 1, ['outcome:coalesced']);
    return 'coalesced';
  }

  const startedAt = new Date().toISOString();
  await refreshHomeStatsAndPurgeHome(rc, db, 'stats-debounce');
  await writeStamp(db, HOME_STATS_REFRESHED_KEY, startedAt);
  submitCount(rc, rc.env, rc.request, 'aeci.stats.debounce', 1, ['outcome:ran']);
  return 'ran';
}
