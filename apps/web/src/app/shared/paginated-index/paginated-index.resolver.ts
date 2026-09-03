/**
 * Server-side prefetch of a listing page's FIRST page (AECI-746).
 *
 * ─── What was broken ────────────────────────────────────────────────────────
 *
 * `createPaginatedIndex` drives its data with `httpResource({ url: '/api/...' })`
 * — a RELATIVE URL. On production that fetch does not happen: `resource.error()`
 * goes truthy and `/products` plus every taxonomy browse page server-render their
 * "Couldn't load products. Refresh to try again." branch. Humans never saw it —
 * in a browser the same relative URL resolves against the page origin and works —
 * but every crawler was served that error document on its first pass. Googlebot
 * reached 177 of 1,445 sitemap URLs in August 2026 (12%) against Bingbot's 940
 * (65%); the ~80 hub pages it needed as entry points were all dead ends.
 *
 * ─── What is measured, and what is inferred ─────────────────────────────────
 *
 * **Measured, on production 2026-08-31:** the error copy in the HTML, zero
 * product names, a serialized `ng-state` containing NO fetched payload at all
 * (not the listing's and not the facet sidebar's), across 5/5 cache-busted
 * requests.
 *
 * **Inferred:** that the relative URL is why. The most likely mechanism is that a
 * Worker cannot usefully subrequest its own public hostname, so the resolved
 * `https://<host>/api/...` fetch fails at the edge. Note that **local `wrangler
 * dev` does NOT reproduce the failure** — there the relative URL resolves to
 * `http://localhost:<port>` and succeeds, which is precisely why this survived so
 * long. Do not treat a green local run as proof this route is healthy; run
 * `scripts/check-ssr-listings.sh` against a DEPLOYED environment.
 *
 * The fix is deliberately indifferent to which inference is right: it stops
 * depending on the relative URL at all.
 *
 * ─── Why a resolver, and not an HTTP interceptor ────────────────────────────
 *
 * An interceptor that answered relative `/api/*` GETs from the service binding is
 * the tidier-looking fix. It was tried and abandoned:
 *
 *   - SSR can serialize the HTML before `httpResource` settles, making the render
 *     a race against the fetch.
 *   - Blocking stability with `PendingTasks.add()` did not save it: the binding
 *     call made from inside the render failed with "Network connection lost",
 *     while the detail resolvers' calls to the SAME `ctx.api` succeeded in the
 *     same process. (Some of that was local-dev binding flakiness — see above
 *     about local not being a faithful environment — but the approach was
 *     unreliable enough to reject.)
 *
 * A `ResolveFn` runs inside route resolution, which the router awaits before it
 * renders — the same window `create-detail-resolver.ts` and
 * `taxonomy-browse.resolver.ts` have always used, and which works in production
 * today for every detail page. That is the strongest available evidence that this
 * path is sound where it matters.
 *
 * ─── The contract with `server-api-interceptor.ts` ──────────────────────────
 *
 * This resolver only *stores*. `serverApiInterceptor` is what *serves*: it answers
 * any relative `/api/*` GET whose request line is already in `TransferState`
 * without touching the network, on the server and again on the client during
 * hydration. Neither half calls the network from inside the render.
 *
 * The two are joined by the request line, and that string has to match exactly.
 * That is why both go through `indexRequestLine()` / `buildIndexParams()` in
 * `paginated-index-controller.ts` rather than each formatting their own URL, and
 * why those functions build the query with Angular's own `HttpParams` — so the
 * encoding cannot drift from what `HttpRequest.urlWithParams` produces.
 *
 * ─── Deliberately page 1 only ───────────────────────────────────────────────
 *
 * `mode: 'append'` listings load pages 2..N client-side as the reader scrolls,
 * and a crawler that does not run our JavaScript never asks for them. Prefetching
 * more would inflate every edge-cached document for nobody's benefit. A crawler
 * that wants the rest follows `pagination-footer`'s real `?page=N+1` anchor,
 * which server-renders through this same resolver.
 */

import { isPlatformServer } from '@angular/common';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, inject, makeStateKey } from '@angular/core';
import type { ParamMap, ResolveFn } from '@angular/router';

import type { AeciRequestContext } from '../../../server/request-context';

import {
  type PaginatedIndexRequestConfig,
  buildIndexParams,
  indexRequestLine,
  parseIndexPage,
} from './paginated-index-request';

// One key function, imported — never a second copy that agrees by coincidence.
import { apiStateKey } from '../../core/server-api-interceptor';

/**
 * Builds the SSR prefetch resolver for one listing surface.
 *
 * `config` must be the SAME object the component hands `createPaginatedIndex` —
 * pass a shared constant, never a second literal that happens to look alike, or
 * `baseParams`/`passthroughParams` can diverge and the prefetch silently misses.
 */
export function createPaginatedIndexResolver(
  config: PaginatedIndexRequestConfig,
): ResolveFn<boolean> {
  return async (route) => {
    // Client navigations already have a working relative URL; there is nothing to
    // prefetch and the component's own `httpResource` is the right fetcher.
    if (!isPlatformServer(inject(PLATFORM_ID))) return true;

    const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
    if (!ctx) return true;

    await prefetchIndexPage(ctx, inject(TransferState), config, route.queryParamMap);
    return true;
  };
}

/**
 * The prefetch itself, callable directly.
 *
 * Exported because the taxonomy browse grid cannot use a sibling resolver: its
 * request is scoped to `term.id`, and resolvers on one route run in PARALLEL, so
 * a sibling would build its URL before the term existed.
 * `taxonomy-browse.resolver.ts` therefore calls this after its own fetch.
 *
 * **Fails open, deliberately.** A listing whose prefetch failed still renders —
 * the client fetches on hydration exactly as it did before this existed — whereas
 * a resolver that rejects takes the whole route down. The cost of a miss is one
 * unindexable page; the cost of a throw is a 500.
 */
export async function prefetchIndexPage(
  ctx: AeciRequestContext,
  transferState: TransferState,
  config: PaginatedIndexRequestConfig,
  qp: ParamMap,
): Promise<void> {
  try {
    // `?page=` is honoured for BOTH modes. In append mode the component starts its
    // buffer at the same page (`firstPage`), so a crawler following the footer's
    // `?page=2` anchor gets page 2 server-rendered, not page 1.
    //
    // Building the request line sits INSIDE the try with the fetch. It reads
    // `config.baseParams()`, which is caller-supplied, so it is not guaranteed
    // total — and a throw here would take down a route that renders perfectly
    // well without any prefetch at all.
    const params = buildIndexParams(config, qp, { page: parseIndexPage(qp.get('page')) });
    const requestLine = indexRequestLine(config, params);
    const body = await ctx.api.request<unknown>(requestLine);
    transferState.set(makeStateKey<unknown>(apiStateKey(requestLine)), body);
  } catch {
    // See the note above: silence here is the correct behaviour, not an oversight.
  }
}
