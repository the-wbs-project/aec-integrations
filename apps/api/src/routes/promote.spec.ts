/**
 * `POST /api/promote` on the Drizzle/D1 path (ADR 0016 / AECI-253, AECI-249),
 * against the in-memory D1 harness. The plan-then-`db.batch` upsert is exercised
 * over real SQL: seed real rows, assert the real vendor/product/taxonomy/
 * integration/join/audit rows + the post-batch count recompute.
 *
 * The post-commit Algolia upsert is injected as a seam (its transport is
 * `algolia-sync.spec`'s job); the cache-purge enqueue (WC-5: onto a mock
 * `CACHE_PURGE_QUEUE`) + `cacheTagsForPromote` are DB-independent. The 409/500
 * unique-violation paths inject a
 * `db.batch` that throws the SQLite error the DB would raise.
 */

import type { CachePurgeMessage, PromoteResponse } from '@aeci/shared';
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
  productVendors,
  profiles,
  statsCache,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
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
import { cacheTagsForPromote } from './promote-cache-tags';

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

  it('collapses a repeated attestation source within one claim rather than failing the batch', async () => {
    // `attestations_slot_key` (AECI-603) is unique on (claim_id, source) among
    // non-retracted rows, so without the in-payload dedupe a bundle that repeated a
    // source would take down the WHOLE promote, not just the duplicate row. First
    // occurrence wins, matching the claim-identity dedupe.
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs', []);

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
              attestations: [
                { source: 'aeci', asserted: true, note: 'first' },
                { source: 'aeci', asserted: false, note: 'duplicate' },
              ],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const attRows = await t.db.select().from(attestations);
    expect(attRows).toHaveLength(1);
    expect(attRows[0]).toMatchObject({ source: 'aeci', asserted: true, note: 'first' });
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

describe('cache purge after promote (AECI-105 → WC-5 / AECI-319)', () => {
  /** Run a promote with a mock `CACHE_PURGE_QUEUE` producer binding; drain the
   *  post-commit `waitUntil` tasks so the enqueue is observable. Returns the `send`
   *  spy (the enqueued `CachePurgeMessage`s). */
  async function promoteWithPurge(body: unknown, send = vi.fn().mockResolvedValue(undefined)) {
    const env: Env = {
      ...baseEnv,
      CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
    };
    const execCtx = fakeExecutionContext();
    const res = await buildApp().request('/api/promote', post(body), env, execCtx);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    return { res, execCtx, send };
  }

  it('enqueues the expected tag set (source:promote) for a representative create', async () => {
    const { res, execCtx, send } = await promoteWithPurge({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit', categories: ['BIM'], audiences: ['Architecture'] },
    });

    expect(res.status).toBe(200);
    // Two post-commit tasks on a write: the purge enqueue + the AECI-305 home-stats
    // refresh (a no-op seam here). Only the purge enqueues, so `send` sees one call.
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as CachePurgeMessage;
    expect(msg.source).toBe('promote');
    expect(new Set(msg.tags)).toEqual(
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
    expect(msg.tags?.some((tag) => tag.startsWith('route:'))).toBe(false);
  });

  it('enqueues the pair tag for an integration carrying claims (AECI-297)', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs');

    const { res, send } = await promoteWithPurge({
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
    const msg = send.mock.calls[0][0] as CachePurgeMessage;
    // Alphabetically-first slug is the pair context: navisworks < revit.
    expect(msg.tags).toContain('pair:navisworks__revit');
  });

  it('does not enqueue when the queue binding is absent (graceful no-op)', async () => {
    const execCtx = fakeExecutionContext();
    const res = await buildApp().request(
      '/api/promote',
      post({ product: { ref: 'p1', name: 'Revit' } }),
      baseEnv,
      execCtx,
    );
    expect(res.status).toBe(200);
    // The AECI-305 home-stats refresh still schedules its waitUntil on a write, but
    // with no queue binding the purge is skipped — only the one waitUntil fires.
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 when the enqueue rejects (never fails the promote)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const { res } = await promoteWithPurge({ product: { ref: 'p1', name: 'Revit' } }, send);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
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

describe('home-stats refresh after promote (AECI-305 → WC-5 / AECI-319)', () => {
  /** An env carrying a mock `CACHE_PURGE_QUEUE` producer binding + its `send` spy. */
  function purgeEnvWith(send: ReturnType<typeof vi.fn>): Env {
    return { ...baseEnv, CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'] };
  }

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

  it('recomputes the home.* stats_cache keys, THEN enqueues the index:home purge', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit', { integrationCount: 2 });
    // Capture the stats_cache row count at enqueue time to prove the load-bearing
    // ordering: the recompute must have already landed when the purge is enqueued.
    let statsRowsAtEnqueue = -1;
    const send = vi.fn(async (_msg: CachePurgeMessage) => {
      statsRowsAtEnqueue = (await t.db.select().from(statsCache)).length;
    });

    await refreshHomeStatsAfterPromote(fakeContext(purgeEnvWith(send)), t.db);

    const cached = await t.db.select().from(statsCache);
    const byKey = new Map(cached.map((r) => [r.key, r.value]));
    // The counts the home banner reads are now written from live state.
    expect(byKey.get('home.total_products')).toBe(1);
    expect(byKey.has('home.total_integrations')).toBe(true);

    // …and only then is the home page purged, by exactly the tag the SSR route emits.
    expect(send).toHaveBeenCalledTimes(1);
    expect(statsRowsAtEnqueue).toBeGreaterThan(0);
    expect(send.mock.calls[0][0]).toEqual({ tags: ['index:home'], source: 'promote' });
  });

  it('recomputes the stats_cache but skips the enqueue when the queue is absent', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit');

    await refreshHomeStatsAfterPromote(fakeContext(baseEnv), t.db);

    expect((await t.db.select().from(statsCache)).length).toBeGreaterThan(0);
  });

  it('recomputes the stats_cache and never throws when the enqueue rejects', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit');
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));

    // Must resolve (never reject) so the post-commit waitUntil can't turn into an
    // unhandled rejection — the recompute still lands.
    await expect(
      refreshHomeStatsAfterPromote(fakeContext(purgeEnvWith(send)), t.db),
    ).resolves.toBeUndefined();
    expect((await t.db.select().from(statsCache)).length).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(1);
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
  const emptyTaxonomy = { categories: [], audiences: [], phases: [] };

  it('created product + vendor + mixed taxonomy → entity, index, taxonomy, sitemap tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused')],
        audiences: [tax('architecture', 'created')],
        phases: [],
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
      taxonomy: { categories: [tax('bim', 'reused')], audiences: [], phases: [] },
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
      taxonomy: { categories: [], audiences: [], phases: [tax('design', 'created')] },
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

  it('never emits coarse route-class tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'created')], audiences: [], phases: [] },
      skipped: [],
    };
    expect(cacheTagsForPromote(response).some((tag) => tag.startsWith('route:'))).toBe(false);
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

// ─── Claimed-vendor guard (AECI-520) ──────────────────────────────────────────

/**
 * Once AECi grants a vendor-portal seat, that vendor's row and every product it
 * owns become vendor-owned — the vendor edits them through `/api/vendor/*`, and
 * this endpoint writes the very same columns. So a promote must not overwrite
 * them (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4).
 *
 * The failure modes are asymmetric, so both directions are pinned: under-blocking
 * silently reverts a vendor's edits (they'd report "AECi keeps undoing our
 * changes"), and over-blocking freezes a vendor out of AECi curation entirely.
 */
describe('createPromoteHandler — claimed-vendor block', () => {
  const V_CLAIMED = uuid(50);
  const V_FREE = uuid(51);
  const P_OWNED = uuid(60); // owned by the claimed vendor
  const P_FREE = uuid(61); // owned by nobody in particular
  const P_OTHER = uuid(62); // an unrelated integration endpoint

  /** Grant a seat — the ONLY thing that marks a vendor as claimed. */
  const seedSeat = (id: string, vendorId: string | null, role = 'vendor_admin') =>
    t.db.insert(profiles).values({ id, role, vendorId });
  const seedOwnership = (productId: string, vendorId: string) =>
    t.db.insert(productVendors).values({ productId, vendorId, isPrimary: true });

  const skippedKinds = (body: PromoteResponse) => body.skipped.map((s) => s.kind);

  beforeEach(async () => {
    await seedVendor(V_CLAIMED, 'autodesk', 'Autodesk');
    await seedVendor(V_FREE, 'bentley', 'Bentley');
    await seedProduct(P_OWNED, 'revit', 'Revit', { description: 'Vendor-owned copy' });
    await seedProduct(P_FREE, 'microstation', 'MicroStation');
    await seedProduct(P_OTHER, 'navisworks', 'Navisworks');
    await seedOwnership(P_OWNED, V_CLAIMED);
    await seedSeat(uuid(70), V_CLAIMED);
  });

  it('skips the claimed vendor while a sibling vendor still promotes', async () => {
    const res = await promote({
      vendors: [
        { ref: 'v1', supabaseId: V_CLAIMED, companyName: 'Autodesk', website: 'https://new' },
        { ref: 'v2', supabaseId: V_FREE, companyName: 'Bentley', website: 'https://bentley.new' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromoteResponse;

    // Blocked entities are OMITTED from the results, not marked — that is what
    // keeps them out of the purge / IndexNow / Algolia derivers for free.
    expect(body.vendors.map((v) => v.ref)).toEqual(['v2']);
    expect(body.skipped).toContainEqual(expect.objectContaining({ ref: 'v1', kind: 'vendor' }));

    const [claimed] = await t.db.select().from(vendors).where(eq(vendors.id, V_CLAIMED));
    const [free] = await t.db.select().from(vendors).where(eq(vendors.id, V_FREE));
    expect(claimed?.website).toBeNull(); // untouched
    expect(free?.website).toBe('https://bentley.new');

    const actions = await auditActions();
    expect(actions).toContain('promote.blocked');
    expect(actions.filter((a) => a === 'vendor.updated')).toHaveLength(1);
  });

  it('blocks an existing product owned by a claimed vendor, wholesale', async () => {
    const res = await promote({
      product: {
        ref: 'p1',
        supabaseId: P_OWNED,
        name: 'Revit 2027',
        description: 'review-app copy',
        categories: ['Brand New Category'],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromoteResponse;

    expect(body.product).toBeNull();
    expect(skippedKinds(body)).toEqual(['product']);

    const [row] = await t.db.select().from(products).where(eq(products.id, P_OWNED));
    expect(row?.name).toBe('Revit');
    expect(row?.description).toBe('Vendor-owned copy');
    expect(row?.promotionStatus).toBe('promoted'); // seeded value, not re-set

    // Taxonomy resolution is gated too: no orphan term is minted for a product
    // that was never written, and the response reports no taxonomy work.
    expect(await t.db.select().from(taxonomyCategories)).toHaveLength(0);
    expect(body.taxonomy.categories).toEqual([]);
    expect(await auditActions()).not.toContain('product.updated');
  });

  it('never wipes the ownership join rows of a blocked product', async () => {
    // The delete+reinsert of `product_vendors` is the destructive statement: a
    // payload that omits the claimed vendor would otherwise orphan the claim.
    await promote({
      vendors: [{ ref: 'v2', supabaseId: V_FREE, companyName: 'Bentley' }],
      product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' },
    });
    const rows = await t.db
      .select()
      .from(productVendors)
      .where(eq(productVendors.productId, P_OWNED));
    expect(rows.map((r) => r.vendorId)).toEqual([V_CLAIMED]);
  });

  it('blocks a product this payload would hand to a claimed vendor', async () => {
    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: V_CLAIMED, companyName: 'Autodesk' }],
      product: { ref: 'p1', supabaseId: P_FREE, name: 'MicroStation Renamed' },
    });
    const body = (await res.json()) as PromoteResponse;
    expect(body.product).toBeNull();
    expect(skippedKinds(body).sort()).toEqual(['product', 'vendor']);

    const [row] = await t.db.select().from(products).where(eq(products.id, P_FREE));
    expect(row?.name).toBe('MicroStation');
  });

  it('never blocks a CREATE, and the vendor slug suffix still resolves', async () => {
    // Creation is always allowed: nothing vendor-owned exists yet. This also
    // pins that the blocked-vendor branch still contributes `firstVendorSlug`,
    // which `generateSlug` uses to disambiguate a colliding product slug.
    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: V_CLAIMED, companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit' }, // collides with the seeded 'revit'
    });
    const body = (await res.json()) as PromoteResponse;
    expect(body.product?.operation).toBe('created');
    expect(body.product?.slug).toBe('revit-autodesk');

    const joins = await t.db
      .select()
      .from(productVendors)
      .where(eq(productVendors.vendorId, V_CLAIMED));
    // The new product is still joined to the claimed vendor.
    expect(joins.map((r) => r.productId)).toContain(body.product?.id);
  });

  it('cascades to integrations referencing the blocked product by ref AND by id', async () => {
    const res = await promote({
      product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: P_OTHER } },
        // The superRefine only constrains `ref` endpoints, so this id-form
        // reference to the same blocked product must be caught explicitly.
        {
          ref: 'i2',
          sourceProduct: { supabaseId: P_OWNED },
          targetProduct: { supabaseId: P_OTHER },
        },
        // Unrelated: neither endpoint is the blocked product, so it promotes.
        {
          ref: 'i3',
          sourceProduct: { supabaseId: P_FREE },
          targetProduct: { supabaseId: P_OTHER },
        },
      ],
    });
    const body = (await res.json()) as PromoteResponse;

    expect(body.integrations.map((i) => i.ref)).toEqual(['i3']);
    const blocked = body.skipped.filter((s) => s.kind === 'integration');
    expect(blocked.map((s) => s.ref).sort()).toEqual(['i1', 'i2']);
    // The reason must name the real cause, not the misleading "not promoted yet".
    for (const entry of blocked) expect(entry.reason).toMatch(/claimed vendor/i);

    // The blocked product's own integration count is left alone.
    const [owned] = await t.db.select().from(products).where(eq(products.id, P_OWNED));
    expect(owned?.integrationCount).toBe(0);
    const [free] = await t.db.select().from(products).where(eq(products.id, P_FREE));
    expect(free?.integrationCount).toBe(1);
  });

  it('skips an integration whose poweredByProduct is the blocked product', async () => {
    // Without this the integration writes, `resolveProduct` degrades the unknown
    // ref to null, and `powered_by_product_id` is CLEARED on a promote whose
    // whole purpose was to leave the blocked product alone — silently, with
    // nothing in skipped[] to show for it.
    await t.db.insert(integrations).values({
      id: uuid(90),
      sourceProductId: P_FREE,
      targetProductId: P_OTHER,
      poweredByProductId: P_OWNED,
    });

    const res = await promote({
      product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: uuid(90),
          sourceProduct: { supabaseId: P_FREE },
          targetProduct: { supabaseId: P_OTHER },
          poweredByProduct: { ref: 'p1' },
        },
      ],
    });
    const body = (await res.json()) as PromoteResponse;

    expect(body.integrations).toEqual([]);
    expect(body.skipped).toContainEqual(
      expect.objectContaining({ ref: 'i1', kind: 'integration' }),
    );

    const [row] = await t.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, uuid(90)));
    expect(row?.poweredByProductId).toBe(P_OWNED); // link intact
  });

  it('treats only role=vendor_admin WITH a vendor_id as a claim', async () => {
    // A reviewer pointed at the vendor, and a vendor_admin with no vendor_id:
    // neither claims anything. Over-blocking would freeze curation.
    await seedSeat(uuid(71), V_FREE, 'reviewer');
    await seedSeat(uuid(72), null, 'vendor_admin');

    const res = await promote({
      vendors: [
        { ref: 'v2', supabaseId: V_FREE, companyName: 'Bentley', website: 'https://b.new' },
      ],
    });
    const body = (await res.json()) as PromoteResponse;
    expect(body.vendors.map((v) => v.ref)).toEqual(['v2']);
    expect(body.skipped).toEqual([]);

    const [row] = await t.db.select().from(vendors).where(eq(vendors.id, V_FREE));
    expect(row?.website).toBe('https://b.new');
  });

  it('does not schedule the home-stats refresh for a fully blocked promote', async () => {
    // A blocked promote writes only `promote.blocked` audit rows. The refresh
    // gate must count catalog writes, not statement count, or it fires for a
    // promote that changed nothing.
    const refreshHomeStats = vi.fn<PromoteHomeStatsRefresh>(async () => {});
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ refreshHomeStats }).request(
      '/api/promote',
      post({
        vendors: [{ ref: 'v1', supabaseId: V_CLAIMED, companyName: 'Autodesk' }],
        product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' },
      }),
      baseEnv,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(refreshHomeStats).not.toHaveBeenCalled();
    expect(await auditActions()).toEqual(['promote.blocked', 'promote.blocked']);
  });

  it('enqueues no cache purge for a fully blocked promote', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env: Env = {
      ...baseEnv,
      CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
    };
    const execCtx = fakeExecutionContext();
    await buildApp().request(
      '/api/promote',
      post({ product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' } }),
      env,
      execCtx,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── `verified` is grant-only (AECI-520) ──────────────────────────────────────

describe('createPromoteHandler — verified is not review-app writable', () => {
  it('ignores `verified` on an update instead of flipping the entitlement bit', async () => {
    // The regression this guards: a routine Airtable push carrying
    // `verified: false` used to silently un-verify a paying vendor.
    await t.db
      .insert(vendors)
      .values({ id: uuid(80), slug: 'autodesk', companyName: 'Autodesk', verified: true });

    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: uuid(80), companyName: 'Autodesk', verified: false }],
    });
    expect(res.status).toBe(200);

    const [row] = await t.db
      .select()
      .from(vendors)
      .where(eq(vendors.id, uuid(80)));
    expect(row?.verified).toBe(true);
  });

  it('ignores `verified` on a create — the grant flow is the only way in', async () => {
    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Newco', verified: true }],
    });
    const body = (await res.json()) as PromoteResponse;
    const [row] = await t.db
      .select()
      .from(vendors)
      .where(eq(vendors.id, body.vendors[0]?.id as string));
    expect(row?.verified).toBe(false);
  });
});
