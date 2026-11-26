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
 * page so editing the vendor invalidates affected product pages) is **live**:
 * the Stage 1.5 product-pair route emits `product:<ctx>` / `product:<other>`
 * embedded tags from `cacheTagInputsForPath`, and resolver-derived embedded refs
 * are merged in via `mergeEmbeddedTags` (`server-runtime.ts`). Routes with no
 * embedded entities simply pass `embedded: undefined`.
 */

import { orderedPairSlugs } from '@aeci/shared';

import { ACCESSIBILITY_STATEMENT_PUBLISHED } from '../app/accessibility/accessibility-published';

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
  /**
   * AECI-2025: set on a `vendor:` entity whose logo the page renders, which a logo
   * upload or objection purges through `vendor:{slug}` alone. A cut tag list never drops
   * it quietly: losing it makes the page uncacheable. Ignored on other types.
   */
  lead?: boolean;
};

export type CacheTagInputs = {
  route: CacheableRouteClass;
  entity?: CacheTagEntity;
  embedded?: readonly CacheTagEntity[];
  /** Set when the response renders the global taxonomy nav (home, etc.). */
  taxonomy?: boolean;
};

/**
 * Cloudflare's limits on a `Cache-Tag` header, which Workers Cache shares with the zone
 * cache (`docs/CACHE_STRATEGY.md` §3 "A page never fails on its tag list"):
 * the whole value at most 16 KB, at most 1,000 tags, each tag at most 1,024 printable
 * ASCII characters. Cloudflare silently drops an invalid tag at storage time.
 */
export const CACHE_TAG_MAX_BYTES = 16_384;
export const CACHE_TAG_MAX_COUNT = 1_000;
export const CACHE_TAG_MAX_TAG_LENGTH = 1_024;

/** Printable ASCII, `0x21`–`0x7E`. A space is not printable here: Cloudflare strips it. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * What a composed tag list kept and what it left out (AECI-2025).
 *
 * - `truncated` is true when any tag was left out, for the budget or for being invalid.
 * - `cacheable` is false when a left-out tag is one an "at once" purge travels by: a
 *   mandatory tag, a `pair:` tag, a `product:` tag, or the page's lead `vendor:` tag. Such
 *   a page must not be stored, so nothing a purge removes can be served stale (Tier B).
 *   A page that is `truncated` and still `cacheable` is Tier A: cached on a short TTL.
 * - `total` counts distinct tags before the cap, `kept` the tags in `value`.
 * - `droppedByType` counts the left-out tags by prefix (`integration`, `vendor`, ...).
 * - `invalid` counts tags left out for length or characters, inside `droppedByType` too.
 */
export type CacheTagComposition = {
  value: string;
  bytes: number;
  truncated: boolean;
  cacheable: boolean;
  total: number;
  kept: number;
  droppedByType: Record<string, number>;
  invalid: number;
};

function entityTag(entity: CacheTagEntity): string | null {
  const value = entity.slug ?? entity.id;
  if (!value) return null;
  return `${entity.type}:${value}`;
}

/** Lower ranks are kept first. Ranks at or under `MUST_KEEP_RANK` must never be dropped. */
const RANK_MANDATORY = 0;
const RANK_PAIR_OR_LEAD_VENDOR = 1;
const RANK_PRODUCT = 2;
const MUST_KEEP_RANK = RANK_PRODUCT;
const RANK_VENDOR = 3;
const RANK_OTHER = 4;
const RANK_INTEGRATION = 5;

function embeddedRank(type: string, isLeadVendor: boolean): number {
  if (type === 'pair') return RANK_PAIR_OR_LEAD_VENDOR;
  if (type === 'vendor') return isLeadVendor ? RANK_PAIR_OR_LEAD_VENDOR : RANK_VENDOR;
  if (type === 'product') return RANK_PRODUCT;
  if (type === 'integration') return RANK_INTEGRATION;
  return RANK_OTHER;
}

function tagType(tag: string): string {
  const colon = tag.indexOf(':');
  return colon === -1 ? tag : tag.slice(0, colon);
}

/**
 * Composes the `Cache-Tag` value per `docs/CACHE_STRATEGY.md` §2–3 and never throws:
 *
 *   - always emits `route:<route>`
 *   - emits the entity tag (`<type>:<slug|id>`) when `entity` is set
 *   - emits one tag per embedded entity
 *   - emits `taxonomy` when `opts.taxonomy === true`
 *
 * The list is deduplicated, comma-joined and space-free. When it fits Cloudflare's limits
 * it is exactly what it always was, in push order. When it does not, tags are kept by
 * rank, and by push order within a rank: the mandatory tags (`route:*`, the page's own
 * entity, `taxonomy`), then `pair:` and the lead vendor, then `product:`, then the other
 * `vendor:` tags, then the term and index tags, then `integration:`. A lead vendor is a
 * `vendor:` entity pushed with `lead: true`: on a product page, the product's own vendor,
 * whose logo the facts card renders. A tag is added when it still fits, so a later short
 * tag can fill room a long one could not. The kept tags keep their push order.
 */
export function composeCacheTags(opts: CacheTagInputs): CacheTagComposition {
  type Candidate = { tag: string; rank: number; order: number };
  const byTag = new Map<string, Candidate>();
  const candidates: Candidate[] = [];
  const add = (tag: string | null, rank: number): void => {
    if (!tag) return;
    const existing = byTag.get(tag);
    // A repeat keeps its first slot but takes the higher rank, so a lead mark on a
    // later push of the same vendor still protects it.
    if (existing) {
      existing.rank = Math.min(existing.rank, rank);
      return;
    }
    const candidate = { tag, rank, order: candidates.length };
    byTag.set(tag, candidate);
    candidates.push(candidate);
  };

  add(`route:${opts.route}`, RANK_MANDATORY);
  if (opts.entity) add(entityTag(opts.entity), RANK_MANDATORY);
  // `taxonomy` is mandatory, but it has always been emitted last. Its rank is fixed
  // here and its slot after the embedded tags, so an under-limit header is unchanged.
  for (const e of opts.embedded ?? []) {
    add(entityTag(e), embeddedRank(e.type, e.type === 'vendor' && e.lead === true));
  }
  if (opts.taxonomy) add('taxonomy', RANK_MANDATORY);

  const droppedByType: Record<string, number> = {};
  let cacheable = true;
  let invalid = 0;
  const drop = (c: Candidate): void => {
    const type = tagType(c.tag);
    droppedByType[type] = (droppedByType[type] ?? 0) + 1;
    if (c.rank <= MUST_KEEP_RANK) cacheable = false;
  };

  const valid: Candidate[] = [];
  for (const c of candidates) {
    if (c.tag.length > CACHE_TAG_MAX_TAG_LENGTH || !PRINTABLE_ASCII.test(c.tag)) {
      invalid += 1;
      drop(c);
    } else {
      valid.push(c);
    }
  }

  // Every tag is printable ASCII now, so a character is a byte. Each tag after the first
  // costs one more byte for its comma.
  const fullBytes = valid.reduce((sum, c) => sum + c.tag.length, 0) + Math.max(0, valid.length - 1);
  let kept: Candidate[];
  if (fullBytes <= CACHE_TAG_MAX_BYTES && valid.length <= CACHE_TAG_MAX_COUNT) {
    kept = valid;
  } else {
    const byRank = [...valid].sort((a, b) => a.rank - b.rank || a.order - b.order);
    kept = [];
    let bytes = 0;
    for (const c of byRank) {
      const cost = c.tag.length + (kept.length > 0 ? 1 : 0);
      if (kept.length < CACHE_TAG_MAX_COUNT && bytes + cost <= CACHE_TAG_MAX_BYTES) {
        kept.push(c);
        bytes += cost;
      } else {
        drop(c);
      }
    }
    kept.sort((a, b) => a.order - b.order);
  }

  const value = kept.map((c) => c.tag).join(',');
  return {
    value,
    bytes: value.length,
    truncated: kept.length < candidates.length,
    cacheable,
    total: candidates.length,
    kept: kept.length,
    droppedByType,
    invalid,
  };
}

/**
 * The `Cache-Tag` header value for `opts`: {@link composeCacheTags}'s `value`. It never
 * throws. A caller that must know whether tags were left out, and whether the page may
 * still be stored, reads `composeCacheTags` instead (the SSR runtime does).
 */
export function buildCacheTags(opts: CacheTagInputs): string {
  return composeCacheTags(opts).value;
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
  // /roadmap — the coming-soon placeholder linked from the footer. Same shape as
  // /updates: static content page with no §2 entity, route-class tag only.
  if (path === '/roadmap') return { route: 'index' };
  // AECI-804 — /methodology. Static content page with no §2 entity, so the
  // route-class tag only, like /about and /updates. Never an ad-hoc namespace.
  if (path === '/methodology') return { route: 'index' };
  // AECI-1673 — /accessibility, the accessibility statement. Same shape. Hidden
  // until AECI-1687: while off, the path is the `**` 404, so no route tag.
  if (path === '/accessibility' && ACCESSIBILITY_STATEMENT_PUBLISHED) return { route: 'index' };
  // AECI-1283 — /vendor-program, the vendor landing page. Static, no §2 entity,
  // route-class tag only (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §2.2).
  if (path === '/vendor-program') return { route: 'index' };
  // AECI-1474 — the listing request page under it, the same route-class tag only.
  if (path === '/vendor-program/list-your-product') return { route: 'index' };
  if (path === '/legal' || path.startsWith('/legal/')) return { route: 'index' };
  // AECI-1104, AECI-1248 — the product docs: the `/docs` home, the section
  // indexes and the articles. Static content, route-class tag only.
  if (path === '/docs' || path.startsWith('/docs/')) return { route: 'index' };

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
