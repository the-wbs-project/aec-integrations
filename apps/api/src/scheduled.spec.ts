/**
 * Unit tests for the ADR 0013 cron→queue→consumer orchestration in
 * `scheduled.ts`. The dispatched job impls (`runDailySync`, `reportAlgoliaDrift`)
 * and Prisma/Datadog are mocked, so these lock in the orchestration contract
 * only: the cron `scheduled` handler enqueues when a queue binding is present,
 * runs inline when it is absent, and falls back to inline (logging the failure)
 * when `queue.send` rejects; the `queue` consumer `ack()`s on success and
 * `retry()`s on an unexpected throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products, reviews } from './db/schema';
import type { ScheduledJob, ScheduledJobMessageInput, Env } from './env';
import { makeTestDb, type TestDb } from './test/d1';

vi.mock('./datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));
vi.mock('./lib/algolia-sync', () => ({ runDailySync: vi.fn() }));
vi.mock('./lib/algolia-drift', () => ({
  createAlgoliaCounter: vi.fn(() => ({})),
  reportAlgoliaDrift: vi.fn(),
}));
vi.mock('./lib/home-stats', () => ({ runHomeStats: vi.fn() }));
vi.mock('./lib/reconciliation-sweep', () => ({ runReconciliationSweep: vi.fn() }));
// The inline jobs (moderation snapshot, drift counter) call `getDb`; mock it to
// hand back the in-memory D1 harness so the real Drizzle reads run on real SQL.
vi.mock('./db/client', () => ({ getDb: vi.fn() }));

import { getDb } from './db/client';
import { logToDatadog, submitCount, submitDistribution, submitGauge } from './datadog';
import { reportAlgoliaDrift } from './lib/algolia-drift';
import { runDailySync } from './lib/algolia-sync';
import { runHomeStats } from './lib/home-stats';
import { runReconciliationSweep } from './lib/reconciliation-sweep';
import { normalizeJobMessage, queue, scheduled } from './scheduled';

// Must stay byte-equal to the constants / `wrangler.jsonc` triggers.
const MODERATION_CRON = '0 6 * * *';
const STATS_CRON = '0 7 * * *';
const SYNC_CRON = '0 8 * * *';
const DRIFT_CRON = '0 9 * * *';
const RECONCILE_CRON = '*/15 * * * *';

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    ALGOLIA_APP_ID: 'APP',
    ALGOLIA_ADMIN_KEY: 'write-key',
    ENV: 'staging',
    ...over,
  } as unknown as Env;
}

function cronController(cron: string) {
  return { cron, scheduledTime: 0, noRetry: vi.fn() } as unknown as Parameters<typeof scheduled>[0];
}

// A real Cloudflare queue message always carries a `timestamp` (queue receive
// time) — the consumer reads it as the `enqueuedAt` fallback, so the fakes must
// have one too.
const MSG_TIMESTAMP = new Date('2026-06-12T07:00:00.000Z');

function makeBatchFromBody(body: ScheduledJobMessageInput, queueName: string) {
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    queue: queueName,
    messages: [{ id: '1', timestamp: MSG_TIMESTAMP, attempts: 1, body, ack, retry }],
  } as unknown as Parameters<typeof queue>[0];
  return { batch, ack, retry };
}

function makeBatch(job: ScheduledJob, queueName: string) {
  return makeBatchFromBody({ job, trigger: 'cron', enqueuedAt: 'x' }, queueName);
}

let t: TestDb;
beforeEach(async () => {
  vi.clearAllMocks();
  // runAlgoliaSync reads `result.entities` after the call; default to a clean run.
  vi.mocked(runDailySync).mockResolvedValue({ entities: [] } as never);
  // runHomeStatsJob reads `result.keys` after the call; default to a clean run.
  vi.mocked(runHomeStats).mockResolvedValue({ keys: [] } as never);
  t = await makeTestDb();
  vi.mocked(getDb).mockReturnValue(t.dbCtx);
});
afterEach(() => t.dispose());

describe('scheduled (cron producer)', () => {
  it('enqueues the sync job when the queue binding is present (does not run inline)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ ALGOLIA_SYNC_QUEUE: { send } as never });

    await scheduled(cronController(SYNC_CRON), env, ctx);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ job: 'sync', trigger: 'cron' }));
    expect(runDailySync).not.toHaveBeenCalled();
  });

  it('enqueues the drift job onto its own queue', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ ALGOLIA_DRIFT_QUEUE: { send } as never });

    await scheduled(cronController(DRIFT_CRON), env, ctx);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ job: 'drift', trigger: 'cron' }));
    expect(reportAlgoliaDrift).not.toHaveBeenCalled();
  });

  it('enqueues the stats job onto its own queue (AECI-178)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ STATS_QUEUE: { send } as never });

    await scheduled(cronController(STATS_CRON), env, ctx);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ job: 'stats', trigger: 'cron' }));
    expect(runHomeStats).not.toHaveBeenCalled();
  });

  it('enqueues the reconcile job onto its own queue every 15 min (AECI-214)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ RECONCILE_QUEUE: { send } as never });

    await scheduled(cronController(RECONCILE_CRON), env, ctx);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'reconcile', trigger: 'cron' }),
    );
    expect(runReconciliationSweep).not.toHaveBeenCalled();
  });

  it('runs the reconcile sweep inline when no RECONCILE_QUEUE binding is present', async () => {
    await scheduled(cronController(RECONCILE_CRON), makeEnv(), ctx);

    expect(runReconciliationSweep).toHaveBeenCalledTimes(1);
  });

  it('runs the job inline when no queue binding is present (local/preview)', async () => {
    await scheduled(cronController(SYNC_CRON), makeEnv(), ctx);

    expect(runDailySync).toHaveBeenCalledTimes(1);
  });

  it('runs the stats job inline when no STATS_QUEUE binding is present', async () => {
    await scheduled(cronController(STATS_CRON), makeEnv(), ctx);

    expect(runHomeStats).toHaveBeenCalledTimes(1);
  });

  it('snapshots the moderation queue inline on the 06:00 cron (queue-less) and emits its gauges', async () => {
    // Seed 3 pending reviews (one older) on the harness — the real Drizzle reads run.
    await t.db.insert(products).values({ id: 'p1', slug: 'p1', name: 'P1' });
    const review = (id: string, createdAt: string) => ({
      id,
      productId: 'p1',
      ratingOverall: 5,
      ratingOnboarding: 5,
      title: 't',
      body: 'b',
      status: 'pending',
      createdAt,
    });
    await t.db
      .insert(reviews)
      .values([
        review('r1', '2026-06-10T06:00:00.000Z'),
        review('r2', '2026-06-11T06:00:00.000Z'),
        review('r3', '2026-06-12T06:00:00.000Z'),
      ]);

    // Even with every queue bound, moderation has no producer → always inline.
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({
      ALGOLIA_SYNC_QUEUE: { send } as never,
      ALGOLIA_DRIFT_QUEUE: { send } as never,
      STATS_QUEUE: { send } as never,
    });

    await scheduled(cronController(MODERATION_CRON), env, ctx);

    expect(send).not.toHaveBeenCalled();
    const gauges = vi.mocked(submitGauge).mock.calls;
    const names = gauges.map((c) => c[3]);
    expect(names).toEqual(['aeci.moderation.queue_depth', 'aeci.moderation.queue_oldest_age_hours']);
    // Depth gauge reflects the 3 seeded pending reviews.
    expect(gauges[0]![4]).toBe(3);
  });

  it('falls back to an inline run and logs to Datadog when queue.send rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    const env = makeEnv({ ALGOLIA_SYNC_QUEUE: { send } as never });

    await scheduled(cronController(SYNC_CRON), env, ctx);

    expect(send).toHaveBeenCalledTimes(1);
    expect(runDailySync).toHaveBeenCalledTimes(1); // ran inline rather than dropping the tick
    expect(logToDatadog).toHaveBeenCalledWith(
      ctx,
      env,
      expect.anything(),
      expect.objectContaining({ level: 'error', message: 'aeci.algolia.sync.enqueue_failed' }),
    );
  });
});

describe('normalizeJobMessage', () => {
  it('implies trigger=manual and enqueuedAt=receivedAt when a body omits them', () => {
    expect(normalizeJobMessage({ job: 'stats' }, '2026-06-12T07:00:00.000Z')).toEqual({
      job: 'stats',
      trigger: 'manual',
      enqueuedAt: '2026-06-12T07:00:00.000Z',
    });
  });

  it('preserves the trigger + enqueuedAt the cron producer already stamped', () => {
    expect(
      normalizeJobMessage(
        { job: 'sync', trigger: 'cron', enqueuedAt: '2026-01-01T00:00:00.000Z' },
        'ignored',
      ),
    ).toEqual({ job: 'sync', trigger: 'cron', enqueuedAt: '2026-01-01T00:00:00.000Z' });
  });
});

describe('queue (consumer)', () => {
  it('ack()s a message whose job runs successfully', async () => {
    const { batch, ack, retry } = makeBatch('sync', 'aeci-algolia-sync-staging');

    await queue(batch, makeEnv(), ctx);

    expect(runDailySync).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('retry()s when the job throws unexpectedly (e.g. a missing D1 binding)', async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('D1 binding `DB` is not configured');
    });
    const { batch, ack, retry } = makeBatch('sync', 'aeci-algolia-sync-staging');

    await queue(batch, makeEnv(), ctx);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
  });

  it('ack()s a stats job message and runs the home-stats compute (AECI-178)', async () => {
    const { batch, ack, retry } = makeBatch('stats', 'aeci-stats-staging');

    await queue(batch, makeEnv(), ctx);

    expect(runHomeStats).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('ack()s a reconcile job message and runs the reconciliation sweep (AECI-214)', async () => {
    const { batch, ack, retry } = makeBatch('reconcile', 'aeci-reconcile-staging');

    await queue(batch, makeEnv(), ctx);

    expect(runReconciliationSweep).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('runs + ack()s a minimal { job } operator push (trigger/enqueuedAt implied)', async () => {
    // An out-of-band Cloudflare Queues REST push of just `{ "job": "stats" }`:
    // the consumer implies `trigger`/`enqueuedAt` rather than choking on them.
    const { batch, ack, retry } = makeBatchFromBody({ job: 'stats' }, 'aeci-stats-production');

    await queue(batch, makeEnv(), ctx);

    expect(runHomeStats).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('emits per-key + job-level stats metrics through the real emitter (AECI-180)', async () => {
    // The real `emitHomeStatsMetrics` runs (only `./datadog` is mocked), so this
    // locks in that a completed stats run lands the 4.5 metrics on the wire.
    vi.mocked(runHomeStats).mockResolvedValue({
      keys: [
        { key: 'home.total_integrations', status: 'written', durationMs: 3 },
        { key: 'home.trending_products', status: 'failed', durationMs: 5, error: 'boom' },
      ],
    } as never);
    const { batch } = makeBatch('stats', 'aeci-stats-staging');

    await queue(batch, makeEnv(), ctx);

    // per-key outcome (names the failing key)
    expect(submitCount).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.anything(),
      'aeci.stats.compute.key',
      1,
      ['trigger:cron', 'key:home.trending_products', 'outcome:failed'],
    );
    // job rollup: one written + one failed → partial
    expect(submitCount).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.anything(),
      'aeci.stats.compute',
      1,
      ['trigger:cron', 'outcome:partial'],
    );
    // per-key + job-level duration distributions
    expect(submitDistribution).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.anything(),
      'aeci.stats.compute.key.duration_ms',
      5,
      ['trigger:cron', 'key:home.trending_products'],
    );
    expect(submitDistribution).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.anything(),
      'aeci.stats.compute.duration_ms',
      expect.any(Number),
      ['trigger:cron'],
    );
  });
});
