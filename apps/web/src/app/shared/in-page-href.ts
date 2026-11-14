import { Location, isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID, computed, inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';

/**
 * Builds an href that jumps to `#id` on the CURRENT page.
 *
 * The app ships `<base href="/">`, so a bare `href="#id"` resolves to `/#id` and loads the
 * home page from every other route (AECI-1839). This returns `{path}[?{query}]#{id}` from the
 * router's serialized URL instead. Any fragment already on the URL is replaced.
 *
 * `keepQuery` is for routes the edge cache never stores. The cache key drops most query
 * params, so a cached render must not bake in the warming request's query string: pass
 * `false` there and the server render carries the path only.
 */
export function inPageHref(routerUrl: string, id: string, keepQuery: boolean): string {
  const noFragment = routerUrl.split('#', 1)[0];
  const queryAt = noFragment.indexOf('?');
  const path = queryAt === -1 ? noFragment : noFragment.slice(0, queryAt);
  const query = queryAt === -1 || !keepQuery ? '' : noFragment.slice(queryAt);
  return `${path || '/'}${query}#${id}`;
}

/**
 * A signal of the in-page href for `id`, kept current across client navigations. Call from an
 * injection context. On the server the query string is dropped unless `keepQueryOnServer` is set
 * (see `inPageHref`); in the browser it is always kept, so the jump never changes the URL's query
 * or reloads the page.
 */
export function injectInPageHref(id: string, opts: { keepQueryOnServer: boolean }): Signal<string> {
  const router = inject(Router);
  // `Location`, not `router.url`: the router reports "/" until the initial navigation ends, which
  // briefly rendered `/#main` right after hydration. `Location` always holds the real URL.
  const location = inject(Location);
  const keepQuery = isPlatformBrowser(inject(PLATFORM_ID)) || opts.keepQueryOnServer;
  const url = toSignal(
    router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => location.path()),
      startWith(location.path()),
    ),
    { requireSync: true },
  );
  return computed(() => inPageHref(url(), id, keepQuery));
}
