/**
 * The current page as `?return=` params for a "Sign in" link, so signing in
 * lands back where the visitor clicked. The header and the mobile menu are
 * shell components outside the routed outlet, so this reads `Router.url`
 * (refreshed on `NavigationEnd`) rather than an `ActivatedRoute`.
 *
 * Cache-safe: the server render uses the path alone. The edge cache key keeps
 * the path verbatim but drops most of the query (every param on detail, home
 * and static routes, and `utm_*` / `fbclid` / the email send id `n` everywhere,
 * `docs/CACHE_STRATEGY.md` §4a). Rendering the query would bake the first
 * visitor's params, such as another recipient's `n`, into HTML served to
 * everyone. In the browser the full URL is used, so the visitor's own query,
 * including their arrival params, survives the sign-in round trip.
 */
import { isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID, computed, inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

import { signInQueryParams } from './return-path';

export function injectSignInQueryParams(): Signal<Record<string, string>> {
  const router = inject(Router);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  const url = toSignal(
    router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => router.url),
    ),
    { initialValue: router.url },
  );
  return computed(() => signInQueryParams(isBrowser ? url() : pathOnly(url())));
}

/** `url` without its query string or fragment. */
export function pathOnly(url: string): string {
  return url.split(/[?#]/, 1)[0];
}
