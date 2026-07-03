import { z } from 'zod';

import { LinkRefSchema, ProductLinkSchema } from './common';
import { IntegrationListItemSchema } from './integrations';
import { ProductListItemSchema } from './products';
import { TaxonomyTermWithCountSchema } from './taxonomy';

/**
 * Home-stats contract (docs/API_CONTRACTS.md §6.5, fed by the daily stats
 * pipeline in docs/STAGE_1_SPEC.md §10 and the `stats_cache` table in
 * docs/DATABASE_SCHEMA.md §9.2). Types + schemas only — the compute job (4.3),
 * the `GET /api/stats/home` endpoint (4.4), and the home UI (4.8 / 4.10) all
 * build against this one source of truth.
 *
 * The §6.5 contract names `ProductRef`, `TaxonomyRef`, `Integration`, and
 * `Product`. None of those are new shapes — they map onto the existing
 * hydration types so we never carry parallel duplicates (AECI-176):
 *   - `ProductRef`  → `ProductLink`        (id + name + slug + logo_url)
 *   - `TaxonomyRef` → `LinkRef`            (id + name + slug)
 *   - `Integration` → `IntegrationListItem`
 *   - `Product`     → `ProductListItem`
 */

/**
 * `ProductRef` from §6.5 — bound to `ProductLink`. The `most_integrated_product`
 * card renders a product name/logo linking to its page, which is exactly the
 * `ProductLink` hydration shape (common.ts).
 */
export const ProductRefSchema = ProductLinkSchema;
export type ProductRef = z.infer<typeof ProductRefSchema>;

/**
 * `TaxonomyRef` from §6.5 — bound to `LinkRef`. The `most_active_category` card
 * only needs id + name + slug to render a labelled link to the category page;
 * its count lives in the sibling `integration_count`, not on the ref.
 */
export const TaxonomyRefSchema = LinkRefSchema;
export type TaxonomyRef = z.infer<typeof TaxonomyRefSchema>;

/**
 * `home.most_integrated_product` value (§10) and the matching §6.5 response
 * field — the single most-integrated product plus its integration count.
 */
export const MostIntegratedProductSchema = z.object({
  product: ProductRefSchema,
  integration_count: z.number().int().min(0),
});
export type MostIntegratedProduct = z.infer<typeof MostIntegratedProductSchema>;

/**
 * `home.most_active_category` value (§10) and the matching §6.5 response field —
 * the category with the highest aggregate integration count.
 */
export const MostActiveCategorySchema = z.object({
  category: TaxonomyRefSchema,
  integration_count: z.number().int().min(0),
});
export type MostActiveCategory = z.infer<typeof MostActiveCategorySchema>;

/**
 * Shared value shape for the `category_counts` / `audience_counts` /
 * `phase_counts` keys (§10: "product count per category / audience / phase").
 * Each entry is the same per-term shape `GET /api/taxonomy` already returns —
 * `TaxonomyTermWithCount` carries `product_count`, so the home "Browse by …"
 * grids render straight from the cache without a second lookup. These three
 * keys are not part of `HomeStatsResponse`; they are modelled here because
 * §9.2 / §10 enumerate them as `stats_cache` keys (see `statsCacheValueSchemas`).
 */
export const TaxonomyCountsSchema = z.array(TaxonomyTermWithCountSchema);
export type TaxonomyCounts = z.infer<typeof TaxonomyCountsSchema>;

/**
 * The enumerated `stats_cache` keys (docs/DATABASE_SCHEMA.md §9.2). Drives the
 * runtime-validated `StatsCacheKey` and the completeness guard on
 * `statsCacheValueSchemas` below.
 */
export const STATS_CACHE_KEYS = [
  'home.total_integrations',
  'home.integrations_added_30d',
  'home.total_products',
  'home.total_vendors',
  'home.total_reviews',
  'home.total_contributing_firms',
  'home.most_integrated_product',
  'home.most_active_category',
  'home.recent_integrations',
  'home.trending_products',
  'home.recently_added_products',
  'category_counts',
  'audience_counts',
  'phase_counts',
] as const;

export const StatsCacheKeySchema = z.enum(STATS_CACHE_KEYS);
export type StatsCacheKey = (typeof STATS_CACHE_KEYS)[number];

/**
 * One Zod schema per `stats_cache` key — the single source of truth for the
 * jsonb `value` each key holds. The compute job (4.3) validates what it writes
 * and the endpoint (4.4) validates what it reads against the *same* schema.
 *
 * Two judgment calls the spec leaves open (it pins the response field types in
 * §6.5 but not the internal jsonb shape):
 *   1. Scalar keys store a bare JSON number, matching the §6.5 field type
 *      exactly — no `{ value }` wrapper.
 *   2. The `*_counts` keys store `TaxonomyTermWithCount[]` (see above).
 *
 * The `.max()` caps mirror the §6.5 comments (recent ≤10, trending ≤5,
 * recently-added ≤10). `satisfies Record<StatsCacheKey, z.ZodType>` is a
 * compile-time guard that every key is present and none extra, while keeping
 * each entry's precise schema type for `z.infer`.
 */
export const statsCacheValueSchemas = {
  'home.total_integrations': z.number().int().min(0),
  'home.integrations_added_30d': z.number().int().min(0),
  'home.total_products': z.number().int().min(0),
  'home.total_vendors': z.number().int().min(0),
  'home.total_reviews': z.number().int().min(0),
  'home.total_contributing_firms': z.number().int().min(0),
  'home.most_integrated_product': MostIntegratedProductSchema,
  'home.most_active_category': MostActiveCategorySchema,
  'home.recent_integrations': z.array(IntegrationListItemSchema).max(10),
  'home.trending_products': z.array(ProductListItemSchema).max(5),
  'home.recently_added_products': z.array(ProductListItemSchema).max(10),
  category_counts: TaxonomyCountsSchema,
  audience_counts: TaxonomyCountsSchema,
  phase_counts: TaxonomyCountsSchema,
} satisfies Record<StatsCacheKey, z.ZodType>;

/**
 * `GET /api/stats/home` response (docs/API_CONTRACTS.md §6.5). Assembled from
 * the per-key schemas above so the read endpoint and the cache writers can
 * never drift. Reads from `stats_cache`; never aggregates live.
 *
 * The two single-card fields (`most_integrated_product`, `most_active_category`)
 * are `.nullable()` here even though the per-key write schemas above are not:
 * those schemas validate a *present* compute-job write (a real product/category
 * with a valid UUID), but pre-launch the cache is sparse, so the endpoint (4.4)
 * must still return a valid 200. An absent (or drifted) cache key surfaces as
 * `null` — the genuine "no data yet" empty state — and the 4.11 consumer just
 * branches on `null`. The scalar/array fields have valid empties (`0` / `[]`),
 * so only these two need to widen.
 */
export const HomeStatsResponseSchema = z.object({
  total_integrations: statsCacheValueSchemas['home.total_integrations'],
  integrations_added_30d: statsCacheValueSchemas['home.integrations_added_30d'],
  // Coverage counts for the home credibility strip (AECI-271, +AECI-284). Scalars
  // with a valid empty (`0`); the strip suppresses each metric at 0 (no "0 reviews",
  // no "0 firms"). `total_contributing_firms` is the distinct count of normalized
  // reviewer firms among approved reviews (AECI-284).
  total_products: statsCacheValueSchemas['home.total_products'],
  total_vendors: statsCacheValueSchemas['home.total_vendors'],
  total_reviews: statsCacheValueSchemas['home.total_reviews'],
  total_contributing_firms: statsCacheValueSchemas['home.total_contributing_firms'],
  most_integrated_product: statsCacheValueSchemas['home.most_integrated_product'].nullable(),
  most_active_category: statsCacheValueSchemas['home.most_active_category'].nullable(),
  recent_integrations: statsCacheValueSchemas['home.recent_integrations'],
  trending_products: statsCacheValueSchemas['home.trending_products'],
  recently_added_products: statsCacheValueSchemas['home.recently_added_products'],
});
export type HomeStatsResponse = z.infer<typeof HomeStatsResponseSchema>;
