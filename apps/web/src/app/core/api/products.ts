/**
 * Typed accessors for the products API surface (apps/api `GET
 * /api/products/:slug`, etc.). Wraps `ServerApiClient.request<T>` so each
 * SSR call site stays free of stringly-typed paths and `NOT_FOUND` envelope
 * decoding.
 *
 * Anchor: Phase 2 Spec §3.1 / §7 — the API Worker is reached by the SSR Worker
 * via `env.API.fetch(...)` (service binding). Helpers here wrap that server-only
 * `ServerApiClient` and run during SSR; the resolvers' browser hydration-miss
 * branch fetches the same endpoints via the same-origin `/api/*` passthrough
 * (`core/api/http-get-or-null.ts`), not this client. ("No public API surface" =
 * no separate public API product / no ingress on the API Worker's own host.)
 */
import type { ProductDetail } from '@aeci/shared';

import type { ServerApiClient } from '../../../server-api-client';
import { fetchOrNull } from './fetch-or-null';

/**
 * Fetch a product by slug. Returns `null` on the canonical `NOT_FOUND`
 * envelope (HTTP 404 with `error.code === 'NOT_FOUND'`) so the resolver can
 * render the inline NotFound panel without try/catch noise. Any other API
 * error rethrows.
 *
 * Slug is encoded with `encodeURIComponent` defensively — fixtures and
 * real data should already be URL-safe (lowercase, hyphens), but a leaked
 * uppercase / unicode slug should not produce a malformed path.
 */
export async function fetchProductBySlug(
  client: ServerApiClient,
  slug: string,
): Promise<ProductDetail | null> {
  return fetchOrNull<ProductDetail>(client, `/api/products/${encodeURIComponent(slug)}`);
}
