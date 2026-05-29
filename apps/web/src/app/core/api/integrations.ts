/**
 * Typed accessors for the integrations API surface (apps/api `GET
 * /api/integrations/:id`, etc.). Wraps `ServerApiClient.request<T>` so each
 * SSR call site stays free of stringly-typed paths and `NOT_FOUND` envelope
 * decoding.
 *
 * Anchor: Phase 2 Spec §3.1 / §6.2 — "No public API surface; every call
 * goes through `env.API.fetch(...)` via the service binding." Helpers here
 * are server-only and must never be reached from browser code.
 *
 * Integrations are keyed by record ID, not slug (Phase 2 Spec §6.5), so this
 * is the ID-based parallel to `fetchProductBySlug` / `fetchVendorBySlug`.
 */
import type { IntegrationDetail } from '@aeci/shared';

import { isServerApiError, type ServerApiClient } from '../../../server-api-client';

/**
 * Fetch an integration by ID. Returns `null` on the canonical `NOT_FOUND`
 * envelope (HTTP 404 with `error.code === 'NOT_FOUND'`) so the resolver can
 * render the global 404 shell without try/catch noise. Any other API error
 * rethrows.
 *
 * ID is encoded with `encodeURIComponent` defensively — real IDs are UUIDs
 * and already URL-safe, but a leaked malformed param should not produce a
 * broken path.
 */
export async function fetchIntegrationById(
  client: ServerApiClient,
  id: string,
): Promise<IntegrationDetail | null> {
  try {
    return await client.request<IntegrationDetail>(`/api/integrations/${encodeURIComponent(id)}`);
  } catch (err) {
    // Structural check, not `instanceof` — see `isServerApiError` for why.
    if (isServerApiError(err) && err.status === 404 && err.code === 'NOT_FOUND') {
      return null;
    }
    throw err;
  }
}
