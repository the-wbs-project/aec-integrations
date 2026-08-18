/**
 * Phase 3.10 (AECI-143) scoped facet-count endpoint — Drizzle/D1 (ADR 0016 /
 * AECI-253).
 *
 *   GET /api/products/facets — per taxonomy dimension, the count of products per
 *   term under the *other* active filters (disjunctive faceting).
 *
 * For each dimension the scoped count joins the dimension's link table to
 * `products`, applies `buildProductsWhere(query, dim)` (every active filter EXCEPT
 * that dimension's own clause), and groups by term. Terms are listed in editorial
 * order to match the flat list endpoints; a term with no matching product counts 0.
 *
 * `trades` (§5.5a / AECI-541) is the fourth dimension and behaves identically —
 * including the zero-count listing, which is the common case there: the facet is
 * sparse by design (`TRADES_VOCABULARY.md` §1.1). No publication gate is applied
 * here; the sidebar decides what to render.
 */

import {
  ProductFacetsQuerySchema,
  ProductFacetsResponseSchema,
  type ProductFacetsResponse,
} from '@aeci/shared';
import { asc, count, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import {
  productAudiences,
  productCategories,
  productPhases,
  products,
  productTrades,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
} from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import { buildProductsWhere, toTaxonomyTermWithCount } from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

type TermRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  displayOrder: number | null;
};

function withCounts(terms: TermRow[], counts: Array<{ termId: string; value: number }>) {
  const byTerm = new Map(counts.map((r) => [r.termId, r.value]));
  return terms.map((t) => toTaxonomyTermWithCount({ ...t, productCount: byTerm.get(t.id) ?? 0 }));
}

export function createProductFacetsHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = ProductFacetsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);

    const [
      catTerms,
      catCounts,
      audTerms,
      audCounts,
      phaseTerms,
      phaseCounts,
      tradeTerms,
      tradeCounts,
    ] = await Promise.all([
      db
        .select({
          id: taxonomyCategories.id,
          slug: taxonomyCategories.slug,
          name: taxonomyCategories.name,
          description: taxonomyCategories.description,
          displayOrder: taxonomyCategories.displayOrder,
        })
        .from(taxonomyCategories)
        .orderBy(asc(taxonomyCategories.displayOrder), asc(taxonomyCategories.name)),
      db
        .select({ termId: productCategories.categoryId, value: count() })
        .from(productCategories)
        .innerJoin(products, eq(products.id, productCategories.productId))
        .where(buildProductsWhere(db, query, 'category'))
        .groupBy(productCategories.categoryId),
      db
        .select({
          id: taxonomyAudiences.id,
          slug: taxonomyAudiences.slug,
          name: taxonomyAudiences.name,
          description: taxonomyAudiences.description,
          displayOrder: taxonomyAudiences.displayOrder,
        })
        .from(taxonomyAudiences)
        .orderBy(asc(taxonomyAudiences.displayOrder), asc(taxonomyAudiences.name)),
      db
        .select({ termId: productAudiences.audienceId, value: count() })
        .from(productAudiences)
        .innerJoin(products, eq(products.id, productAudiences.productId))
        .where(buildProductsWhere(db, query, 'audience'))
        .groupBy(productAudiences.audienceId),
      db
        .select({
          id: taxonomyPhases.id,
          slug: taxonomyPhases.slug,
          name: taxonomyPhases.name,
          description: taxonomyPhases.description,
          displayOrder: taxonomyPhases.displayOrder,
        })
        .from(taxonomyPhases)
        .orderBy(asc(taxonomyPhases.displayOrder), asc(taxonomyPhases.name)),
      db
        .select({ termId: productPhases.phaseId, value: count() })
        .from(productPhases)
        .innerJoin(products, eq(products.id, productPhases.productId))
        .where(buildProductsWhere(db, query, 'phase'))
        .groupBy(productPhases.phaseId),
      db
        .select({
          id: taxonomyTrades.id,
          slug: taxonomyTrades.slug,
          name: taxonomyTrades.name,
          description: taxonomyTrades.description,
          displayOrder: taxonomyTrades.displayOrder,
        })
        .from(taxonomyTrades)
        .orderBy(asc(taxonomyTrades.displayOrder), asc(taxonomyTrades.name)),
      db
        .select({ termId: productTrades.tradeId, value: count() })
        .from(productTrades)
        .innerJoin(products, eq(products.id, productTrades.productId))
        .where(buildProductsWhere(db, query, 'trade'))
        .groupBy(productTrades.tradeId),
    ]);

    const body: ProductFacetsResponse = {
      categories: withCounts(catTerms, catCounts),
      audiences: withCounts(audTerms, audCounts),
      phases: withCounts(phaseTerms, phaseCounts),
      trades: withCounts(tradeTerms, tradeCounts),
    };

    validateResponseInDev(c.env, () => {
      ProductFacetsResponseSchema.parse(body);
    });

    return json(body);
  };
}
