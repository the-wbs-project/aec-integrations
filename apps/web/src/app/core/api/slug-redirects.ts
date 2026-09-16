/**
 * Typed accessors for the retired-slug map (AECI-978 / `STAGE_3_SPEC.md` §2.6
 * option B).
 *
 * Both wrappers are called **only on the not-found branch** of a detail resolver.
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

/** The detail routes wired to the map. Mirrors the D1 CHECK and the shared enum. */
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
