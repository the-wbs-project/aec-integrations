/**
 * Phase 3.10 (AECI-143) scoped facet-count endpoint.
 *
 *   GET /api/products/facets — for each taxonomy dimension (category / audience
 *   / phase), the count of products per term under the *other* active filters.
 *
 * This is the server-side aggregation that backs the API-backed filter sidebar
 * on `/products` and the taxonomy browse pages (issue Decision 1: API-backed,
 * NOT Algolia — these pages stay edge-cacheable and Algolia/InstantSearch stays
 * scoped to `/search`). The *page* is edge-cached; this internal call is
 * request-scoped and never cached (`Cache-Control: private, no-store` via
 * `json()`), same as the list/detail siblings.
 *
 * Contracts:
 *   - Query: `ProductFacetsQuerySchema` from `@aeci/shared` — the same filter
 *     params as `GET /api/products` minus page/perPage/sort.
 *   - Response: `ProductFacetsResponseSchema` = `{ categories, audiences,
 *     phases }`, each `TaxonomyTermWithCount[]` where `product_count` is the
 *     **scoped** count.
 *
 * Disjunctive faceting: each dimension's counts are computed with every active
 * filter applied EXCEPT that dimension's own clause (`buildProductsWhere(query,
 * dim)`), so the count reflects "products that would match if you also picked
 * this term" rather than collapsing onto the already-selected term. The locked
 * `{kind}_id` a browse page sends rides the same `category_id` / `audience_id` /
 * `phase_id` params — it applies to the *other* dimensions' counts (correct)
 * and is excluded from its own (irrelevant; the sidebar hides the locked group).
 *
 * One filtered-relation `_count` query per dimension (3 total), batched with
 * `Promise.all`. The term list + order match the flat taxonomy list endpoints
 * (`routes/taxonomy-list.ts`) so the sidebar renders terms in editorial order.
 */

import {
  ProductFacetsQuerySchema,
  ProductFacetsResponseSchema,
  type ProductFacetsResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import { buildProductsWhere, toTaxonomyTermWithCount } from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';

export function createProductFacetsHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = ProductFacetsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const prisma = prismaFor(c.env);
    const order = [{ displayOrder: 'asc' as const }, { name: 'asc' as const }];

    const [categoryRows, audienceRows, phaseRows] = await Promise.all([
      prisma.taxonomyCategory.findMany({
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          displayOrder: true,
          _count: {
            select: {
              productCategories: { where: { product: buildProductsWhere(query, 'category') } },
            },
          },
        },
        orderBy: order,
      }),
      prisma.taxonomyAudience.findMany({
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          displayOrder: true,
          _count: {
            select: {
              productAudiences: { where: { product: buildProductsWhere(query, 'audience') } },
            },
          },
        },
        orderBy: order,
      }),
      prisma.taxonomyPhase.findMany({
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          displayOrder: true,
          _count: {
            select: { productPhases: { where: { product: buildProductsWhere(query, 'phase') } } },
          },
        },
        orderBy: order,
      }),
    ]);

    const body: ProductFacetsResponse = {
      categories: categoryRows.map((row) => toTaxonomyTermWithCount(row, 'productCategories')),
      audiences: audienceRows.map((row) => toTaxonomyTermWithCount(row, 'productAudiences')),
      phases: phaseRows.map((row) => toTaxonomyTermWithCount(row, 'productPhases')),
    };

    validateResponseInDev(c.env, () => {
      ProductFacetsResponseSchema.parse(body);
    });

    return json(body);
  };
}
