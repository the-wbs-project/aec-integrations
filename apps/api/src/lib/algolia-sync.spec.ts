/**
 * Unit tests for the AECI-139 incremental sync core — Drizzle/D1 (ADR 0016 /
 * AECI-253). Replaces the fake-Prisma suite: each case seeds REAL rows on the
 * in-memory D1 harness and drives the Algolia batch transport with a FAKE `fetch`
 * (recording every `{requests}` body it receives). That exercises the real
 * membership partition (promoted → upsert, else delete; integration eligible iff
 * BOTH endpoints promoted), the watermark window `(gtIso, lteIso]` over the ISO
 * `updated_at` TEXT, the watermark fence (advance on success, hold on failure),
 * chunk-and-stop, transform-error resilience, and the promote-hook id targeting —
 * against the actual queries, no Prisma, no network.
 */

import { ALGOLIA_BATCH_MAX } from '@aeci/shared/algolia-batch';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { integrations, products, statsCache, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  ALGOLIA_WATERMARK_KEY,
  indexEntity,
  readWatermark,
  runDailySync,
  syncPromoteTargets,
  writeWatermark,
  type AlgoliaSyncFilter,
  type AlgoliaWatermark,
} from './algolia-sync';

const CREDS = { appId: 'APP', apiKey: 'write-key' };
const ENV = 'staging' as const;

// A window wide enough to cover every seeded `updated_at` unless a test overrides it.
const ALL: AlgoliaSyncFilter = {
  type: 'window',
  gtIso: '1970-01-01T00:00:00.000Z',
  lteIso: '2999-01-01T00:00:00.000Z',
};

// Valid UUIDs for any id the record schemas would validate downstream.
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedProduct(
  id: string,
  over: Partial<typeof products.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(products).values({
    id,
    slug: id,
    name: `Product ${id}`,
    promotionStatus: 'promoted',
    updatedAt: '2026-06-05T00:00:00.000Z',
    ...over,
  });
}

async function seedVendor(
  id: string,
  over: Partial<typeof vendors.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(vendors).values({
    id,
    slug: id,
    companyName: `Vendor ${id}`,
    promotionStatus: 'promoted',
    updatedAt: '2026-06-05T00:00:00.000Z',
    ...over,
  });
}

async function seedIntegration(
  id: string,
  sourceProductId: string,
  targetProductId: string,
  over: Partial<typeof integrations.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(integrations).values({
    id,
    sourceProductId,
    targetProductId,
    mechanismKind: 'native',
    updatedAt: '2026-06-05T00:00:00.000Z',
    ...over,
  });
}

// ── Fake Algolia batch transport (records each request body) ─────────────────

type BatchCall = {
  url: string;
  body: { requests: Array<{ action: string; body: { objectID: string } }> };
};

function makeFetch(failOn?: (url: string) => boolean) {
  const calls: BatchCall[] = [];
  const fn = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (failOn?.(url)) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
    return new Response(JSON.stringify({ taskID: 1 }), { status: 200 });
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

const actionsOf = (call: BatchCall) =>
  call.body.requests.map((r) => `${r.action}:${r.body.objectID}`);

// ── indexEntity: membership partition (products) ─────────────────────────────

describe('indexEntity — products', () => {
  it('upserts promoted rows and deletes non-promoted rows in one batch', async () => {
    await seedProduct('keep', { promotionStatus: 'promoted' });
    await seedProduct('gone', { promotionStatus: 'retracted' });
    await seedProduct('gone-2', { promotionStatus: 'rejected' });
    const { fetchImpl, calls } = makeFetch();

    const result = await indexEntity(t.db, fetchImpl, CREDS, ENV, 'products', ALL);

    expect(result).toMatchObject({
      entity: 'products',
      saved: 1,
      deleted: 2,
      ok: true,
      transformErrors: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://APP.algolia.net/1/indexes/staging_products/batch');
    expect(actionsOf(calls[0]!).sort()).toEqual(
      ['deleteObject:gone', 'deleteObject:gone-2', 'updateObject:keep'].sort(),
    );
  });

  it('is a no-op (no fetch) when nothing changed', async () => {
    const { fetchImpl, calls } = makeFetch();
    const result = await indexEntity(t.db, fetchImpl, CREDS, ENV, 'products', ALL);
    expect(result).toMatchObject({ saved: 0, deleted: 0, ok: true });
    expect(calls).toHaveLength(0);
  });

  it('reports ok:false with the upstream message on a push failure', async () => {
    await seedProduct('p-1');
    const { fetchImpl } = makeFetch(() => true);
    const result = await indexEntity(t.db, fetchImpl, CREDS, ENV, 'products', ALL);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('chunks at ALGOLIA_BATCH_MAX and stops at the first failed chunk', async () => {
    // ALGOLIA_BATCH_MAX + 1 promoted rows → two chunks; fail only the 2nd call.
    for (let i = 0; i <= ALGOLIA_BATCH_MAX; i++) {
      await seedProduct(u(i), { slug: `p-${i}`, name: `P${i}` });
    }
    let nth = 0;
    const { fetchImpl, calls } = makeFetch(() => ++nth === 2);

    const result = await indexEntity(t.db, fetchImpl, CREDS, ENV, 'products', ALL);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.requests).toHaveLength(ALGOLIA_BATCH_MAX);
    expect(calls[1]!.body.requests).toHaveLength(1);
    // First chunk succeeded (counted), second failed → stop, ok:false.
    expect(result.ok).toBe(false);
    expect(result.saved).toBe(ALGOLIA_BATCH_MAX);
    expect(result.error).toBe('boom');
  });
});

// ── indexEntity: window selects only (gtIso, lteIso] ─────────────────────────

describe('indexEntity — watermark window', () => {
  it('pushes only rows whose updated_at is in (gtIso, lteIso]', async () => {
    await seedProduct('before', { updatedAt: '2026-06-01T00:00:00.000Z' }); // == gt → excluded
    await seedProduct('inside', { updatedAt: '2026-06-05T00:00:00.000Z' }); // in window
    await seedProduct('edge', { updatedAt: '2026-06-09T03:00:00.000Z' }); // == lte → included
    await seedProduct('after', { updatedAt: '2026-06-10T00:00:00.000Z' }); // > lte → excluded
    const { fetchImpl, calls } = makeFetch();

    const result = await indexEntity(t.db, fetchImpl, CREDS, ENV, 'products', {
      type: 'window',
      gtIso: '2026-06-01T00:00:00.000Z',
      lteIso: '2026-06-09T03:00:00.000Z',
    });

    expect(result.saved).toBe(2);
    expect(actionsOf(calls[0]!).sort()).toEqual(
      ['updateObject:edge', 'updateObject:inside'].sort(),
    );
  });
});

// ── indexEntity: membership partition (integrations) ─────────────────────────

describe('indexEntity — integrations', () => {
  it('upserts eligible (both endpoints promoted) and deletes ineligible', async () => {
    // keep: both endpoints promoted. gone: target NOT promoted → ineligible.
    await seedProduct('src', { promotionStatus: 'promoted' });
    await seedProduct('tgt-promoted', { promotionStatus: 'promoted' });
    await seedProduct('tgt-pending', { promotionStatus: 'pending' });
    await seedIntegration('keep', 'src', 'tgt-promoted');
    await seedIntegration('gone', 'src', 'tgt-pending');
    const { fetchImpl, calls } = makeFetch();

    const result = await indexEntity(t.db, fetchImpl, CREDS, ENV, 'integrations', ALL);

    expect(result).toMatchObject({ entity: 'integrations', saved: 1, deleted: 1, ok: true });
    expect(calls[0]!.url).toBe('https://APP.algolia.net/1/indexes/staging_integrations/batch');
    expect(actionsOf(calls[0]!).sort()).toEqual(['deleteObject:gone', 'updateObject:keep'].sort());
  });

  it('deletes an integration when EITHER endpoint is not promoted (source unpromoted)', async () => {
    await seedProduct('src-pending', { promotionStatus: 'pending' });
    await seedProduct('tgt', { promotionStatus: 'promoted' });
    await seedIntegration('gone', 'src-pending', 'tgt');
    const { fetchImpl, calls } = makeFetch();

    const result = await indexEntity(t.db, fetchImpl, CREDS, ENV, 'integrations', ALL);
    expect(result).toMatchObject({ saved: 0, deleted: 1, ok: true });
    expect(actionsOf(calls[0]!)).toEqual(['deleteObject:gone']);
  });

  it('skips (and counts) a row whose transform throws — never wedges the run', async () => {
    await seedProduct('src', { promotionStatus: 'promoted' });
    await seedProduct('tgt', { promotionStatus: 'promoted' });
    await seedIntegration('good', 'src', 'tgt', { mechanismKind: 'native' });
    // The DB CHECK guards a bad mechanism_kind on INSERT/UPDATE, so seed a valid
    // row and corrupt the column with the CHECK temporarily suspended — this
    // plants the exact data-integrity violation the transform's fail-loud branch
    // exists to catch, and drives it through the real query path.
    await seedIntegration('bad', 'src', 'tgt', { mechanismKind: 'webhook' });
    t.raw.pragma('ignore_check_constraints = ON');
    t.raw.prepare(`UPDATE integrations SET mechanism_kind = 'telepathy' WHERE id = ?`).run('bad');
    t.raw.pragma('ignore_check_constraints = OFF');
    const { fetchImpl, calls } = makeFetch();

    const result = await indexEntity(t.db, fetchImpl, CREDS, ENV, 'integrations', ALL);

    expect(result).toMatchObject({ saved: 1, transformErrors: 1, ok: true });
    expect(calls[0]!.body.requests.map((r) => r.body.objectID)).toEqual(['good']);
  });
});

// ── runDailySync: watermark fence + window ───────────────────────────────────

describe('runDailySync', () => {
  const NOW = new Date('2026-06-09T03:00:00.000Z');
  const PRIOR: AlgoliaWatermark = {
    products: '2026-06-01T00:00:00.000Z',
    vendors: '2026-06-01T00:00:00.000Z',
    integrations: '2026-06-01T00:00:00.000Z',
  };

  async function seedWatermark(value: AlgoliaWatermark): Promise<void> {
    await t.db
      .insert(statsCache)
      .values({ key: ALGOLIA_WATERMARK_KEY, value, computedAt: '2026-06-01T00:00:00.000Z' });
  }
  const readBack = () =>
    t.db.query.statsCache.findFirst({ where: eq(statsCache.key, ALGOLIA_WATERMARK_KEY) });

  it('windows each entity by [prior, cutoff] and advances every watermark on success', async () => {
    await seedWatermark(PRIOR);
    // In-window vs out-of-window product: only the in-window one should sync.
    await seedProduct('fresh', { updatedAt: '2026-06-05T00:00:00.000Z' });
    await seedProduct('stale', { updatedAt: '2026-05-01T00:00:00.000Z' }); // ≤ prior → excluded
    await seedVendor('v-1', { updatedAt: '2026-06-05T00:00:00.000Z' });
    const { fetchImpl, calls } = makeFetch();

    const result = await runDailySync(t.db, fetchImpl, CREDS, ENV, NOW);

    expect(result.cutoff).toBe('2026-06-09T03:00:00.000Z');
    // Only 'fresh' was in the product window.
    const productCall = calls.find((c) => c.url.includes('staging_products'))!;
    expect(actionsOf(productCall)).toEqual(['updateObject:fresh']);

    const value = (await readBack())!.value as AlgoliaWatermark;
    expect(value).toEqual({
      products: '2026-06-09T03:00:00.000Z',
      vendors: '2026-06-09T03:00:00.000Z',
      integrations: '2026-06-09T03:00:00.000Z',
    });
  });

  it('holds the watermark of an entity whose push failed (others advance)', async () => {
    await seedWatermark(PRIOR);
    await seedProduct('p-1');
    await seedVendor('v-1');
    // Only the vendors index push fails.
    const { fetchImpl } = makeFetch((url) => url.includes('staging_vendors'));

    await runDailySync(t.db, fetchImpl, CREDS, ENV, NOW);

    const value = (await readBack())!.value as AlgoliaWatermark;
    expect(value).toEqual({
      products: '2026-06-09T03:00:00.000Z',
      vendors: '2026-06-01T00:00:00.000Z', // held for retry
      integrations: '2026-06-09T03:00:00.000Z',
    });
  });

  it('treats a missing watermark row as epoch (self-healing full sweep)', async () => {
    // No stats_cache row seeded → epoch gt → an old row still falls in the window.
    await seedProduct('ancient', { updatedAt: '2000-01-01T00:00:00.000Z' });
    const { fetchImpl, calls } = makeFetch();

    await runDailySync(t.db, fetchImpl, CREDS, ENV, NOW);

    const productCall = calls.find((c) => c.url.includes('staging_products'))!;
    expect(actionsOf(productCall)).toEqual(['updateObject:ancient']);
    // And the watermark row is created at the cutoff.
    const value = (await readBack())!.value as AlgoliaWatermark;
    expect(value.products).toBe('2026-06-09T03:00:00.000Z');
  });
});

// ── readWatermark / writeWatermark round-trip ────────────────────────────────

describe('watermark persistence', () => {
  it('readWatermark defaults every entity to epoch when no row exists', async () => {
    const wm = await readWatermark(t.db);
    expect(wm).toEqual({
      products: '1970-01-01T00:00:00.000Z',
      vendors: '1970-01-01T00:00:00.000Z',
      integrations: '1970-01-01T00:00:00.000Z',
    });
  });

  it('writeWatermark round-trips through the stats_cache singleton (insert then update)', async () => {
    const first: AlgoliaWatermark = {
      products: '2026-06-01T00:00:00.000Z',
      vendors: '2026-06-02T00:00:00.000Z',
      integrations: '2026-06-03T00:00:00.000Z',
    };
    await writeWatermark(t.db, first, new Date('2026-06-09T03:00:00.000Z'));
    expect(await readWatermark(t.db)).toEqual(first);

    // Re-write upserts the same singleton row (onConflictDoUpdate), not a second.
    const second: AlgoliaWatermark = { ...first, products: '2026-06-08T00:00:00.000Z' };
    await writeWatermark(t.db, second, new Date('2026-06-10T03:00:00.000Z'));
    expect(await readWatermark(t.db)).toEqual(second);

    const rows = await t.db.select().from(statsCache);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.computedAt).toBe('2026-06-10T03:00:00.000Z');
  });
});

// ── syncPromoteTargets: id-scoped, skips empty entities ──────────────────────

describe('syncPromoteTargets', () => {
  it('indexes the touched product + vendors by id and skips empty integrations', async () => {
    await seedProduct('p-1');
    await seedProduct('p-other'); // present but NOT a target → must not be pushed
    await seedVendor('v-1');
    const { fetchImpl, calls } = makeFetch();

    const results = await syncPromoteTargets(t.db, fetchImpl, CREDS, ENV, {
      product: { id: 'p-1' },
      vendors: [{ id: 'v-1' }],
      integrations: [],
    });

    expect(results.map((r) => r.entity)).toEqual(['products', 'vendors']);
    expect(calls.map((c) => c.url)).toEqual([
      'https://APP.algolia.net/1/indexes/staging_products/batch',
      'https://APP.algolia.net/1/indexes/staging_vendors/batch',
    ]);
    // Only the targeted product id was indexed (id filter, not the whole table).
    const productCall = calls.find((c) => c.url.includes('staging_products'))!;
    expect(actionsOf(productCall)).toEqual(['updateObject:p-1']);
  });

  it('returns no results when the promote touched nothing indexable', async () => {
    const { fetchImpl, calls } = makeFetch();
    const results = await syncPromoteTargets(t.db, fetchImpl, CREDS, ENV, {
      product: null,
      vendors: [],
      integrations: [],
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
