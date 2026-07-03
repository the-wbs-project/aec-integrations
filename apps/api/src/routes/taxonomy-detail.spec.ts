/**
 * GET /api/categories|audiences|phases/:slug detail on the Drizzle/D1 path
 * (ADR 0016 / AECI-253), against the in-memory D1 harness.
 */

import { AudienceDetailSchema, CategoryDetailSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  productAudiences,
  productCategories,
  products,
  taxonomyAudiences,
  taxonomyCategories,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createTaxonomyDetailHandler } from './taxonomy-detail';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const categoryApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/categories/:slug',
    handler: createTaxonomyDetailHandler(
      { resource: 'category', schema: CategoryDetailSchema },
      t.factory,
    ),
  });
const audienceApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/audiences/:slug',
    handler: createTaxonomyDetailHandler(
      { resource: 'audience', schema: AudienceDetailSchema },
      t.factory,
    ),
  });
const get = (app: ReturnType<typeof categoryApp>, url: string) =>
  app.request(url, {}, TEST_ENV, fakeExecutionContext());

describe('GET /api/categories/:slug', () => {
  it('hydrates the term, its product_count, and embedded products', async () => {
    await t.db
      .insert(taxonomyCategories)
      .values({ id: u(1), slug: 'bim', name: 'BIM', displayOrder: 10 });
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(productCategories).values({ productId: u(11), categoryId: u(1) });

    const res = await get(categoryApp(), '/api/categories/bim');
    expect(res.status).toBe(200);
    const body = CategoryDetailSchema.parse(await res.json());
    expect(body.slug).toBe('bim');
    expect(body.product_count).toBe(1);
    expect(body.products.map((p) => p.slug)).toEqual(['revit']);
  });

  it('404s an unknown slug', async () => {
    expect((await get(categoryApp(), '/api/categories/nope')).status).toBe(404);
  });
});

describe('GET /api/audiences/:slug', () => {
  it('reuses the factory for the audience facet', async () => {
    await t.db
      .insert(taxonomyAudiences)
      .values({ id: u(1), slug: 'arch', name: 'Architecture', displayOrder: 10 });
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(productAudiences).values({ productId: u(11), audienceId: u(1) });

    const body = AudienceDetailSchema.parse(
      await (await get(audienceApp(), '/api/audiences/arch')).json(),
    );
    expect(body.products.map((p) => p.slug)).toEqual(['revit']);
  });
});
