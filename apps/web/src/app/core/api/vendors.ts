/**
 * Typed accessors for the vendors API surface (apps/api `GET
 * /api/vendors/:slug`, etc.). Wraps `ServerApiClient.request<T>` so each
 * SSR call site stays free of stringly-typed paths and `NOT_FOUND` envelope
 * decoding.
 *
 * Anchor: Phase 2 Spec §3.1 / §6.2 — "No public API surface; every call
 * goes through `env.API.fetch(...)` via the service binding." Helpers here
 * are server-only and must never be reached from browser code.
 */
import type { VendorDetail } from '@aeci/shared';

import { isServerApiError, type ServerApiClient } from '../../../server-api-client';

/**
 * Fetch a vendor by slug. Returns `null` on the canonical `NOT_FOUND`
 * envelope (HTTP 404 with `error.code === 'NOT_FOUND'`) so the resolver can
 * render the inline NotFound panel without try/catch noise. Any other API
 * error rethrows.
 *
 * Slug is encoded with `encodeURIComponent` defensively — fixtures and
 * real data should already be URL-safe (lowercase, hyphens), but a leaked
 * uppercase / unicode slug should not produce a malformed path.
 */
export async function fetchVendorBySlug(
  client: ServerApiClient,
  slug: string,
): Promise<VendorDetail | null> {
  try {
    return await client.request<VendorDetail>(`/api/vendors/${encodeURIComponent(slug)}`);
  } catch (err) {
    // Structural check, not `instanceof` — see `isServerApiError` for why.
    if (isServerApiError(err) && err.status === 404 && err.code === 'NOT_FOUND') {
      return null;
    }
    throw err;
  }
}
