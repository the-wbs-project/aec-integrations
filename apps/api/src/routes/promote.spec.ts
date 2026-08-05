/**
 * `POST /api/promote` on the Drizzle/D1 path (ADR 0016 / AECI-253, AECI-249),
 * against the in-memory D1 harness. The plan-then-`db.batch` upsert is exercised
 * over real SQL: seed real rows, assert the real vendor/product/taxonomy/
 * integration/join/audit rows + the post-batch count recompute.
 *
 * The post-commit Algolia upsert is injected as a seam (its transport is
 * `algolia-sync.spec`'s job); the cache purge + `cacheTagsForPromote` are
 * unchanged (DB-independent). The 409/500 unique-violation paths inject a
 * `db.batch` that throws the SQLite error the DB would raise.
 */

import type { PromoteResponse } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  integrations,
  productCategories,
  products,
  productTrades,
  productVendors,
  statsCache,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { bookmarkMiddleware } from '../bookmark-middleware';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { DbFactory } from '../lib/handler-utils';
import { requireReviewAppAuth } from '../lib/review-auth';
import { makeTestDb, recordingFactory, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  createPromoteHandler,
  refreshHomeStatsAfterPromote,
  type PromoteAlgoliaSync,
  type PromoteGoogleIndexingNotify,
  type PromoteHomeStatsRefresh,
  type PromoteIndexNowNotify,
} from './promote';
import { cacheTagsForPromote, touchedTradeSlugs } from './promote-cache-tags';
import { affectedUrlsForPromote, type AffectedUrlOptions } from './promote-indexnow-urls';

/** Deterministic UUID for seeded rows referenced via `supabaseId`. */
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const baseEnv: Env = {
  ENV: 'preview',
  REVIEW_APP_TOKEN: 'secret-token',
};

/** A no-op Algolia seam — default for all tests so the real (Prisma) default is
 *  never hit; the wiring tests inject a spy instead. */
const noopAlgolia: PromoteAlgoliaSync = async () => {};

/** A no-op IndexNow seam — default for all tests so the real default (which calls
 *  the global `fetch`) is never hit; the wiring tests inject a spy instead. */
const noopIndexNow: PromoteIndexNowNotify = async () => {};

/** A no-op Google Indexing seam — default for all tests so the real default
 *  (which signs a JWT + calls the global `fetch`) is never hit; the wiring tests
 *  inject a spy instead. */
const noopGoogleIndexing: PromoteGoogleIndexingNotify = async () => {};

/** A no-op home-stats refresh seam — default for all tests so the real default
 *  (which opens a fresh `getDb` on `env.DB` + recomputes/purges) is never hit; the
 *  wiring tests inject a spy, and the default-behavior tests call
 *  `refreshHomeStatsAfterPromote` directly against the in-memory `t.db`. */
const noopHomeStats: PromoteHomeStatsRefresh = async () => {};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => {
  t.dispose();
  vi.unstubAllGlobals();
});

function buildApp(
  opts: {
    withAuth?: boolean;
    syncAlgolia?: PromoteAlgoliaSync;
    notifyIndexNow?: PromoteIndexNowNotify;
    notifyGoogleIndexing?: PromoteGoogleIndexingNotify;
    refreshHomeStats?: PromoteHomeStatsRefresh;
    dbFor?: DbFactory;
  } = {},
) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  const handler = createPromoteHandler(
    opts.dbFor ?? t.factory,
    opts.syncAlgolia ?? noopAlgolia,
    opts.notifyIndexNow ?? noopIndexNow,
    opts.notifyGoogleIndexing ?? noopGoogleIndexing,
    opts.refreshHomeStats ?? noopHomeStats,
  );
  if (opts.withAuth) app.post('/api/promote', requireReviewAppAuth(), handler);
  else app.post('/api/promote', handler);
  return app;
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function promote(body: unknown, env = baseEnv, execCtx = fakeExecutionContext()) {
  return buildApp().request('/api/promote', post(body), env, execCtx);
}

const auditActions = async () => (await t.db.select().from(auditLog)).map((e) => e.action);

// ─── Seed helpers ──────────────────────────────────────────────────────────────
const seedVendor = (id: string, slug: string, name: string) =>
  t.db.insert(vendors).values({ id, slug, companyName: name, promotionStatus: 'promoted' });
const seedProduct = (
  id: string,
  slug: string,
  name: string,
  extra: Partial<typeof products.$inferInsert> = {},
) => t.db.insert(products).values({ id, slug, name, promotionStatus: 'promoted', ...extra });
const seedDataObject = (id: string, slug: string, name: string, aliases: string[] = []) =>
  t.db.insert(taxonomyDataObjects).values({ id, slug, name, aliases });

describe('createPromoteHandler — Sessions API bookmark threading (AECI-250)', () => {
  it('threads inbound x-d1-bookmark + first-primary into getDb and emits the outbound bookmark', async () => {
    const rec = recordingFactory(t.db);
    rec.setBookmark('bk-after-write');

    const app = new Hono<{ Bindings: Env }>();
    app.onError(errorHandler());
    app.use('*', bookmarkMiddleware());
    app.post(
      '/api/promote',
      createPromoteHandler(
        rec.factory,
        noopAlgolia,
        noopIndexNow,
        noopGoogleIndexing,
        noopHomeStats,
      ),
    );

    const res = await app.request(
      '/api/promote',
      post(
        {
          vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
          product: { ref: 'p1', name: 'Revit' },
          integrations: [],
        },
        { 'x-d1-bookmark': 'in-99' },
      ),
      baseEnv,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    // Inbound bookmark + the write anchor reached getDb …
    expect(rec.calls[0]).toEqual({ bookmark: 'in-99', constraint: 'first-primary' });
    // … and the session bookmark came back out for the next request.
    expect(res.headers.get('x-d1-bookmark')).toBe('bk-after-write');
    // The real write still happened over the recording factory's client.
    expect(await t.db.select().from(products)).toHaveLength(1);
  });
});

describe('createPromoteHandler', () => {
  it('creates a product with vendor and taxonomy', async () => {
    const existingProd = uuid(1);
    await seedProduct(existingProd, 'navisworks', 'Navisworks');

    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: {
        ref: 'p1',
        name: 'Revit',
        categories: ['BIM', 'Design'],
        audiences: ['Architecture'],
      },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: existingProd },
          builtByVendor: { ref: 'v1' },
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      vendors: { ref: string; slug: string; operation: string }[];
      product: { ref: string; id: string; slug: string; operation: string };
      integrations: { ref: string; operation: string }[];
      taxonomy: { categories: unknown[]; audiences: unknown[] };
      skipped: unknown[];
    };

    expect(b.vendors[0]).toMatchObject({ ref: 'v1', slug: 'autodesk', operation: 'created' });
    expect(b.product).toMatchObject({ ref: 'p1', slug: 'revit', operation: 'created' });
    expect(b.taxonomy.categories).toHaveLength(2);
    expect(b.taxonomy.audiences).toHaveLength(1);
    expect(b.skipped).toHaveLength(0);
    expect(b.integrations[0]).toMatchObject({ ref: 'i1', operation: 'created' });

    // Join rows + integration reflect the bundle.
    expect(await t.db.select().from(productVendors)).toHaveLength(1);
    expect(await t.db.select().from(productCategories)).toHaveLength(2);
    expect(await t.db.select().from(integrations)).toHaveLength(1);

    // Post-batch recompute: both endpoints' integration_count = 1.
    const revit = await t.db.query.products.findFirst({ where: eq(products.id, b.product.id) });
    const navis = await t.db.query.products.findFirst({ where: eq(products.id, existingProd) });
    expect(revit!.integrationCount).toBe(1);
    expect(navis!.integrationCount).toBe(1);

    const audits = await t.db.select().from(auditLog);
    expect(audits.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'vendor.created',
        'category.created',
        'product.created',
        'integration.created',
      ]),
    );
    expect(
      audits.every((e) => (e.metadata as { source?: string }).source === 'review-app-promote'),
    ).toBe(true);
  });

  it('updates by supabaseId and keeps the slug stable', async () => {
    const vendX = uuid(2);
    const prodX = uuid(3);
    await seedVendor(vendX, 'autodesk', 'Autodesk');
    await seedProduct(prodX, 'revit', 'Revit');

    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: vendX, companyName: 'Autodesk Inc.' }],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit 2025' },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      vendors: { slug: string; operation: string }[];
      product: { slug: string; operation: string };
    };
    expect(b.vendors[0]).toMatchObject({ slug: 'autodesk', operation: 'updated' });
    expect(b.product).toMatchObject({ slug: 'revit', operation: 'updated' });

    const prod = await t.db.query.products.findFirst({ where: eq(products.id, prodX) });
    expect(prod).toMatchObject({ name: 'Revit 2025', slug: 'revit' });
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['vendor.updated', 'product.updated']),
    );
  });

  it('promotes a vendor on its own (no product)', async () => {
    const vendX = uuid(2);
    await seedVendor(vendX, 'autodesk', 'Autodesk');

    const res = await promote({
      vendors: [
        {
          ref: 'v1',
          supabaseId: vendX,
          companyName: 'Autodesk',
          website: 'https://new.example',
          xUrl: 'https://x.com/autodesk',
          facebookUrl: 'https://www.facebook.com/autodesk',
          instagramUrl: 'https://www.instagram.com/autodesk',
          youtubeUrl: 'https://www.youtube.com/@autodesk',
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      vendors: { id: string; slug: string; operation: string }[];
      product: unknown;
      taxonomy: { categories: unknown[] };
    };
    expect(b.vendors[0]).toMatchObject({ id: vendX, slug: 'autodesk', operation: 'updated' });
    expect(b.product).toBeNull();
    expect(b.taxonomy.categories).toHaveLength(0);

    const vend = await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendX) });
    expect(vend).toMatchObject({
      website: 'https://new.example',
      xUrl: 'https://x.com/autodesk',
      facebookUrl: 'https://www.facebook.com/autodesk',
      instagramUrl: 'https://www.instagram.com/autodesk',
      youtubeUrl: 'https://www.youtube.com/@autodesk',
    });
    expect(await t.db.select().from(products)).toHaveLength(0);
    expect(await auditActions()).toEqual(['vendor.updated']);
  });

  it('disambiguates a colliding product slug using the primary vendor slug', async () => {
    await seedProduct(uuid(5), 'revit', 'Revit');
    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit' },
    });
    const b = (await res.json()) as { product: { slug: string } };
    expect(b.product.slug).toBe('revit-autodesk');
  });

  it('reuses existing taxonomy rather than duplicating', async () => {
    await t.db.insert(taxonomyCategories).values({ id: uuid(6), slug: 'bim', name: 'BIM' });
    const res = await promote({ product: { ref: 'p1', name: 'Revit', categories: ['BIM'] } });
    const b = (await res.json()) as {
      taxonomy: { categories: { id: string; operation: string }[] };
    };
    expect(b.taxonomy.categories[0]).toMatchObject({ id: uuid(6), operation: 'reused' });
    expect(await t.db.select().from(taxonomyCategories)).toHaveLength(1);
    expect(await auditActions()).not.toContain('category.created');
  });

  it('skips an integration whose other endpoint is not promoted', async () => {
    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: uuid(9) } },
      ],
    });
    const b = (await res.json()) as {
      integrations: unknown[];
      skipped: { ref: string; kind: string }[];
    };
    expect(b.integrations).toHaveLength(0);
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'i1', kind: 'integration' })]);
    expect(await t.db.select().from(integrations)).toHaveLength(0);
  });

  it('skips a self-referential integration', async () => {
    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [{ ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { ref: 'p1' } }],
    });
    const b = (await res.json()) as { skipped: { ref: string; reason: string }[] };
    expect(b.skipped[0]!.ref).toBe('i1');
    expect(b.skipped[0]!.reason).toMatch(/self-link/i);
  });

  it('recomputes the OLD endpoint count when an integration update moves an endpoint', async () => {
    const [prodA, prodB, prodC, intgId] = [uuid(1), uuid(2), uuid(3), uuid(4)];
    await seedProduct(prodA, 'a', 'A', { integrationCount: 1 });
    await seedProduct(prodB, 'b', 'B', { integrationCount: 1 });
    await seedProduct(prodC, 'c', 'C', { integrationCount: 0 });
    await t.db
      .insert(integrations)
      .values({ id: intgId, sourceProductId: prodA, targetProductId: prodB });

    const res = await promote({
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgId,
          sourceProduct: { supabaseId: prodA },
          targetProduct: { supabaseId: prodC },
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as { integrations: { ref: string; operation: string }[] };
    expect(b.integrations[0]).toMatchObject({ ref: 'i1', operation: 'updated' });

    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, intgId) });
    expect(row).toMatchObject({ sourceProductId: prodA, targetProductId: prodC });
    const get = async (id: string) =>
      (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.integrationCount;
    expect(await get(prodA)).toBe(1);
    expect(await get(prodC)).toBe(1);
    expect(await get(prodB)).toBe(0); // OLD endpoint recomputed — the AECI-86 drift fix
  });

  it('returns 400 for a payload missing the product', async () => {
    const res = await promote({ vendors: [] });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: { code: string }; trace_id: string };
    expect(b.error.code).toBe('VALIDATION_FAILED');
    expect(b.trace_id).toBeTruthy();
  });

  it('returns 400 for duplicate refs', async () => {
    const res = await promote({
      vendors: [{ ref: 'dup', companyName: 'A' }],
      product: { ref: 'dup', name: 'Revit' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await buildApp().request(
      '/api/promote',
      post('not json'),
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MALFORMED_REQUEST',
    );
  });

  it('returns 409 SLUG_CONFLICT when the batch trips a slug unique constraint', async () => {
    // Inject the SQLite UNIQUE error the DB would raise on a racing duplicate slug.
    (t.db as unknown as { batch: () => Promise<unknown[]> }).batch = () =>
      Promise.reject(new Error('UNIQUE constraint failed: products.slug'));

    const res = await promote({ product: { ref: 'p1', name: 'Revit' } });
    expect(res.status).toBe(409);
    const b = (await res.json()) as {
      error: { code: string; details?: { target?: unknown } };
      trace_id: string;
    };
    expect(b.error.code).toBe('SLUG_CONFLICT');
    expect(b.error.details?.target).toEqual(['slug']);
    expect(b.trace_id).toBeTruthy();
  });

  it('still returns 500 for a non-slug unique violation (no mislabeling)', async () => {
    (t.db as unknown as { batch: () => Promise<unknown[]> }).batch = () =>
      Promise.reject(
        new Error(
          'UNIQUE constraint failed: product_vendors.product_id, product_vendors.vendor_id',
        ),
      );

    const res = await promote({ product: { ref: 'p1', name: 'Revit' } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('usefulness resolution on promote (AECI-172)', () => {
  type UseGroup = { slug: string; name: string; points: string[] };
  type Stored = { audiences: UseGroup[]; phases: UseGroup[] };

  const seedAudience = (id: string, slug: string, name: string) =>
    t.db.insert(taxonomyAudiences).values({ id, slug, name });
  const seedPhase = (id: string, slug: string, name: string) =>
    t.db.insert(taxonomyPhases).values({ id, slug, name });
  const storedUsefulness = async (id: string) =>
    (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.usefulness;

  it('resolves groups by name and by slug, storing the canonical {slug,name}', async () => {
    await seedAudience(uuid(1), 'architecture', 'Architecture');
    await seedPhase(uuid(2), 'design', 'Design');

    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: {
          audiences: [{ name: 'Architecture', points: ['Coordinate models', 'Clash detection'] }],
          phases: [{ slug: 'design', points: ['Author drawings'] }],
        },
      },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string }; skipped: unknown[] };
    expect(b.skipped).toHaveLength(0);
    expect(await storedUsefulness(b.product.id)).toEqual({
      audiences: [
        {
          slug: 'architecture',
          name: 'Architecture',
          points: ['Coordinate models', 'Clash detection'],
        },
      ],
      phases: [{ slug: 'design', name: 'Design', points: ['Author drawings'] }],
    });
  });

  it('resolves usefulness against a term created in the same promote (runs after taxonomy)', async () => {
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        audiences: ['Architecture'],
        usefulness: { audiences: [{ name: 'Architecture', points: ['x'] }], phases: [] },
      },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string }; skipped: unknown[] };
    expect(b.skipped).toHaveLength(0);
    expect((await storedUsefulness(b.product.id)) as Stored).toMatchObject({
      audiences: [{ slug: 'architecture', name: 'Architecture', points: ['x'] }],
    });
  });

  it('merges same-term groups, concatenating points in source order', async () => {
    await seedAudience(uuid(1), 'architecture', 'Architecture');
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: {
          audiences: [
            { slug: 'architecture', points: ['first'] },
            { name: 'Architecture', points: ['second'] },
          ],
          phases: [],
        },
      },
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string } };
    expect(((await storedUsefulness(b.product.id)) as Stored).audiences).toEqual([
      { slug: 'architecture', name: 'Architecture', points: ['first', 'second'] },
    ]);
  });

  it('drops an unresolvable group and reports it in skipped[] with kind=usefulness', async () => {
    await seedAudience(uuid(1), 'architecture', 'Architecture');
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: {
          audiences: [
            { name: 'Architecture', points: ['kept'] },
            { name: 'Nonexistent Discipline', points: ['dropped'] },
          ],
          phases: [],
        },
      },
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      product: { id: string };
      skipped: { ref: string; kind: string }[];
    };
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'p1', kind: 'usefulness' })]);
    expect(((await storedUsefulness(b.product.id)) as Stored).audiences).toEqual([
      { slug: 'architecture', name: 'Architecture', points: ['kept'] },
    ]);
  });

  it('clears the column to NULL when usefulness is null', async () => {
    const prodX = uuid(3);
    await seedProduct(prodX, 'revit', 'Revit', {
      usefulness: {
        audiences: [{ slug: 'architecture', name: 'Architecture', points: ['old'] }],
        phases: [],
      },
    });
    const res = await promote({
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit', usefulness: null },
    });
    expect(res.status).toBe(200);
    expect(await storedUsefulness(prodX)).toBeNull();
  });

  it('leaves the column NULL when usefulness is absent on a create', async () => {
    const res = await promote({ product: { ref: 'p1', name: 'Revit' } });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string } };
    expect(await storedUsefulness(b.product.id)).toBeNull();
  });

  it('accepts and strips unknown keys inside a usefulness group (Zod passthrough off)', async () => {
    await seedAudience(uuid(1), 'architecture', 'Architecture');
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: {
          audiences: [{ slug: 'architecture', points: ['x'], bogusKey: 'ignored' }],
          phases: [],
        },
      },
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string } };
    expect(((await storedUsefulness(b.product.id)) as Stored).audiences).toEqual([
      { slug: 'architecture', name: 'Architecture', points: ['x'] },
    ]);
  });

  it('rejects a usefulness group with neither slug nor name', async () => {
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: { audiences: [{ points: ['x'] }], phases: [] },
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('createPromoteHandler — trades ingest (AECI-542)', () => {
  // `taxonomy_trades.description` is NOT NULL (`/trades/:slug` ships as an SEO
  // landing page, so copy is part of the contract — TRADES_VOCABULARY.md §5).
  const seedTrade = (id: string, slug: string, name: string, aliases: string[] = []) =>
    t.db.insert(taxonomyTrades).values({ id, slug, name, description: `${name} work.`, aliases });

  const tradeSlugsFor = async (productId: string) =>
    (
      await t.db
        .select({ slug: taxonomyTrades.slug })
        .from(productTrades)
        .innerJoin(taxonomyTrades, eq(taxonomyTrades.id, productTrades.tradeId))
        .where(eq(productTrades.productId, productId))
    )
      .map((r) => r.slug)
      .sort();

  type Body = {
    product: { id: string };
    taxonomy: { trades: { slug: string; id: string; operation: string }[] };
    skipped: { ref: string; kind: string; reason: string }[];
  };

  it('leaves behaviour unchanged for a payload with no trades key', async () => {
    await seedTrade(uuid(1), 'electrical', 'Electrical');

    const res = await promote({ product: { ref: 'p1', name: 'Revit' } });

    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    expect(b.taxonomy.trades).toEqual([]);
    expect(b.skipped).toHaveLength(0);
    expect(await tradeSlugsFor(b.product.id)).toEqual([]);
  });

  it('resolves by slug, name, and alias case-insensitively, deduping to one join row', async () => {
    await seedTrade(uuid(1), 'electrical', 'Electrical', ['Electrician']);
    await seedTrade(uuid(2), 'hvac-mechanical', 'HVAC & Mechanical', ['HVAC', 'Mechanical']);

    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        // slug, name (odd casing), alias, and a second alias for the SAME term.
        trades: ['electrical', 'hvac & MECHANICAL', 'Electrician', 'HVAC'],
      },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    expect(b.skipped).toHaveLength(0);
    expect(b.taxonomy.trades).toEqual([
      { slug: 'electrical', id: uuid(1), operation: 'reused' },
      { slug: 'hvac-mechanical', id: uuid(2), operation: 'reused' },
    ]);
    expect(await tradeSlugsFor(b.product.id)).toEqual(['electrical', 'hvac-mechanical']);
  });

  it('writes the join rows and the product audit row in ONE atomic batch (§26.1)', async () => {
    await seedTrade(uuid(1), 'electrical', 'Electrical');
    const realBatch = t.db.batch.bind(t.db) as (s: unknown[]) => Promise<unknown[]>;
    let batchCalls = 0;
    (t.db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch = (stmts) => {
      batchCalls += 1;
      return realBatch(stmts);
    };

    const res = await promote({
      product: { ref: 'p1', name: 'Revit', trades: ['electrical'] },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    // One batch — so the join rows and the audit row commit or roll back together.
    expect(batchCalls).toBe(1);
    expect(await tradeSlugsFor(b.product.id)).toEqual(['electrical']);
    // Resolve-only: the product audit row lands, but no term was minted, so there
    // is no `trade.created` action to log.
    const actions = await auditActions();
    expect(actions).toContain('product.created');
    expect(actions).not.toContain('trade.created');
  });

  it('reports an unresolvable trade in skipped[] (kind: trade) and creates no term', async () => {
    await seedTrade(uuid(1), 'paving-asphalt', 'Paving & Asphalt', ['Blacktop']);

    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        trades: ['paving-asphalt', 'paving-contractors'],
      },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    // The known trade still lands; only the unmatched value is dropped.
    expect(b.taxonomy.trades).toEqual([
      { slug: 'paving-asphalt', id: uuid(1), operation: 'reused' },
    ]);
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'p1', kind: 'trade' })]);
    expect(b.skipped[0]!.reason).toMatch(/paving-contractors/);
    expect(await tradeSlugsFor(b.product.id)).toEqual(['paving-asphalt']);
    // The governance guarantee: a typo must NEVER mint a term (§5.5a / ADR 0008).
    expect(await t.db.select().from(taxonomyTrades)).toHaveLength(1);
    expect(await auditActions()).not.toContain('trade.created');
  });

  it('replaces the whole trade set on re-promote, removing a previously-set tag', async () => {
    const prodId = uuid(9);
    await seedTrade(uuid(1), 'electrical', 'Electrical');
    await seedTrade(uuid(2), 'roofing', 'Roofing');
    await seedProduct(prodId, 'revit', 'Revit');
    await t.db.insert(productTrades).values([
      { productId: prodId, tradeId: uuid(1) },
      { productId: prodId, tradeId: uuid(2) },
    ]);

    const res = await promote({
      product: { ref: 'p1', supabaseId: prodId, name: 'Revit', trades: ['roofing'] },
    });

    expect(res.status).toBe(200);
    expect(await tradeSlugsFor(prodId)).toEqual(['roofing']);
  });

  it('clears every trade when the product is re-promoted without the key', async () => {
    const prodId = uuid(9);
    await seedTrade(uuid(1), 'electrical', 'Electrical');
    await seedProduct(prodId, 'revit', 'Revit');
    await t.db.insert(productTrades).values({ productId: prodId, tradeId: uuid(1) });

    const res = await promote({
      product: { ref: 'p1', supabaseId: prodId, name: 'Revit' },
    });

    expect(res.status).toBe(200);
    expect(await tradeSlugsFor(prodId)).toEqual([]);
  });

  // ── Publication gate → indexing pings (AECI-546) ───────────────────────────
  // The handler resolves the floor POST-commit and hands the same result to both
  // ping seams. This asserts the wiring end to end: the count must include the
  // rows this very promote just wrote, or a term crossing the floor is missed.
  describe('trade URLs handed to the indexing pings', () => {
    const SITE = 'https://aecintegrations.com';
    const pingEnv: Env = {
      ...baseEnv,
      INDEXNOW_KEY: 'k',
      GOOGLE_INDEXING_SA_EMAIL: 'sa@example.com',
      GOOGLE_INDEXING_SA_PRIVATE_KEY: 'pk',
      PUBLIC_SITE_URL: SITE,
    };

    /** Promote with recording ping seams; returns whatever each seam received. */
    async function promoteWithPingSeams(body: unknown, env: Env) {
      const captured: Promise<AffectedUrlOptions>[] = [];
      const record: PromoteIndexNowNotify = async (_c, _r, tradeUrls) => {
        captured.push(tradeUrls);
      };
      const app = buildApp({ notifyIndexNow: record, notifyGoogleIndexing: record });
      const res = await app.request('/api/promote', post(body), env, fakeExecutionContext());
      expect(res.status).toBe(200);
      return { res, captured };
    }

    /** Both pings configured → both seams fire, and must share ONE resolution. */
    async function promoteAndCaptureTradeUrls(body: unknown) {
      const { res, captured } = await promoteWithPingSeams(body, pingEnv);
      // The SAME promise reaches both seams — one D1 read, and no chance of the
      // two pings disagreeing about what's published (§20.2 "no second deriver").
      expect(captured).toHaveLength(2);
      expect(captured[0]).toBe(captured[1]);
      return { res, tradeUrls: await captured[0]! };
    }

    it('submits a trade that this promote pushed OVER the floor, but not a sub-floor one', async () => {
      await seedTrade(uuid(1), 'electrical', 'Electrical');
      await seedTrade(uuid(2), 'plumbing', 'Plumbing');
      // Two products already carry `electrical`; the promoted one makes three.
      for (const n of [10, 11]) {
        await seedProduct(uuid(n), `p${n}`, `P${n}`);
        await t.db.insert(productTrades).values({ productId: uuid(n), tradeId: uuid(1) });
      }

      const { res, tradeUrls } = await promoteAndCaptureTradeUrls({
        product: { ref: 'p1', name: 'Revit', trades: ['electrical', 'plumbing'] },
      });

      expect(tradeUrls.publishedTradeSlugs).toEqual(['electrical']);
      const urls = affectedUrlsForPromote((await res.json()) as PromoteResponse, SITE, tradeUrls);
      expect(urls).toContain(`${SITE}/trades/electrical`);
      expect(urls).not.toContain(`${SITE}/trades/plumbing`);
      expect(urls).toContain(`${SITE}/trades`);
    });

    // A removal is not echoed on the response, so it reaches the ping only via
    // `removedTradeSlugs` — and it must be re-counted post-commit, since dropping
    // the link may have pushed the term back under the floor.
    it('carries removed trades through and re-counts them after the write', async () => {
      const prodId = uuid(9);
      await seedTrade(uuid(1), 'electrical', 'Electrical');
      await seedProduct(prodId, 'revit', 'Revit');
      await t.db.insert(productTrades).values({ productId: prodId, tradeId: uuid(1) });

      const { tradeUrls } = await promoteAndCaptureTradeUrls({
        product: { ref: 'p1', supabaseId: prodId, name: 'Revit' },
      });

      expect(tradeUrls.removedTradeSlugs).toEqual(['electrical']);
      // Down to zero products → unpublished → no term URL submitted.
      expect(tradeUrls.publishedTradeSlugs).toEqual([]);
    });

    // Trades are sparse by design: the overwhelming majority of promotes touch
    // none, and must not pay for the floor read.
    it('resolves to empty options when no trade was touched', async () => {
      const { tradeUrls } = await promoteAndCaptureTradeUrls({
        product: { ref: 'p1', name: 'Revit' },
      });

      expect(tradeUrls).toEqual({});
    });

    // Pre-launch, neither ping is provisioned (their secrets ARE the gate), so
    // nothing is submitted and the floor read never runs.
    it('fires no ping at all when neither is configured', async () => {
      await seedTrade(uuid(1), 'electrical', 'Electrical');

      const { captured } = await promoteWithPingSeams(
        { product: { ref: 'p1', name: 'Revit', trades: ['electrical'] } },
        baseEnv,
      );

      expect(captured).toEqual([]);
    });

    // Either ping alone arms the resolution — the two are provisioned by separate
    // secrets and Google may well land without IndexNow (or vice versa).
    it('resolves the floor when only the Google ping is configured', async () => {
      await seedTrade(uuid(1), 'electrical', 'Electrical');
      for (const n of [10, 11]) {
        await seedProduct(uuid(n), `p${n}`, `P${n}`);
        await t.db.insert(productTrades).values({ productId: uuid(n), tradeId: uuid(1) });
      }

      const { captured } = await promoteWithPingSeams(
        { product: { ref: 'p1', name: 'Revit', trades: ['electrical'] } },
        {
          ...baseEnv,
          GOOGLE_INDEXING_SA_EMAIL: 'sa@example.com',
          GOOGLE_INDEXING_SA_PRIVATE_KEY: 'pk',
          PUBLIC_SITE_URL: SITE,
        },
      );

      expect(captured).toHaveLength(1);
      expect((await captured[0]!).publishedTradeSlugs).toEqual(['electrical']);
    });
  });
});

describe('createPromoteHandler — claims ingest (AECI-297)', () => {
  it('ingests claims + attestations for a created integration and returns the pair slugs', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs', ['RFI', 'Requests for Information']);

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [
            {
              dataObject: 'rfis',
              direction: 'a_to_b',
              attestations: [{ source: 'aeci', asserted: true }],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      integrations: { ref: string; sourceSlug?: string; targetSlug?: string }[];
      skipped: unknown[];
    };
    expect(b.skipped).toHaveLength(0);
    // The two product slugs ride back so the pair derivers need no DB read.
    expect(b.integrations[0]).toMatchObject({ sourceSlug: 'revit', targetSlug: 'navisworks' });

    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({ dataObjectId: uuid(20), direction: 'a_to_b' });

    const attRows = await t.db.select().from(attestations);
    expect(attRows).toHaveLength(1);
    expect(attRows[0]).toMatchObject({ claimId: claimRows[0]!.id, source: 'aeci', asserted: true });

    expect(await auditActions()).toEqual(
      expect.arrayContaining(['integration.created', 'claim.created', 'attestation.created']),
    );
  });

  it('returns poweredBySlug for an integration powered by a connector product (Addendum B)', async () => {
    const target = uuid(1);
    const connector = uuid(2);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          poweredByProduct: { supabaseId: connector },
          claims: [],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      integrations: { ref: string; poweredBySlug?: string }[];
    };
    // The connector's slug rides back so the cache-tag deriver can purge its own
    // product page — it is neither endpoint, so no other tag reaches it.
    expect(b.integrations[0]).toMatchObject({ poweredBySlug: 'agave-erp-sync' });

    const rows = await t.db.select().from(integrations);
    expect(rows[0]).toMatchObject({ poweredByProductId: connector });
  });

  it('omits poweredBySlug when the integration names no powered-by product', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as { integrations: { poweredBySlug?: string }[] };
    expect(b.integrations[0]?.poweredBySlug).toBeUndefined();
  });

  it('reports an unresolved dataObject in skipped[] (kind: claim), never a 500', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [{ dataObject: 'not-a-real-object', direction: 'both', attestations: [] }],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      integrations: unknown[];
      skipped: { ref: string; kind: string }[];
    };
    // The integration still lands; only the unresolved claim is skipped.
    expect(b.integrations).toHaveLength(1);
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'i1', kind: 'claim' })]);
    expect(await t.db.select().from(claims)).toHaveLength(0);
    expect(await t.db.select().from(integrations)).toHaveLength(1);
  });

  it('resolves a dataObject by alias (case-insensitive)', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'models', 'Models', ['BIM Models', 'IFC']);

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [{ dataObject: 'BIM Models', direction: 'b_to_a', attestations: [] }],
        },
      ],
    });

    expect(res.status).toBe(200);
    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({ dataObjectId: uuid(20), direction: 'b_to_a' });
  });

  it('replaces the claim set (+ cascades attestations) on re-promote by supabaseId; idempotent', async () => {
    const [srcId, tgtId, intgId] = [uuid(3), uuid(1), uuid(2)];
    await seedProduct(srcId, 'revit', 'Revit');
    await seedProduct(tgtId, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs');
    await seedDataObject(uuid(21), 'models', 'Models');
    await t.db
      .insert(integrations)
      .values({ id: intgId, sourceProductId: srcId, targetProductId: tgtId });
    // A stale claim + attestation already on the integration.
    await t.db
      .insert(claims)
      .values({ id: uuid(30), integrationId: intgId, dataObjectId: uuid(20), direction: 'a_to_b' });
    await t.db
      .insert(attestations)
      .values({ id: uuid(40), claimId: uuid(30), source: 'aeci', asserted: true });

    const body = {
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgId,
          sourceProduct: { supabaseId: srcId },
          targetProduct: { supabaseId: tgtId },
          claims: [
            {
              dataObject: 'models',
              direction: 'both',
              attestations: [{ source: 'aeci', asserted: true }],
            },
          ],
        },
      ],
    };

    const res = await promote(body);
    expect(res.status).toBe(200);

    // Stale claim (rfis/a_to_b) is gone; only the new one survives.
    let claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({ dataObjectId: uuid(21), direction: 'both' });
    // The stale attestation cascade-deleted with its claim; one remains (the new claim's).
    let attRows = await t.db.select().from(attestations);
    expect(attRows).toHaveLength(1);
    expect(attRows[0]!.claimId).toBe(claimRows[0]!.id);

    // Re-pushing the identical bundle is idempotent (still exactly one claim/attestation).
    const res2 = await promote(body);
    expect(res2.status).toBe(200);
    claimRows = await t.db.select().from(claims);
    attRows = await t.db.select().from(attestations);
    expect(claimRows).toHaveLength(1);
    expect(attRows).toHaveLength(1);
  });

  it('withholds claims when their integration is withheld (far endpoint not promoted)', async () => {
    await seedDataObject(uuid(20), 'rfis', 'RFIs');

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: uuid(9) },
          claims: [
            {
              dataObject: 'rfis',
              direction: 'a_to_b',
              attestations: [{ source: 'aeci', asserted: true }],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      integrations: unknown[];
      skipped: { ref: string; kind: string }[];
    };
    expect(b.integrations).toHaveLength(0);
    // The integration is skipped; its claims ride with it (not separately ingested).
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'i1', kind: 'integration' })]);
    expect(await t.db.select().from(claims)).toHaveLength(0);
  });

  it('clears prior claims when an integration is re-promoted with an empty claims[]', async () => {
    const [srcId, tgtId, intgId] = [uuid(3), uuid(1), uuid(2)];
    await seedProduct(srcId, 'revit', 'Revit');
    await seedProduct(tgtId, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs');
    await t.db
      .insert(integrations)
      .values({ id: intgId, sourceProductId: srcId, targetProductId: tgtId });
    await t.db
      .insert(claims)
      .values({ id: uuid(30), integrationId: intgId, dataObjectId: uuid(20), direction: 'a_to_b' });

    const res = await promote({
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgId,
          sourceProduct: { supabaseId: srcId },
          targetProduct: { supabaseId: tgtId },
          // no claims → replace-by-integration clears the prior set
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(await t.db.select().from(claims)).toHaveLength(0);
  });
});

describe('cache purge after promote (AECI-105)', () => {
  const CF_PURGE_URL = 'https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache';
  const purgeEnv: Env = { ...baseEnv, CF_PURGE_API_TOKEN: 'cf-token', CF_ZONE_ID: 'zone-1' };

  async function promoteWithPurge(body: unknown, fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchMock);
    const execCtx = fakeExecutionContext();
    const res = await buildApp().request('/api/promote', post(body), purgeEnv, execCtx);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    return { res, execCtx };
  }

  it('purges the expected tag set for a representative create', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { res, execCtx } = await promoteWithPurge(
      {
        vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
        product: { ref: 'p1', name: 'Revit', categories: ['BIM'], audiences: ['Architecture'] },
      },
      fetchMock,
    );

    expect(res.status).toBe(200);
    // Two post-commit tasks on a write: the cache purge + the AECI-305 home-stats
    // refresh (a no-op seam here). Only the purge fetches, so `fetchMock` sees one call.
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CF_PURGE_URL);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cf-token');
    const sent = JSON.parse(init.body as string) as { tags: string[] };
    expect(new Set(sent.tags)).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'vendor:autodesk',
        'category:bim',
        'audience:architecture',
        'taxonomy',
        'sitemap',
      ]),
    );
    expect(sent.tags.some((tag) => tag.startsWith('route:'))).toBe(false);
  });

  it('purges the pair tag for an integration carrying claims (AECI-297)', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs');

    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const { res } = await promoteWithPurge(
      {
        product: { ref: 'p1', name: 'Revit' },
        integrations: [
          {
            ref: 'i1',
            sourceProduct: { ref: 'p1' },
            targetProduct: { supabaseId: target },
            claims: [
              {
                dataObject: 'rfis',
                direction: 'a_to_b',
                attestations: [{ source: 'aeci', asserted: true }],
              },
            ],
          },
        ],
      },
      fetchMock,
    );

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as { tags: string[] };
    // Alphabetically-first slug is the pair context: navisworks < revit.
    expect(sent.tags).toContain('pair:navisworks__revit');
  });

  it('does not purge when CF credentials are absent (graceful no-op)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const execCtx = fakeExecutionContext();
    const res = await buildApp().request(
      '/api/promote',
      post({ product: { ref: 'p1', name: 'Revit' } }),
      baseEnv,
      execCtx,
    );
    expect(res.status).toBe(200);
    // The AECI-305 home-stats refresh still schedules its waitUntil on a write, but
    // with no CF creds the cache purge is skipped — so no fetch fires.
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still returns 200 when the purge call fails (never fails the promote)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"errors":[{"message":"x"}]}', { status: 502 }));
    const { res } = await promoteWithPurge({ product: { ref: 'p1', name: 'Revit' } }, fetchMock);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 when the purge fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('cf unreachable'));
    const { res } = await promoteWithPurge({ product: { ref: 'p1', name: 'Revit' } }, fetchMock);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Algolia index sync after promote (AECI-139)', () => {
  const algoliaEnv: Env = { ...baseEnv, ALGOLIA_APP_ID: 'APP', ALGOLIA_ADMIN_KEY: 'write-key' };

  async function promoteWithSeam(env: Env, body: unknown, syncAlgolia: PromoteAlgoliaSync) {
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ syncAlgolia }).request('/api/promote', post(body), env, execCtx);
    return { res, execCtx };
  }

  it('schedules the Algolia sync (with the touched product) when credentials are present', async () => {
    const id = uuid(1);
    await seedProduct(id, 'procore', 'Procore');
    const syncAlgolia = vi.fn<PromoteAlgoliaSync>(async () => {});

    const { res, execCtx } = await promoteWithSeam(
      algoliaEnv,
      { product: { ref: 'p1', supabaseId: id, name: 'Procore' } },
      syncAlgolia,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));

    expect(res.status).toBe(200);
    expect(syncAlgolia).toHaveBeenCalledTimes(1);
    const response = syncAlgolia.mock.calls[0]![1] as PromoteResponse;
    expect(response.product?.id).toBe(id);
  });

  it('does not schedule the Algolia sync when credentials are absent (graceful no-op)', async () => {
    const syncAlgolia = vi.fn<PromoteAlgoliaSync>(async () => {});
    const { res } = await promoteWithSeam(
      baseEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      syncAlgolia,
    );
    expect(res.status).toBe(200);
    expect(syncAlgolia).not.toHaveBeenCalled();
  });

  it('still returns 200 when the Algolia sync rejects (post-response, never fails the promote)', async () => {
    const syncAlgolia = vi.fn<PromoteAlgoliaSync>(async () => {
      throw new Error('algolia unreachable');
    });
    const { res, execCtx } = await promoteWithSeam(
      algoliaEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      syncAlgolia,
    );
    expect(res.status).toBe(200); // returned before the waitUntil settles
    await Promise.allSettled(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  });
});

describe('IndexNow submission after promote (AECI-236)', () => {
  const indexNowEnv: Env = {
    ...baseEnv,
    INDEXNOW_KEY: 'a1b2c3d4e5f6a7b8',
    PUBLIC_SITE_URL: 'https://aecintegrations.com',
  };

  async function promoteWithSeam(env: Env, body: unknown, notifyIndexNow: PromoteIndexNowNotify) {
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ notifyIndexNow }).request(
      '/api/promote',
      post(body),
      env,
      execCtx,
    );
    return { res, execCtx };
  }

  it('schedules the IndexNow notify (with the touched response) when creds are present', async () => {
    const notifyIndexNow = vi.fn<PromoteIndexNowNotify>(async () => {});
    const { res, execCtx } = await promoteWithSeam(
      indexNowEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyIndexNow,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));

    expect(res.status).toBe(200);
    expect(notifyIndexNow).toHaveBeenCalledTimes(1);
    const response = notifyIndexNow.mock.calls[0]![1] as PromoteResponse;
    expect(response.product?.slug).toBe('revit');
  });

  it('does not schedule the IndexNow notify when creds are absent (graceful no-op)', async () => {
    const notifyIndexNow = vi.fn<PromoteIndexNowNotify>(async () => {});
    const { res } = await promoteWithSeam(
      baseEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyIndexNow,
    );
    expect(res.status).toBe(200);
    expect(notifyIndexNow).not.toHaveBeenCalled();
  });

  it('still returns 200 when the IndexNow notify rejects (post-response, never fails the promote)', async () => {
    const notifyIndexNow = vi.fn<PromoteIndexNowNotify>(async () => {
      throw new Error('indexnow unreachable');
    });
    const { res, execCtx } = await promoteWithSeam(
      indexNowEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyIndexNow,
    );
    expect(res.status).toBe(200); // returned before the waitUntil settles
    await Promise.allSettled(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  });
});

describe('Google Indexing submission after promote (AECI-263)', () => {
  const googleEnv: Env = {
    ...baseEnv,
    GOOGLE_INDEXING_SA_EMAIL: 'svc@aeci.iam.gserviceaccount.com',
    GOOGLE_INDEXING_SA_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    PUBLIC_SITE_URL: 'https://aecintegrations.com',
  };

  async function promoteWithSeam(
    env: Env,
    body: unknown,
    notifyGoogleIndexing: PromoteGoogleIndexingNotify,
  ) {
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ notifyGoogleIndexing }).request(
      '/api/promote',
      post(body),
      env,
      execCtx,
    );
    return { res, execCtx };
  }

  it('schedules the Google Indexing notify (with the touched response) when creds are present', async () => {
    const notifyGoogleIndexing = vi.fn<PromoteGoogleIndexingNotify>(async () => {});
    const { res, execCtx } = await promoteWithSeam(
      googleEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyGoogleIndexing,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));

    expect(res.status).toBe(200);
    expect(notifyGoogleIndexing).toHaveBeenCalledTimes(1);
    const response = notifyGoogleIndexing.mock.calls[0]![1] as PromoteResponse;
    expect(response.product?.slug).toBe('revit');
  });

  it('does not schedule the Google Indexing notify when creds are absent (graceful no-op)', async () => {
    const notifyGoogleIndexing = vi.fn<PromoteGoogleIndexingNotify>(async () => {});
    const { res } = await promoteWithSeam(
      baseEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyGoogleIndexing,
    );
    expect(res.status).toBe(200);
    expect(notifyGoogleIndexing).not.toHaveBeenCalled();
  });

  it('does not schedule the Google Indexing notify when only the email is set (both creds required)', async () => {
    const notifyGoogleIndexing = vi.fn<PromoteGoogleIndexingNotify>(async () => {});
    const { res } = await promoteWithSeam(
      {
        ...baseEnv,
        GOOGLE_INDEXING_SA_EMAIL: 'svc@aeci.iam.gserviceaccount.com',
        PUBLIC_SITE_URL: 'https://aecintegrations.com',
      },
      { product: { ref: 'p1', name: 'Revit' } },
      notifyGoogleIndexing,
    );
    expect(res.status).toBe(200);
    expect(notifyGoogleIndexing).not.toHaveBeenCalled();
  });

  it('still returns 200 when the Google Indexing notify rejects (post-response, never fails the promote)', async () => {
    const notifyGoogleIndexing = vi.fn<PromoteGoogleIndexingNotify>(async () => {
      throw new Error('google indexing unreachable');
    });
    const { res, execCtx } = await promoteWithSeam(
      googleEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyGoogleIndexing,
    );
    expect(res.status).toBe(200); // returned before the waitUntil settles
    await Promise.allSettled(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  });
});

describe('home-stats refresh after promote (AECI-305)', () => {
  const CF_PURGE_URL = 'https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache';
  const purgeEnv: Env = { ...baseEnv, CF_PURGE_API_TOKEN: 'cf-token', CF_ZONE_ID: 'zone-1' };

  // ── Seam wiring: scheduled iff the promote actually wrote rows ──────────────
  async function promoteWithSeam(body: unknown, refreshHomeStats: PromoteHomeStatsRefresh) {
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ refreshHomeStats }).request(
      '/api/promote',
      post(body),
      baseEnv,
      execCtx,
    );
    return { res, execCtx };
  }

  it('schedules the home-stats refresh when the promote wrote rows', async () => {
    const refreshHomeStats = vi.fn<PromoteHomeStatsRefresh>(async () => {});
    const { res, execCtx } = await promoteWithSeam(
      { product: { ref: 'p1', name: 'Revit' } },
      refreshHomeStats,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    expect(res.status).toBe(200);
    expect(refreshHomeStats).toHaveBeenCalledTimes(1);
  });

  it('does not schedule the refresh for an all-skipped promote (nothing written)', async () => {
    const refreshHomeStats = vi.fn<PromoteHomeStatsRefresh>(async () => {});
    // Both endpoints reference unpromoted products → the integration is skipped and
    // no product/vendor is written, so the batch is empty.
    const { res } = await promoteWithSeam(
      {
        integrations: [
          {
            ref: 'i1',
            sourceProduct: { supabaseId: uuid(8) },
            targetProduct: { supabaseId: uuid(9) },
          },
        ],
      },
      refreshHomeStats,
    );
    expect(res.status).toBe(200);
    expect(refreshHomeStats).not.toHaveBeenCalled();
  });

  it('still returns 200 when the refresh rejects (post-response, never fails the promote)', async () => {
    const refreshHomeStats = vi.fn<PromoteHomeStatsRefresh>(async () => {
      throw new Error('stats recompute exploded');
    });
    const { res, execCtx } = await promoteWithSeam(
      { product: { ref: 'p1', name: 'Revit' } },
      refreshHomeStats,
    );
    expect(res.status).toBe(200); // returned before the waitUntil settles
    await Promise.allSettled(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  });

  // ── Default behaviour: recompute stats_cache, THEN purge the home page ──────
  function fakeContext(env: Env) {
    return {
      env,
      executionCtx: fakeExecutionContext(),
      req: { raw: new Request('https://api.local/api/promote', { method: 'POST' }) },
    } as unknown as Parameters<typeof refreshHomeStatsAfterPromote>[0];
  }

  it('recomputes the home.* stats_cache keys and purges index:home when CF creds are present', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit', { integrationCount: 2 });
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await refreshHomeStatsAfterPromote(fakeContext(purgeEnv), t.db);

    const cached = await t.db.select().from(statsCache);
    const byKey = new Map(cached.map((r) => [r.key, r.value]));
    // The counts the home banner reads are now written from live state.
    expect(byKey.get('home.total_products')).toBe(1);
    expect(byKey.has('home.total_integrations')).toBe(true);

    // …and only then is the home page purged, by exactly the tag the SSR route emits.
    const purgeCalls = fetchSpy.mock.calls.filter(([url]) => url === CF_PURGE_URL);
    expect(purgeCalls).toHaveLength(1);
    const body = JSON.parse((purgeCalls[0]![1] as RequestInit).body as string) as {
      tags: string[];
    };
    expect(body.tags).toEqual(['index:home']);
  });

  it('recomputes the stats_cache but skips the purge when CF creds are absent', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await refreshHomeStatsAfterPromote(fakeContext(baseEnv), t.db);

    expect((await t.db.select().from(statsCache)).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recomputes the stats_cache and never throws when the purge fetch rejects', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit');
    const fetchSpy = vi.fn().mockRejectedValue(new Error('cf unreachable'));
    vi.stubGlobal('fetch', fetchSpy);

    // Must resolve (never reject) so the post-commit waitUntil can't turn into an
    // unhandled rejection — the recompute still lands.
    await expect(
      refreshHomeStatsAfterPromote(fakeContext(purgeEnv), t.db),
    ).resolves.toBeUndefined();
    expect((await t.db.select().from(statsCache)).length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('cacheTagsForPromote (AECI-105)', () => {
  const entity = (slug: string, operation: 'created' | 'updated') => ({
    ref: `ref-${slug}`,
    id: `id-${slug}`,
    slug,
    operation,
  });
  const tax = (slug: string, operation: 'created' | 'reused') => ({
    id: `id-${slug}`,
    slug,
    operation,
  });
  const emptyTaxonomy = { categories: [], audiences: [], phases: [], trades: [] };

  it('created product + vendor + mixed taxonomy → entity, index, taxonomy, sitemap tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused')],
        audiences: [tax('architecture', 'created')],
        phases: [],
        trades: [],
      },
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'vendor:autodesk',
        'category:bim',
        'audience:architecture',
        'taxonomy',
        'sitemap',
      ]),
    );
  });

  it('updated entities + all-reused taxonomy → no sitemap, no taxonomy tag', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'reused')], audiences: [], phases: [], trades: [] },
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['product:revit', 'index:products', 'vendor:autodesk', 'category:bim']),
    );
  });

  it('vendor-only update → vendor tag only', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(cacheTagsForPromote(response).sort()).toEqual(['vendor:autodesk']);
  });

  it('created vendor (no product) → vendor + sitemap', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(new Set(['vendor:autodesk', 'sitemap']));
  });

  it('a newly created phase → phase tag + taxonomy', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [], audiences: [], phases: [tax('design', 'created')], trades: [] },
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['product:revit', 'index:products', 'phase:design', 'taxonomy']),
    );
  });

  it('nothing cacheable changed → empty tag set', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(cacheTagsForPromote(response)).toEqual([]);
  });

  it('a powered integration → the connector product tag alongside the pair tag', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [
        {
          ref: 'i1',
          id: 'id-i1',
          operation: 'updated',
          sourceSlug: 'revit',
          targetSlug: 'navisworks',
          poweredBySlug: 'agave-erp-sync',
        },
      ],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['pair:navisworks__revit', 'product:agave-erp-sync']),
    );
  });

  it('an integration with no powered-by product emits no connector tag', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [
        {
          ref: 'i1',
          id: 'id-i1',
          operation: 'updated',
          sourceSlug: 'revit',
          targetSlug: 'navisworks',
        },
      ],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(cacheTagsForPromote(response)).toEqual(['pair:navisworks__revit']);
  });

  it('never emits coarse route-class tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'created')], audiences: [], phases: [], trades: [] },
      skipped: [],
    };
    expect(cacheTagsForPromote(response).some((tag) => tag.startsWith('route:'))).toBe(false);
  });

  // AECI-542 — trades diverge from the three sibling facets: they can never be
  // `created`, yet any touched trade still changes the publication-gated `/trades`
  // index, facet sidebar, and sitemap (`CACHE_STRATEGY.md` §2).
  it('a reused trade → trade tag + index:trades + taxonomy + sitemap', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: {
        categories: [],
        audiences: [],
        phases: [],
        trades: [tax('electrical', 'reused')],
      },
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'trade:electrical',
        'index:trades',
        'taxonomy',
        'sitemap',
      ]),
    );
  });

  it('a REMOVED trade still purges its browse page and the gated surfaces', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response, { removedTradeSlugs: ['roofing'] }))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'trade:roofing',
        'index:trades',
        'taxonomy',
        'sitemap',
      ]),
    );
  });

  it('a promote with no trades emits no trade tags', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['product:revit', 'index:products']),
    );
  });
});

// AECI-546 — the touched-trade set, shared by `cacheTagsForPromote` and
// `affectedUrlsForPromote`. Pinned directly because the two consumers MUST agree:
// a trade URL pinged to IndexNow but never purged from the edge hands the crawler
// a stale page.
describe('touchedTradeSlugs', () => {
  const withTrades = (trades: string[]): PromoteResponse => ({
    vendors: [],
    product: { ref: 'ref-revit', id: 'id-revit', slug: 'revit', operation: 'updated' },
    integrations: [],
    taxonomy: {
      categories: [],
      audiences: [],
      phases: [],
      // Always `reused`: the vocabulary is closed and find-only, so a trade can
      // never be `created`.
      trades: trades.map((slug) => ({ id: `id-${slug}`, slug, operation: 'reused' as const })),
    },
    skipped: [],
  });

  it('unions the SET trades with the REMOVED ones', () => {
    expect(new Set(touchedTradeSlugs(withTrades(['electrical']), ['roofing']))).toEqual(
      new Set(['electrical', 'roofing']),
    );
  });

  // A re-promote that keeps a trade puts it in neither list twice; a caller that
  // passes overlapping sets must not get a duplicate tag or a duplicate ping.
  it('dedupes a slug present on both sides', () => {
    expect(touchedTradeSlugs(withTrades(['electrical']), ['electrical'])).toEqual(['electrical']);
  });

  it('is empty when the promote touched no trade', () => {
    expect(touchedTradeSlugs(withTrades([]))).toEqual([]);
  });

  it('agrees with the tag deriver about what was touched', () => {
    const response = withTrades(['electrical']);
    const removed = ['roofing'];
    const tags = cacheTagsForPromote(response, { removedTradeSlugs: removed });
    for (const slug of touchedTradeSlugs(response, removed)) {
      expect(tags).toContain(`trade:${slug}`);
    }
  });
});

describe('requireReviewAppAuth (on /api/promote)', () => {
  const validBody = { product: { ref: 'p1', name: 'Revit' } };
  const authApp = () => buildApp({ withAuth: true });

  it('rejects a request with no Authorization header', async () => {
    const res = await authApp().request(
      '/api/promote',
      post(validBody),
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a wrong token', async () => {
    const res = await authApp().request(
      '/api/promote',
      post(validBody, { Authorization: 'Bearer wrong' }),
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it('accepts the correct token', async () => {
    const res = await authApp().request(
      '/api/promote',
      post(validBody, { Authorization: 'Bearer secret-token' }),
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
  });

  it('fails closed when REVIEW_APP_TOKEN is unset', async () => {
    const res = await authApp().request(
      '/api/promote',
      post(validBody, { Authorization: 'Bearer anything' }),
      { ...baseEnv, REVIEW_APP_TOKEN: undefined },
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });
});
