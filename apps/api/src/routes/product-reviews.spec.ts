import { ProductReviewsResponseSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { PROCORE_PRODUCT_ID } from '../test/fixtures/products';
import { approvedReviewRows } from '../test/fixtures/reviews';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createProductReviewsListHandler } from './product-reviews';

function reviewsApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug/reviews',
    handler: createProductReviewsListHandler(() => prisma as never),
  });
}

/** Mock where the slug resolves and the review queries return canned rows. */
function prismaWithReviews(rows = approvedReviewRows, total = rows.length) {
  return makeMockAcceleratedPrisma({
    product: { findUnique: { id: PROCORE_PRODUCT_ID } },
    review: { findMany: rows, count: total },
  });
}

describe('GET /api/products/:slug/reviews', () => {
  it('returns the paginated envelope with defaults, newest-first', async () => {
    const prisma = prismaWithReviews();
    const res = await reviewsApp(prisma).request(
      '/api/products/procore/reviews',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const parsed = ProductReviewsResponseSchema.parse(await res.json());
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
    expect(parsed.total).toBe(2);
    expect(parsed.data.map((r) => r.title)).toEqual(['Rolled out across two studios', 'Mixed bag']);
  });

  it('queries approved-only, newest-first, scoped to the resolved product id', async () => {
    const prisma = prismaWithReviews();
    await reviewsApp(prisma).request(
      '/api/products/procore/reviews',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    const call = prisma.review.findMany.mock.calls[0][0] as {
      where: { productId: string; status: string };
      orderBy: unknown;
    };
    expect(call.where).toEqual({ productId: PROCORE_PRODUCT_ID, status: 'approved' });
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);

    // count uses the same approved-only filter
    const countCall = prisma.review.count.mock.calls[0][0] as { where: unknown };
    expect(countCall.where).toEqual({ productId: PROCORE_PRODUCT_ID, status: 'approved' });
  });

  it('honors page/perPage with the correct skip/take', async () => {
    const prisma = prismaWithReviews([], 40);
    await reviewsApp(prisma).request(
      '/api/products/procore/reviews?page=3&perPage=10',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    const call = prisma.review.findMany.mock.calls[0][0] as { skip: number; take: number };
    expect(call.skip).toBe(20);
    expect(call.take).toBe(10);
  });

  it('exposes no PII (no reviewer id / email / status fields) in the payload', async () => {
    const prisma = prismaWithReviews();
    const res = await reviewsApp(prisma).request(
      '/api/products/procore/reviews',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const row = body.data[0];
    for (const forbidden of [
      'reviewer_id',
      'reviewerId',
      'reviewer',
      'email',
      'reviewer_email',
      'status',
      'toxicity_score',
      'locale',
      'moderated_at',
    ]) {
      expect(row).not.toHaveProperty(forbidden);
    }
    // The select also must not have asked Prisma for reviewer columns.
    const call = prisma.review.findMany.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(call.select).not.toHaveProperty('reviewerId');
    expect(call.select).not.toHaveProperty('reviewer');
  });

  it('returns an empty page for a known product with no approved reviews', async () => {
    const prisma = makeMockAcceleratedPrisma({
      product: { findUnique: { id: PROCORE_PRODUCT_ID } },
      review: { findMany: [], count: 0 },
    });
    const res = await reviewsApp(prisma).request(
      '/api/products/procore/reviews',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    const parsed = ProductReviewsResponseSchema.parse(await res.json());
    expect(parsed.data).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it('returns the canonical 404 envelope for an unknown slug', async () => {
    const prisma = makeMockAcceleratedPrisma({ product: { findUnique: null } });
    const res = await reviewsApp(prisma).request(
      '/api/products/no-such/reviews',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string; slug?: string } };
      trace_id: string;
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'product', slug: 'no-such' });
    // The reviews queries must not run when the slug doesn't resolve.
    expect(prisma.review.findMany).not.toHaveBeenCalled();
  });

  it('emits `Cache-Control: private, no-store` on success', async () => {
    const prisma = prismaWithReviews();
    const res = await reviewsApp(prisma).request(
      '/api/products/procore/reviews',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
