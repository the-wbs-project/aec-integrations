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
 *   - 403 / 404 → authenticated, but NOT this vendor (a reviewer, a banned seat,
 *     a half-granted seat with a null `vendor_id`, or an admin — `requireVendor()`
 *     rejects site admins too). Set `RESPONSE_INIT.status = 404` + the noindex 404
 *     meta and return `null` so the page renders `<aec-not-found/>` — **don't
 *     reveal the surface** (mirrors the admin gate). The URL is left alone.
 *   - 403 `VENDOR_SUSPENDED` naming the slug in the URL → this caller's vendor is
 *     suspended. See "the suspended branch" below.
 *   - 401 → not authenticated at all; redirect to `/auth/login?return=<this url>`.
 *     See "the 401 branch" below.
 *   - 5xx → a real failure; rethrow (never fake a 404 on an outage).
 *
 * ── THE 401 BRANCH (AECI-954) ───────────────────────────────────────────────
 * A 401 used to take the not-found path with 403, which is what made an expired
 * vendor session render "Page not found" with no way out. The worker-level gate
 * (`server-runtime.ts` `isVendorPath`) only bounces visitors with NO session
 * cookie — `hasSessionCookie` is a presence check by design, no crypto and no
 * network — so a cookie holding an hour-old access token sails past it and lands
 * here.
 *
 * The two platforms answer it differently, and the asymmetry is the point:
 *
 *   - **Server.** The SSR gate already tried a refresh before the render
 *     (`server/auth/session-refresh.ts`), so a 401 here means it failed and the
 *     honest move is to hand the visitor to the login page. `@angular/ssr` turns the
 *     `RedirectCommand` into a real 302. `RESPONSE_INIT.status` is deliberately
 *     LEFT ALONE on this branch — the engine feeds it into its redirect-response
 *     builder, which rejects any status outside 301/302/303/307/308.
 *   - **Client.** The browser CAN recover: `@supabase/ssr` refreshes inside
 *     `getSession()` and rewrites the cookie, and the refresh token outlives the
 *     access token by weeks. So `hasLiveSession()` runs first; a session that
 *     survives it earns exactly one retry, and only a session that does not
 *     survive redirects. That ordering is also the loop breaker — see
 *     `auth/session-recovery.ts`.
 *
 * ── THE SUSPENDED BRANCH (AECI-1623) ────────────────────────────────────────
 * A suspended vendor's seats lose every portal read, and they must still be told why
 * and be able to cancel. So this one 403 does not blur into the 404: there is no surface
 * left to hide from a person who holds a seat on the vendor, and `details.vendor_slug`
 * proves they do. It returns a {@link VendorSuspendedGate}, which `VendorPage` renders as
 * `VendorSuspendedNotice`. The server sets status 403 and hands the marker through
 * TransferState. `VendorPage` sets the noindex head on this path.
 *
 * The slug must match the URL exactly, both ways. A slug that names another vendor takes
 * the not-found path, as a 200 payload does. So does a slug-less mount, which has nothing
 * to match. A banned seat answers a plain 403 before the suspension check, so it keeps
 * the 404.
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
 * Bundle-split note: errors are checked with `isServerApiError` (a structural
 * guard), never `instanceof` — the worker and Angular bundles hold separate class
 * identities (`server-api-client.ts`). `httpGetOrNull` can't be reused on the
 * client branch because it only maps a 404+NOT_FOUND envelope; the vendor gate
 * returns 401/403 too, mapped here to the redirect and the not-found render.
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
import { ResolveFn, Router, type RedirectCommand } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { VendorMeResponse } from '@aeci/shared';

import { isServerApiError, type ServerApiClient } from '../../server-api-client';
import type { AeciRequestContext } from '../../server/request-context';
import { AuthService } from '../auth/auth.service';
import { loginRedirect } from '../auth/login-redirect';
import { hasLiveSession } from '../auth/session-recovery';
import { MetaService } from '../core/meta.service';

import {
  isUnauthenticated,
  isVendorGateRejection,
  isVendorSuspendedGate,
  readVendorSuspended,
  vendorNotFoundMarker,
  type VendorSuspendedGate,
} from './vendor-gate';

const VENDOR_ME_PATH = '/api/vendor/me';
const STATE_KEY = makeStateKey<VendorMeResponse | VendorSuspendedGate | null>('aeci.vendor-me');

/** What the resolver hands back. `null` = render not-found in place. */
type VendorMeResolved = VendorMeResponse | VendorSuspendedGate | null | RedirectCommand;

export const vendorMeResolver: ResolveFn<VendorMeResponse | VendorSuspendedGate | null> = (
  route,
  state,
) => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const meta = inject(MetaService);
  const router = inject(Router);
  const wantedSlug = route.paramMap.get('vendorSlug');
  const path = wantedSlug ? `/vendor/${wantedSlug}` : '/vendor';
  // Built eagerly: it resolves the serving origin through `inject(REQUEST)`, and
  // every call site below is past an `await`. See `vendorNotFoundMarker`.
  const markNotFound = vendorNotFoundMarker(meta, path);
  // `state.url` is the whole in-app URL, so the bounce returns the visitor to the
  // exact section they aimed at rather than the portal root. It falls back to the
  // route's own path when the router state carries no URL (test hosts do this).
  const toLogin = (): RedirectCommand => loginRedirect(router, state.url || path);

  /** The slug check, applied identically on both branches. */
  const forSlug = (me: VendorMeResponse): VendorMeResponse | null =>
    wantedSlug !== null && me.vendor.slug !== wantedSlug ? null : me;

  /** The suspended marker when this error is one and it names the URL's vendor. */
  const suspendedHere = (err: unknown): VendorSuspendedGate | null => {
    const gate = readVendorSuspended(err);
    return gate && gate.vendorSlug === wantedSlug ? gate : null;
  };

  // ── Client path: hydration or in-app navigation. ──────────────────────────
  if (!isPlatformServer(platformId)) {
    if (transferState.hasKey(STATE_KEY)) {
      const cached = transferState.get(STATE_KEY, null);
      if (isVendorSuspendedGate(cached)) {
        return cached.vendorSlug === wantedSlug ? cached : markNotFound();
      }
      // The cached payload was already slug-checked server-side, but re-check it:
      // the key survives one navigation into the portal under a different slug.
      return cached && forSlug(cached) ? cached : markNotFound();
    }
    return resolveClient(
      inject(HttpClient),
      inject(AuthService),
      forSlug,
      suspendedHere,
      markNotFound,
      toLogin,
    );
  }

  // ── Server path (RenderMode.Server). ──────────────────────────────────────
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  if (!ctx) {
    transferState.set(STATE_KEY, null);
    return null;
  }
  return resolveServer(
    ctx.api,
    transferState,
    responseInit,
    forSlug,
    suspendedHere,
    markNotFound,
    toLogin,
  );
};

async function resolveServer(
  api: ServerApiClient,
  transferState: TransferState,
  responseInit: { status?: number } | null,
  forSlug: (me: VendorMeResponse) => VendorMeResponse | null,
  suspendedHere: (err: unknown) => VendorSuspendedGate | null,
  markNotFound: () => null,
  toLogin: () => RedirectCommand,
): Promise<VendorMeResolved> {
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
    if (!isServerApiError(err)) throw err;
    // No `responseInit.status` write here, and no TransferState handoff: this
    // response is a 302 and never renders a page. See the header.
    if (isUnauthenticated(err.status)) return toLogin();
    const suspended = suspendedHere(err);
    if (suspended) {
      transferState.set(STATE_KEY, suspended);
      if (responseInit) responseInit.status = 403;
      return suspended;
    }
    if (isVendorGateRejection(err.status)) return reject();
    throw err;
  }
}

async function resolveClient(
  http: HttpClient,
  auth: AuthService,
  forSlug: (me: VendorMeResponse) => VendorMeResponse | null,
  suspendedHere: (err: unknown) => VendorSuspendedGate | null,
  markNotFound: () => null,
  toLogin: () => RedirectCommand,
): Promise<VendorMeResolved> {
  const fetchMe = () => firstValueFrom(http.get<VendorMeResponse>(VENDOR_ME_PATH));
  const statusOf = (err: unknown): number | null =>
    err instanceof HttpErrorResponse ? err.status : null;

  try {
    return forSlug(await fetchMe()) ?? markNotFound();
  } catch (err) {
    const status = statusOf(err);
    if (status === null) throw err;
    const suspended = suspendedHere(err);
    if (suspended) return suspended;
    if (isVendorGateRejection(status)) return markNotFound();
    if (!isUnauthenticated(status)) throw err;

    // Repair a refreshable cookie, then retry ONCE. A session that does not
    // survive the probe is genuinely gone → login. One that does and still 401s
    // is authenticated but unauthorizable (the missing-`profiles`-row case), and
    // signing in again would not change that — so it takes the not-found render,
    // which is what keeps this from looping.
    if (!(await hasLiveSession(auth))) return toLogin();
    try {
      return forSlug(await fetchMe()) ?? markNotFound();
    } catch (retryErr) {
      const retryStatus = statusOf(retryErr);
      if (retryStatus === null) throw retryErr;
      const suspendedOnRetry = suspendedHere(retryErr);
      if (suspendedOnRetry) return suspendedOnRetry;
      if (isUnauthenticated(retryStatus) || isVendorGateRejection(retryStatus)) {
        return markNotFound();
      }
      throw retryErr;
    }
  }
}
