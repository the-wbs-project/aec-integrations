/**
 * Typed accessors for the retired-slug map (AECI-978 / `STAGE_3_SPEC.md` §2.6
 * option B).
 *
 * Both wrappers are called **only on the not-found branch** of a resolver: the
 * detail resolvers, the product-pair resolver, and (AECI-979) the taxonomy browse
 * resolver.
 * That ordering is the correctness rule, not an optimisation: a live row must always
 * beat a redirect, which is what lets a mapping be deployed ahead of the data op that
 * retires the row (see `apps/api/src/db/schema.ts`).
 *
 * The SSR wrapper mirrors `core/api/products.ts` (service binding); the browser one
 * mirrors the resolvers' hydration-miss branch (the same-origin `/api/*`
 * passthrough, ADR 0001). Both map the `NOT_FOUND` envelope to `null`, which here
 * means "no redirect — serve the ordinary 404" and is the common answer.
 */
import type { HttpClient } from '@angular/common/http';

import type { SlugRedirect } from '@aeci/shared';

import type { ServerApiClient } from '../../../server-api-client';
import { fetchOrNull } from './fetch-or-null';
import { httpGetOrNull } from './http-get-or-null';

/** The routes wired to the map: two detail kinds and the four taxonomy kinds.
 *  Mirrors the D1 CHECK and the shared enum. */
export type RedirectableEntity = SlugRedirect['entity'];

/** Path for both transports, so the two can never disagree about the URL. */
function slugRedirectPath(entity: RedirectableEntity, fromSlug: string): string {
  return `/api/slug-redirects/${entity}/${encodeURIComponent(fromSlug)}`;
}

/** SSR lookup over the service binding. `null` = no mapping. */
export async function fetchSlugRedirect(
  client: ServerApiClient,
  entity: RedirectableEntity,
  fromSlug: string,
): Promise<SlugRedirect | null> {
  return fetchOrNull<SlugRedirect>(client, slugRedirectPath(entity, fromSlug));
}

/** Browser lookup over the same-origin `/api/*` passthrough. `null` = no mapping. */
export async function httpGetSlugRedirect(
  http: HttpClient,
  entity: RedirectableEntity,
  fromSlug: string,
): Promise<SlugRedirect | null> {
  return httpGetOrNull<SlugRedirect>(http, slugRedirectPath(entity, fromSlug));
}

/**
 * Run a retired-slug lookup, swallowing everything except its answer.
 *
 * `fetchOrNull` / `httpGetOrNull` map a `NOT_FOUND` envelope to `null` and RETHROW
 * anything else — correct for an entity read, wrong here. This call is a lookup on a
 * request that has already decided to 404: if the map is unreachable, or the API
 * Worker predates the endpoint and answers 404 without the envelope, or D1 is having
 * a bad minute, the right outcome is the ordinary 404 page. Letting it throw would
 * turn a cheap, edge-cacheable 404 into an SSR render failure — a strictly worse
 * page, caused by an enhancement that only ever applies to a handful of slugs.
 *
 * Deliberately silent rather than logged: this runs once per detail 404, and detail
 * 404s are overwhelmingly crawler noise, so a log line here is a log flood with no
 * reader behind it. The redirect's own correctness is covered by tests and by the
 * `slug_redirects` read being trivial.
 *
 * Shared by `createDetailResolver` and the pair resolver (AECI-991), which apply the
 * same map at their own not-found branches.
 */
export async function lookUpRedirect<T>(lookup: () => Promise<T | null>): Promise<T | null> {
  try {
    return await lookup();
  } catch {
    return null;
  }
}

/**
 * The pair-page path a moved pair redirects to. One spelling for both branches, so the
 * `Location` header and the client-side `navigateByUrl` can never disagree.
 *
 * The API has already oriented the two slugs for the requesting URL, so this does NOT
 * canonicalise them — the endpoint the reader asked for stays in frame, and the new
 * page's own `<link rel=canonical>` handles the alphabetical rule (§7.1/§11.2).
 */
export function movedPairPath(movedTo: { context_slug: string; other_slug: string }): string {
  return `/products/${movedTo.context_slug}/integrations/${movedTo.other_slug}`;
}

/**
 * Apply the retired-slug map to the two slugs of a pair URL (AECI-991).
 *
 * `null` when neither slug is mapped (the ordinary case — most pair 404s are junk),
 * or when the rewrite would name a pair whose two endpoints are the same product.
 *
 * Both lookups go out in ONE wave. They are independent, this request has already
 * decided to 404, and serialising them would double the latency of a page nobody is
 * being shown.
 */
export async function rewriteRetiredPairSlugs(
  contextSlug: string,
  otherSlug: string,
  lookup: (slug: string) => Promise<{ to_slug: string } | null>,
): Promise<{ context_slug: string; other_slug: string } | null> {
  const [context, other] = await Promise.all([
    lookUpRedirect(() => lookup(contextSlug)),
    lookUpRedirect(() => lookup(otherSlug)),
  ]);
  if (!context && !other) return null;
  const nextContext = context?.to_slug ?? contextSlug;
  const nextOther = other?.to_slug ?? otherSlug;
  // A merge whose survivor is the pair's OTHER endpoint — the two products are now
  // one, there is no pair, and the API 404s equal slugs by definition.
  if (nextContext === nextOther) return null;
  return { context_slug: nextContext, other_slug: nextOther };
}

/**
 * `Cache-Control` for a retired-slug 301 (AECI-978).
 *
 * The same `public, max-age=3600, s-maxage=86400` every other permanent redirect in
 * the app carries: the SSR Worker's `/integrations/:id` and `/disciplines` routes,
 * and AECI-953's moved-pair 301. A redirect is a mapping, not content. It changes
 * only when an operator edits `slug_redirects`, and the `Cache-Tag` is the handle for
 * that. No `stale-while-revalidate`: redirects deliberately omit it.
 *
 * Written as a literal because `buildCacheControl` lives in `server-runtime.ts`,
 * which app code cannot import (it pulls in the Worker `Bindings` types).
 */
export const SLUG_REDIRECT_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';

/**
 * Turn the SSR response into a retired-slug 301 (`CACHE_STRATEGY.md` §3 rule 6).
 * Shared by `createDetailResolver` and the taxonomy browse resolver (AECI-979) so
 * the two cannot drift on the header set.
 *
 *   - `Location` is the caller's: the detail routes drop the query, the browse routes
 *     keep the cache-key params, and only the caller knows which applies.
 *   - `Cache-Control` is set HERE rather than left to the SSR Worker, because
 *     `withCacheHeaders` hands a 3xx to `ensureNoStore`, which only fills in a
 *     MISSING directive. Without it a permanent mapping re-renders on every hit.
 *   - `Cache-Tag` carries BOTH slugs. `{to}` purges when the survivor changes;
 *     `{from}` purges when the retired row COMES BACK, which a re-promote of that
 *     slug signals with its own tag and nothing else.
 *
 * `ResponseInit.headers` is typed `HeadersInit | undefined`, though `@angular/ssr`
 * always builds a real `Headers` and hands the SAME object to DI and the final
 * `new Response(...)`. Normalising rather than casting keeps that an assumption we
 * can be wrong about without losing the headers.
 */
export function setSlugRedirectResponse(
  responseInit: ResponseInit,
  redirect: { location: string; entity: RedirectableEntity; fromSlug: string; toSlug: string },
): void {
  responseInit.status = 301;
  const headers = responseInit.headers instanceof Headers ? responseInit.headers : new Headers();
  responseInit.headers = headers;
  headers.set('Location', redirect.location);
  headers.set('Cache-Control', SLUG_REDIRECT_CACHE_CONTROL);
  headers.set(
    'Cache-Tag',
    `${redirect.entity}:${redirect.fromSlug},${redirect.entity}:${redirect.toSlug}`,
  );
}
