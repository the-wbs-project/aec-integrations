/**
 * Phase 2.8 taxonomy list endpoints — the flat, per-facet lists with product
 * counts. Generalized across the three facets for AECI-157:
 *
 *   GET /api/categories | /api/audiences | /api/phases
 *
 * All three return the same `{ data: TaxonomyTermWithCount[] }` shape
 * (`CategoriesListResponseSchema`, whose doc already anticipates the
 * audiences / phases reuse). Not paginated; the taxonomy is small by design
 * (Phase 2 Spec §3.1). The per-slug detail endpoints go through
 * `createTaxonomyDetailHandler` (`routes/taxonomy-detail.ts`); the aggregate
 * `{ categories, audiences, phases }` tree is `createTaxonomyHandler`
 * (`routes/taxonomy.ts`).
 *
 * One explicit `findMany` per facet keyed by `kind` (mirroring the aggregate
 * handler's three queries) keeps Prisma's per-model `select` narrowing intact —
 * no loose-delegate cast on the list path. AECI-54 originally shipped the
 * categories list here as `createCategoriesListHandler`.
 */

import { CategoriesListResponseSchema, type CategoriesListResponse } from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import {
  categoryTermSelect,
  audienceTermSelect,
  phaseTermSelect,
  toTaxonomyTermWithCount,
  type RawTaxonomyTermRow,
  type TaxonomyCountKey,
} from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';

/** The three facet list endpoints, keyed by URL path segment. */
export type TaxonomyListKind = 'categories' | 'audiences' | 'phases';

export function createTaxonomyListHandler(
  kind: TaxonomyListKind,
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const prisma = prismaFor(c.env);

    let rows: RawTaxonomyTermRow[];
    let countKey: TaxonomyCountKey;
    switch (kind) {
      case 'categories':
        rows = await prisma.taxonomyCategory.findMany({
          select: categoryTermSelect,
          orderBy: [{ displayOrder: 'asc' as const }, { name: 'asc' as const }],
        });
        countKey = 'productCategories';
        break;
      case 'audiences':
        rows = await prisma.taxonomyAudience.findMany({
          select: audienceTermSelect,
          orderBy: [{ displayOrder: 'asc' as const }, { name: 'asc' as const }],
        });
        countKey = 'productAudiences';
        break;
      case 'phases':
        rows = await prisma.taxonomyPhase.findMany({
          select: phaseTermSelect,
          orderBy: [{ displayOrder: 'asc' as const }, { name: 'asc' as const }],
        });
        countKey = 'productPhases';
        break;
    }

    const body: CategoriesListResponse = {
      data: rows.map((row) => toTaxonomyTermWithCount(row, countKey)),
    };

    validateResponseInDev(c.env, () => {
      CategoriesListResponseSchema.parse(body);
    });

    return json(body);
  };
}
