/**
 * GET /api/categories|audiences|phases|trades list on the Drizzle/D1 path
 * (ADR 0016 / AECI-253), against the in-memory D1 harness.
 */

import { CategoriesListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  integrations,
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
import { createTaxonomyListHandler, type TaxonomyListKind } from './taxonomy-list';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const app = (kind: TaxonomyListKind, path: string) =>
  buildAppWithHandler({
    method: 'get',
    path,
    handler: createTaxonomyListHandler(kind, t.factory),
  });

describe('GET /api/categories (list)', () => {
  it('returns terms ordered by display_order with product counts', async () => {
    await t.db.insert(taxonomyCategories).values([
      { id: u(1), slug: 'zeta', name: 'Zeta', displayOrder: 90 },
      { id: u(2), slug: 'alpha', name: 'Alpha', displayOrder: 10 },
    ]);
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(productCategories).values({ productId: u(11), categoryId: u(2) });

    const res = await app('categories', '/api/categories').request(
      '/api/categories',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = CategoriesListResponseSchema.parse(await res.json());
    expect(body.data.map((c) => c.slug)).toEqual(['alpha', 'zeta']);
    expect(body.data[0]?.product_count).toBe(1);
  });
});

// The count the taxonomy index pages sort by. The cases that matter are the two
// ways a naive implementation gets it wrong: counting an integration twice when
// both of its endpoints carry the term, and missing one that is only reachable
// through its *target*.
describe('integration_count', () => {
  /** Two products tagged `alpha`, one tagged nothing, wired as noted per test. */
  async function seedCategoryFixture() {
    await t.db.insert(taxonomyCategories).values([
      { id: u(1), slug: 'alpha', name: 'Alpha', displayOrder: 10 },
      { id: u(2), slug: 'beta', name: 'Beta', displayOrder: 20 },
    ]);
    await t.db.insert(products).values([
      { id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
      { id: u(12), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
      { id: u(13), slug: 'outsider', name: 'Outsider', promotionStatus: 'promoted' },
    ]);
    await t.db.insert(productCategories).values([
      { productId: u(11), categoryId: u(1) },
      { productId: u(12), categoryId: u(1) },
    ]);
  }

  const alpha = async () => {
    const res = await app('categories', '/api/categories').request(
      '/api/categories',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = CategoriesListResponseSchema.parse(await res.json());
    return body.data.find((c) => c.slug === 'alpha');
  };

  it('counts an integration once when BOTH endpoints carry the term', async () => {
    await seedCategoryFixture();
    // Revit ↔ Procore: both tagged `alpha`. This is the row that a
    // SUM(products.integration_count) implementation would count twice.
    await t.db
      .insert(integrations)
      .values({ id: u(21), sourceProductId: u(11), targetProductId: u(12) });

    expect((await alpha())?.integration_count).toBe(1);
  });

  it('counts an integration reachable through either endpoint', async () => {
    await seedCategoryFixture();
    await t.db.insert(integrations).values([
      // Tagged product as SOURCE.
      { id: u(21), sourceProductId: u(11), targetProductId: u(13) },
      // Tagged product as TARGET — the direction a `source_product_id`-only
      // implementation drops.
      { id: u(22), sourceProductId: u(13), targetProductId: u(12) },
    ]);

    expect((await alpha())?.integration_count).toBe(2);
  });

  it('is 0 for a term whose products have no integrations, and for an empty term', async () => {
    await seedCategoryFixture();
    const res = await app('categories', '/api/categories').request(
      '/api/categories',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = CategoriesListResponseSchema.parse(await res.json());
    expect(body.data.find((c) => c.slug === 'alpha')?.integration_count).toBe(0);
    // `beta` has no tagged products at all.
    expect(body.data.find((c) => c.slug === 'beta')?.integration_count).toBe(0);
  });

  it('does not leak across terms', async () => {
    await seedCategoryFixture();
    // An integration between two products, NEITHER tagged `alpha`.
    await t.db
      .insert(products)
      .values({ id: u(14), slug: 'bluebeam', name: 'Bluebeam', promotionStatus: 'promoted' });
    await t.db.insert(productCategories).values({ productId: u(14), categoryId: u(2) });
    await t.db
      .insert(integrations)
      .values({ id: u(21), sourceProductId: u(13), targetProductId: u(14) });

    const res = await app('categories', '/api/categories').request(
      '/api/categories',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = CategoriesListResponseSchema.parse(await res.json());
    expect(body.data.find((c) => c.slug === 'alpha')?.integration_count).toBe(0);
    expect(body.data.find((c) => c.slug === 'beta')?.integration_count).toBe(1);
  });
  // AECI-1483 moved the OR out of a correlated EXISTS into two top-level `IN`
  // arms so SQLite can use the endpoint indexes. This pins the new count to the
  // old shape on one fixture with every tricky row: both endpoints tagged, a
  // product tagged with BOTH terms, source-only, target-only, retired, and an
  // integration touching no tagged product.
  it('agrees with the pre-AECI-1483 EXISTS form on a mixed fixture', async () => {
    await seedCategoryFixture();
    await t.db.insert(products).values([
      { id: u(14), slug: 'bluebeam', name: 'Bluebeam', promotionStatus: 'promoted' },
      { id: u(15), slug: 'untagged', name: 'Untagged', promotionStatus: 'promoted' },
    ]);
    await t.db.insert(productCategories).values([
      { productId: u(14), categoryId: u(2) },
      // Procore carries both terms.
      { productId: u(12), categoryId: u(2) },
    ]);
    await t.db.insert(integrations).values([
      { id: u(21), sourceProductId: u(11), targetProductId: u(12) },
      { id: u(22), sourceProductId: u(11), targetProductId: u(13) },
      { id: u(23), sourceProductId: u(13), targetProductId: u(12) },
      { id: u(24), sourceProductId: u(12), targetProductId: u(14) },
      {
        id: u(25),
        sourceProductId: u(14),
        targetProductId: u(11),
        retiredAt: '2026-10-01T00:00:00.000Z',
      },
      { id: u(26), sourceProductId: u(13), targetProductId: u(15) },
    ]);

    const legacy = t.raw
      .prepare(
        `SELECT tc.slug, (SELECT count(*) FROM integrations i WHERE EXISTS (
           SELECT 1 FROM product_categories j
           WHERE j.category_id = tc.id
             AND (j.product_id = i.source_product_id OR j.product_id = i.target_product_id)
         ) AND i.retired_at IS NULL) AS n
         FROM taxonomy_categories tc`,
      )
      .all() as { slug: string; n: number }[];

    const res = await app('categories', '/api/categories').request(
      '/api/categories',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = CategoriesListResponseSchema.parse(await res.json());
    const current = Object.fromEntries(body.data.map((c) => [c.slug, c.integration_count]));

    expect(current).toEqual(Object.fromEntries(legacy.map((r) => [r.slug, r.n])));
    // Spelled out so a shared regression in both shapes still fails:
    // alpha = 21 (both ends, once), 22, 23, 24; beta = 21, 23, 24 via Procore.
    expect(current).toEqual({ alpha: 4, beta: 3 });
  });
});

describe('GET /api/audiences (list)', () => {
  it('orders audiences A to Z by name, case-insensitive, ignoring display_order (AECI-1243)', async () => {
    await t.db.insert(taxonomyAudiences).values([
      { id: u(1), slug: 'structural-engineer', name: 'Structural Engineer', displayOrder: 10 },
      { id: u(2), slug: 'architect', name: 'architect', displayOrder: 20 },
      { id: u(3), slug: 'bim-manager', name: 'BIM Manager', displayOrder: null },
    ]);
    const res = await app('audiences', '/api/audiences').request(
      '/api/audiences',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = CategoriesListResponseSchema.parse(await res.json());
    expect(body.data.map((a) => a.slug)).toEqual([
      'architect',
      'bim-manager',
      'structural-engineer',
    ]);
  });
});

describe('GET /api/phases (list)', () => {
  it('reuses the factory for the phases facet', async () => {
    await t.db
      .insert(taxonomyPhases)
      .values({ id: u(1), slug: 'design', name: 'Design', displayOrder: 10 });
    const res = await app('phases', '/api/phases').request(
      '/api/phases',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = CategoriesListResponseSchema.parse(await res.json());
    expect(body.data.map((p) => p.slug)).toEqual(['design']);
  });
});

// AECI-541 — the fourth facet (§5.5a). `description` is NOT NULL on
// `taxonomy_trades` (unlike its three siblings), so every fixture supplies it.
describe('GET /api/trades (list)', () => {
  const getTrades = () =>
    app('trades', '/api/trades').request('/api/trades', {}, TEST_ENV, fakeExecutionContext());

  it('returns terms ordered by display_order with product counts', async () => {
    await t.db.insert(taxonomyTrades).values([
      {
        id: u(1),
        slug: 'roofing',
        name: 'Roofing',
        description: 'Roof systems.',
        displayOrder: 90,
      },
      {
        id: u(2),
        slug: 'electrical',
        name: 'Electrical',
        description: 'Power distribution.',
        displayOrder: 10,
      },
    ]);
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'accubid', name: 'Accubid', promotionStatus: 'promoted' });
    await t.db.insert(productTrades).values({ productId: u(11), tradeId: u(2) });

    const res = await getTrades();
    expect(res.status).toBe(200);
    const body = CategoriesListResponseSchema.parse(await res.json());
    expect(body.data.map((x) => x.slug)).toEqual(['electrical', 'roofing']);
    expect(body.data[0]?.product_count).toBe(1);
  });

  it('is NOT publication-gated: zero-count terms are still listed', async () => {
    // `paving-asphalt` sits below TRADE_PUBLISH_MIN_PRODUCTS at any floor value,
    // and the endpoint returns it anyway. Every term travels with its real count
    // so each surface can apply the floor itself.
    await t.db.insert(taxonomyTrades).values([
      {
        id: u(1),
        slug: 'glazing-curtain-wall',
        name: 'Glazing & Curtain Wall',
        description: 'Facades.',
        displayOrder: 10,
      },
      {
        id: u(2),
        slug: 'paving-asphalt',
        name: 'Paving & Asphalt',
        description: 'Pavement.',
        displayOrder: 20,
      },
    ]);
    await t.db.insert(products).values([
      { id: u(11), slug: 'p1', name: 'P1', promotionStatus: 'promoted' },
      { id: u(12), slug: 'p2', name: 'P2', promotionStatus: 'promoted' },
    ]);
    await t.db.insert(productTrades).values([
      { productId: u(11), tradeId: u(1) },
      { productId: u(12), tradeId: u(1) },
    ]);

    const body = CategoriesListResponseSchema.parse(await (await getTrades()).json());
    expect(body.data.map((x) => [x.slug, x.product_count])).toEqual([
      ['glazing-curtain-wall', 2],
      ['paving-asphalt', 0],
    ]);
  });
});
