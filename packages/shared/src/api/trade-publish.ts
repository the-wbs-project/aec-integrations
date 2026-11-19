/**
 * The trade publication floor (AECI-546), with no Zod import (AECI-1720).
 *
 * `taxonomy.ts` declares Zod schemas at the top level, and since zod 4.6
 * (AECI-1932) a bundler can no longer drop them, so the eager Browse menu's
 * `isPublishedTrade` pulled the whole of zod into the initial bundle.
 * `taxonomy.ts` re-exports both names, so every existing import keeps working.
 */

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
