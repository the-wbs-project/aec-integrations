/**
 * Resolver for the `**` wildcard route (AECI-62 / Phase 2.16).
 *
 * Mirrors the SSR-side half of `productDetailResolver` but with no API call:
 * the route exists purely to surface a real HTTP 404 and the noindex meta
 * tags. The runtime's `withCacheHeaders` reads `RESPONSE_INIT.status = 404`
 * and emits `NOT_FOUND_TTL` + `Cache-Tag: route:404`.
 *
 * No client-side branch is required — hydration on a 404 just re-runs the
 * resolver, which is a no-op other than `transferState` housekeeping. The
 * component renders the same regardless.
 *
 * Spec anchors: Stage 1 Spec §9.1b (real 404 status, no pinned-404 trap),
 * §20.7 (useful 404 with recovery links).
 */
import { isPlatformServer } from '@angular/common';
import { PLATFORM_ID, REQUEST, RESPONSE_INIT, inject } from '@angular/core';
import { ResolveFn } from '@angular/router';

import { MetaService } from '../core/meta.service';

export const notFoundResolver: ResolveFn<null> = () => {
  const platformId = inject(PLATFORM_ID);
  if (!isPlatformServer(platformId)) return null;

  const meta = inject(MetaService);
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
