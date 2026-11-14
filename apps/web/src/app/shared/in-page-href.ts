import { Location, isPlatformBrowser } from '@angular/common';
import { DestroyRef, PLATFORM_ID, computed, inject, signal, type Signal } from '@angular/core';

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
 * The server render keeps only the params the route's edge cache key keeps, so every request
 * that shares a cache entry renders the same hrefs. The browser keeps the whole query, so a
 * jump never reloads the page or drops `utm_*` (`in-page-href-url.ts`).
 */
export function injectInPageHrefFor(): Signal<(id: string) => string> {
  const location = inject(Location);
  const browser = isPlatformBrowser(inject(PLATFORM_ID));
  const url = signal(location.path());
  if (browser) {
    const unsubscribe = location.onUrlChange(() => url.set(location.path()));
    inject(DestroyRef).onDestroy(unsubscribe);
  }
  return computed(() => {
    const current = url();
    return (id: string) => inPageHref(current, id, browser);
  });
}

/** A signal of the in-page href for one `id`. Call from an injection context. */
export function injectInPageHref(id: string): Signal<string> {
  const hrefFor = injectInPageHrefFor();
  return computed(() => hrefFor()(id));
}
