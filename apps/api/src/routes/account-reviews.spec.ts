/**
 * GET /api/account/reviews on the Drizzle/D1 path (ADR 0016 / AECI-253), against
 * the in-memory D1 harness. The handler reads `c.get('auth').userId`, so a tiny
 * middleware injects the verified session; the scope filter is server-set.
 */

import { AccountReviewsResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { products, profiles, reviews } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createGetAccountReviewsHandler } from './account-reviews';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REVIEWER = u(900);
const OTHER = u(901);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function app(userId: string) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId,
      email: undefined,
      role: 'reviewer',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.get('/api/account/reviews', createGetAccountReviewsHandler(t.factory));
  return a;
}
const get = (userId: string, url = '/api/account/reviews') =>
  app(userId).request(url, {}, TEST_ENV, fakeExecutionContext());

// One non-archived review per (product, reviewer) — the partial unique index —
// so each review uses a distinct product.
async function review(id: string, productId: string, reviewerId: string, status: string) {
  await t.db.insert(reviews).values({
    id,
    productId,
    reviewerId,
    ratingOverall: 5,
    ratingOnboarding: 4,
    title: `T${id.slice(-2)}`,
    body: 'Body',
    status,
  });
}

describe('GET /api/account/reviews', () => {
  beforeEach(async () => {
    await t.db.insert(products).values(
      [1, 2, 3, 4].map((n) => ({
        id: u(n),
        slug: `p${n}`,
        name: `P${n}`,
        promotionStatus: 'promoted',
      })),
    );
    await t.db.insert(profiles).values([{ id: REVIEWER }, { id: OTHER }]);
  });

  it("returns only the caller's own reviews, in every status", async () => {
    await review(u(11), u(1), REVIEWER, 'pending');
    await review(u(12), u(2), REVIEWER, 'approved');
    await review(u(13), u(3), REVIEWER, 'rejected');
    await review(u(14), u(4), OTHER, 'approved'); // someone else's — must not appear

    const res = await get(REVIEWER);
    expect(res.status).toBe(200);
    const body = AccountReviewsResponseSchema.parse(await res.json());
    expect(body.total).toBe(3);
    expect(body.data.map((r) => r.status).sort()).toEqual(['approved', 'pending', 'rejected']);
  });

  it('ignores a client-supplied reviewer_id (scope is the session sub)', async () => {
    await review(u(11), u(1), REVIEWER, 'pending');
    await review(u(14), u(4), OTHER, 'approved');

    const body = AccountReviewsResponseSchema.parse(
      await (await get(REVIEWER, `/api/account/reviews?reviewer_id=${OTHER}`)).json(),
    );
    expect(body.total).toBe(1);
  });

  // ── ?product_id= filter (AECI-260) ──────────────────────────────────────
  it('narrows to a single product with ?product_id= (data + count)', async () => {
    await review(u(11), u(1), REVIEWER, 'pending');
    await review(u(12), u(2), REVIEWER, 'approved');
    await review(u(13), u(3), REVIEWER, 'rejected');

    const body = AccountReviewsResponseSchema.parse(
      await (await get(REVIEWER, `/api/account/reviews?product_id=${u(2)}`)).json(),
    );
    // The count reflects the filter (1), not the caller's full set (3).
    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.product.id).toBe(u(2));
    expect(body.data[0]?.status).toBe('approved');
  });

  it('returns an empty page for a product the caller has not reviewed', async () => {
    await review(u(11), u(1), REVIEWER, 'pending');

    const body = AccountReviewsResponseSchema.parse(
      await (await get(REVIEWER, `/api/account/reviews?product_id=${u(4)}`)).json(),
    );
    expect(body.total).toBe(0);
    expect(body.data).toEqual([]);
  });

  it('keeps reviewer scope server-set even with ?product_id= (no cross-user leak)', async () => {
    await review(u(12), u(2), REVIEWER, 'approved');
    await review(u(14), u(2), OTHER, 'approved'); // same product, different reviewer

    const body = AccountReviewsResponseSchema.parse(
      await (
        await get(REVIEWER, `/api/account/reviews?reviewer_id=${OTHER}&product_id=${u(2)}`)
      ).json(),
    );
    expect(body.total).toBe(1);
    expect(body.data[0]?.id).toBe(u(12)); // the caller's, not OTHER's
  });

  it('rejects a malformed product_id with 400', async () => {
    const res = await get(REVIEWER, '/api/account/reviews?product_id=not-a-uuid');
    expect(res.status).toBe(400);
  });
});
