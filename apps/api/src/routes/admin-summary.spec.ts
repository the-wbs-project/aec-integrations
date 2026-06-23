/**
 * GET /api/admin/summary on the Drizzle/D1 path (ADR 0016 / AECI-253), against
 * the in-memory D1 harness. The handler counts pending reviews; the requireAdmin
 * gate lives in index.ts, so the handler itself reads no auth context.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { products, reviews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminSummaryHandler } from './admin-summary';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const get = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/admin/summary',
    handler: createAdminSummaryHandler(t.factory),
  }).request('/api/admin/summary', {}, TEST_ENV, fakeExecutionContext());

describe('GET /api/admin/summary', () => {
  it('returns the pending-review count', async () => {
    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'p', name: 'P', promotionStatus: 'promoted' });
    await t.db.insert(reviews).values([
      {
        id: u(11),
        productId: u(1),
        ratingOverall: 5,
        ratingOnboarding: 4,
        title: 'a',
        body: 'b',
        status: 'pending',
      },
      {
        id: u(12),
        productId: u(1),
        ratingOverall: 5,
        ratingOnboarding: 4,
        title: 'c',
        body: 'd',
        status: 'pending',
      },
      {
        id: u(13),
        productId: u(1),
        ratingOverall: 5,
        ratingOnboarding: 4,
        title: 'e',
        body: 'f',
        status: 'approved',
      },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()) as { pending_reviews: number }).toEqual({ pending_reviews: 2 });
  });

  it('returns 0 when there are no pending reviews', async () => {
    expect((await (await get()).json()) as { pending_reviews: number }).toEqual({
      pending_reviews: 0,
    });
  });
});
