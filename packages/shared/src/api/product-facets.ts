import { z } from 'zod';

import { ProductsListQuerySchema } from './products';
import { TaxonomyTermWithCountSchema } from './taxonomy';

/**
 * Query for `GET /api/products/facets` (AECI-143) — the scoped facet-count
 * endpoint behind the API-backed filter sidebar on `/products` and the taxonomy
 * browse pages. It takes the **same filter params** as `GET /api/products`
 * (`ProductsListQuerySchema`) minus the pagination/sort triple (`page`,
 * `perPage`, `sort`): facet counts are independent of how the matching products
 * are paged or ordered. Derived with `.omit(...)` so the two query shapes can
 * never drift — a new product filter is picked up here automatically.
 *
 * The endpoint returns, per taxonomy dimension, the product count for each term
 * under the *other* active filters (disjunctive faceting — a dimension's own
 * filter is excluded from its own counts). See `docs/SEARCH_RANKING.md` is NOT
 * involved: this path is Prisma/Postgres, not Algolia (issue Decision 1).
 */
export const ProductFacetsQuerySchema = ProductsListQuerySchema.omit({
  page: true,
  perPage: true,
  sort: true,
});

export type ProductFacetsQuery = z.infer<typeof ProductFacetsQuerySchema>;

/**
 * Response for `GET /api/products/facets`. One `TaxonomyTermWithCount[]` per
 * dimension — the same per-term shape the flat taxonomy list endpoints return —
 * except `product_count` here is the **scoped** count (reflecting the other
 * active filters), not the global count. Terms are ordered by `display_order`
 * then name, matching the taxonomy list endpoints, so the sidebar renders them
 * in editorial order without re-sorting.
 */
export const ProductFacetsResponseSchema = z.object({
  categories: z.array(TaxonomyTermWithCountSchema),
  audiences: z.array(TaxonomyTermWithCountSchema),
  phases: z.array(TaxonomyTermWithCountSchema),
  // The fourth dimension (§5.5a / AECI-541). Ungated like the other three: every
  // trade term is listed with its scoped count, sub-floor terms included — the
  // sidebar decides what to render (`TRADES_VOCABULARY.md` §6).
  trades: z.array(TaxonomyTermWithCountSchema),
});

export type ProductFacetsResponse = z.infer<typeof ProductFacetsResponseSchema>;
