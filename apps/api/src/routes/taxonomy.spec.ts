/**
 * GET /api/taxonomy aggregate on the Drizzle/D1 path (ADR 0016 / AECI-253),
 * against the in-memory D1 harness (no TAXONOMY_KV → direct DB fallback).
 */

import { TaxonomyResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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
import { createTaxonomyHandler } from './taxonomy';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const app = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/taxonomy',
    handler: createTaxonomyHandler(t.factory),
  });

describe('GET /api/taxonomy', () => {
  it('returns the four facet lists ordered by display_order, with product counts', async () => {
    await t.db.insert(taxonomyCategories).values([
      { id: u(1), slug: 'zeta', name: 'Zeta', displayOrder: 90 },
      { id: u(2), slug: 'alpha', name: 'Alpha', displayOrder: 10 },
    ]);
    await t.db
      .insert(taxonomyAudiences)
      .values({ id: u(3), slug: 'arch', name: 'Arch', displayOrder: 10 });
    await t.db
      .insert(taxonomyPhases)
      .values({ id: u(4), slug: 'design', name: 'Design', displayOrder: 10 });
    await t.db.insert(taxonomyTrades).values([
      {
        id: u(5),
        slug: 'roofing',
        name: 'Roofing',
        description: 'Roof systems.',
        displayOrder: 90,
      },
      {
        id: u(6),
        slug: 'electrical',
        name: 'Electrical',
        description: 'Power distribution.',
        displayOrder: 10,
      },
    ]);
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(productCategories).values({ productId: u(11), categoryId: u(2) });
    await t.db.insert(productTrades).values({ productId: u(11), tradeId: u(6) });

    const res = await app().request('/api/taxonomy', {}, TEST_ENV, fakeExecutionContext());
    expect(res.status).toBe(200);
    const body = TaxonomyResponseSchema.parse(await res.json());

    // display_order ASC → alpha (10) before zeta (90)
    expect(body.categories.map((c) => c.slug)).toEqual(['alpha', 'zeta']);
    expect(body.categories.find((c) => c.slug === 'alpha')?.product_count).toBe(1);
    expect(body.categories.find((c) => c.slug === 'zeta')?.product_count).toBe(0);
    expect(body.audiences.map((a) => a.slug)).toEqual(['arch']);
    expect(body.phases.map((p) => p.slug)).toEqual(['design']);
    // AECI-541 — trades mirror the other three: display_order ASC, live counts,
    // and NO publication gate (roofing is listed at 0, well under the floor).
    expect(body.trades.map((x) => x.slug)).toEqual(['electrical', 'roofing']);
    expect(body.trades.find((x) => x.slug === 'electrical')?.product_count).toBe(1);
    expect(body.trades.find((x) => x.slug === 'roofing')?.product_count).toBe(0);
  });

  it('returns an empty trades list on a catalog with no trade vocabulary seeded', async () => {
    const res = await app().request('/api/taxonomy', {}, TEST_ENV, fakeExecutionContext());
    const body = TaxonomyResponseSchema.parse(await res.json());
    expect(body.trades).toEqual([]);
  });
});
