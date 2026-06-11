/**
 * Phase 5.8 (AECI-199) public reviews list.
 *
 *   GET /api/products/:slug/reviews — paginated, approved-only, newest-first.
 *
 * Contracts:
 *   - Query shape: `ProductReviewsQuerySchema` (page/perPage) from `@aeci/shared`.
 *   - Response shape: `ProductReviewsResponseSchema` — a plain
 *     `PaginatedResponse<PublicReview>`. No PII (no reviewer id/email), no
 *     ratings summary (that lives on `ProductDetail`, §5.4/§5.5).
 *   - `Cache-Control: private, no-store` applied by `json()`. Edge-cacheability
 *     and the `product:<slug>` Cache-Tag are an SSR-layer concern (the public
 *     product page bakes page 1 in); approval/rejection (5.13) purges that tag.
 *   - 4xx envelope produced by `errorMiddleware()` in `errors.ts`.
 */

import {
  ProductReviewsQuerySchema,
  ProductReviewsResponseSchema,
  type ProductReviewsResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import { publicReviewSelect, toPublicReview } from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';

export function createProductReviewsListHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product slug', { field: 'slug' });
    }

    const query = ProductReviewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const prisma = prismaFor(c.env);

    // Resolve the slug to its id first — an unknown slug is a 404, distinct from
    // a known product with zero approved reviews (an empty page).
    const product = await prisma.product.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!product) throw notFoundError('product', { slug });

    const where = { productId: product.id, status: 'approved' };
    const skip = (query.page - 1) * query.perPage;

    const [rows, total] = await Promise.all([
      prisma.review.findMany({
        where,
        // Newest-first (§5.4); `id` tiebreaks a `created_at` collision so
        // pagination is stable across pages.
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        skip,
        take: query.perPage,
        select: publicReviewSelect,
      }),
      prisma.review.count({ where }),
    ]);

    const body: ProductReviewsResponse = {
      data: rows.map(toPublicReview),
      page: query.page,
      perPage: query.perPage,
      total,
    };

    validateResponseInDev(c.env, () => {
      ProductReviewsResponseSchema.parse(body);
    });

    return json(body);
  };
}
