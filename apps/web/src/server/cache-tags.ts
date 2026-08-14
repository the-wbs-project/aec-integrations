/**
 * Cache-Tag composition for SSR responses on the cacheable branch
 * (AECI-56 / Phase 2.10).
 *
 * `docs/CACHE_STRATEGY.md` §2–3 defines the tag vocabulary and composition
 * rules; this module is the single place those rules are codified. Two
 * concerns live here:
 *
 *   1. `buildCacheTags(opts)` — turns a route + entity + embedded refs into
 *      the comma-separated `Cache-Tag` header value (no spaces, ≤ 16 KB).
 *   2. `cacheTagInputsForPath(path)` — turns a locale-stripped pathname into
 *      the `buildCacheTags` input shape. Mirrors the `ROUTE_CACHE_PATTERNS`
 *      table in `server-runtime.ts` one-for-one, so adding a cacheable URL
 *      always means updating both.
 *
 * Callers never construct `Cache-Tag` strings by hand — extend `buildCacheTags`
 * and/or `cacheTagInputsForPath` plus `docs/CACHE_STRATEGY.md` §2 together.
 *
 * Embedded-entity tagging (e.g. tagging `vendor:<slug>` on a product detail
 * page so editing the vendor invalidates affected product pages) is supported
 * in the signature but Phase 2.10 callers pass `undefined`. The Phase 4 data
 * flow that produces those refs lands when product / vendor / integration
 * detail pages render their embedded entities.
 */

import { orderedPairSlugs } from '@aeci/shared';

/** Route classes that map to `route:<class>` tags. */
export type CacheableRouteClass = 'detail' | 'index' | 'browse';

/** Entity reference for the entity (or embedded entity) being rendered. */
export type CacheTagEntity = {
  /** Tag prefix, e.g. `product`, `vendor`, `integration`, `category`, `index`. */
  type: string;
  /** Slug for slug-keyed entities. One of `slug` / `id` must be present. */
  slug?: string;
  /** ID for id-keyed entities (currently `integration:<id>`). */
  id?: string;
};

export type CacheTagInputs = {
  route: CacheableRouteClass;
  entity?: CacheTagEntity;
  embedded?: readonly CacheTagEntity[];
  /** Set when the response renders the global taxonomy nav (home, etc.). */
  taxonomy?: boolean;
};

/** Cloudflare's documented Cache-Tag header limit (§2 line 18). */
export const CACHE_TAG_MAX_BYTES = 16_384;

function entityTag(entity: CacheTagEntity): string | null {
  const value = entity.slug ?? entity.id;
  if (!value) return null;
  return `${entity.type}:${value}`;
}

/**
 * Builds the `Cache-Tag` header value per `docs/CACHE_STRATEGY.md` §2–3:
 *
 *   - always emits `route:<route>`
 *   - emits the entity tag (`<type>:<slug|id>`) when `entity` is set
 *   - emits one tag per embedded entity
 *   - emits `taxonomy` when `opts.taxonomy === true`
 *
 * The string is deduplicated, comma-joined, contains no spaces, and is
 * ≤ `CACHE_TAG_MAX_BYTES`. Exceeding the limit throws — that's a programmer
 * error (a page with thousands of embedded entities), not a runtime condition
 * worth handling at the call site.
 */
export function buildCacheTags(opts: CacheTagInputs): string {
  const tags = new Set<string>();
  tags.add(`route:${opts.route}`);

  if (opts.entity) {
    const tag = entityTag(opts.entity);
    if (tag) tags.add(tag);
  }

  if (opts.embedded) {
    for (const e of opts.embedded) {
      const tag = entityTag(e);
      if (tag) tags.add(tag);
    }
  }

  if (opts.taxonomy) tags.add('taxonomy');

  const value = [...tags].join(',');
  if (value.length > CACHE_TAG_MAX_BYTES) {
    throw new Error(
      `Cache-Tag value exceeds ${CACHE_TAG_MAX_BYTES} bytes (got ${value.length}); reduce embedded entities`,
    );
  }
  return value;
}

/**
 * Maps a locale-stripped pathname (the second member of
 * `stripLocalePrefix(url.pathname)`) to the tag inputs for that route, or
 * `null` if the path isn't cacheable. Mirrors the `ROUTE_CACHE_PATTERNS`
 * table in `server-runtime.ts` exactly — both move together when a new
 * cacheable URL lands.
 *
 * For static pages with no entity in the §2 vocabulary (`/about`, `/legal/*`),
 * only the route-class tag is emitted (entity is omitted). Those pages are
 * almost never targets of purge-by-tag; emitting only `route:index` is
 * deliberate and keeps the helper from minting ad-hoc tag namespaces.
 */
export function cacheTagInputsForPath(path: string): CacheTagInputs | null {
  // Home carries its own `index:home` entity tag (alongside `taxonomy`) so a
  // promote can purge just the home page — its credibility strip + stats cards
  // render `home.*` `stats_cache` counts that a promote refreshes (AECI-305).
  // `route:index` alone is incident-only (§3.3) and `taxonomy` only fires on a
  // term-set change, so neither is a routine per-promote handle for `/`.
  if (path === '/')
    return { route: 'index', entity: { type: 'index', slug: 'home' }, taxonomy: true };
  if (path === '/about') return { route: 'index' };
  // AECI-536 — /updates is a static content page with no §2 entity, so it emits
  // only the route-class tag (like /about), never an ad-hoc tag namespace.
  if (path === '/updates') return { route: 'index' };
  // /roadmap — the coming-soon placeholder behind the header "More" menu. Same
  // shape as /updates: static content page with no §2 entity, route-class tag only.
  if (path === '/roadmap') return { route: 'index' };
  if (path === '/legal' || path.startsWith('/legal/')) return { route: 'index' };

  let m: RegExpExecArray | null;
  // AECI-294 — the product-PAIR page. The `pair:{min}__{max}` tag is
  // orientation-independent (both `/products/A/integrations/B` and its mirror
  // emit the same tag, since `orderedPairSlugs` sorts the two slugs), and both
  // products are embedded so a promote touching either one purges the page
  // (§7.3). Matched BEFORE `/products/:slug` (a 3-segment path can't match that
  // single-segment pattern, but the order documents intent).
  const pairMatch = path.match(/^\/products\/([^/]+)\/integrations\/([^/]+)$/);
  if (pairMatch) {
    const context = pairMatch[1]!;
    const other = pairMatch[2]!;
    const [min, max] = orderedPairSlugs(context, other);
    return {
      route: 'detail',
      entity: { type: 'pair', slug: `${min}__${max}` },
      embedded: [
        { type: 'product', slug: context },
        { type: 'product', slug: other },
      ],
    };
  }
  if ((m = /^\/products\/([^/]+)$/.exec(path)))
    return { route: 'detail', entity: { type: 'product', slug: m[1]! } };
  if ((m = /^\/vendors\/([^/]+)$/.exec(path)))
    return { route: 'detail', entity: { type: 'vendor', slug: m[1]! } };
  // AECI-294 retired `/integrations/:id` — it now 301-redirects to the pair page
  // in `server-runtime.ts` and never reaches the SSR cache pipeline; the 301
  // response carries its own `integration:{id}` Cache-Tag.

  if (path === '/products') return { route: 'index', entity: { type: 'index', slug: 'products' } };
  // AECI-165 removed the `/vendors` and `/integrations` index pages — they now
  // 301-redirect to `/products` at the SSR Worker (see `server-runtime.ts`) and
  // never reach the SSR cache pipeline, so they have no `index:*` tag here. Their
  // `:slug` / `:id` DETAIL pages are handled by the detail matchers above.

  // `/categories` is the flat index (AECI-61), not a browse facet: per
  // CACHE_STRATEGY.md §2 it carries `index:categories` + `taxonomy` (it renders
  // the full taxonomy), distinct from the per-slug browse pages below.
  if (path === '/categories')
    return { route: 'index', entity: { type: 'index', slug: 'categories' }, taxonomy: true };
  if ((m = /^\/categories\/(.+)$/.exec(path)))
    return { route: 'browse', entity: { type: 'category', slug: m[1]! } };

  // `/audiences` and `/phases` are flat indexes (AECI-157) — like `/categories`,
  // they render the full taxonomy, so they carry `index:<segment>` + `taxonomy`,
  // distinct from the per-slug browse pages below.
  if (path === '/audiences')
    return { route: 'index', entity: { type: 'index', slug: 'audiences' }, taxonomy: true };
  if ((m = /^\/audiences\/(.+)$/.exec(path)))
    return { route: 'browse', entity: { type: 'audience', slug: m[1]! } };

  if (path === '/phases')
    return { route: 'index', entity: { type: 'index', slug: 'phases' }, taxonomy: true };
  if ((m = /^\/phases\/(.+)$/.exec(path)))
    return { route: 'browse', entity: { type: 'phase', slug: m[1]! } };

  // `/trades` — the fourth facet's flat index (AECI-544), same shape as its
  // siblings. `trade:{slug}` is emitted for EVERY trade, published or not: the
  // publication gate controls indexability, not cacheability, so a term that
  // crosses `TRADE_PUBLISH_MIN_PRODUCTS` is purgeable by the same tag it always
  // had. A promote that touches any trade must also purge `index:trades`,
  // `taxonomy`, and `sitemap` (CACHE_STRATEGY.md §2, AECI-542/546).
  if (path === '/trades')
    return { route: 'index', entity: { type: 'index', slug: 'trades' }, taxonomy: true };
  const tradeMatch = path.match(/^\/trades\/(.+)$/);
  if (tradeMatch) return { route: 'browse', entity: { type: 'trade', slug: tradeMatch[1]! } };

  return null;
}
