/**
 * The edge cache key's per-route rules, as plain TypeScript so both the SSR Worker
 * (`server-runtime.ts`, which builds `cacheKeyFor` and the route table from these) and app
 * code can import them. `apps/web` cannot import `server-runtime.ts` itself: it pulls in Hono
 * and the Worker-only modules.
 *
 * App code reads this where a server render must emit a URL that depends on the query string
 * (`injectInPageHref`, AECI-1839). The cache key is the URL's path plus the params this module
 * names, so an href built from exactly those params is the same for every request that shares
 * the cache entry. Anything else in the query (`utm_*`) must not reach cached HTML.
 * See `docs/CACHE_STRATEGY.md` §4a.
 */
import { LISTING_CACHE_KEY_PARAMS } from './listing-cache-key-params';

/** AECI-294 / AECI-303: the product-PAIR page reads exactly these three params. */
export const PAIR_PAGE_CACHE_KEY_PARAMS: readonly string[] = [
  'view',
  'context_version',
  'other_version',
];

/**
 * Cache-key params whose value is a comma-separated *set* (multi-select taxonomy
 * facets, AECI-223). Kept in step with `LISTING_CACHE_KEY_PARAMS` and `DIMENSIONS` in
 * `facet-sidebar.ts`.
 */
export const MULTI_VALUE_CACHE_KEY_PARAMS: ReadonlySet<string> = new Set([
  'category_id',
  'audience_id',
  'phase_id',
  'trade_id',
]);

/** `/products/:contextSlug/integrations/:otherSlug` (locale prefix already stripped). */
export function isPairPagePath(p: string): boolean {
  return /^\/products\/[^/]+\/integrations\/[^/]+$/.test(p);
}

export const isProductsIndexPath = (p: string): boolean => p === '/products';
export const isCategoriesPath = (p: string): boolean =>
  p === '/categories' || p.startsWith('/categories/');
export const isAudiencesPath = (p: string): boolean =>
  p === '/audiences' || p.startsWith('/audiences/');
export const isPhasesPath = (p: string): boolean => p === '/phases' || p.startsWith('/phases/');
export const isTradesPath = (p: string): boolean => p === '/trades' || p.startsWith('/trades/');

function isListingPath(p: string): boolean {
  return (
    isProductsIndexPath(p) ||
    isCategoriesPath(p) ||
    isAudiencesPath(p) ||
    isPhasesPath(p) ||
    isTradesPath(p)
  );
}

/**
 * The query params the cache key keeps for a path. Empty for every other route: the key
 * strips the whole query string there. Locale prefix already stripped by the caller.
 */
export function cacheKeyParamsForPath(localePath: string): readonly string[] {
  if (isPairPagePath(localePath)) return PAIR_PAGE_CACHE_KEY_PARAMS;
  if (isListingPath(localePath)) return LISTING_CACHE_KEY_PARAMS;
  return [];
}

/** Sort a comma-separated set canonically (the AECI-223 multi-select CSV invariant). */
function sortCsv(value: string): string {
  return value
    .split(',')
    .filter((v) => v.length > 0)
    .sort()
    .join(',');
}

/**
 * The canonical query string the cache key carries: only the allowlisted params, multi-select
 * CSVs sorted, names in canonical order. `''` when nothing survives.
 */
export function cacheKeyQuery(allowed: readonly string[], source: URLSearchParams): string {
  const params = new URLSearchParams();
  for (const name of allowed) {
    for (const value of source.getAll(name)) {
      params.append(name, MULTI_VALUE_CACHE_KEY_PARAMS.has(name) ? sortCsv(value) : value);
    }
  }
  params.sort(); // ?sort=name&page=2 and ?page=2&sort=name → one key
  return params.toString();
}

/**
 * Paths whose responses never enter the shared edge cache, at any status (AECI-1442). Input
 * is the locale-stripped path. `/vendor` is SINGULAR: the public `/vendors/:slug` page and
 * `/vendor-program` are not matched.
 */
export function isAdminPath(localePath: string): boolean {
  return localePath === '/admin' || localePath.startsWith('/admin/');
}

export function isVendorPath(localePath: string): boolean {
  return localePath === '/vendor' || localePath.startsWith('/vendor/');
}

export function isNeverCacheablePath(localePath: string): boolean {
  const underPrefix = (prefix: string) =>
    localePath === prefix || localePath.startsWith(`${prefix}/`);
  return (
    isAdminPath(localePath) ||
    isVendorPath(localePath) ||
    underPrefix('/auth') ||
    underPrefix('/account') ||
    underPrefix('/welcome') ||
    underPrefix('/search')
  );
}
