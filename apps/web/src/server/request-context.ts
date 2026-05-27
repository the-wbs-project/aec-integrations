/**
 * Per-request mutable side-channel between Angular SSR resolvers and the
 * SSR Worker runtime. The runtime creates one per request and passes it as
 * the second arg to `AngularAppEngine.handle(req, ctx)`. Angular wires it
 * into DI via the built-in `REQUEST_CONTEXT` token from `@angular/core`
 * whenever `RenderMode.Server` is in effect (verified at
 * `@angular/ssr@21.2.10` `fesm2022/ssr.mjs:1270`).
 *
 * Three things are modelled here because Angular's own SSR plumbing doesn't
 * expose a clean place for them:
 *
 *   1. `api` — a typed `ServerApiClient` over the Cloudflare service binding.
 *      Resolvers must call the API via this (NOT the public `/api/*` proxy)
 *      per the Phase 2 §3.1 / §6.2 "no public API surface" contract. The
 *      Worker constructs one per request from `env.API`.
 *
 *   2. `embedded` — additional `Cache-Tag` entities the resolver knows about
 *      after fetching data (the vendor displayed on a product detail page,
 *      each shown integration). `cacheTagInputsForPath` is path-only and
 *      can't know these; the runtime merges this array in before writing
 *      the header.
 *
 *   3. `pageView` — fire-and-forget payload for `POST /api/page-views`
 *      (Phase 2 no-op; Phase 4 wires the write). The runtime turns it into
 *      `executionCtx.waitUntil(env.API.fetch(...))` after the response is
 *      built. Only fires on 2xx so 404/5xx renders don't pollute view counts.
 *
 * HTTP response status is NOT here. Angular ships a `RESPONSE_INIT` token
 * (`{ status, headers }`) that's already mutable from a resolver, and the
 * SSR runtime's `withCacheHeaders` already routes a 404 status to
 * `NOT_FOUND_TTL`. No duplication needed.
 */
import type { PageViewPayload } from '@aeci/shared';

import type { ServerApiClient } from '../server-api-client';
import type { CacheTagEntity } from './cache-tags';

export type { PageViewPayload };

export interface AeciRequestContext {
  readonly api: ServerApiClient;
  embedded: CacheTagEntity[];
  pageView: PageViewPayload | null;
}

export function createRequestContext(api: ServerApiClient): AeciRequestContext {
  return { api, embedded: [], pageView: null };
}
