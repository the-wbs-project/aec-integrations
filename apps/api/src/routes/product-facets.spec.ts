/**
 * GET /api/products/facets on the Drizzle/D1 path (ADR 0016 / AECI-253), against
 * the in-memory D1 harness. Exercises disjunctive faceting: a filter on one
 * dimension scopes the OTHER dimensions' counts but not its own.
 */

import { ProductFacetsResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  productAudiences,
  productCategories,
  products,
  productTrades,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createProductFacetsHandler } from './product-facets';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const get = (url: string) =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products/facets',
    handler: createProductFacetsHandler(t.factory),
  }).request(url, {}, TEST_ENV, fakeExecutionContext());

describe('GET /api/products/facets', () => {
  beforeEach(async () => {
    // Two products. p1 ∈ {cat A, aud X, trade E}; p2 ∈ {cat B, aud X, trade E}.
    await t.db.insert(products).values([
      { id: u(1), slug: 'p1', name: 'P1', promotionStatus: 'promoted' },
      { id: u(2), slug: 'p2', name: 'P2', promotionStatus: 'promoted' },
    ]);
    await t.db.insert(taxonomyCategories).values([
      { id: u(11), slug: 'cat-a', name: 'Cat A', displayOrder: 10 },
      { id: u(12), slug: 'cat-b', name: 'Cat B', displayOrder: 20 },
    ]);
    await t.db
      .insert(taxonomyAudiences)
      .values({ id: u(21), slug: 'aud-x', name: 'Aud X', displayOrder: 10 });
    await t.db
      .insert(taxonomyPhases)
      .values({ id: u(31), slug: 'phase-1', name: 'Phase 1', displayOrder: 10 });
    // AECI-541 — trade E carries both products; trade R carries none (the sparse
    // zero-count case that is the norm for this facet).
    await t.db.insert(taxonomyTrades).values([
      {
        id: u(41),
        slug: 'electrical',
        name: 'Electrical',
        description: 'Power distribution.',
        displayOrder: 10,
      },
      {
        id: u(42),
        slug: 'roofing',
        name: 'Roofing',
        description: 'Roof systems.',
        displayOrder: 20,
      },
    ]);
    await t.db.insert(productCategories).values([
      { productId: u(1), categoryId: u(11) },
      { productId: u(2), categoryId: u(12) },
    ]);
    await t.db.insert(productAudiences).values([
      { productId: u(1), audienceId: u(21) },
      { productId: u(2), audienceId: u(21) },
    ]);
    await t.db.insert(productTrades).values([
      { productId: u(1), tradeId: u(41) },
      { productId: u(2), tradeId: u(41) },
    ]);
  });

  it('returns per-term counts across all dimensions (no filter)', async () => {
    const body = ProductFacetsResponseSchema.parse(
      await (await get('/api/products/facets')).json(),
    );
    const cat = (slug: string) => body.categories.find((c) => c.slug === slug)?.product_count;
    expect(cat('cat-a')).toBe(1);
    expect(cat('cat-b')).toBe(1);
    expect(body.audiences.find((a) => a.slug === 'aud-x')?.product_count).toBe(2);
    // term with no links still listed, count 0
    expect(body.phases.find((p) => p.slug === 'phase-1')?.product_count).toBe(0);
    // trades listed in editorial order, zero-count term included (AECI-541)
    expect(body.trades.map((x) => [x.slug, x.product_count])).toEqual([
      ['electrical', 2],
      ['roofing', 0],
    ]);
  });

  it('disjunctive faceting: filtering category A scopes audience counts but not category counts', async () => {
    const body = ProductFacetsResponseSchema.parse(
      await (await get(`/api/products/facets?category_id=${u(11)}`)).json(),
    );
    // category counts ignore their own filter → both still 1
    expect(body.categories.find((c) => c.slug === 'cat-a')?.product_count).toBe(1);
    expect(body.categories.find((c) => c.slug === 'cat-b')?.product_count).toBe(1);
    // audience count is scoped to category A → only p1 → 1 (not 2)
    expect(body.audiences.find((a) => a.slug === 'aud-x')?.product_count).toBe(1);
    // trades are a sibling dimension → also scoped to category A → 1 (not 2)
    expect(body.trades.find((x) => x.slug === 'electrical')?.product_count).toBe(1);
  });

  it('disjunctive faceting: a trade filter scopes the other dimensions but not its own counts', async () => {
    // Narrow to trade E (both products carry it), then also narrow category A so
    // the trade dimension has something to be excluded FROM.
    const body = ProductFacetsResponseSchema.parse(
      await (await get(`/api/products/facets?trade_id=${u(41)}&category_id=${u(11)}`)).json(),
    );
    // trade counts exclude their OWN filter but still honour category A → p1 only
    expect(body.trades.find((x) => x.slug === 'electrical')?.product_count).toBe(1);
    expect(body.trades.find((x) => x.slug === 'roofing')?.product_count).toBe(0);
    // categories exclude their own filter but honour the trade filter → both 1
    expect(body.categories.find((c) => c.slug === 'cat-a')?.product_count).toBe(1);
    expect(body.categories.find((c) => c.slug === 'cat-b')?.product_count).toBe(1);
    // audiences honour BOTH filters → p1 only
    expect(body.audiences.find((a) => a.slug === 'aud-x')?.product_count).toBe(1);
  });

  it('a {kind}_slug lock is disjunctive exactly like its id (AECI-1508)', async () => {
    const bySlug = ProductFacetsResponseSchema.parse(
      await (await get('/api/products/facets?category_slug=cat-a')).json(),
    );
    const byId = ProductFacetsResponseSchema.parse(
      await (await get(`/api/products/facets?category_id=${u(11)}`)).json(),
    );
    expect(bySlug).toEqual(byId);
    // its own dimension ignores it; the siblings are scoped by it
    expect(bySlug.categories.find((c) => c.slug === 'cat-b')?.product_count).toBe(1);
    expect(bySlug.audiences.find((a) => a.slug === 'aud-x')?.product_count).toBe(1);
  });

  it('a trade filter matching nothing zeroes the other dimensions', async () => {
    const body = ProductFacetsResponseSchema.parse(
      await (await get(`/api/products/facets?trade_id=${u(42)}`)).json(),
    );
    expect(body.categories.every((c) => c.product_count === 0)).toBe(true);
    expect(body.audiences.every((a) => a.product_count === 0)).toBe(true);
    // ...but the trade dimension still ignores its own filter
    expect(body.trades.find((x) => x.slug === 'electrical')?.product_count).toBe(2);
  });
});

describe('GET /api/products/facets — audience order (AECI-1242)', () => {
  it('lists audiences A to Z by name, not by display_order', async () => {
    await t.db.insert(taxonomyAudiences).values([
      { id: u(21), slug: 'architecture', name: 'Architecture', displayOrder: 20 },
      { id: u(22), slug: 'project-manager', name: 'Project Manager', displayOrder: 220 },
      { id: u(23), slug: 'bim-manager', name: 'BIM Manager', displayOrder: 290 },
      { id: u(24), slug: 'general-contracting', name: 'general Contracting', displayOrder: 80 },
    ]);
    const body = ProductFacetsResponseSchema.parse(
      await (await get('/api/products/facets')).json(),
    );
    expect(body.audiences.map((a) => a.slug)).toEqual([
      'architecture',
      'bim-manager',
      'general-contracting',
      'project-manager',
    ]);
  });
});

describe('GET /api/products/facets — connector kinds (AECI-1662)', () => {
  const connector = (
    n: number,
    slug: string,
    productRole: 'application' | 'connector' | 'hybrid',
    connectorKind: 'integration_platform' | 'sync_service' | null,
    hiddenAt: string | null = null,
  ) => ({
    id: u(n),
    slug,
    name: slug,
    promotionStatus: 'promoted' as const,
    productRole,
    connectorKind,
    hiddenAt,
  });

  beforeEach(async () => {
    await t.db.insert(taxonomyCategories).values([
      { id: u(11), slug: 'cat-a', name: 'Cat A', displayOrder: 10 },
      { id: u(12), slug: 'cat-b', name: 'Cat B', displayOrder: 20 },
    ]);
    await t.db.insert(products).values([
      // Two Integration platforms, one Sync Service and one hybrid Sync Service.
      connector(1, 'ip-1', 'connector', 'integration_platform'),
      connector(2, 'ip-2', 'connector', 'integration_platform'),
      connector(3, 'ss-1', 'connector', 'sync_service'),
      connector(4, 'hy-1', 'hybrid', 'sync_service'),
      // An unclassified connector, and an application left holding a stale kind
      // (a promote moved it off `connector`). Neither has a kind to count.
      connector(5, 'cx', 'connector', null),
      connector(6, 'app', 'application', 'sync_service'),
      // A hidden product is in no facet tally.
      connector(7, 'hidden', 'connector', 'sync_service', '2026-11-01T00:00:00.000Z'),
    ]);
    await t.db.insert(productCategories).values([
      { productId: u(1), categoryId: u(11) },
      { productId: u(3), categoryId: u(11) },
      { productId: u(4), categoryId: u(12) },
      { productId: u(6), categoryId: u(11) },
    ]);
  });

  const facets = async (qs = '') =>
    ProductFacetsResponseSchema.parse(await (await get(`/api/products/facets${qs}`)).json());

  it('lists both kinds in vocabulary order, counting only a connector or hybrid', async () => {
    expect((await facets()).connector_kinds).toEqual([
      { kind: 'integration_platform', product_count: 2 },
      { kind: 'sync_service', product_count: 2 },
    ]);
  });

  it('a kind filter scopes the taxonomy counts but not its own', async () => {
    const body = await facets('?connector_kind=sync_service');
    expect(body.connector_kinds).toEqual([
      { kind: 'integration_platform', product_count: 2 },
      { kind: 'sync_service', product_count: 2 },
    ]);
    // Sync Services: ss-1 in cat A, hy-1 in cat B. The application is not one.
    expect(body.categories.find((c) => c.slug === 'cat-a')?.product_count).toBe(1);
    expect(body.categories.find((c) => c.slug === 'cat-b')?.product_count).toBe(1);
  });

  it('a taxonomy filter scopes the kind counts', async () => {
    expect((await facets(`?category_id=${u(11)}`)).connector_kinds).toEqual([
      { kind: 'integration_platform', product_count: 1 },
      { kind: 'sync_service', product_count: 1 },
    ]);
  });

  it('refuses an unknown kind with a 400', async () => {
    expect((await get('/api/products/facets?connector_kind=ipaas')).status).toBe(400);
  });
});
