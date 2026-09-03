/**
 * Typed accessor for the product-PAIR read (apps/api
 * `GET /api/products/:slug/integrations/:otherSlug` — Stage 1.5 §7 / AECI-294).
 * Wraps `ServerApiClient.request<T>` so the SSR resolver stays free of
 * stringly-typed paths and `NOT_FOUND` envelope decoding, mirroring
 * `fetchProductBySlug` / `fetchIntegrationById`.
 *
 * The SSR resolver branch calls this over the service binding; the browser
 * hydration-miss branch fetches the same endpoint via the same-origin `/api/*`
 * passthrough (`http-get-or-null.ts`), not this client.
 */
import type { PairTimelineResponse, ProductPairResponse } from '@aeci/shared';
import type { HttpClient } from '@angular/common/http';

import type { ServerApiClient } from '../../../server-api-client';
import { fetchOrNull } from './fetch-or-null';
import { httpGetOrNull } from './http-get-or-null';

/**
 * The reader's version selection, as it arrives from the URL (AECI-303 / §9).
 * Both sides optional: absent means "latest", which the API resolves.
 */
export interface PairVersionSelectionParams {
  readonly contextVersion?: string | null;
  readonly otherVersion?: string | null;
}

/**
 * Build the pair read's path, appending only the selection params that are set.
 *
 * **A default selection must produce the BARE path**, with no query string at all.
 * That is what lets the default render share one API response and one
 * `TransferState` slot with an unparameterised visit, and it mirrors the SSR
 * Worker's `cacheKeyFor`, which drops an absent param rather than encoding an empty
 * one. Exported for the timeline sibling and the resolver's spec.
 */
export function pairPath(
  contextSlug: string,
  otherSlug: string,
  selection: PairVersionSelectionParams | undefined,
  suffix = '',
): string {
  // Slugs are `encodeURIComponent`-encoded defensively — real slugs are already
  // URL-safe (lowercase, hyphens), but a leaked malformed param must not produce a
  // broken path.
  const base = `/api/products/${encodeURIComponent(contextSlug)}/integrations/${encodeURIComponent(
    otherSlug,
  )}${suffix}`;
  const query = new URLSearchParams();
  if (selection?.contextVersion) query.set('context_version', selection.contextVersion);
  if (selection?.otherVersion) query.set('other_version', selection.otherVersion);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

/**
 * Fetch the consolidated pair for `contextSlug` (the page's context product) and
 * `otherSlug`. Returns `null` on the canonical `NOT_FOUND` envelope — either slug
 * unknown, or the two equal — so the resolver renders the 404 shell; any other
 * API error rethrows. A valid-but-unconnected pair is a 200 with an empty
 * `mechanisms` list, not a `null`.
 *
 * `selection` carries the §9 version selectors. An unknown or renamed label is NOT
 * an error: the API degrades it to latest and echoes what it resolved in
 * `version_diff.selected`, so this never returns `null` for a bad label.
 */
export async function fetchProductPair(
  client: ServerApiClient,
  contextSlug: string,
  otherSlug: string,
  selection?: PairVersionSelectionParams,
): Promise<ProductPairResponse | null> {
  return fetchOrNull<ProductPairResponse>(client, pairPath(contextSlug, otherSlug, selection));
}

/**
 * Fetch the pair's per-claim attestation histories (AECI-303 / §9.1).
 *
 * **Browser-only, and deliberately so.** It takes an `HttpClient` rather than the SSR
 * `ServerApiClient` because there is no SSR caller: history is the gateable depth
 * (§9.3) and the pair page lands in a shared, URL-keyed edge cache. AECI-304 kept the
 * gate URL-derived (it reads the PAIR'S vendors, not the reader), so §9.1a holds
 * either way — but the history stays out of the SSR payload because it is also the
 * one unbounded response in the system. It goes through the same-origin `/api/*`
 * passthrough, whose responses are `private, no-store`.
 *
 * Unversioned: the history is the whole append-only log, independent of which version
 * pair is selected.
 */
export async function fetchPairTimeline(
  http: HttpClient,
  contextSlug: string,
  otherSlug: string,
): Promise<PairTimelineResponse | null> {
  return httpGetOrNull<PairTimelineResponse>(
    http,
    pairPath(contextSlug, otherSlug, undefined, '/timeline'),
  );
}
