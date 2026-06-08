/**
 * Resolver for the `**` wildcard route (AECI-62 / Phase 2.16).
 *
 * Mirrors the SSR-side half of `productDetailResolver` but with no API call:
 * the route exists purely to surface a real HTTP 404 and the noindex meta
 * tags. The runtime's `withCacheHeaders` reads `RESPONSE_INIT.status = 404`
 * and emits `NOT_FOUND_TTL` + `Cache-Tag: route:404`.
 *
 * Client path (AECI-151): a client navigation to an unknown route never reaches
 * the SSR Worker, so set the noindex 404 meta (title + `robots: noindex` +
 * stale-JSON-LD cleanup) here too — otherwise a client-nav'd 404 keeps the
 * previous page's title/canonical/structured data. There is no HTTP status to
 * set on a SPA navigation (`RESPONSE_INIT` is server-only). The `NotFound`
 * component renders identically regardless.
 *
 * Spec anchors: Stage 1 Spec §9.1b (real 404 status, no pinned-404 trap),
 * §20.7 (useful 404 with recovery links).
 */
import { isPlatformServer } from '@angular/common';
import { PLATFORM_ID, REQUEST, RESPONSE_INIT, inject } from '@angular/core';
import { ResolveFn } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

export const notFoundResolver: ResolveFn<null> = (_route, state) => {
  const platformId = inject(PLATFORM_ID);
  const meta = inject(MetaService);

  // Client path: no API call, no HTTP status — just refresh the noindex 404 meta
  // for the requested URL so an in-app nav to a missing route doesn't inherit the
  // prior page's head. `setNotFoundMeta` strips query params internally.
  if (!isPlatformServer(platformId)) {
    meta.setNotFoundMeta({ kind: 'index', slug: '', canonical: canonicalUrl(state.url) });
    return null;
  }

  const request = inject(REQUEST, { optional: true });
  const responseInit = inject(RESPONSE_INIT, { optional: true });

  // Canonical for a 404 has no meaningful entity; use the requested URL so
  // the noindex'd page still self-references rather than pointing somewhere
  // unrelated. `setNotFoundMeta` strips query params internally.
  const canonical = request ? request.url : 'https://aecintegrations.com/';

  if (responseInit) responseInit.status = 404;
  meta.setNotFoundMeta({ kind: 'index', slug: '', canonical });

  return null;
};
