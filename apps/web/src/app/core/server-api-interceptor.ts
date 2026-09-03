/**
 * Serves relative `/api/*` GETs from `TransferState` when a resolver already
 * fetched them (AECI-746).
 *
 * ─── What this is half of ───────────────────────────────────────────────────
 *
 * `createPaginatedIndexResolver` (see `shared/paginated-index/paginated-index.resolver.ts`)
 * fetches a listing's first page through the Cloudflare service binding during
 * route resolution and parks the body in `TransferState`, keyed by the exact
 * request line the component is about to ask for. This interceptor is the other
 * half: it answers that request without touching the network.
 *
 * It fires twice for one page load, and both matter:
 *
 *   1. **On the server**, so the `httpResource` inside `createPaginatedIndex`
 *      resolves synchronously and the products are in the serialized HTML. Before
 *      this, they were not — `/products` shipped 62KB containing the string
 *      "Couldn't load products. Refresh to try again." and zero product names, to
 *      every crawler, every time.
 *   2. **On the client during hydration**, so the browser does not immediately
 *      refetch what the server already sent it. That is the property
 *      `paginated-index-controller.ts` has always claimed ("keeps that key
 *      byte-identical between server and client so the client doesn't re-fetch on
 *      hydration") and never had.
 *
 * ─── Why not just call the binding from here ────────────────────────────────
 *
 * That was the first attempt and it was abandoned. `httpResource` fires from an
 * effect during rendering; SSR can serialize before it settles, and a binding
 * fetch started there failed with "Network connection lost" even with
 * `PendingTasks.add()` holding stability. Route resolution is a window that works
 * in production today (every detail page depends on it); rendering is not a
 * window we could make behave. So the network call lives in the resolver and this
 * file never makes one.
 *
 * **Local `wrangler dev` does not reproduce the production failure** — relative
 * `/api/*` URLs resolve to `localhost` there and succeed. A green local run
 * proves this code does no harm; it does not prove the route is fixed. Verify
 * with `scripts/check-ssr-listings.sh` against a deployed environment.
 *
 * ─── Three properties that must not be refactored away ──────────────────────
 *
 * **Relative URLs only.** An absolute `https://…` URL is a deliberate call to
 * somewhere else and must reach the real backend untouched. The guard is
 * `startsWith('/api/')` on `urlWithParams`, which is false for any absolute URL.
 *
 * **GET only.** These are reads. Answering a POST from a cache would be a
 * correctness bug, and the resolvers queue a fire-and-forget
 * `POST /api/page-views` that must never be intercepted.
 *
 * **A miss falls through to `next(req)`.** No entry means no prefetch ran — a
 * client navigation, a route without the resolver, or a prefetch that failed
 * open. All three must behave exactly as they did before this file existed.
 *
 * ─── Why the client REMOVES and the server does not ─────────────────────────
 *
 * The server must leave the entry in place or it never gets serialized into
 * `ng-state` and the client half has nothing to read. The client must remove it,
 * so the payload is spent exactly once: a later in-app navigation back to the
 * same URL has to hit the network for live data rather than replay a snapshot of
 * what the page looked like when it was rendered — which, on an edge-cached page,
 * may have been rendered for somebody else hours ago.
 */

import { isPlatformServer } from '@angular/common';
import { type HttpEvent, type HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { PLATFORM_ID, TransferState, inject, makeStateKey } from '@angular/core';
import { type Observable, of } from 'rxjs';

/** The one prefix this interceptor claims. Relative by construction: an absolute
 *  URL starts with a scheme, so it can never match. */
const API_PREFIX = '/api/';

/**
 * The `TransferState` key for a request line, as a plain string.
 *
 * Returns the string rather than a `StateKey` so the resolver and the interceptor
 * cannot end up with two `makeStateKey` calls that drift apart; each wraps this in
 * `makeStateKey` at the point of use. The key IS the full request line
 * (`/api/products?page=1&perPage=24&sort=created`), so a payload can never answer
 * a different question than the one asked.
 */
export function apiStateKey(urlWithParams: string): string {
  return `aeci.api:${urlWithParams}`;
}

export const serverApiInterceptor: HttpInterceptorFn = (
  req,
  next,
): Observable<HttpEvent<unknown>> => {
  if (req.method !== 'GET') return next(req);

  // `urlWithParams` — not `url` — because the query string IS the request here:
  // page, perPage, sort, and the taxonomy cross-filters all ride on it.
  const path = req.urlWithParams;
  if (!path.startsWith(API_PREFIX)) return next(req);

  const transferState = inject(TransferState);
  const stateKey = makeStateKey<unknown>(apiStateKey(path));
  if (!transferState.hasKey(stateKey)) return next(req);

  const body = transferState.get(stateKey, null);
  if (!isPlatformServer(inject(PLATFORM_ID))) transferState.remove(stateKey);

  return of(new HttpResponse<unknown>({ body, status: 200, statusText: 'OK', url: path }));
};
