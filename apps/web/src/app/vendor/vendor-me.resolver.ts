/**
 * Resolver for `/vendor` (AECI-522) — the vendor-portal gate + the dashboard
 * payload, in one authenticated call. Modelled on `adminSummaryResolver`
 * (AECI-203); `server-runtime.ts` mandates this pattern for the `/vendor` route.
 *
 * `/vendor` is non-cacheable (fail-closed classifier) and renders
 * `RenderMode.Server`, so the server branch has `REQUEST_CONTEXT` (whose `api`
 * client the SSR Worker built with the inbound session cookie forwarded — see
 * `server-runtime.ts` / `createServerApiClient`'s `forwardCookieFrom`). It calls
 * `GET /api/vendor/me`, which is gated by `requireVendor()`:
 *
 *   - 200 → the caller is a vendor admin; store the payload in TransferState and
 *     return it. The page renders the dashboard.
 *   - 401 / 403 / 404 → NOT a vendor (no session, a reviewer, a banned seat, a
 *     half-granted seat with a null `vendor_id`, or an admin — `requireVendor()`
 *     rejects site admins too). Set `RESPONSE_INIT.status = 404` + the noindex 404
 *     meta and return `null` so the page renders `<aec-not-found/>` — **don't
 *     reveal the surface** (mirrors the admin gate). URL stays at `/vendor`.
 *   - 5xx → a real failure; rethrow (never fake a 404 on an outage).
 *
 * A genuine logged-out visitor is bounced to `/auth/login` by the worker-level
 * gate before SSR (`server-runtime.ts` `isVendorPath`), so the 401 path here is
 * the defensive/expired-cookie/in-app-navigation case.
 *
 * Bundle-split note: errors are checked with `isServerApiError` (a structural
 * guard), never `instanceof` — the worker and Angular bundles hold separate class
 * identities (`server-api-client.ts`). `httpGetOrNull` can't be reused on the
 * client branch because it only maps a 404+NOT_FOUND envelope; the vendor gate
 * returns 401/403 too, mapped here to the same not-found render.
 */
import { isPlatformServer } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  PLATFORM_ID,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  TransferState,
  inject,
  makeStateKey,
} from '@angular/core';
import { ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { VendorMeResponse } from '@aeci/shared';

import { isServerApiError, type ServerApiClient } from '../../server-api-client';
import type { AeciRequestContext } from '../../server/request-context';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

const VENDOR_ME_PATH = '/api/vendor/me';
const STATE_KEY = makeStateKey<VendorMeResponse | null>('aeci.vendor-me');

/** Treat a 401/403 (and a defensive 404) from the vendor gate as "render the
 *  not-found page" — same UX whether the caller is anon, a reviewer, a banned
 *  seat, or a site admin. */
function notAuthorized(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export const vendorMeResolver: ResolveFn<VendorMeResponse | null> = () => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const meta = inject(MetaService);
  const canonical = canonicalUrl('/vendor');
  const markNotFound = (): null => {
    meta.setNotFoundMeta({ kind: 'index', slug: '', canonical });
    return null;
  };

  // ── Client path: hydration or in-app navigation. ──────────────────────────
  if (!isPlatformServer(platformId)) {
    if (transferState.hasKey(STATE_KEY)) {
      const cached = transferState.get(STATE_KEY, null);
      return cached ?? markNotFound();
    }
    return resolveClient(inject(HttpClient), markNotFound);
  }

  // ── Server path (RenderMode.Server). ──────────────────────────────────────
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  if (!ctx) {
    transferState.set(STATE_KEY, null);
    return null;
  }
  return resolveServer(ctx.api, transferState, responseInit, markNotFound);
};

async function resolveServer(
  api: ServerApiClient,
  transferState: TransferState,
  responseInit: { status?: number } | null,
  markNotFound: () => null,
): Promise<VendorMeResponse | null> {
  try {
    const me = await api.request<VendorMeResponse>(VENDOR_ME_PATH);
    transferState.set(STATE_KEY, me);
    return me;
  } catch (err) {
    if (isServerApiError(err) && notAuthorized(err.status)) {
      transferState.set(STATE_KEY, null);
      if (responseInit) responseInit.status = 404;
      return markNotFound();
    }
    throw err;
  }
}

async function resolveClient(
  http: HttpClient,
  markNotFound: () => null,
): Promise<VendorMeResponse | null> {
  try {
    return await firstValueFrom(http.get<VendorMeResponse>(VENDOR_ME_PATH));
  } catch (err) {
    if (err instanceof HttpErrorResponse && notAuthorized(err.status)) {
      return markNotFound();
    }
    throw err;
  }
}
