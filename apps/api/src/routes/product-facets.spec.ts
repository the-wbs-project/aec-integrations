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
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
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
    // Two products. p1 ∈ {cat A, aud X}; p2 ∈ {cat B, aud X}.
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
    await t.db.insert(productCategories).values([
      { productId: u(1), categoryId: u(11) },
      { productId: u(2), categoryId: u(12) },
    ]);
    await t.db.insert(productAudiences).values([
      { productId: u(1), audienceId: u(21) },
      { productId: u(2), audienceId: u(21) },
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
  });
});
