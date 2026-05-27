/**
 * Phase 2.8 (AECI-54) categories endpoints.
 *
 *   GET /api/categories         — flat list with per-term product counts.
 *                                 Not paginated; the taxonomy is small by design
 *                                 (Phase 2 Spec §3.1).
 *   GET /api/categories/:slug   — single category detail with embedded products.
 */

import {
  CategoriesListResponseSchema,
  CategoryDetailSchema,
  type CategoriesListResponse,
  type CategoryDetail,
} from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  productListSelect,
  taxonomyDetailScalarSelect,
  toProductListItem,
  toTaxonomyTermWithCount,
  type RawProductListRow,
  type RawTaxonomyDetailRow,
  type RawTaxonomyTermRow,
} from '../lib/prisma-helpers';
import { getPrisma, type AcceleratedPrisma } from '../prisma';

type PrismaFactory = (env: Env) => AcceleratedPrisma;

function validateResponseInDev(env: Env, validate: () => void): void {
  if (env.ENV !== 'production') validate();
}

export function createCategoriesListHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const prisma = prismaFor(c.env);
    const rows = (await prisma.taxonomyCategory.findMany({
      select: {
        ...taxonomyDetailScalarSelect,
        _count: { select: { productCategories: true } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    })) as unknown as RawTaxonomyTermRow[];

    const body: CategoriesListResponse = {
      data: rows.map((row) => toTaxonomyTermWithCount(row, 'productCategories')),
    };

    validateResponseInDev(c.env, () => {
      CategoriesListResponseSchema.parse(body);
    });

    return json(body);
  };
}

export function createCategoryDetailHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing category slug', { field: 'slug' });
    }

    const prisma = prismaFor(c.env);
    const row = (await prisma.taxonomyCategory.findUnique({
      where: { slug },
      select: {
        ...taxonomyDetailScalarSelect,
        _count: { select: { productCategories: true } },
        productCategories: { select: { product: { select: productListSelect } } },
      },
    })) as unknown as RawTaxonomyDetailRow | null;

    if (!row) throw notFoundError('category', { slug });

    const products: RawProductListRow[] = (row.productCategories ?? []).map((r) => r.product);

    const body: CategoryDetail = {
      ...toTaxonomyTermWithCount(row, 'productCategories'),
      products: products.map(toProductListItem),
    };

    validateResponseInDev(c.env, () => {
      CategoryDetailSchema.parse(body);
    });

    return json(body);
  };
}
