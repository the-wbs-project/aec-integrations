/**
 * Phase 2.8 (AECI-54) products endpoints — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 *   GET /api/products         — paginated, filterable, sortable list.
 *   GET /api/products/:slug   — single product detail with full hydration.
 *
 * Contracts:
 *   - Query shape: `ProductsListQuerySchema` from `@aeci/shared`.
 *   - Response shape: `ProductsListResponseSchema` (list) / `ProductDetailSchema`
 *     (detail). Hydration depth per `docs/API_CONTRACTS.md` §3.4.
 *   - Sort defaults & direction: §7.4 (resolved by `lib/sort.ts`).
 *   - `Cache-Control: private, no-store` applied by `json()`.
 */

import {
  ProductDetailSchema,
  ProductsListQuerySchema,
  ProductsListResponseSchema,
  type ProductDetail,
  type ProductsListResponse,
} from '@aeci/shared';
import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { products, reviews } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  buildProductsWhere,
  EMBED_REVIEWS_PAGE_SIZE,
  productDetailConfig,
  productListConfig,
  publicReviewColumns,
  toProductDetail,
  toProductListItem,
  type RawProductListRow,
} from '../lib/drizzle-helpers';
import { reportMissingVendors, validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { resolveProductOrderBy } from '../lib/sort';

export function createProductsListHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = ProductsListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const where = buildProductsWhere(db, query);
    const orderBy = resolveProductOrderBy(query.sort);
    const offset = (query.page - 1) * query.perPage;

    const [rows, countRows] = await Promise.all([
      db.query.products.findMany({
        ...productListConfig,
        where,
        orderBy,
        limit: query.perPage,
        offset,
      }),
      db.select({ value: count() }).from(products).where(where),
    ]);

    const body: ProductsListResponse = {
      data: rows.map(toProductListItem),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    reportMissingVendors(c, body.data);

    validateResponseInDev(c.env, () => {
      ProductsListResponseSchema.parse(body);
    });

    return json(body);
  };
}

export function createProductDetailHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product slug', { field: 'slug' });
    }

    const { db } = dbFor(c.env);
    const row = await db.query.products.findFirst({
      ...productDetailConfig,
      where: eq(products.slug, slug),
    });

    if (!row) throw notFoundError('product', { slug });

    // Baseline `related_products`: latest 6 products sharing ≥1 category,
    // excluding self. Reuse `buildProductsWhere` for the category clause.
    const categoryIds = row.productCategories.map((r) => r.category.id);
    const relatedPromise: Promise<RawProductListRow[]> =
      categoryIds.length === 0
        ? Promise.resolve([])
        : db.query.products.findMany({
            ...productListConfig,
            where: and(
              ne(products.id, row.id),
              buildProductsWhere(db, { category_id: categoryIds }),
            ),
            orderBy: [desc(products.createdAt)],
            limit: 6,
          });

    const [relatedProducts, reviewRows] = await Promise.all([
      relatedPromise,
      // First page of approved reviews, newest-first; `id` tiebreaks ties.
      db.query.reviews.findMany({
        columns: publicReviewColumns,
        where: and(eq(reviews.productId, row.id), eq(reviews.status, 'approved')),
        orderBy: [desc(reviews.createdAt), asc(reviews.id)],
        limit: EMBED_REVIEWS_PAGE_SIZE,
      }),
    ]);

    const body: ProductDetail = toProductDetail(row, relatedProducts, reviewRows);

    reportMissingVendors(c, [body, ...body.related_products]);

    validateResponseInDev(c.env, () => {
      ProductDetailSchema.parse(body);
    });

    return json(body);
  };
}
