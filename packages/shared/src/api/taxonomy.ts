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
 * Minimum promoted products a trade needs before it is **published** —
 * `TRADES_VOCABULARY.md` §6, launch-tunable. Trades are the only facet with a
 * publication floor: the vocabulary is a closed 34-term list seeded up front,
 * so most terms start empty and a thin `/trades/:slug` page would be SEO junk.
 *
 * The API deliberately does not apply it (see `TaxonomyResponseSchema` below);
 * it lives here so every consumer that *can* apply it uses one value. Consumers
 * today: the `/trades` index grid and the primary-nav flyout (AECI-544); the XML
 * sitemap, each term page's `noindex` decision, and the IndexNow / Google
 * Indexing submit set (AECI-546).
 *
 * Not applied by the facet sidebar, which sees **scoped** disjunctive counts —
 * a published trade's count legitimately falls below the floor under an active
 * filter, so gating there would hide published terms. Not applied to
 * product-detail trade chips either: the tag is true even when the page isn't
 * promoted. Both carve-outs are recorded in `TRADES_VOCABULARY.md` §6.
 */
export const TRADE_PUBLISH_MIN_PRODUCTS = 3;

/**
 * Whether a trade term clears the publication floor. Takes the count alone so
 * callers can pass a term, a facet entry, or a raw number.
 */
export function isPublishedTrade(term: { product_count: number }): boolean {
  return term.product_count >= TRADE_PUBLISH_MIN_PRODUCTS;
}

/**
 * Full taxonomy fetch returned by `GET /api/taxonomy` — the lookup the SSR
 * Worker uses to render nav, footer, and the `/categories` flat list. All
 * four lists hydrate as `TaxonomyTermWithCount[]` so callers don't need a
 * second roundtrip to count products.
 *
 * `trades` is the fourth facet (STAGE_1_SPEC.md §5.5a / AECI-541) and is **not
 * publication-gated here**: every term ships with its `product_count`,
 * including terms below the `TRADE_PUBLISH_MIN_PRODUCTS` floor exported above.
 * Each surface applies the floor itself (`TRADES_VOCABULARY.md` §6) so the gate
 * is tunable without an API deploy.
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
