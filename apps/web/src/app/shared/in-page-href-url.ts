// Plain TypeScript, no Angular imports, so the SSR Worker specs can import it.
import {
  cacheKeyParamsForPath,
  cacheKeyQuery,
  isNeverCacheablePath,
} from '../core/route-cache-key';

/**
 * Builds an href that jumps to `#id` on the CURRENT page.
 *
 * The app ships `<base href="/">`, so a bare `href="#id"` resolves to `/#id` and loads the
 * home page from every other route (AECI-1839). This returns `{path}[?{query}]#{id}` from the
 * current URL instead. Any fragment already on the URL is replaced.
 *
 * Which query survives depends on where it renders:
 *  - `browser`: the whole query, so the jump never reloads the page or drops a filter.
 *  - server, route the edge never stores (`isNeverCacheablePath`): the whole query, so a
 *    no-JS Enter keeps it.
 *  - server, any other route: only the params the route's cache key keeps, in the key's
 *    canonical order (`route-cache-key.ts`, the same code `cacheKeyFor` uses). Everything
 *    else (`utm_*`) is dropped. Every request that shares a cache entry then renders the
 *    same href, so cached HTML never carries another URL's query.
 */
export function inPageHref(url: string, id: string, browser: boolean): string {
  const noFragment = url.split('#', 1)[0];
  const queryAt = noFragment.indexOf('?');
  const path = (queryAt === -1 ? noFragment : noFragment.slice(0, queryAt)) || '/';
  const rawQuery = queryAt === -1 ? '' : noFragment.slice(queryAt + 1);
  let query = rawQuery;
  if (!browser && rawQuery && !isNeverCacheablePath(path)) {
    query = cacheKeyQuery(cacheKeyParamsForPath(path), new URLSearchParams(rawQuery));
  }
  return `${path}${query ? `?${query}` : ''}#${id}`;
}
