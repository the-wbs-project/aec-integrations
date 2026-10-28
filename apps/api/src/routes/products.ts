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
import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { productCategories, products, reviews } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { reachablePartnerProductIdsQuery, toReachablePartnerIds } from '../lib/connector-reach';
import {
  buildProductsWhere,
  EMBED_REVIEWS_PAGE_SIZE,
  productDetailConfig,
  productListConfig,
  publicReviewColumns,
  toProductDetail,
  toProductListItem,
} from '../lib/drizzle-helpers';
import { reportMissingVendors, validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { productExtensionQueries } from '../lib/product-extensions';
import {
  attachVendorResponses,
  groupVendorResponses,
  publishedVendorResponsesQuery,
} from '../lib/review-responses';
import { resolveProductOrderBy } from '../lib/sort';
import { orderUsefulness, phaseDisplayOrdersQuery, toPhaseOrderMap } from '../lib/usefulness-order';

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

/**
 * The product's id as a scalar subquery on `products_slug` (AECI-1507). Every
 * product-detail read keys on this rather than on a fetched id, so all of them run
 * in one `db.batch`: one D1 round trip, one connection. An unknown slug makes it
 * NULL, and every keyed read then returns nothing.
 */
function productIdBySlug(db: Db, slug: string): SQL {
  return sql`${db.select({ id: products.id }).from(products).where(eq(products.slug, slug))}`;
}

/**
 * Baseline `related_products`: the latest 6 products sharing at least one
 * category with the page product, excluding itself. `id` tiebreaks equal
 * timestamps, which promote writes in bulk. A product with no category has none.
 */
function relatedProductsQuery(db: Db, productId: SQL) {
  const pageCategories = db
    .select({ id: productCategories.categoryId })
    .from(productCategories)
    .where(eq(productCategories.productId, productId));
  return db.query.products.findMany({
    ...productListConfig,
    where: and(
      ne(products.id, productId),
      inArray(
        products.id,
        db
          .select({ id: productCategories.productId })
          .from(productCategories)
          .where(inArray(productCategories.categoryId, pageCategories)),
      ),
    ),
    orderBy: [desc(products.createdAt), asc(products.id)],
    limit: 6,
  });
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
    const productId = productIdBySlug(db, slug);
    // First page of approved reviews, newest-first; `id` tiebreaks ties. The reply
    // query below reads the same page as a subquery, so the two must keep the same
    // where, order and limit.
    const approvedReviewsWhere = and(
      eq(reviews.productId, productId),
      eq(reviews.status, 'approved'),
    );
    const firstReviewPageIds = db
      .select({ id: reviews.id })
      .from(reviews)
      .where(approvedReviewsWhere)
      .orderBy(desc(reviews.createdAt), asc(reviews.id))
      .limit(EMBED_REVIEWS_PAGE_SIZE);
    const extensionQueries = productExtensionQueries(db, productId);

    // One `db.batch`, so one D1 round trip (AECI-1507). Every statement keys on
    // the slug subquery, so none waits on another's result.
    const [
      [row],
      relatedProducts,
      reviewRows,
      replyRows,
      reachRows,
      extensionHosts,
      extensions,
      phaseRows,
    ] = await db.batch([
      // `findMany` with `limit: 1`, never `findFirst`: drizzle 0.45's D1 batch maps
      // an empty `findFirst` result as `[undefined]` and throws, so an unknown slug
      // would 500 instead of 404 (`test/d1.ts` mirrors the crash).
      db.query.products.findMany({
        ...productDetailConfig,
        where: eq(products.slug, slug),
        limit: 1,
      }),
      relatedProductsQuery(db, productId),
      db.query.reviews.findMany({
        columns: publicReviewColumns,
        where: approvedReviewsWhere,
        orderBy: [desc(reviews.createdAt), asc(reviews.id)],
        limit: EMBED_REVIEWS_PAGE_SIZE,
      }),
      // Published vendor replies for that page, through the one §11c.11 predicate
      // the reviews list also uses (§11c.14, AECI-1178).
      publishedVendorResponsesQuery(db, firstReviewPageIds),
      // §13.7's reach count (AECI-892). Its own statement rather than an entry in
      // `productDetailConfig`, because the relational `with:` hydrates ROWS and
      // this needs an aggregate.
      reachablePartnerProductIdsQuery(db, productId),
      // §13.3b (AECI-710): hosts this product is built within, and the products
      // built within it. Not integrations; see `lib/product-extensions.ts`.
      extensionQueries.hosts,
      extensionQueries.extensions,
      // "How teams use it" phase groups sort by the vocabulary's lifecycle
      // order, which the stored block does not carry (`lib/usefulness-order.ts`).
      phaseDisplayOrdersQuery(db),
    ]);

    if (!row) throw notFoundError('product', { slug });

    const detail = toProductDetail(
      row,
      relatedProducts,
      attachVendorResponses(reviewRows, groupVendorResponses(replyRows)),
      toReachablePartnerIds(reachRows),
      { hosts: extensionHosts, extensions },
    );
    const body: ProductDetail = {
      ...detail,
      usefulness: orderUsefulness(detail.usefulness, toPhaseOrderMap(phaseRows)),
    };

    reportMissingVendors(c, [
      body,
      ...body.related_products,
      ...body.extension_of,
      ...body.extensions,
    ]);

    validateResponseInDev(c.env, () => {
      ProductDetailSchema.parse(body);
    });

    return json(body);
  };
}
