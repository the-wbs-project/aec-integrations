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
  productDetailSelect,
  productListSelect,
  toProductDetail,
  toProductListItem,
  type RawProductDetailRow,
  type RawProductListRow,
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
      }) as unknown as Promise<RawProductListRow[]>,
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
    const row = (await prisma.product.findUnique({
      where: { slug },
      select: productDetailSelect,
    })) as unknown as RawProductDetailRow | null;

    if (!row) throw notFoundError('product', { slug });

    // Baseline `related_products`: latest 6 products that share at least one
    // category with this product, excluding the product itself. Refining the
    // algorithm (cosine on categories+disciplines, popularity weighting) is
    // out of scope for AECI-54 — kept simple so the hydration contract is
    // satisfied without an external ML hop.
    const categoryIds = row.productCategories.map((r) => r.category.id);
    const relatedProducts = (categoryIds.length === 0
      ? []
      : await prisma.product.findMany({
          where: {
            id: { not: row.id },
            productCategories: { some: { categoryId: { in: categoryIds } } },
          },
          orderBy: { createdAt: 'desc' },
          take: 6,
          select: productListSelect,
        })) as unknown as RawProductListRow[];

    const body: ProductDetail = toProductDetail(row, relatedProducts);

    reportMissingVendors(c, [body, ...body.related_products]);

    validateResponseInDev(c.env, () => {
      ProductDetailSchema.parse(body);
    });

    return json(body);
  };
}

type ProductsWhere = {
  productRole?: string;
  hasApiDocs?: boolean;
  name?: { contains: string; mode: 'insensitive' };
  productCategories?: { some: { categoryId: string } };
  productDisciplines?: { some: { disciplineId: string } };
  productPhases?: { some: { phaseId: string } };
  productVendors?: { some: { vendorId: string } };
};

function buildProductsWhere(query: {
  search?: string;
  category_id?: string;
  discipline_id?: string;
  phase_id?: string;
  vendor_id?: string;
  product_role?: string;
  has_api_docs?: boolean;
}): ProductsWhere {
  const where: ProductsWhere = {};
  if (query.search) where.name = { contains: query.search, mode: 'insensitive' };
  if (query.category_id) where.productCategories = { some: { categoryId: query.category_id } };
  if (query.discipline_id) {
    where.productDisciplines = { some: { disciplineId: query.discipline_id } };
  }
  if (query.phase_id) where.productPhases = { some: { phaseId: query.phase_id } };
  if (query.vendor_id) where.productVendors = { some: { vendorId: query.vendor_id } };
  if (query.product_role) where.productRole = query.product_role;
  if (query.has_api_docs !== undefined) where.hasApiDocs = query.has_api_docs;
  return where;
}
