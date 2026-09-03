/**
 * Resolver for `/vendor/:vendorSlug/**` (AECI-522) — the vendor-portal gate + the
 * dashboard payload, in one authenticated call. Modelled on
 * `adminSummaryResolver` (AECI-203); `server-runtime.ts` mandates this pattern
 * for the `/vendor` route.
 *
 * The portal is non-cacheable (fail-closed classifier) and renders
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
 *     reveal the surface** (mirrors the admin gate). The URL is left alone.
 *   - 5xx → a real failure; rethrow (never fake a 404 on an outage).
 *
 * ── THE SLUG IN THE URL IS CHECKED, NOT DECORATION ──────────────────────────
 * The route carries `:vendorSlug`. A payload whose `vendor.slug` is not the one
 * the URL names takes the SAME not-found path as an unauthorized caller. Two
 * reasons, and the second is the one that lasts: rendering the session's
 * dashboard under a URL that names a different vendor is how someone edits (or
 * cites) the wrong listing; and today's "one seat, one `vendor_id`" is a
 * temporary shape — the moment a seat can hold several vendors, "the slug is not
 * one of yours" is exactly this branch. Ownership is still enforced server-side
 * on every write; this is the surface half.
 *
 * A genuine logged-out visitor is bounced to `/auth/login` by the worker-level
 * gate before SSR (`server-runtime.ts` `isVendorPath`, which already covers
 * `/vendor/…` sub-paths), so the 401 path here is the defensive /
 * expired-cookie / in-app-navigation case.
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
import { MetaService } from '../core/meta.service';
import { isVendorGateRejection, vendorNotFoundMarker } from './vendor-gate';

const VENDOR_ME_PATH = '/api/vendor/me';
const STATE_KEY = makeStateKey<VendorMeResponse | null>('aeci.vendor-me');

export const vendorMeResolver: ResolveFn<VendorMeResponse | null> = (route) => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const meta = inject(MetaService);
  const wantedSlug = route.paramMap.get('vendorSlug');
  // Built eagerly: it resolves the serving origin through `inject(REQUEST)`, and
  // every call site below is past an `await`. See `vendorNotFoundMarker`.
  const markNotFound = vendorNotFoundMarker(meta, wantedSlug ? `/vendor/${wantedSlug}` : '/vendor');

  /** The slug check, applied identically on both branches. */
  const forSlug = (me: VendorMeResponse): VendorMeResponse | null =>
    wantedSlug !== null && me.vendor.slug !== wantedSlug ? null : me;

  // ── Client path: hydration or in-app navigation. ──────────────────────────
  if (!isPlatformServer(platformId)) {
    if (transferState.hasKey(STATE_KEY)) {
      const cached = transferState.get(STATE_KEY, null);
      // The cached payload was already slug-checked server-side, but re-check it:
      // the key survives one navigation into the portal under a different slug.
      return cached && forSlug(cached) ? cached : markNotFound();
    }
    return resolveClient(inject(HttpClient), forSlug, markNotFound);
  }

  // ── Server path (RenderMode.Server). ──────────────────────────────────────
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  if (!ctx) {
    transferState.set(STATE_KEY, null);
    return null;
  }
  return resolveServer(ctx.api, transferState, responseInit, forSlug, markNotFound);
};

async function resolveServer(
  api: ServerApiClient,
  transferState: TransferState,
  responseInit: { status?: number } | null,
  forSlug: (me: VendorMeResponse) => VendorMeResponse | null,
  markNotFound: () => null,
): Promise<VendorMeResponse | null> {
  const reject = (): null => {
    transferState.set(STATE_KEY, null);
    if (responseInit) responseInit.status = 404;
    return markNotFound();
  };

  try {
    const me = await api.request<VendorMeResponse>(VENDOR_ME_PATH);
    if (!forSlug(me)) return reject();
    transferState.set(STATE_KEY, me);
    return me;
  } catch (err) {
    if (isServerApiError(err) && isVendorGateRejection(err.status)) return reject();
    throw err;
  }
}

async function resolveClient(
  http: HttpClient,
  forSlug: (me: VendorMeResponse) => VendorMeResponse | null,
  markNotFound: () => null,
): Promise<VendorMeResponse | null> {
  try {
    const me = await firstValueFrom(http.get<VendorMeResponse>(VENDOR_ME_PATH));
    return forSlug(me) ?? markNotFound();
  } catch (err) {
    if (err instanceof HttpErrorResponse && isVendorGateRejection(err.status)) {
      return markNotFound();
    }
    throw err;
  }
}
