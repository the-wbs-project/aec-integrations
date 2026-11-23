import { Location, isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  PLATFORM_ID,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

import type { AeciRequestContext } from '../../server/request-context';
import { inPageHref } from './in-page-href-url';

/**
 * A signal of the in-page href for `id`. Call from an injection context.
 *
 * It follows `Location.onUrlChange`, which fires for the router's own writes, for
 * `Location.replaceState` calls that fire no router event (the vendor integrations filter),
 * and for popstate. `Location` rather than `router.url`: the router reports `/` until the
 * initial navigation ends, which briefly rendered `/#main` right after hydration.
 *
 * On the server the href keeps the whole query when the runtime rendered on its
 * non-cacheable branch and the page is not a 404 (AECI-1848 review). The 404 status is set
 * by a resolver, so the server value is computed again when the navigation ends.
 */
export function injectInPageHref(id: string): Signal<string> {
  const location = inject(Location);
  const browser = isPlatformBrowser(inject(PLATFORM_ID));
  if (browser) {
    const href = signal(inPageHref(location.path(), id, true));
    const unsubscribe = location.onUrlChange(() => href.set(inPageHref(location.path(), id, true)));
    inject(DestroyRef).onDestroy(unsubscribe);
    return href.asReadonly();
  }

  const ctx = inject(REQUEST_CONTEXT, { optional: true }) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  const serverHref = () =>
    inPageHref(
      location.path(),
      id,
      false,
      ctx?.edgeCacheable === false && responseInit?.status !== 404,
    );
  const href = signal(serverHref());
  const subscription = inject(Router).events.subscribe((event) => {
    if (event instanceof NavigationEnd) href.set(serverHref());
  });
  inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  return href.asReadonly();
}
