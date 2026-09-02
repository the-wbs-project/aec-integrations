/**
 * `GET /api/admin/system` (AECI-580 / P1.6, extended by AECI-583 / P3.1) against
 * the in-memory D1 harness.
 *
 * The centre of gravity is the AC's failure mode — **the screen must not report
 * "fine" for want of data** — and AECI-583 sharpened rather than relaxed it. `ok`
 * is now reachable, but only from a `job_runs` row that actually says so, which
 * makes the negative cases the load-bearing ones:
 *
 *   - with no `job_runs` rows the ten read `unknown`/`derived` exactly as they
 *     did in P1.6, and no row reports an outcome (the "a newly added cron must
 *     still render honestly" AC);
 *   - an OPEN row (`finished_at IS NULL`) reports `in_flight` with a null outcome
 *     **even when an outcome is stored**, so an interrupted run cannot render as
 *     `ok`;
 *   - a stored value the enum does not recognize reads as no-outcome, not as
 *     itself.
 *
 * The rest covers the `?recompute=1` contract (§13 D8), the single-drift-call
 * guarantee, the watermark + orphan-sweep reads, and the D1 size/row-count block.
 *
 * One caveat worth knowing before adding cases here: **this harness is
 * better-sqlite3, not D1**, and the two differ on limits. The row-count query hit
 * `SQLITE_MAX_COMPOUND_SELECT` (5 on D1, 500 here) during local verification —
 * green suite, 500 in the browser. The last case in the D1-footprint block guards
 * that by asserting query shape rather than result.
 */

import { AdminSystemResponseSchema, type AdminSystemResponse } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jobRuns, products, statsCache, vendors } from '../db/schema';
import type { Env } from '../env';
import type { AlgoliaIndexDrift } from '../lib/algolia-drift';
import { ALGOLIA_WATERMARK_KEY } from '../lib/algolia-sync';
import { CRON_JOBS, CRON_SCHEDULES } from '../lib/cron-schedules';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminSystemHandler, type AdminSystemDeps } from './admin-system';

const NOW = new Date('2026-08-13T05:00:00.000Z');

/** Never hits the network: check #9 probes logo URLs with `fetch`. Every product
 *  in these fixtures is logo-less, but the seam is injected regardless so a
 *  future fixture change cannot start making real requests from a unit test. */
const NO_FETCH: typeof fetch = () =>
  Promise.reject(new Error('the data-quality logo probe must not reach the network in specs'));

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function call(query = '', env: Env = TEST_ENV, deps: AdminSystemDeps = {}) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/system',
    handler: createAdminSystemHandler(t.factory, {
      now: () => NOW,
      fetchImpl: NO_FETCH,
      // No Algolia credentials by default — `createDriftRunner`'s production
      // behaviour on preview/local, and what the drift check reads as "skipped".
      driftRunnerFor: () => undefined,
      ...deps,
    }),
  }).request(`/api/admin/system${query}`, {}, env, fakeExecutionContext());
}

async function system(query = '', env?: Env, deps?: AdminSystemDeps): Promise<AdminSystemResponse> {
  const res = await call(query, env, deps);
  expect(res.status).toBe(200);
  return AdminSystemResponseSchema.parse(await res.json());
}

const codes = (body: AdminSystemResponse) => body.notes.map((n) => n.code);

/** Seed a §7.2 run row. Written through raw SQL so a spec can store a value the
 *  application layer would refuse — which is the point of the untrusted-input
 *  cases below. */
function seedRun(
  job: string,
  startedAt: string,
  over: { finishedAt?: string; outcome?: string; detail?: unknown } = {},
) {
  t.raw
    .prepare(
      'INSERT INTO job_runs (job, started_at, finished_at, outcome, detail) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      job,
      startedAt,
      over.finishedAt ?? null,
      over.outcome ?? null,
      over.detail === undefined ? null : JSON.stringify(over.detail),
    );
}

const cron = (body: AdminSystemResponse, job: string) =>
  body.crons.find((r) => r.job === job) ?? expect.fail(`no cron row for ${job}`);

describe('GET /api/admin/system — cron liveness never reports a passing state', () => {
  it('returns all thirteen crons as `unknown` on an empty database', async () => {
    const body = await system();

    expect(body.crons).toHaveLength(13);
    expect(body.crons.map((r) => r.job)).toEqual([
      'metrics-snapshot',
      'asn-registry',
      'retention-prune',
      'data-quality',
      'analytics-digest',
      'moderation-snapshot',
      'home-stats',
      'algolia-sync',
      'algolia-drift',
      'attestation-notify',
      'entitlement-expiry',
      'request-reconcile',
      'waf-poll',
    ]);
    for (const row of body.crons) {
      expect(row.source).toBe('unknown');
      expect(row.last_run_at).toBeNull();
      expect(row.last_outcome).toBeNull();
      expect(row.duration_ms).toBeNull();
      expect(row.derived_from).toBeNull();
      expect(row.run_state).toBeNull();
    }
  });

  it('reports NO outcome for a derived or unknown row, however seeded the database', async () => {
    await t.db.insert(statsCache).values([
      { key: 'home.total_products', value: 3, computedAt: '2026-08-13T01:00:00.000Z' },
      {
        key: ALGOLIA_WATERMARK_KEY,
        value: { product: '2026-08-13T02:00:00.000Z' },
        computedAt: '2026-08-13T02:00:00.000Z',
      },
    ]);

    const body = await system();
    // The P1.6 AC, and still the guard for "a newly added cron with no rows yet
    // must render honestly": with no `job_runs` rows nothing is knowable beyond
    // "it ran", and a derived stamp attests to the run, not to its success.
    expect(body.crons.every((r) => r.last_outcome === null)).toBe(true);
    expect(body.crons.some((r) => r.source === 'job_runs')).toBe(false);
  });

  it('carries `cron_liveness_unavailable` naming how many rows are unknown', async () => {
    const body = await system();
    const note = body.notes.find((n) => n.code === 'cron_liveness_unavailable');
    expect(note).toBeDefined();
    expect(note?.severity).toBe('warn');
    expect(note?.params).toEqual({ unknown: 13, total: 13 });
  });

  it('derives home-stats + algolia-sync from D1 once their artifacts exist, and leaves the other eleven unknown', async () => {
    await t.db.insert(statsCache).values([
      { key: 'home.total_products', value: 3, computedAt: '2026-08-13T01:00:00.000Z' },
      { key: 'home.total_vendors', value: 2, computedAt: '2026-08-13T01:05:00.000Z' },
      {
        key: ALGOLIA_WATERMARK_KEY,
        value: { product: '2026-08-13T02:00:00.000Z', vendor: '2026-08-13T02:00:00.000Z' },
        computedAt: '2026-08-13T02:30:00.000Z',
      },
    ]);

    const body = await system();
    const byJob = Object.fromEntries(body.crons.map((r) => [r.job, r]));

    expect(byJob['home-stats']).toMatchObject({
      source: 'derived',
      // MAX across the table — which includes the watermark row, the newest stamp.
      last_run_at: '2026-08-13T02:30:00.000Z',
      last_outcome: null,
      derived_from: 'stats_cache.computed_at',
    });
    expect(byJob['algolia-sync']).toMatchObject({
      source: 'derived',
      last_run_at: '2026-08-13T02:30:00.000Z',
      last_outcome: null,
      derived_from: `stats_cache['${ALGOLIA_WATERMARK_KEY}'].computed_at`,
    });

    const stillUnknown = body.crons.filter((r) => r.source === 'unknown').map((r) => r.job);
    expect(stillUnknown).toEqual([
      'metrics-snapshot',
      'asn-registry',
      'retention-prune',
      'data-quality',
      'analytics-digest',
      'moderation-snapshot',
      'algolia-drift',
      'attestation-notify',
      'entitlement-expiry',
      'request-reconcile',
      'waf-poll',
    ]);
    expect(body.notes.find((n) => n.code === 'cron_liveness_unavailable')?.params).toEqual({
      unknown: 11,
      total: 13,
    });
  });

  it('keeps algolia-sync `unknown` when only the home-stats rows exist — an absent stamp is not evidence', async () => {
    await t.db
      .insert(statsCache)
      .values([{ key: 'home.total_products', value: 3, computedAt: '2026-08-13T01:00:00.000Z' }]);

    const body = await system();
    const byJob = Object.fromEntries(body.crons.map((r) => [r.job, r]));
    expect(byJob['home-stats'].source).toBe('derived');
    expect(byJob['algolia-sync']).toMatchObject({
      source: 'unknown',
      last_run_at: null,
      derived_from: null,
    });
  });

  it('reports each schedule from the same constants `scheduled.ts` dispatches on', async () => {
    const body = await system();
    for (const row of body.crons) {
      expect(row.schedule).toBe(CRON_SCHEDULES[row.job]);
    }
    // Spot-check the two the spec text names explicitly (§5.6).
    const byJob = Object.fromEntries(body.crons.map((r) => [r.job, r]));
    expect(byJob['data-quality'].schedule).toBe('0 4 * * *');
    expect(byJob['request-reconcile'].schedule).toBe('*/15 * * * *');
  });
});

describe('GET /api/admin/system — ?recompute=1 (§13 D8)', () => {
  it('omits both items by default when nothing has been stored yet', async () => {
    const body = await system();

    expect(body.recomputed).toBe(false);
    // Null because no 04:00 run has stored a result — not because the default
    // view refuses to show one. See the job_runs cases below.
    expect(body.data_quality).toBeNull();
    expect(body.algolia.drift).toBeNull();
    expect(codes(body)).toContain('requires_recompute');
  });

  it('tags a recomputed result as live, stamped with the request clock', async () => {
    const body = await system('?recompute=1');
    expect(body.data_quality).toMatchObject({
      source: 'live',
      computed_at: NOW.toISOString(),
    });
  });

  it('writes nothing while recomputing — the endpoint stays a pure read', async () => {
    await system('?recompute=1');

    // §6 / §13 D8: `?recompute=1` re-runs the checks but must not record a run.
    expect(await t.db.select().from(jobRuns)).toHaveLength(0);
  });

  it('runs all eleven data-quality checks when asked', async () => {
    const body = await system('?recompute=1');

    expect(body.recomputed).toBe(true);
    expect(body.data_quality).not.toBeNull();
    expect(body.data_quality?.checks.map((c) => c.id)).toEqual([
      'products_without_vendor',
      'ready_products_unpromoted',
      'broken_integration_refs',
      'vendors_without_products',
      'reviews_missing_anonymized_at',
      'stale_stats_cache',
      'duplicate_vendors',
      'duplicate_products',
      'logo_404',
      'algolia_index_drift',
      'entitlement_mirror_drift',
    ]);
    expect(codes(body)).not.toContain('requires_recompute');
  });

  it('reports a check with findings as failing, and a skipped check as NOT failing', async () => {
    // A vendor with no products trips check #4; nothing trips the rest. Check #10
    // is skipped (no Algolia credentials) and must not inflate `failing`.
    await t.db
      .insert(vendors)
      .values({ slug: 'orphan-co', companyName: 'Orphan Co', promotionStatus: 'promoted' });

    const body = await system('?recompute=1');
    const byId = Object.fromEntries((body.data_quality?.checks ?? []).map((c) => [c.id, c]));

    expect(byId['vendors_without_products']).toMatchObject({ count: 1, severity: 'warn' });
    expect(byId['vendors_without_products'].sample).toEqual(['Orphan Co (orphan-co)']);
    expect(byId['algolia_index_drift'].skipped).toBe(true);
    expect(body.data_quality?.failing).toBe(1);
  });

  it('reports a clean check as count 0 rather than omitting it — the UI renders that as passing', async () => {
    const body = await system('?recompute=1');
    const byId = Object.fromEntries((body.data_quality?.checks ?? []).map((c) => [c.id, c]));

    expect(byId['products_without_vendor']).toMatchObject({ count: 0, sample: [] });
    expect(byId['products_without_vendor'].error).toBeUndefined();
    expect(byId['products_without_vendor'].skipped).toBeUndefined();
    expect(body.data_quality?.failing).toBe(0);
  });

  it('invokes the Algolia drift runner exactly ONCE — check #10 and the drift panel share it', async () => {
    const rows: AlgoliaIndexDrift[] = [
      { entity: 'products', indexName: 'aeci_preview_products', database: 5, algolia: 4, drift: 1 },
      { entity: 'vendors', indexName: 'aeci_preview_vendors', database: 2, algolia: 2, drift: 0 },
    ];
    const runDrift = vi.fn(() => Promise.resolve(rows));

    const body = await system('?recompute=1', TEST_ENV, { driftRunnerFor: () => runDrift });

    expect(runDrift).toHaveBeenCalledTimes(1);
    expect(body.algolia.drift).toEqual({
      drifted: 1,
      indexes: [
        {
          entity: 'products',
          index_name: 'aeci_preview_products',
          database: 5,
          algolia: 4,
          drift: 1,
        },
        {
          entity: 'vendors',
          index_name: 'aeci_preview_vendors',
          database: 2,
          algolia: 2,
          drift: 0,
        },
      ],
    });
    // The same numbers reach check #10, from the same single call.
    const drift = body.data_quality?.checks.find((c) => c.id === 'algolia_index_drift');
    expect(drift?.count).toBe(1);
    expect(drift?.skipped).toBeUndefined();
  });

  it('notes absent Algolia credentials rather than reporting zero drift', async () => {
    const body = await system('?recompute=1');
    expect(body.algolia.drift).toBeNull();
    expect(codes(body)).toContain('algolia_credentials_absent');
  });

  it('reports drift as unknown (null) when the drift call throws, without 500-ing the screen', async () => {
    const runDrift = vi.fn(() => Promise.reject(new Error('algolia unreachable')));

    const body = await system('?recompute=1', TEST_ENV, { driftRunnerFor: () => runDrift });

    expect(body.algolia.drift).toBeNull();
    // The real cause rides the errored check, so no misleading credentials note.
    expect(codes(body)).not.toContain('algolia_credentials_absent');
    expect(body.data_quality?.checks.find((c) => c.id === 'algolia_index_drift')?.error).toContain(
      'algolia unreachable',
    );
  });
});

describe('GET /api/admin/system — Algolia state', () => {
  it('returns a null watermark when the sync has never run', async () => {
    const body = await system();
    expect(body.algolia.watermark).toBeNull();
  });

  it('returns the per-entity watermark and the row stamp', async () => {
    await t.db.insert(statsCache).values({
      key: ALGOLIA_WATERMARK_KEY,
      value: {
        vendor: '2026-08-13T02:00:00.000Z',
        product: '2026-08-13T02:00:00.000Z',
        integration: '2026-08-12T02:00:00.000Z',
      },
      computedAt: '2026-08-13T02:30:00.000Z',
    });

    const body = await system();
    expect(body.algolia.watermark).toEqual({
      computed_at: '2026-08-13T02:30:00.000Z',
      entities: [
        { entity: 'integration', watermark: '2026-08-12T02:00:00.000Z' },
        { entity: 'product', watermark: '2026-08-13T02:00:00.000Z' },
        { entity: 'vendor', watermark: '2026-08-13T02:00:00.000Z' },
      ],
    });
  });

  it('reports the orphan sweep as unrecorded — with no note — when no drift run has stored one', async () => {
    const body = await system('?recompute=1');
    // Null means "no record", never "clean". The old `orphan_sweep_not_persisted`
    // note is gone: since AECI-583 the sweep IS persisted, so claiming otherwise
    // would be false.
    expect(body.algolia.orphan_sweep).toBeNull();
    expect(codes(body)).not.toContain('orphan_sweep_not_persisted');
  });

  it('renders the sweep stored by the last 09:00 drift run', async () => {
    seedRun('algolia-drift', '2026-08-13T09:00:00.000Z', {
      finishedAt: '2026-08-13T09:00:30.000Z',
      outcome: 'ok',
      detail: {
        job: 'algolia-drift',
        report: { ran: true, drifted: [] },
        sweep: {
          ran: true,
          ok: true,
          totalOrphans: 7,
          totalDeleted: 5,
          entities: [
            {
              entity: 'products',
              indexName: 'aeci_products',
              indexCount: 100,
              promotedCount: 95,
              orphans: 5,
              deleted: 5,
              skippedBySafetyCap: false,
              ok: true,
            },
            {
              entity: 'vendors',
              indexName: 'aeci_vendors',
              indexCount: 50,
              promotedCount: 48,
              orphans: 2,
              deleted: 0,
              skippedBySafetyCap: true,
              ok: true,
            },
          ],
        },
      },
    });

    const body = await system();
    expect(body.algolia.orphan_sweep).toMatchObject({
      ran_at: '2026-08-13T09:00:30.000Z',
      ok: true,
      total_orphans: 7,
      total_deleted: 5,
      // The `--force` signal an operator acts on.
      capped: 1,
    });
    expect(body.algolia.orphan_sweep?.indexes[1]).toMatchObject({
      index_name: 'aeci_vendors',
      orphans: 2,
      deleted: 0,
      skipped_by_safety_cap: true,
    });
  });

  it('reports a sweep that crashed as unrecorded rather than as a clean one', async () => {
    seedRun('algolia-drift', '2026-08-13T09:00:00.000Z', {
      finishedAt: '2026-08-13T09:00:05.000Z',
      outcome: 'failed',
      detail: {
        job: 'algolia-drift',
        report: { ran: true, drifted: [] },
        sweep: { ran: false, reason: 'browse failed' },
      },
    });

    expect((await system()).algolia.orphan_sweep).toBeNull();
  });

  it('omits an unparseable sweep payload and says so, rather than reporting it in part', async () => {
    seedRun('algolia-drift', '2026-08-13T09:00:00.000Z', {
      finishedAt: '2026-08-13T09:00:05.000Z',
      outcome: 'ok',
      detail: { job: 'algolia-drift', report: { ran: true, drifted: [] }, sweep: { ran: true } },
    });

    const body = await system();
    expect(body.algolia.orphan_sweep).toBeNull();
    expect(codes(body)).toContain('stored_result_unreadable');
  });
});

describe('GET /api/admin/system — data quality served from the last stored run', () => {
  const CHECKS = [
    {
      id: 'broken_integration_refs',
      label: 'Broken refs',
      severity: 'error',
      count: 2,
      sample: ['a'],
    },
    { id: 'logo_404', label: 'Logo 404s', severity: 'warn', count: 0, sample: [], skipped: true },
  ];

  const seedDq = (startedAt: string, finishedAt: string, checks: unknown = CHECKS) =>
    seedRun('data-quality', startedAt, {
      finishedAt,
      outcome: 'failed',
      detail: { job: 'data-quality', durationMs: 900, checks, email: 'sent' },
    });

  it('replays the stored result on the DEFAULT view, under the run’s own timestamp', async () => {
    seedDq('2026-08-13T04:00:00.000Z', '2026-08-13T04:01:00.000Z');

    const body = await system();
    expect(body.data_quality).toMatchObject({
      source: 'job_runs',
      // The run's finish stamp, NOT the response's `generated_at` — a stored
      // result shown under the response clock claims a freshness it lacks.
      computed_at: '2026-08-13T04:01:00.000Z',
      failing: 1,
    });
    expect(body.data_quality?.checks.map((c) => c.id)).toEqual([
      'broken_integration_refs',
      'logo_404',
    ]);
    expect(body.generated_at).toBe(NOW.toISOString());
  });

  it('counts findings and errors as failing, and a skipped check as not', async () => {
    seedDq('2026-08-13T04:00:00.000Z', '2026-08-13T04:01:00.000Z');
    // One check with findings, one skipped → exactly one failing.
    expect((await system()).data_quality?.failing).toBe(1);
  });

  it('keeps yesterday’s result visible while today’s run is still in flight', async () => {
    seedDq('2026-08-12T04:00:00.000Z', '2026-08-12T04:01:00.000Z');
    seedRun('data-quality', '2026-08-13T04:00:00.000Z');

    // Blanking a good result for the few minutes the cron is running would be a
    // worse lie than showing it with its stamp.
    expect((await system()).data_quality?.computed_at).toBe('2026-08-12T04:01:00.000Z');
  });

  it('is superseded by ?recompute=1', async () => {
    seedDq('2026-08-13T04:00:00.000Z', '2026-08-13T04:01:00.000Z');

    const body = await system('?recompute=1');
    expect(body.data_quality?.source).toBe('live');
    expect(body.data_quality?.checks).toHaveLength(11);
  });

  it.each([
    ['a non-array payload', { not: 'an array' }],
    ['an empty result set', []],
    ['rows that are not checks', [{ id: 'x' }]],
  ])('omits %s entirely and says so, rather than reporting it in part', async (_label, checks) => {
    seedDq('2026-08-13T04:00:00.000Z', '2026-08-13T04:01:00.000Z', checks);

    const body = await system();
    expect(body.data_quality).toBeNull();
    expect(codes(body)).toContain('stored_result_unreadable');
  });
});

describe('GET /api/admin/system — cron liveness from job_runs (§7.2 / AECI-583)', () => {
  it('reports a completed run with its outcome and duration', async () => {
    seedRun('waf-poll', '2026-08-13T04:00:00.000Z', {
      finishedAt: '2026-08-13T04:00:02.500Z',
      outcome: 'ok',
    });

    const row = cron(await system(), 'waf-poll');
    expect(row).toMatchObject({
      source: 'job_runs',
      last_run_at: '2026-08-13T04:00:00.000Z',
      last_outcome: 'ok',
      duration_ms: 2500,
      derived_from: null,
      run_state: 'complete',
    });
  });

  it('beats the derived fallback — a real record always wins over an inference', async () => {
    await t.db.insert(statsCache).values({
      key: 'home.total_products',
      value: 3,
      computedAt: '2026-08-13T01:00:00.000Z',
    });
    seedRun('home-stats', '2026-08-13T07:00:00.000Z', {
      finishedAt: '2026-08-13T07:00:01.000Z',
      outcome: 'failed',
    });

    const row = cron(await system(), 'home-stats');
    expect(row.source).toBe('job_runs');
    expect(row.last_run_at).toBe('2026-08-13T07:00:00.000Z');
    expect(row.derived_from).toBeNull();
    expect(row.last_outcome).toBe('failed');
  });

  it('keeps the derived fallback for a job that has not run since instrumentation shipped', async () => {
    await t.db.insert(statsCache).values({
      key: 'home.total_products',
      value: 3,
      computedAt: '2026-08-13T01:00:00.000Z',
    });
    seedRun('waf-poll', '2026-08-13T04:00:00.000Z', {
      finishedAt: '2026-08-13T04:00:01.000Z',
      outcome: 'ok',
    });

    // Only `waf-poll` has a row; `home-stats` must still show its inference
    // rather than regressing to "unknown".
    expect(cron(await system(), 'home-stats')).toMatchObject({
      source: 'derived',
      derived_from: 'stats_cache.computed_at',
    });
  });

  it('renders an unfinished run as in flight, never as ok', async () => {
    seedRun('data-quality', '2026-08-13T04:00:00.000Z');

    const row = cron(await system(), 'data-quality');
    expect(row).toMatchObject({
      source: 'job_runs',
      last_run_at: '2026-08-13T04:00:00.000Z',
      last_outcome: null,
      duration_ms: null,
      run_state: 'in_flight',
    });
  });

  it('refuses an outcome on an OPEN row even when one is stored', async () => {
    // A row can only be written this way by something other than `withJobRun`.
    // The guard is structural precisely so it does not depend on the writer.
    seedRun('data-quality', '2026-08-13T04:00:00.000Z', { outcome: 'ok' });

    const row = cron(await system(), 'data-quality');
    expect(row.last_outcome).toBeNull();
    expect(row.run_state).toBe('in_flight');
  });

  it('reads an unrecognized stored outcome as no outcome', async () => {
    // The CHECK constraint refuses this value today, so suspend it to reach the
    // read-side guard. Belt and braces on purpose: the column and the wire enum
    // are two vocabularies that a future migration could let drift, and the
    // screen must degrade to "no outcome" rather than emit an unvalidatable one.
    t.raw.pragma('ignore_check_constraints = ON');
    seedRun('waf-poll', '2026-08-13T04:00:00.000Z', {
      finishedAt: '2026-08-13T04:00:01.000Z',
      outcome: 'partial',
    });
    t.raw.pragma('ignore_check_constraints = OFF');

    const row = cron(await system(), 'waf-poll');
    expect(row.last_outcome).toBeNull();
    expect(row.run_state).toBe('complete');
  });

  it('falls back to unknown — and still validates — when a stored stamp is not a date', async () => {
    seedRun('waf-poll', 'yesterday-ish', { finishedAt: 'x', outcome: 'ok' });

    // `system()` parses through `AdminSystemResponseSchema`, so this failing to
    // validate IS the assertion: a bad stamp must never reach the wire.
    expect(cron(await system(), 'waf-poll')).toMatchObject({
      source: 'unknown',
      last_run_at: null,
    });
  });

  it('reports the newest run when a job has several', async () => {
    seedRun('waf-poll', '2026-08-13T02:00:00.000Z', {
      finishedAt: '2026-08-13T02:00:01.000Z',
      outcome: 'failed',
    });
    seedRun('waf-poll', '2026-08-13T04:00:00.000Z', {
      finishedAt: '2026-08-13T04:00:01.000Z',
      outcome: 'ok',
    });
    seedRun('waf-poll', '2026-08-13T03:00:00.000Z', {
      finishedAt: '2026-08-13T03:00:01.000Z',
      outcome: 'failed',
    });

    expect(cron(await system(), 'waf-poll').last_outcome).toBe('ok');
  });

  it('drops the cron_liveness_unavailable note once every job has a row', async () => {
    // Driven off CRON_JOBS rather than a second hand-written list: this test's
    // whole claim is "every job has a row", and a literal here would silently stop
    // covering a newly added cron the day one lands.
    for (const job of CRON_JOBS) {
      seedRun(job, '2026-08-13T04:00:00.000Z', {
        finishedAt: '2026-08-13T04:00:01.000Z',
        outcome: 'ok',
      });
    }

    const body = await system();
    expect(codes(body)).not.toContain('cron_liveness_unavailable');
    expect(body.crons.every((r) => r.source === 'job_runs')).toBe(true);
  });

  it('never scans job_runs — every read is a bounded per-job seek', async () => {
    // The read must not grow with the table: retention is 90 days and the */15
    // reconcile alone writes ~9k rows into that window. Assert query SHAPE, since
    // the harness would happily scan without complaint (cf. the compound-SELECT
    // note in this file's header).
    const original = t.raw.prepare.bind(t.raw);
    const seen: string[] = [];
    const spy = vi.spyOn(t.raw, 'prepare').mockImplementation((sql: string) => {
      // Only the liveness reads. `tableCounts` legitimately selects `count(*)
      // FROM "job_runs"` too — it enumerates every user table — and that one IS
      // a UNION, chunked at D1's compound-SELECT limit.
      if (/from\s+"?job_runs"?/i.test(sql) && !/count\(\*\)/i.test(sql)) seen.push(sql);
      return original(sql);
    });

    await system();
    spy.mockRestore();

    expect(seen.length).toBeGreaterThan(0);
    for (const sql of seen) {
      expect(sql.toLowerCase()).toContain('limit');
      expect(sql.toLowerCase()).not.toContain('union');
    }
  });
});

describe('GET /api/admin/system — D1 footprint', () => {
  it('counts every user table and excludes SQLite/D1 internals + the migration ledger', async () => {
    await t.db.insert(vendors).values([
      { slug: 'a-co', companyName: 'A Co', promotionStatus: 'promoted' },
      { slug: 'b-co', companyName: 'B Co', promotionStatus: 'promoted' },
    ]);
    await t.db
      .insert(products)
      .values({ slug: 'a-app', name: 'A App', promotionStatus: 'promoted' });

    const body = await system();
    const byTable = Object.fromEntries(body.database.tables.map((r) => [r.table, r.rows]));

    expect(byTable['vendors']).toBe(2);
    expect(byTable['products']).toBe(1);
    expect(byTable['reviews']).toBe(0);
    expect(Object.keys(byTable)).not.toContain('d1_migrations');
    expect(Object.keys(byTable).some((n) => n.startsWith('sqlite_'))).toBe(false);
    expect(Object.keys(byTable).some((n) => n.startsWith('_cf_'))).toBe(false);
  });

  it('name-orders the tables', async () => {
    const names = (await system()).database.tables.map((r) => r.table);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('reports size as unknown rather than estimating it when D1 does not supply one', async () => {
    // better-sqlite3's `run()` returns no `meta.size_after`, which is exactly the
    // production "unknowable" branch.
    expect((await system()).database.size_bytes).toBeNull();
  });

  it('reports the size D1 supplies', async () => {
    const body = await system('', TEST_ENV, { dbSizeProbe: () => Promise.resolve(19_030_016) });
    expect(body.database.size_bytes).toBe(19_030_016);
  });

  /**
   * Regression guard for a limit this harness CANNOT reproduce.
   *
   * D1 compiles SQLite with `SQLITE_MAX_COMPOUND_SELECT = 5`; better-sqlite3
   * ships the stock 500. A single 28-term `UNION ALL` therefore passes every
   * assertion above and 500s on the first real request with `D1_ERROR: too many
   * terms in compound SELECT` — which is exactly what happened during AECI-580's
   * local verification. Since the failure is invisible to the engine these specs
   * run on, assert the query SHAPE instead of the result.
   */
  it('never emits a compound SELECT wider than D1 allows (5 terms)', async () => {
    const statements: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading drizzle's dialect to recover the built SQL text is the only way to assert query shape.
    const anyDb = t.db as any;
    const dialect = anyDb.dialect;
    const originalAll = anyDb.all.bind(anyDb);
    anyDb.all = (query: unknown) => {
      statements.push(dialect.sqlToQuery(query).sql);
      return originalAll(query);
    };

    try {
      const body = await system();
      // The fixture DB really does have enough tables for this to matter.
      expect(body.database.tables.length).toBeGreaterThan(5);

      const unions = statements.filter((s) => s.includes('UNION ALL'));
      expect(unions.length).toBeGreaterThan(1); // i.e. it chunked rather than emitting one wide union
      for (const s of unions) {
        // n terms == n-1 `UNION ALL` separators.
        expect(s.split('UNION ALL').length).toBeLessThanOrEqual(5);
      }
    } finally {
      anyDb.all = originalAll;
    }
  });
});

describe('GET /api/admin/system — version + freshness', () => {
  it('reports the API Worker build vars', async () => {
    const env = {
      ENV: 'staging',
      COMMIT_SHA: 'abc1234',
      DEPLOYED_AT: '2026-08-13T04:00:00.000Z',
    } as Env;

    const body = await system('', env);
    expect(body.version).toEqual({
      sha: 'abc1234',
      deployed_at: '2026-08-13T04:00:00.000Z',
      environment: 'staging',
    });
  });

  it('falls back to sentinels when the deploy vars were never injected', async () => {
    const body = await system('', { ENV: 'preview' } as Env);
    expect(body.version).toEqual({
      sha: 'unknown',
      deployed_at: '1970-01-01T00:00:00.000Z',
      environment: 'preview',
    });
  });

  it('reports an empty stats_cache as stale with null age, not as fresh', async () => {
    const body = await system();
    expect(body.stats_freshness).toEqual({ computed_at: null, age_hours: null, stale: true });
  });

  it('computes stats freshness against the injected clock', async () => {
    await t.db
      .insert(statsCache)
      .values({ key: 'home.total_products', value: 3, computedAt: '2026-08-13T01:00:00.000Z' });

    const body = await system();
    expect(body.stats_freshness).toEqual({
      computed_at: '2026-08-13T01:00:00.000Z',
      age_hours: 4,
      stale: false,
    });
  });

  it('stamps generated_at from the injected clock and reports a live source', async () => {
    const body = await system();
    expect(body.generated_at).toBe(NOW.toISOString());
    expect(body.source).toBe('live');
  });
});
