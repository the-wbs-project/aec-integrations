import { isPlatformServer } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { PLATFORM_ID, REQUEST_CONTEXT, RESPONSE_INIT, inject } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { VendorMeResponse } from '@aeci/shared';

import { isServerApiError, type ServerApiClient } from '../../server-api-client';
import type { AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';
import { isVendorGateRejection, vendorNotFoundMarker } from './vendor-gate';

const VENDOR_ME_PATH = '/api/vendor/me';

/**
 * The bare `/vendor` entry point. Resolves the caller's own vendor and redirects
 * to `/vendor/:vendorSlug/overview`; renders the 404 surface for anyone
 * `requireVendor()` rejects.
 *
 * ── WHY A GUARD AND NOT A `redirectTo` ──────────────────────────────────────
 * The target depends on the session, and `Route.redirectTo` — including its
 * function form — cannot see resolved data (resolvers do not run for a redirect
 * route). A guard can, because it returns a `UrlTree`. That matters beyond
 * tidiness: when the router's final URL differs from the requested one,
 * `@angular/ssr` emits a **real HTTP redirect** instead of HTML, so a cold hit on
 * `/vendor` costs one 302 and lands the browser on an address that names the
 * vendor — rather than SSR-ing the dashboard at `/vendor` and rewriting the bar
 * after hydration.
 *
 * `/vendor` stays linkable from the header menus (`layout/user-menu.ts`,
 * `layout/nav-menu.ts`), which is the point: those render for any signed-in user
 * and have no vendor payload to build a slugged link from. The cost is one extra
 * `GET /api/vendor/me` on that hop — the redirect target's resolver fetches
 * again, because a 302 carries no `TransferState`. Deep links, bookmarks and
 * every in-portal navigation skip this guard entirely.
 *
 * The rejection branch returns `true` rather than a `UrlTree` so the URL the
 * visitor typed stays intact (the AECI-62 "no pinned-404 trap" rule) and the
 * route's own `NotFound` component renders; the guard sets the 404 status and
 * noindex head that component expects. A 5xx rethrows — an outage must not
 * launder into a not-found.
 */
export const vendorHomeRedirectGuard: CanActivateFn = () => {
  const platformId = inject(PLATFORM_ID);
  const router = inject(Router);
  const meta = inject(MetaService);

  const toDashboard = (me: VendorMeResponse): UrlTree =>
    router.createUrlTree(['/vendor', me.vendor.slug, 'overview']);
  // Built eagerly: it resolves the serving origin through `inject(REQUEST)`, and
  // it is only ever invoked past an `await`. See `vendorNotFoundMarker`.
  const markNotFound = vendorNotFoundMarker(meta, '/vendor');

  if (!isPlatformServer(platformId)) {
    const http = inject(HttpClient);
    return resolveClient(http, toDashboard, () => {
      markNotFound();
      return true;
    });
  }

  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  const reject = (): true => {
    if (responseInit) responseInit.status = 404;
    markNotFound();
    return true;
  };
  // No request context means no cookie-forwarding API client — nothing to
  // authorize with, so there is nothing to redirect to.
  if (!ctx) return reject();
  return resolveServer(ctx.api, toDashboard, reject);
};

async function resolveServer(
  api: ServerApiClient,
  toDashboard: (me: VendorMeResponse) => UrlTree,
  reject: () => true,
): Promise<UrlTree | true> {
  try {
    return toDashboard(await api.request<VendorMeResponse>(VENDOR_ME_PATH));
  } catch (err) {
    if (isServerApiError(err) && isVendorGateRejection(err.status)) return reject();
    throw err;
  }
}

async function resolveClient(
  http: HttpClient,
  toDashboard: (me: VendorMeResponse) => UrlTree,
  reject: () => true,
): Promise<UrlTree | true> {
  try {
    return toDashboard(await firstValueFrom(http.get<VendorMeResponse>(VENDOR_ME_PATH)));
  } catch (err) {
    if (err instanceof HttpErrorResponse && isVendorGateRejection(err.status)) return reject();
    throw err;
  }
}
