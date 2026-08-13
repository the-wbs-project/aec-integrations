/**
 * `GET /api/admin/system` (AECI-580 / P1.6) against the in-memory D1 harness.
 *
 * The centre of gravity is the AC's failure mode — **the screen must not report
 * "fine" for want of data**. So the cron-liveness block is asserted hard: no row
 * ever carries `last_outcome: 'ok'`, six of eight are `unknown` even on a fully
 * seeded database, and the two derivable ones stay `unknown` until their D1
 * artifact actually exists.
 *
 * The rest covers the `?recompute=1` contract (§13 D8), the single-drift-call
 * guarantee, the watermark read, and the D1 size/row-count block.
 *
 * One caveat worth knowing before adding cases here: **this harness is
 * better-sqlite3, not D1**, and the two differ on limits. The row-count query hit
 * `SQLITE_MAX_COMPOUND_SELECT` (5 on D1, 500 here) during local verification —
 * green suite, 500 in the browser. The last case in the D1-footprint block guards
 * that by asserting query shape rather than result.
 */

import { AdminSystemResponseSchema, type AdminSystemResponse } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products, statsCache, vendors } from '../db/schema';
import type { Env } from '../env';
import type { AlgoliaIndexDrift } from '../lib/algolia-drift';
import { ALGOLIA_WATERMARK_KEY } from '../lib/algolia-sync';
import { CRON_SCHEDULES } from '../lib/cron-schedules';
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

describe('GET /api/admin/system — cron liveness never reports a passing state', () => {
  it('returns all eight crons as `unknown` on an empty database', async () => {
    const body = await system();

    expect(body.crons).toHaveLength(8);
    expect(body.crons.map((r) => r.job)).toEqual([
      'data-quality',
      'analytics-digest',
      'moderation-snapshot',
      'home-stats',
      'algolia-sync',
      'algolia-drift',
      'request-reconcile',
      'waf-poll',
    ]);
    for (const row of body.crons) {
      expect(row.source).toBe('unknown');
      expect(row.last_run_at).toBeNull();
      expect(row.last_outcome).toBeNull();
      expect(row.duration_ms).toBeNull();
      expect(row.derived_from).toBeNull();
    }
  });

  it('NEVER reports `ok` — not on an empty database, not on a fully seeded one', async () => {
    await t.db.insert(statsCache).values([
      { key: 'home.total_products', value: 3, computedAt: '2026-08-13T01:00:00.000Z' },
      {
        key: ALGOLIA_WATERMARK_KEY,
        value: { product: '2026-08-13T02:00:00.000Z' },
        computedAt: '2026-08-13T02:00:00.000Z',
      },
    ]);

    const body = await system();
    // This is the AC: `job_runs` does not exist, so no outcome is knowable, and a
    // derived timestamp attests to the run, not to its success.
    expect(body.crons.every((r) => r.last_outcome === null)).toBe(true);
    expect(body.crons.some((r) => r.source === 'job_runs')).toBe(false);
  });

  it('carries `cron_liveness_unavailable` naming how many rows are unknown', async () => {
    const body = await system();
    const note = body.notes.find((n) => n.code === 'cron_liveness_unavailable');
    expect(note).toBeDefined();
    expect(note?.severity).toBe('warn');
    expect(note?.params).toEqual({ unknown: 8, total: 8 });
  });

  it('derives home-stats + algolia-sync from D1 once their artifacts exist, and leaves the other six unknown', async () => {
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
      'data-quality',
      'analytics-digest',
      'moderation-snapshot',
      'algolia-drift',
      'request-reconcile',
      'waf-poll',
    ]);
    expect(body.notes.find((n) => n.code === 'cron_liveness_unavailable')?.params).toEqual({
      unknown: 6,
      total: 8,
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
  it('omits the two network-dependent items by default, with a requires_recompute note', async () => {
    const body = await system();

    expect(body.recomputed).toBe(false);
    expect(body.data_quality).toBeNull();
    expect(body.algolia.drift).toBeNull();
    expect(codes(body)).toContain('requires_recompute');
  });

  it('runs all ten data-quality checks when asked', async () => {
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

  it('always reports the orphan sweep as unrecorded, with a note', async () => {
    const body = await system('?recompute=1');
    expect(body.algolia.orphan_sweep).toBeNull();
    expect(codes(body)).toContain('orphan_sweep_not_persisted');
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
