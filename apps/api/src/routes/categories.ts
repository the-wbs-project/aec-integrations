/**
 * Phase 2.8 (AECI-54) categories list endpoint.
 *
 *   GET /api/categories   — flat list with per-term product counts. Not
 *                           paginated; the taxonomy is small by design
 *                           (Phase 2 Spec §3.1).
 *
 * The detail endpoint (`GET /api/categories/:slug`) is served by the shared
 * `createTaxonomyDetailHandler` factory (`routes/taxonomy-detail.ts`, AECI-120).
 */

import { CategoriesListResponseSchema, type CategoriesListResponse } from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import {
  taxonomyDetailScalarSelect,
  toTaxonomyTermWithCount,
  type RawTaxonomyTermRow,
} from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';

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
