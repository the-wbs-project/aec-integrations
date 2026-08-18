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
 * publication floor, because the vocabulary is a closed 34-term list seeded up
 * front rather than grown from the catalog: without a floor, every term that
 * nobody has tagged yet would still ship an empty `/trades/:slug` page.
 *
 * At **1** the floor still does that job — it withholds the terms carrying no
 * promoted product at all, which after the AECI-547 backfill is 27 of the 34 —
 * but a term is published the moment any product genuinely carries it. That
 * deliberately admits single-product pages: a page with one honestly-tagged
 * product answers "what understands MY work" for that trade, which is the §1.1
 * test, and it is a truthful page rather than a thin one. Lowered from 3 on
 * 2026-08-14 once the backfill showed the real tagging distribution.
 *
 * The API deliberately does not apply it (see `TaxonomyResponseSchema` below);
 * it lives here so every consumer that *can* apply it uses one value. Consumers
 * today: the `/trades` index grid and the primary-nav flyout (AECI-544); the XML
 * sitemap, each term page's `noindex` decision, and the IndexNow / Google
 * Indexing submit set (AECI-546).
 *
 * Not applied by the facet sidebar, whose rule is its own — show a term when its
 * **scoped** disjunctive count is `> 0`, or when it is currently refined. That
 * rule is floor-independent by design: a scoped count is not a global one, so
 * gating it on an unscoped floor would hide published terms under an active
 * filter. Not applied to product-detail trade chips either: the tag is true even
 * when the page isn't promoted. Both carve-outs are recorded in
 * `TRADES_VOCABULARY.md` §6.
 */
export const TRADE_PUBLISH_MIN_PRODUCTS = 1;

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
