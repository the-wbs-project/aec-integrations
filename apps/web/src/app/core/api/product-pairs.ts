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
import type { ProductPairResponse } from '@aeci/shared';

import type { ServerApiClient } from '../../../server-api-client';
import { fetchOrNull } from './fetch-or-null';

/**
 * Fetch the consolidated pair for `contextSlug` (the page's context product) and
 * `otherSlug`. Returns `null` on the canonical `NOT_FOUND` envelope — either slug
 * unknown, or the two equal — so the resolver renders the 404 shell; any other
 * API error rethrows. A valid-but-unconnected pair is a 200 with an empty
 * `mechanisms` list, not a `null`.
 *
 * Slugs are `encodeURIComponent`-encoded defensively — real slugs are already
 * URL-safe (lowercase, hyphens), but a leaked malformed param must not produce a
 * broken path.
 */
export async function fetchProductPair(
  client: ServerApiClient,
  contextSlug: string,
  otherSlug: string,
): Promise<ProductPairResponse | null> {
  return fetchOrNull<ProductPairResponse>(
    client,
    `/api/products/${encodeURIComponent(contextSlug)}/integrations/${encodeURIComponent(otherSlug)}`,
  );
}
