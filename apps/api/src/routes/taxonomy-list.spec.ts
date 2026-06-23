/**
 * GET /api/categories|audiences|phases list on the Drizzle/D1 path (ADR 0016 /
 * AECI-253), against the in-memory D1 harness.
 */

import { CategoriesListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { productCategories, products, taxonomyCategories, taxonomyPhases } from '../db/schema';
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
