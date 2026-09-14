/**
 * Absolute public URLs for catalogue entities (AECI-944 / AECI-945).
 *
 * ─── Why this module exists ───────────────────────────────────────────────────
 *
 * Before AECI-944 there were four private implementations of "what is the public
 * URL of this thing" in the API Worker and none of them was exported:
 *
 *   - `affectedUrlsForPromote` (`routes/promote-indexnow-urls.ts`) — promote-only,
 *     built over a `PromoteResponse`.
 *   - `siteUrl` / `productUrl` / `pairUrl` / `portalUrl` (`lib/email.ts`) —
 *     module-private, for email links.
 *   - `sortedPairSlugs` / `pairCacheTag` (`routes/promote-pair.ts`) — the
 *     alphabetical primitive, exported but only half the job.
 *   - `orderedPairSlugs` (`@aeci/shared`) — byte-identical to `sortedPairSlugs`,
 *     different home.
 *
 * Adding the vendor-portal writes as a second source of re-crawl URLs would have
 * made it five. This is the one place the shapes are written down.
 *
 * **Scope note.** `affectedUrlsForPromote` and the `email.ts` helpers are
 * deliberately NOT refactored onto this module in AECI-944.
 * `promote-indexnow-urls.spec.ts` pins that function's purity over its arguments,
 * and churning a spec that guards a live discovery path to save four lines is a
 * bad trade. New callers use this; the two incumbents can migrate when something
 * else is already touching them.
 *
 * ─── The trailing-slash rule ──────────────────────────────────────────────────
 *
 * `PUBLIC_SITE_URL` is an operator-set wrangler var, so it may or may not carry a
 * trailing slash, and the two existing implementations disagreed on how to strip
 * it (`/\/+$/` versus `/\/$/`). {@link publicSiteBase} uses the greedy form, so
 * `https://www.aecintegrations.com///` normalises correctly rather than leaving
 * a `//products/x` URL that is a different cache key and a different Search
 * Console entry from the one we meant.
 */

import { sortedPairSlugs } from '../routes/promote-pair';

import type { Env } from '../env';

/**
 * The site origin with any trailing slashes removed, or `null` when
 * `PUBLIC_SITE_URL` is unset or unparseable.
 *
 * Returning `null` rather than throwing is what lets every caller be a fail-open
 * post-commit hook: an environment with no public URL simply produces no URLs,
 * which is the correct behaviour on preview and in the in-memory test harness.
 *
 * The `new URL()` parse is not decoration. An unparseable value means every URL
 * built from it is malformed, and catching that at the producer keeps junk out of
 * the two queue tables rather than making a consumer discard it later.
 */
export function publicSiteBase(env: Pick<Env, 'PUBLIC_SITE_URL'>): string | null {
  const raw = env.PUBLIC_SITE_URL;
  if (!raw) return null;
  const base = raw.replace(/\/+$/, '');
  try {
    new URL(base);
  } catch {
    return null;
  }
  return base;
}

/** `/products/{slug}` — a product detail page. */
export function productUrl(base: string, slug: string): string {
  return `${base}/products/${slug}`;
}

/** `/vendors/{slug}` — a vendor detail page. Note there is no `/vendors` index
 *  to pair with it: that path 301-redirects to `/products` (AECI-165). */
export function vendorUrl(base: string, slug: string): string {
  return `${base}/vendors/${slug}`;
}

/**
 * `/products/{context}/integrations/{other}` — an integration-PAIR page.
 *
 * `context` is the alphabetically-first of the two slugs. The other orientation
 * 301-redirects to it, so emitting the unsorted form would queue a URL that
 * redirects — wasted on IndexNow and actively harmful in Search Console, which
 * reports a redirect as "not indexed" and spends the quota anyway.
 *
 * There is deliberately no `/integrations/{id}` form: that route has 301'd to the
 * pair page since AECI-298.
 */
export function pairUrl(base: string, slugA: string, slugB: string): string {
  const [context, other] = sortedPairSlugs(slugA, slugB);
  return `${base}/products/${context}/integrations/${other}`;
}

/** `/trades/{slug}` — a trade browse page. Publication-gated: only emit this for
 *  a term that clears `TRADE_PUBLISH_MIN_PRODUCTS`, or you are advertising a page
 *  that serves `noindex` (§5.5a). `resolvePublishedTradeSlugs` is the gate. */
export function tradeUrl(base: string, slug: string): string {
  return `${base}/trades/${slug}`;
}

/** `/categories/{slug}`, `/audiences/{slug}`, `/phases/{slug}` — the three
 *  ungated facet browse pages. */
export function facetUrl(
  base: string,
  facet: 'categories' | 'audiences' | 'phases',
  slug: string,
): string {
  return `${base}/${facet}/${slug}`;
}

/** `/products` — the catalogue index. Worth pinging IndexNow for, never worth a
 *  Google Request Indexing slot (see `promote-gsc-recrawl-entries.ts`). */
export function productsIndexUrl(base: string): string {
  return `${base}/products`;
}

/** `/trades` — the trade index. Same asymmetry as {@link productsIndexUrl}. */
export function tradesIndexUrl(base: string): string {
  return `${base}/trades`;
}
