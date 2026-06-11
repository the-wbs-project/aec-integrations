/**
 * Phase 2.8 (AECI-54) products endpoints.
 *
 *   GET /api/products         — paginated, filterable, sortable list.
 *   GET /api/products/:slug   — single product detail with full hydration.
 *
 * Contracts:
 *   - Query shape: `ProductsListQuerySchema` from `@aeci/shared`.
 *   - Response shape: `ProductsListResponseSchema` (list) / `ProductDetailSchema`
 *     (detail). Hydration depth per `docs/API_CONTRACTS.md` §3.4.
 *   - Sort defaults & direction: §7.4 of the Phase 2 spec (resolved by
 *     `lib/sort.ts`).
 *   - `Cache-Control: private, no-store` applied by `json()`.
 *   - 4xx envelope produced by `errorMiddleware()` in `errors.ts`.
 */

import {
  ProductDetailSchema,
  ProductsListQuerySchema,
  ProductsListResponseSchema,
  type ProductDetail,
  type ProductsListResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  reportMissingVendors,
  validateResponseInDev,
  type PrismaFactory,
} from '../lib/handler-utils';
import {
  buildProductsWhere,
  EMBED_REVIEWS_PAGE_SIZE,
  productDetailSelect,
  productListSelect,
  publicReviewSelect,
  toProductDetail,
  toProductListItem,
} from '../lib/prisma-helpers';
import { resolveProductSort } from '../lib/sort';
import { getPrisma } from '../prisma';

export function createProductsListHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = ProductsListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const where = buildProductsWhere(query);
    const orderBy = resolveProductSort(query.sort);
    const skip = (query.page - 1) * query.perPage;

    const prisma = prismaFor(c.env);
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy,
        skip,
        take: query.perPage,
        select: productListSelect,
      }),
      prisma.product.count({ where }),
    ]);

    const body: ProductsListResponse = {
      data: rows.map(toProductListItem),
      page: query.page,
      perPage: query.perPage,
      total,
    };

    reportMissingVendors(c, body.data);

    validateResponseInDev(c.env, () => {
      ProductsListResponseSchema.parse(body);
    });

    return json(body);
  };
}

export function createProductDetailHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product slug', { field: 'slug' });
    }

    const prisma = prismaFor(c.env);
    const row = await prisma.product.findUnique({
      where: { slug },
      select: productDetailSelect,
    });

    if (!row) throw notFoundError('product', { slug });

    // Baseline `related_products`: latest 6 products that share at least one
    // category with this product, excluding the product itself. Refining the
    // algorithm (cosine on categories+audiences, popularity weighting) is
    // out of scope for AECI-54 — kept simple so the hydration contract is
    // satisfied without an external ML hop.
    const categoryIds = row.productCategories.map((r) => r.category.id);
    const [relatedProducts, reviews] = await Promise.all([
      categoryIds.length === 0
        ? Promise.resolve([])
        : prisma.product.findMany({
            where: {
              id: { not: row.id },
              productCategories: { some: { categoryId: { in: categoryIds } } },
            },
            orderBy: { createdAt: 'desc' as const },
            take: 6,
            select: productListSelect,
          }),
      // First page of approved reviews, newest-first, for SSR. `id` tiebreaks a
      // `created_at` collision deterministically (matches the list endpoint).
      prisma.review.findMany({
        where: { productId: row.id, status: 'approved' },
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        take: EMBED_REVIEWS_PAGE_SIZE,
        select: publicReviewSelect,
      }),
    ]);

    const body: ProductDetail = toProductDetail(row, relatedProducts, reviews);

    reportMissingVendors(c, [body, ...body.related_products]);

    validateResponseInDev(c.env, () => {
      ProductDetailSchema.parse(body);
    });

    return json(body);
  };
}
