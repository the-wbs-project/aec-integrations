import { Location, isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  PLATFORM_ID,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

import type { AeciRequestContext } from '../../server/request-context';
import { inPageHref } from './in-page-href-url';

/**
 * A signal of a function that builds the in-page href for any `id`. Call from an injection
 * context. Use it where one component renders several in-page links: the section nav, the docs
 * "On this page" rail and the vendor integration page nav (AECI-1843).
 *
 * It follows `Location.onUrlChange`, which fires for the router's own writes, for
 * `Location.replaceState` calls that fire no router event (the vendor integrations filter),
 * and for popstate. `Location` rather than `router.url`: the router reports `/` until the
 * initial navigation ends, which briefly rendered `/#main` right after hydration.
 *
 * The browser keeps the whole query, so a jump never reloads the page or drops `utm_*`. On
 * the server the href keeps only the params the route's edge cache key keeps, so every request
 * that shares a cache entry renders the same hrefs (`in-page-href-url.ts`). The exception
 * (AECI-1848 review): when the runtime rendered on its non-cacheable branch and the page is not
 * a 404, the server href keeps the whole query too. The 404 status is set by a resolver, so the
 * server value is computed again when the navigation ends.
 */
export function injectInPageHrefFor(): Signal<(id: string) => string> {
  const location = inject(Location);
  const browser = isPlatformBrowser(inject(PLATFORM_ID));
  const url = signal(location.path());

  if (browser) {
    const unsubscribe = location.onUrlChange(() => url.set(location.path()));
    inject(DestroyRef).onDestroy(unsubscribe);
    return computed(() => {
      const current = url();
      return (id: string) => inPageHref(current, id, true);
    });
  }

  const ctx = inject(REQUEST_CONTEXT, { optional: true }) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  const uncached = () => ctx?.edgeCacheable === false && responseInit?.status !== 404;
  const uncachedRender = signal(uncached());
  const subscription = inject(Router).events.subscribe((event) => {
    if (event instanceof NavigationEnd) {
      url.set(location.path());
      uncachedRender.set(uncached());
    }
  });
  inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  return computed(() => {
    const current = url();
    const keepAll = uncachedRender();
    return (id: string) => inPageHref(current, id, false, keepAll);
  });
}

/** A signal of the in-page href for one `id`. Call from an injection context. */
export function injectInPageHref(id: string): Signal<string> {
  const hrefFor = injectInPageHrefFor();
  return computed(() => hrefFor()(id));
}
