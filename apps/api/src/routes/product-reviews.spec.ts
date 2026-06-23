/**
 * GET /api/products/:slug/reviews on the Drizzle/D1 path (ADR 0016 / AECI-253),
 * against the in-memory D1 harness.
 */

import { ProductReviewsResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { products, reviews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createProductReviewsListHandler } from './product-reviews';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const app = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug/reviews',
    handler: createProductReviewsListHandler(t.factory),
  });
const get = (url: string) => app().request(url, {}, TEST_ENV, fakeExecutionContext());

async function review(id: string, productId: string, status: string, createdAt: string) {
  await t.db.insert(reviews).values({
    id,
    productId,
    ratingOverall: 5,
    ratingOnboarding: 4,
    title: `T${id.slice(-1)}`,
    body: 'Body',
    status,
    createdAt,
  });
}

describe('GET /api/products/:slug/reviews', () => {
  it('returns approved reviews newest-first, excluding non-approved', async () => {
    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await review(u(11), u(1), 'approved', '2026-01-01T00:00:00.000Z');
    await review(u(12), u(1), 'approved', '2026-02-01T00:00:00.000Z');
    await review(u(13), u(1), 'pending', '2026-03-01T00:00:00.000Z');

    const res = await get('/api/products/revit/reviews');
    expect(res.status).toBe(200);
    const body = ProductReviewsResponseSchema.parse(await res.json());
    expect(body.total).toBe(2);
    expect(body.data.map((r) => r.id)).toEqual([u(12), u(11)]); // newest-first
  });

  it('paginates', async () => {
    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    for (let i = 1; i <= 3; i++) {
      await review(u(10 + i), u(1), 'approved', `2026-0${i}-01T00:00:00.000Z`);
    }
    const body = ProductReviewsResponseSchema.parse(
      await (await get('/api/products/revit/reviews?perPage=2&page=2')).json(),
    );
    expect(body.total).toBe(3);
    expect(body.data.length).toBe(1);
  });

  it('404s an unknown product slug (distinct from an empty page)', async () => {
    expect((await get('/api/products/nope/reviews')).status).toBe(404);

    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'empty', name: 'Empty', promotionStatus: 'promoted' });
    const ok = await get('/api/products/empty/reviews');
    expect(ok.status).toBe(200);
    expect(ProductReviewsResponseSchema.parse(await ok.json()).total).toBe(0);
  });
});
