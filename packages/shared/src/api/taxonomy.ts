import { z } from 'zod';

import { LinkRefSchema } from './common';
import { ProductListItemSchema } from './products';

/**
 * A taxonomy term (category / audience / phase / trade) with the count of
 * products tagged with it. Used by `GET /api/categories` (and the audiences /
 * phases / trades equivalents inside `TaxonomyResponse`).
 */
export const TaxonomyTermWithCountSchema = LinkRefSchema.extend({
  description: z.string().nullable(),
  display_order: z.number().int(),
  product_count: z.number().int().min(0),
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
 * including terms below the `TRADE_PUBLISH_MIN_PRODUCTS = 3` floor. Each
 * surface applies the floor itself (`TRADES_VOCABULARY.md` §6) so the gate is
 * tunable without an API deploy.
 */
export const TaxonomyResponseSchema = z.object({
  categories: z.array(TaxonomyTermWithCountSchema),
  audiences: z.array(TaxonomyTermWithCountSchema),
  phases: z.array(TaxonomyTermWithCountSchema),
  trades: z.array(TaxonomyTermWithCountSchema),
});

export type TaxonomyResponse = z.infer<typeof TaxonomyResponseSchema>;

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
