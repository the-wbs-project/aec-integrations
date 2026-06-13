/**
 * Unit coverage for `GET /api/account/reviews` (AECI-225 / Phase 5.11). The
 * handler is exercised in isolation (mirroring `account.spec.ts`): a middleware
 * injects the `auth` Variable that `requireAuth()` would, and the AECI-54
 * mock-accelerated Prisma stands in for the real client so the query the handler
 * builds can be asserted.
 *
 * Contract pins:
 *   - the `reviewer_id` scope is SERVER-SET from the session — a client-supplied
 *     `?reviewer_id=…` query param has NO effect.
 *   - ALL statuses (pending / approved / rejected) come back (no status filter),
 *     each with its `rejection_reason`.
 *   - newest-first ordering, page/perPage skip/take, the paginated envelope, and
 *     `Cache-Control: private, no-store`.
 *   - no PII / admin-only columns are selected.
 */

import { AccountReviewsResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { RawAccountReviewRow } from '../lib/prisma-helpers';
import {
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createGetAccountReviewsHandler } from './account-reviews';

const USER_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_USER_ID = '11111111-1111-4111-8111-111111111111';

/** Three of the caller's own reviews, one per status, newest-first. */
const accountReviewRows: RawAccountReviewRow[] = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    ratingOverall: 5,
    ratingOnboarding: 4,
    title: 'Approved one',
    status: 'approved',
    rejectionReason: null,
    createdAt: new Date('2024-06-10T00:00:00Z'),
    product: { id: '00000000-0000-4000-8000-0000000000b1', name: 'Procore', slug: 'procore' },
  },
  {
    id: '00000000-0000-4000-8000-0000000000a2',
    ratingOverall: 3,
    ratingOnboarding: 2,
    title: 'Still pending',
    status: 'pending',
    rejectionReason: null,
    createdAt: new Date('2024-06-05T00:00:00Z'),
    product: { id: '00000000-0000-4000-8000-0000000000b2', name: 'Bluebeam', slug: 'bluebeam' },
  },
  {
    id: '00000000-0000-4000-8000-0000000000a3',
    ratingOverall: 1,
    ratingOnboarding: 1,
    title: 'Was rejected',
    status: 'rejected',
    rejectionReason: 'Off-topic / not a real review.',
    createdAt: new Date('2024-06-01T00:00:00Z'),
    product: { id: '00000000-0000-4000-8000-0000000000b3', name: 'Revit', slug: 'revit' },
  },
];

function reviewsPrisma(rows = accountReviewRows, total = rows.length) {
  return makeMockAcceleratedPrisma({ review: { findMany: rows, count: total } });
}

/** Mount the handler behind a middleware that injects a verified `auth`. */
function appWith(
  prisma: MockAcceleratedPrisma,
  auth: AuthzVariables['auth'] = {
    userId: USER_ID,
    email: 'reviewer@example.com',
    role: 'reviewer',
  },
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/account/reviews', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.get(
    '/api/account/reviews',
    createGetAccountReviewsHandler(() => prisma as never),
  );
  return app;
}

function call(app: ReturnType<typeof appWith>, url = '/api/account/reviews') {
  return app.request(url, {}, TEST_ENV, fakeExecutionContext());
}

describe('GET /api/account/reviews', () => {
  it('returns the paginated envelope with defaults, newest-first', async () => {
    const res = await call(appWith(reviewsPrisma()));

    expect(res.status).toBe(200);
    const parsed = AccountReviewsResponseSchema.parse(await res.json());
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
    expect(parsed.total).toBe(3);
    expect(parsed.data.map((r) => r.title)).toEqual([
      'Approved one',
      'Still pending',
      'Was rejected',
    ]);
    expect(parsed.data[0]?.product).toEqual({
      id: '00000000-0000-4000-8000-0000000000b1',
      name: 'Procore',
      slug: 'procore',
    });
  });

  it('returns ALL statuses (no status filter) with rejection_reason', async () => {
    const res = await call(appWith(reviewsPrisma()));
    const parsed = AccountReviewsResponseSchema.parse(await res.json());

    expect(parsed.data.map((r) => r.status)).toEqual(['approved', 'pending', 'rejected']);
    const rejected = parsed.data.find((r) => r.status === 'rejected');
    expect(rejected?.rejection_reason).toBe('Off-topic / not a real review.');
  });

  it('scopes the query to the session user id — server-set, never client-supplied', async () => {
    const prisma = reviewsPrisma();
    // A spoofed `reviewer_id` query param must be ignored entirely.
    await call(appWith(prisma), `/api/account/reviews?reviewer_id=${OTHER_USER_ID}`);

    const findCall = prisma.review.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
    };
    // Exactly the session scope — no status filter, no client-supplied id.
    expect(findCall.where).toEqual({ reviewerId: USER_ID });
    expect(findCall.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);

    const countCall = prisma.review.count.mock.calls[0][0] as { where: unknown };
    expect(countCall.where).toEqual({ reviewerId: USER_ID });

    // The other user's id never reaches the query.
    expect(JSON.stringify(findCall.where)).not.toContain(OTHER_USER_ID);
  });

  it('honors page/perPage with the correct skip/take', async () => {
    const prisma = reviewsPrisma([], 40);
    await call(appWith(prisma), '/api/account/reviews?page=3&perPage=10');

    const findCall = prisma.review.findMany.mock.calls[0][0] as { skip: number; take: number };
    expect(findCall.skip).toBe(20);
    expect(findCall.take).toBe(10);
  });

  it('selects no PII / admin-only columns', async () => {
    const prisma = reviewsPrisma();
    await call(appWith(prisma));

    const findCall = prisma.review.findMany.mock.calls[0][0] as { select: Record<string, unknown> };
    for (const forbidden of [
      'reviewerId',
      'reviewer',
      'toxicityScore',
      'moderatedAt',
      'moderatedBy',
      'locale',
      'body',
    ]) {
      expect(findCall.select).not.toHaveProperty(forbidden);
    }
  });

  it('returns an empty page when the user has no reviews', async () => {
    const prisma = makeMockAcceleratedPrisma({ review: { findMany: [], count: 0 } });
    const res = await call(appWith(prisma));

    expect(res.status).toBe(200);
    const parsed = AccountReviewsResponseSchema.parse(await res.json());
    expect(parsed.data).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it('emits `Cache-Control: private, no-store` on success', async () => {
    const res = await call(appWith(reviewsPrisma()));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
