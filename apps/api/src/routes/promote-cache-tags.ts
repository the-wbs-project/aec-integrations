/**
 * Derive the edge-cache `Cache-Tag`s a promote should invalidate (AECI-105).
 *
 * `POST /api/promote` mutates cacheable product / vendor / taxonomy pages; after
 * the transaction commits, the handler enqueues these tags in a `CachePurgeMessage`
 * onto the `aeci-cache-purge-{env}` Cloudflare Queue (WC-5 / AECI-319); the SSR
 * Worker's consumer issues the native `ctx.cache.purge()`. (The old direct HTTP
 * purge-by-tag API call — Option B, no web↔api binding — was retired in WC-10 /
 * AECI-324; the zone HTTP purge is inert against native Workers Cache.) The strings
 * here MUST match the vocabulary the SSR Worker
 * emits in `apps/web/src/server/cache-tags.ts` (`buildCacheTags`) — the single
 * source of truth is `docs/CACHE_STRATEGY.md` §2. Keep the two in lockstep: a tag
 * we purge that SSR never emits is a silent no-op; a tag SSR emits that we never
 * purge is silent staleness.
 *
 * Composition rules (`docs/CACHE_STRATEGY.md` §3):
 *   - Entity tags (`product:{slug}`, `vendor:{slug}`, `category|audience|phase:
 *     {slug}`) invalidate that entity's detail / browse pages.
 *   - `index:products` invalidates the products listing page. (AECI-165 removed
 *     the `/vendors` and `/integrations` index pages, so `index:vendors` /
 *     `index:integrations` are no longer emitted or purged.)
 *   - `taxonomy` invalidates every page whose HTML renders the full taxonomy
 *     term set (home, `/categories`, `/audiences`, `/phases`, `/trades`) — for the
 *     first three facets only when the *set* of terms changed, i.e. a term was
 *     newly created. Trades are the exception; see below.
 *   - `trade:{slug}` (AECI-542) invalidates a trade browse page, and — unlike the
 *     three sibling facets — ANY touched trade also pulls in `index:trades`,
 *     `taxonomy`, and `sitemap`. The trade facet is **publication-gated**
 *     (`TRADE_PUBLISH_MIN_PRODUCTS`, `STAGE_1_SPEC.md` §5.5a): the `/trades` index,
 *     the facet sidebar, and the sitemap list *published* terms only, so a promote
 *     that pushes a term across — or back under — the floor changes those surfaces
 *     without creating or destroying any term. `CACHE_STRATEGY.md` §2 states this
 *     requirement directly. Both the trades this promote SET and the ones it
 *     REMOVED count: a removal crosses the floor downward, and the response echoes
 *     only what was set, so the handler reads the product's prior trades and passes
 *     them in as `removedTradeSlugs`.
 *   - `sitemap` invalidates `sitemap.xml` (enumerates all entities) — when a
 *     product or vendor was newly created, or any trade was touched (above).
 *   - `pair:{min}__{max}` (Stage 1.5, §6.2) invalidates the consolidated
 *     product-pair page for an integration, keyed by its two product slugs sorted
 *     alphabetically (`promote-pair.ts`). Emitted per integration result that
 *     carries `sourceSlug`/`targetSlug` (the claims ingest, AECI-297); the pair page
 *     (AECI-294) emits the identical tag, so purge and render stay in lockstep.
 *   - `product:{poweredBySlug}` (Stage 1.5 Addendum B) invalidates the *connector*
 *     product's detail page for an integration it powers. The connector is neither
 *     endpoint, so no other rule reaches it, yet its "Integrations it powers"
 *     hub view renders that edge. Emitted per integration result that carries
 *     `poweredBySlug`.
 *   - **No `route:*` tags.** §3.3 reserves the coarse `route:detail|index|browse`
 *     tags for incident bulk-invalidation and explicitly forbids them on routine
 *     writes (they would nuke every detail/index/browse page site-wide).
 *   - **No `index:home` tag.** The home page IS purged on a promote, but NOT here:
 *     its counts come from the `stats_cache`, which the promote must refresh FIRST,
 *     so the home purge lives in `promote.ts`'s ordered refresh-then-purge task
 *     (AECI-305), not in this concurrently-fired set. Adding `index:home` here would
 *     let the purge race ahead of the refresh and re-cache stale HTML.
 *
 * Known bounded gaps (out of scope here — see the handler doc-comment and
 * `docs/REVIEW_APP_PROMOTE_API.md`):
 *   - Embedded reverse-tagging is Phase 4 and not wired yet, so e.g. a vendor edit
 *     doesn't purge product pages that embed the vendor. Falls back to the TTL.
 *   - Integration seeding is disabled under AECI-86; when it is re-enabled in
 *     `promote.ts`, this deriver must also emit `integration:{id}` and re-purge
 *     the affected source/target `product:{slug}` (tie it to the `affectedProducts`
 *     set the commented integration block maintains).
 *   - An integration whose powered-by product MOVES (re-pointed to a different
 *     connector, or cleared) only purges the NEW connector — the response carries
 *     the post-update `poweredBySlug`, not the pre-update one — so the previous
 *     connector's page falls back to the TTL. Same bounded shape as the endpoint
 *     move above; widen it here if connector re-pointing becomes common.
 *   - A promote that REMOVES a category/audience/phase from a product doesn't purge
 *     that term's browse page: the response echoes only the terms the product now
 *     carries. Those pages fall back to their 5-minute browse TTL. Trades are
 *     deliberately exempt (`removedTradeSlugs`, above) because their publication
 *     gate makes a removal change the index and sitemap too, not just one page.
 *   - `index:trades` and the `/trades*` `Cache-Tag` emitters shipped with the
 *     browse pages in AECI-544, so every trade tag purged here now has a matching
 *     emitter in `apps/web/src/server/cache-tags.ts`; `sitemap` gained its trade
 *     URLs in AECI-546.
 */

import type { PromoteResponse } from '@aeci/shared';

import { pairCacheTag } from './promote-pair';

/**
 * Every trade slug this promote touched — the ones it SET (echoed on the
 * response) union the ones it REMOVED (which the response cannot echo, so the
 * handler reads the product's prior trades before the batch and passes them in).
 * A removal counts because it can push a term back *under* the publication floor,
 * which changes the `/trades` index and the sitemap just as a crossing upward does.
 *
 * Lives here, with the tag deriver, and is shared with `affectedUrlsForPromote`
 * (`promote-indexnow-urls.ts`) — the URL counterpart to this module. The two must
 * model the identical touched set: a trade URL we ping IndexNow about but never
 * purge from the edge hands the crawler a stale page. Pure, and deliberately free
 * of any DB import; the publication floor that narrows this set needs a
 * `product_count` and lives in `promote-trade-publication.ts`.
 */
export function touchedTradeSlugs(
  response: PromoteResponse,
  removedTradeSlugs: readonly string[] = [],
): string[] {
  return [...new Set([...response.taxonomy.trades.map((t) => t.slug), ...removedTradeSlugs])];
}

/**
 * Returns the deduplicated set of cache tags to purge for a promote `response`,
 * or an empty array when nothing cacheable changed (e.g. an all-skipped push).
 * Pure — depends only on its arguments.
 *
 * `opts.removedTradeSlugs` are trades the promote dropped from the product. They
 * can't be derived from the response (which echoes only what was set), so the
 * handler reads them pre-batch and passes them in — see the `trade:{slug}` rule
 * in the module comment.
 */
export function cacheTagsForPromote(
  response: PromoteResponse,
  opts: { removedTradeSlugs?: string[] } = {},
): string[] {
  const tags = new Set<string>();

  // Product detail + products index.
  if (response.product) {
    tags.add(`product:${response.product.slug}`);
    tags.add('index:products');
    if (response.product.operation === 'created') tags.add('sitemap');
  }

  // Vendor detail pages. (No `index:vendors` — the `/vendors` index page was
  // removed in AECI-165; it now 301-redirects to `/products`.)
  for (const vendor of response.vendors) {
    tags.add(`vendor:${vendor.slug}`);
    if (vendor.operation === 'created') tags.add('sitemap');
  }

  // Taxonomy browse pages: one tag per touched term (created *and* reused — the
  // product's facet membership changed either way, so its browse pages repaint).
  const taxonomy: ReadonlyArray<
    ['category' | 'audience' | 'phase', typeof response.taxonomy.categories]
  > = [
    ['category', response.taxonomy.categories],
    ['audience', response.taxonomy.audiences],
    ['phase', response.taxonomy.phases],
  ];
  let taxonomyCreated = false;
  for (const [prefix, results] of taxonomy) {
    for (const result of results) {
      tags.add(`${prefix}:${result.slug}`);
      if (result.operation === 'created') taxonomyCreated = true;
    }
  }
  // Global taxonomy nav (home / `/categories` / footer) only changes when a new
  // term was minted — a reused term is already in the nav.
  if (taxonomyCreated) tags.add('taxonomy');

  // Trades (AECI-542) — their own block, NOT folded into the loop above, because
  // the rule differs: trades can never be `created` (find-only), yet ANY touched
  // trade still changes the publication-gated `/trades` index, facet sidebar, and
  // sitemap. Removed trades count for the same reason (`CACHE_STRATEGY.md` §2).
  const tradeSlugs = touchedTradeSlugs(response, opts.removedTradeSlugs);
  for (const slug of tradeSlugs) tags.add(`trade:${slug}`);
  if (tradeSlugs.length) {
    tags.add('index:trades');
    tags.add('taxonomy');
    tags.add('sitemap');
  }

  // Pair pages (Stage 1.5, §6.2 / §7.3): a promote that touches an integration —
  // or the claims riding on it — invalidates the consolidated product-pair page.
  // Tag it by both product slugs (`pair:{min}__{max}`) so either orientation
  // repaints. The slugs come from the response's integration results (populated by
  // the claims ingest, AECI-297); older responses may omit them, so guard. The
  // pair page (AECI-294) emits the identical tag — keep them in lockstep.
  for (const integration of response.integrations) {
    if (integration.sourceSlug && integration.targetSlug) {
      tags.add(pairCacheTag(integration.sourceSlug, integration.targetSlug));
    }
    // The connector product that POWERS the edge renders it in its own
    // "Integrations it powers" hub view (Stage 1.5 Addendum B), so its detail
    // page must repaint too. Absent for edges with no powered-by product (and on
    // older responses) — guard.
    if (integration.poweredBySlug) tags.add(`product:${integration.poweredBySlug}`);
  }

  return [...tags];
}
