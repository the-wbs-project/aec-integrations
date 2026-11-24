import { z } from 'zod';

import { LinkRefSchema } from './common';
import { ProductListItemSchema } from './products';

/**
 * A taxonomy term (category / audience / phase / trade) with the counts of
 * products tagged with it and integrations reachable through those products.
 * Used by `GET /api/categories` (and the audiences / phases / trades
 * equivalents inside `TaxonomyResponse`).
 *
 * **`integration_count` is optional, deliberately.** The `*_counts` keys in
 * `stats_cache` store arrays of this shape (see `TaxonomyCountsSchema` in
 * `./stats.ts`) and are validated on **read** against this same schema, so a
 * required field would make every row written before this shipped fail
 * validation until the compute cron next rewrote it. Optional means the old
 * rows keep parsing and simply carry no integration count. Read it through
 * `taxonomyIntegrationCount()` (in `./taxonomy-count`) rather than `?? 0` at each call site.
 */
export const TaxonomyTermWithCountSchema = LinkRefSchema.extend({
  description: z.string().nullable(),
  display_order: z.number().int(),
  product_count: z.number().int().min(0),
  integration_count: z.number().int().min(0).optional(),
});

export type TaxonomyTermWithCount = z.infer<typeof TaxonomyTermWithCountSchema>;

/**
 * Full taxonomy fetch returned by `GET /api/taxonomy` — the lookup the SSR
 * Worker uses to render nav, footer, and the `/categories` flat list. All
 * four lists hydrate as `TaxonomyTermWithCount[]` so callers don't need a
 * second roundtrip to count products.
 *
 * `trades` is the fourth facet (STAGE_1_SPEC.md §5.5a / AECI-541) and is **not
 * publication-gated here**: every term ships with its `product_count`,
 * including terms below the `TRADE_PUBLISH_MIN_PRODUCTS` floor (in `./trade-publish`).
 * Each surface applies the floor itself (`TRADES_VOCABULARY.md` §6) so the gate
 * is tunable without an API deploy.
 *
 * `total_products` (AECI-1773) is the count behind the Browse menu's "All
 * products" line. It uses the same visibility rule as `home.total_products`
 * (`computeTotalProducts`), so a hidden listing counts nowhere public.
 */
export const TaxonomyResponseSchema = z.object({
  categories: z.array(TaxonomyTermWithCountSchema),
  audiences: z.array(TaxonomyTermWithCountSchema),
  phases: z.array(TaxonomyTermWithCountSchema),
  trades: z.array(TaxonomyTermWithCountSchema),
  total_products: z.number().int().min(0),
});

export type TaxonomyResponse = z.infer<typeof TaxonomyResponseSchema>;

/** The four term-list keys of {@link TaxonomyResponse}, excluding the `total_products` scalar. */
export type TaxonomyFacetKey = 'categories' | 'audiences' | 'phases' | 'trades';

/**
 * Response for the flat taxonomy list endpoints — `GET /api/categories`,
 * `GET /api/audiences`, `GET /api/phases`, and `GET /api/trades` — all
 * generalised through `createTaxonomyListHandler`. The four share this shape.
 * Not paginated — the taxonomy is small (≈30 terms per facet) by design.
 */
export const CategoriesListResponseSchema = z.object({
  data: z.array(TaxonomyTermWithCountSchema),
});

export type CategoriesListResponse = z.infer<typeof CategoriesListResponseSchema>;

/**
 * Detail responses for `GET /api/categories/:slug`, `/audiences/:slug`,
 * `/phases/:slug`, `/trades/:slug`. Embed the products that carry the term as
 * `ProductListItem[]` per Phase 2 Spec §7.2. Four distinct schemas (not
 * aliases) so future divergence — e.g. audience-specific fields — is cheap.
 */
const taxonomyDetailShape = TaxonomyTermWithCountSchema.extend({
  products: z.array(ProductListItemSchema),
});

export const CategoryDetailSchema = taxonomyDetailShape;
export type CategoryDetail = z.infer<typeof CategoryDetailSchema>;

export const AudienceDetailSchema = taxonomyDetailShape;
export type AudienceDetail = z.infer<typeof AudienceDetailSchema>;

export const PhaseDetailSchema = taxonomyDetailShape;
export type PhaseDetail = z.infer<typeof PhaseDetailSchema>;

/** `GET /api/trades/:slug` (AECI-541). Ungated like the list endpoint: a
 *  sub-floor term still resolves — the consumer decides whether to index it. */
export const TradeDetailSchema = taxonomyDetailShape;
export type TradeDetail = z.infer<typeof TradeDetailSchema>;
