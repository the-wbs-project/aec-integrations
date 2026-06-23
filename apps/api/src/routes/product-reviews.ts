/**
 * Phase 5.8 (AECI-199) public reviews list — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 *   GET /api/products/:slug/reviews — paginated, approved-only, newest-first.
 *
 * Contracts:
 *   - Query: `ProductReviewsQuerySchema` (page/perPage); Response:
 *     `ProductReviewsResponseSchema` (`PaginatedResponse<PublicReview>`). No PII.
 */

import {
  ProductReviewsQuerySchema,
  ProductReviewsResponseSchema,
  type ProductReviewsResponse,
} from '@aeci/shared';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { products, reviews } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { publicReviewColumns, toPublicReview } from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

export function createProductReviewsListHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product slug', { field: 'slug' });
    }

    const query = ProductReviewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);

    // Resolve the slug to its id first — an unknown slug is a 404, distinct from
    // a known product with zero approved reviews (an empty page).
    const product = await db.query.products.findFirst({
      columns: { id: true },
      where: eq(products.slug, slug),
    });
    if (!product) throw notFoundError('product', { slug });

    const where = and(eq(reviews.productId, product.id), eq(reviews.status, 'approved'));

    const [rows, countRows] = await Promise.all([
      db.query.reviews.findMany({
        columns: publicReviewColumns,
        where,
        // Newest-first (§5.4); `id` tiebreaks a `created_at` collision.
        orderBy: [desc(reviews.createdAt), asc(reviews.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(reviews).where(where),
    ]);

    const body: ProductReviewsResponse = {
      data: rows.map(toPublicReview),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      ProductReviewsResponseSchema.parse(body);
    });

    return json(body);
  };
}
