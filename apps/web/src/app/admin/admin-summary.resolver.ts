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
 *   - 401 / 403 → NOT an admin (or no session). Set `RESPONSE_INIT.status = 404`
 *     + the noindex 404 meta and return `null` so the shell renders
 *     `<aec-not-found/>` — **don't reveal the surface** (§7.1). This mirrors the
 *     entity-detail NOT_FOUND pattern (`create-detail-resolver.ts`).
 *   - 5xx → a real failure; rethrow (never fake a 404 on an outage).
 *
 * A genuine logged-out visitor is bounced to `/auth/login` by the worker-level
 * gate before SSR (`server-runtime.ts` `isAdminPath`), so the 401 path here is
 * the defensive/expired-cookie case.
 *
 * Client / SPA-nav branch: hydration reuses the SSR-stored value; a genuine
 * client navigation (no TransferState key) fetches the same endpoint via the
 * same-origin `/api/*` passthrough (cookies auto-sent). `httpGetOrNull` only maps
 * a 404+NOT_FOUND envelope to null, so it can't be reused here — the admin gate
 * returns 401/403, which we map to the same not-found render.
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
import { ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { AdminSummaryResponse } from '@aeci/shared';

import { isServerApiError, type ServerApiClient } from '../../server-api-client';
import type { AeciRequestContext } from '../../server/request-context';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

const ADMIN_SUMMARY_PATH = '/api/admin/summary';
const STATE_KEY = makeStateKey<AdminSummaryResponse | null>('aeci.admin-summary');

/** Treat a 401/403 (and a defensive 404) from the admin gate as "render the
 *  not-found shell" — same UX whether the caller is anon, a reviewer, or banned. */
function notAuthorized(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export const adminSummaryResolver: ResolveFn<AdminSummaryResponse | null> = () => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const meta = inject(MetaService);
  const canonical = canonicalUrl('/admin');
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
): Promise<AdminSummaryResponse | null> {
  try {
    const summary = await api.request<AdminSummaryResponse>(ADMIN_SUMMARY_PATH);
    transferState.set(STATE_KEY, summary);
    return summary;
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
): Promise<AdminSummaryResponse | null> {
  try {
    return await firstValueFrom(http.get<AdminSummaryResponse>(ADMIN_SUMMARY_PATH));
  } catch (err) {
    if (err instanceof HttpErrorResponse && notAuthorized(err.status)) {
      return markNotFound();
    }
    throw err;
  }
}
