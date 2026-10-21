/**
 * Per-request mutable side-channel between Angular SSR resolvers and the
 * SSR Worker runtime. The runtime creates one per request and passes it as
 * the second arg to `AngularAppEngine.handle(req, ctx)`. Angular wires it
 * into DI via the built-in `REQUEST_CONTEXT` token from `@angular/core`
 * whenever `RenderMode.Server` is in effect (verified at
 * `@angular/ssr@21.2.10` `fesm2022/ssr.mjs:1270`).
 *
 * Two things are modelled here because Angular's own SSR plumbing doesn't
 * expose a clean place for them:
 *
 *   1. `api` — a typed `ServerApiClient` over the Cloudflare service binding.
 *      The SSR resolver branch fetches the page's data through this; the Worker
 *      constructs one per request from `env.API`. A genuine client-side
 *      navigation has no `REQUEST_CONTEXT`, so its resolver branch fetches the
 *      same endpoints from the browser via the SSR Worker's same-origin
 *      `/api/*` passthrough (see `app/core/api/http-get-or-null.ts`). "No public
 *      API surface" (Phase 2 Spec §2/§7) means no separately-exposed API
 *      product and no ingress on the API Worker's own hostname — NOT "the
 *      browser may never read `/api/*`" (the index pages already do, via
 *      `httpResource`; ADR 0001 §Consequences sanctions the passthrough).
 *
 *   2. `embedded` — additional `Cache-Tag` entities the resolver knows about
 *      after fetching data (the vendor displayed on a product detail page,
 *      each shown integration). `cacheTagInputsForPath` is path-only and
 *      can't know these; the runtime merges this array in before writing
 *      the header.
 *
 * There is no page-view field. A resolver runs only on a cache MISS, so since
 * AECI-1297 the gateway writes the arrival from the path, on a HIT and a MISS
 * alike, and the API resolves the entity id from that path.
 *
 * HTTP response status is NOT here. Angular ships a `RESPONSE_INIT` token
 * (`{ status, headers }`) that's already mutable from a resolver, and the
 * SSR runtime's `withCacheHeaders` already routes a 404 status to
 * `NOT_FOUND_TTL`. No duplication needed.
 */
import type { ServerApiClient } from '../server-api-client';
import type { CacheTagEntity } from './cache-tags';

export interface AeciRequestContext {
  readonly api: ServerApiClient;
  embedded: CacheTagEntity[];
}

export function createRequestContext(api: ServerApiClient): AeciRequestContext {
  return { api, embedded: [] };
}
