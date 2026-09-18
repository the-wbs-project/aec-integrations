/**
 * GET /api/admin/summary on the Drizzle/D1 path (ADR 0016 / AECI-253), against
 * the in-memory D1 harness. The handler counts the three Operations queues
 * (AECI-922); the requireAdmin gate lives in index.ts, so the handler itself
 * reads no auth context.
 *
 * The load-bearing assertion here is the LAST one: corrections and claims are two
 * kinds of one `vendor_requests` table, and the console sums the three counts, so
 * a `pending_requests` that forgot its `kind` predicate would double every open
 * claim in the Operations badge while every other test still passed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { products, reviews, vendorRequests } from '../db/schema';
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
    expect(await res.json()).toEqual({
      pending_reviews: 2,
      pending_requests: 0,
      pending_claims: 0,
      pending_reindex: 0,
      pending_contests: 0,
    });
  });

  it('returns 0 for every queue when nothing is waiting', async () => {
    expect(await (await get()).json()).toEqual({
      pending_reviews: 0,
      pending_requests: 0,
      pending_claims: 0,
      pending_reindex: 0,
      pending_contests: 0,
    });
  });

  it('splits open vendor_requests into corrections and claims, and counts only open', async () => {
    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'p', name: 'P', promotionStatus: 'promoted' });
    await t.db.insert(vendorRequests).values([
      req(21, 'correction', 'open'),
      req(22, 'correction', 'open'),
      req(23, 'claim', 'open'),
      // Neither of these is waiting on an operator's first look, and neither is in
      // the queue screens' default view — so neither is in the badge.
      req(24, 'claim', 'in_review'),
      req(25, 'correction', 'resolved'),
      req(26, 'claim', 'rejected'),
    ]);

    expect(await (await get()).json()).toEqual({
      pending_reviews: 0,
      pending_requests: 2,
      pending_claims: 1,
      pending_reindex: 0,
      pending_contests: 0,
    });
  });
});

/** A `vendor_requests` row with only the columns these counts key off. */
function req(n: number, kind: 'claim' | 'correction', status: string) {
  return {
    id: u(n),
    kind,
    status,
    targetType: 'product',
    targetId: u(1),
    submitterEmail: `s${n}@example.com`,
    body: 'b',
  };
}
