/**
 * GET /api/categories|audiences|phases|trades list on the Drizzle/D1 path
 * (ADR 0016 / AECI-253), against the in-memory D1 harness.
 */

import { CategoriesListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  productCategories,
  products,
  productTrades,
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

  it('is NOT publication-gated: sub-floor and zero-count terms are still listed', async () => {
    // TRADE_PUBLISH_MIN_PRODUCTS = 3 — both of these are below it, and both must
    // travel with their real count so each surface can apply the floor itself.
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
