/**
 * Resolver for `/admin` (AECI-203 / Phase 5.12) — the admin-surface gate + the
 * shell's pending-count badge, in one authenticated call.
 *
 * `/admin/*` is non-cacheable (fail-closed classifier) and renders
 * `RenderMode.Server`, so the server branch has `REQUEST_CONTEXT` (whose `api`
 * client the SSR Worker built with the inbound session cookie forwarded — see
 * `server-runtime.ts` / `createServerApiClient`'s `forwardCookieFrom`). It calls
 * `GET /api/admin/summary`, which is gated by `requireAdmin()`:
 *
 *   - 200 → the caller is an admin; store `{ pending_reviews }` in TransferState
 *     and return it. The shell renders the nav + badge.
 *   - 403 / 404 → authenticated, but NOT an admin. Set `RESPONSE_INIT.status = 404`
 *     + the noindex 404 meta and return `null` so the shell renders
 *     `<aec-not-found/>` — **don't reveal the surface** (§7.1). This mirrors the
 *     entity-detail NOT_FOUND pattern (`create-detail-resolver.ts`).
 *   - 401 → not authenticated at all; redirect to `/auth/login?return=<this url>`.
 *     See "the 401 branch" below.
 *   - 5xx → a real failure; rethrow (never fake a 404 on an outage).
 *
 * ── THE 401 BRANCH (AECI-954) ───────────────────────────────────────────────
 * A 401 used to take the not-found path with 403, which dead-ended an operator
 * whose access token had aged out on "Page not found" with nothing to click. The
 * worker-level gate (`server-runtime.ts` `isAdminPath`) only bounces visitors
 * with NO session cookie — `hasSessionCookie` is a presence check by design, no
 * crypto and no network — so an expired token sails past it and lands here.
 *
 * 401 and 403 are different questions. 403 says "you are not an admin", which is
 * the answer §7.1 exists to blur. 401 says "you are nobody", about which the site
 * is already loud: the worker gate sends a cookie-less visitor straight to
 * `/auth/login`, so routing a 401 there discloses nothing new.
 *
 * Most expired tokens never reach this branch: the SSR gate refreshes an
 * expired-but-refreshable session before the render and forwards the new cookie
 * (`server/auth/session-refresh.ts`). A 401 here means that refresh failed.
 *
 * The two platforms answer it differently. The server has already tried its
 * refresh, so it redirects; `@angular/ssr` turns that `RedirectCommand` into
 * a real 302, and `RESPONSE_INIT.status` is deliberately LEFT ALONE on the branch
 * because the engine feeds it into its redirect-response builder, which rejects
 * any status outside 301/302/303/307/308. The browser CAN recover — `@supabase/ssr`
 * refreshes inside `getSession()` and rewrites the cookie — so the client probes
 * with `hasLiveSession()`, retries once when a session survives, and redirects
 * only when one does not. That ordering is also the loop breaker: a verified JWT
 * with no `profiles` row 401s forever, and signing in again would not fix it, so
 * it falls through to the not-found render instead (`auth/session-recovery.ts`).
 *
 * Client / SPA-nav branch: hydration reuses the SSR-stored value; a genuine
 * client navigation (no TransferState key) fetches the same endpoint via the
 * same-origin `/api/*` passthrough (cookies auto-sent). `httpGetOrNull` only maps
 * a 404+NOT_FOUND envelope to null, so it can't be reused here — the admin gate
 * returns 401/403, which we map to the redirect and the not-found render.
 *
 * Bundle-split note: errors are checked with `isServerApiError` (a structural
 * guard), never `instanceof` — the worker and Angular bundles hold separate
 * class identities (`server-api-client.ts`).
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

import type { AdminSummaryResponse } from '@aeci/shared';

import { isServerApiError, type ServerApiClient } from '../../server-api-client';
import type { AeciRequestContext } from '../../server/request-context';
import { AuthService } from '../auth/auth.service';
import { loginRedirect } from '../auth/login-redirect';
import { hasLiveSession } from '../auth/session-recovery';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

const ADMIN_SUMMARY_PATH = '/api/admin/summary';
const STATE_KEY = makeStateKey<AdminSummaryResponse | null>('aeci.admin-summary');

/** Treat a 403 (and a defensive 404) from the admin gate as "render the
 *  not-found shell" — same UX whether the caller is a reviewer or banned.
 *  401 is NOT here: see the header's 401 branch. */
function notAuthorized(status: number): boolean {
  return status === 403 || status === 404;
}

/** The caller is not authenticated at all — no token, an unverifiable one, or a
 *  verified one with no `profiles` row. Bounce to login, not to not-found. */
function unauthenticated(status: number): boolean {
  return status === 401;
}

type AdminSummaryResolved = AdminSummaryResponse | null | RedirectCommand;

export const adminSummaryResolver: ResolveFn<AdminSummaryResponse | null> = (_route, state) => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const meta = inject(MetaService);
  const router = inject(Router);
  const canonical = canonicalUrl('/admin');
  const markNotFound = (): null => {
    meta.setNotFoundMeta({ kind: 'index', slug: '', canonical });
    return null;
  };
  // `state.url` carries the whole admin path, so the bounce returns the operator
  // to the screen they aimed at rather than the console root.
  const toLogin = (): RedirectCommand => loginRedirect(router, state.url || '/admin');

  // ── Client path: hydration or in-app navigation. ──────────────────────────
  if (!isPlatformServer(platformId)) {
    if (transferState.hasKey(STATE_KEY)) {
      const cached = transferState.get(STATE_KEY, null);
      return cached ?? markNotFound();
    }
    return resolveClient(inject(HttpClient), inject(AuthService), markNotFound, toLogin);
  }

  // ── Server path (RenderMode.Server). ──────────────────────────────────────
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  if (!ctx) {
    transferState.set(STATE_KEY, null);
    return null;
  }
  return resolveServer(ctx.api, transferState, responseInit, markNotFound, toLogin);
};

async function resolveServer(
  api: ServerApiClient,
  transferState: TransferState,
  responseInit: { status?: number } | null,
  markNotFound: () => null,
  toLogin: () => RedirectCommand,
): Promise<AdminSummaryResolved> {
  const reject = (): null => {
    transferState.set(STATE_KEY, null);
    if (responseInit) responseInit.status = 404;
    return markNotFound();
  };

  try {
    const summary = await api.request<AdminSummaryResponse>(ADMIN_SUMMARY_PATH);
    transferState.set(STATE_KEY, summary);
    return summary;
  } catch (err) {
    if (!isServerApiError(err)) throw err;
    // No `responseInit.status` write here, and no TransferState handoff: this
    // response is a 302 and never renders a page. See the header.
    if (unauthenticated(err.status)) return toLogin();
    if (notAuthorized(err.status)) return reject();
    throw err;
  }
}

async function resolveClient(
  http: HttpClient,
  auth: AuthService,
  markNotFound: () => null,
  toLogin: () => RedirectCommand,
): Promise<AdminSummaryResolved> {
  const fetchSummary = () => firstValueFrom(http.get<AdminSummaryResponse>(ADMIN_SUMMARY_PATH));
  const statusOf = (err: unknown): number | null =>
    err instanceof HttpErrorResponse ? err.status : null;

  try {
    return await fetchSummary();
  } catch (err) {
    const status = statusOf(err);
    if (status === null) throw err;
    if (notAuthorized(status)) return markNotFound();
    if (!unauthenticated(status)) throw err;

    // Repair a refreshable cookie, then retry ONCE. A still-401 retry renders
    // not-found rather than redirecting again — that is the loop breaker.
    if (!(await hasLiveSession(auth))) return toLogin();
    try {
      return await fetchSummary();
    } catch (retryErr) {
      const retryStatus = statusOf(retryErr);
      if (retryStatus === null) throw retryErr;
      if (unauthenticated(retryStatus) || notAuthorized(retryStatus)) return markNotFound();
      throw retryErr;
    }
  }
}
