/**
 * Canonical product-pair identity for the Stage 1.5 pair page (AECI-297).
 *
 * A pair page consolidates every integration between two products under a single
 * URL. Both the edge-cache tag (`promote-cache-tags.ts`) and the IndexNow/Google
 * URL (`promote-indexnow-urls.ts`) that a promote derives for a pair MUST agree on
 * one ordering, and it must match the *context* the pair page itself picks — the
 * **alphabetically-first product slug** (`STAGE_1_5_SPEC.md` §7.1, ADR 0018). This
 * module is that single alphabetical primitive so the two derivers can never drift.
 *
 * The routing helper `defaultIntegrationContext` (`packages/shared`, AECI-294) is
 * the SSR/301 consumer of the same rule; it can be layered on top of
 * `sortedPairSlugs` when it lands. Kept in `apps/api` for now because the promote
 * derivers already mirror the SSR cache-tag vocabulary by documentation, not by
 * shared code (see `promote-cache-tags.ts`).
 */

/**
 * Returns the two product slugs in canonical order — `[context, other]`, where
 * `context` is the alphabetically-first slug (the default pair-URL context) and
 * `other` is the second endpoint. Pure and deterministic.
 */
export function sortedPairSlugs(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * The edge-cache tag for a product pair — `pair:{min}__{max}` (`CACHE_STRATEGY.md`
 * §2). A promote touching either product (or its claims) purges this tag; the pair
 * page (AECI-294) emits the identical tag so the two stay in lockstep.
 */
export function pairCacheTag(a: string, b: string): string {
  const [min, max] = sortedPairSlugs(a, b);
  return `pair:${min}__${max}`;
}
