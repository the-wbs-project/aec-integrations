import { Location, isPlatformBrowser } from '@angular/common';
import { DestroyRef, PLATFORM_ID, inject, signal, type Signal } from '@angular/core';

import { inPageHref } from './in-page-href-url';

/**
 * A signal of the in-page href for `id`. Call from an injection context.
 *
 * It follows `Location.onUrlChange`, which fires for the router's own writes, for
 * `Location.replaceState` calls that fire no router event (the vendor integrations filter),
 * and for popstate. `Location` rather than `router.url`: the router reports `/` until the
 * initial navigation ends, which briefly rendered `/#main` right after hydration.
 */
export function injectInPageHref(id: string): Signal<string> {
  const location = inject(Location);
  const browser = isPlatformBrowser(inject(PLATFORM_ID));
  const href = signal(inPageHref(location.path(), id, browser));
  if (browser) {
    const unsubscribe = location.onUrlChange(() => href.set(inPageHref(location.path(), id, true)));
    inject(DestroyRef).onDestroy(unsubscribe);
  }
  return href.asReadonly();
}
