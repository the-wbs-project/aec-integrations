/**
 * Typed accessors for the integrations API surface (apps/api `GET
 * /api/integrations/:id`, etc.). Wraps `ServerApiClient.request<T>` so each
 * SSR call site stays free of stringly-typed paths and `NOT_FOUND` envelope
 * decoding.
 *
 * Anchor: Phase 2 Spec §3.1 / §7 — the API Worker is reached by the SSR Worker
 * via `env.API.fetch(...)` (service binding). Helpers here wrap that server-only
 * `ServerApiClient` and run during SSR; the resolvers' browser hydration-miss
 * branch fetches the same endpoints via the same-origin `/api/*` passthrough
 * (`core/api/http-get-or-null.ts`), not this client. ("No public API surface" =
 * no separate public API product / no ingress on the API Worker's own host.)
 *
 * Integrations are keyed by record ID, not slug (Phase 2 Spec §6.5), so this
 * is the ID-based parallel to `fetchProductBySlug` / `fetchVendorBySlug`.
 */
import type { IntegrationDetail } from '@aeci/shared';

import type { ServerApiClient } from '../../../server-api-client';
import { fetchOrNull } from './fetch-or-null';

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
  return fetchOrNull<IntegrationDetail>(client, `/api/integrations/${encodeURIComponent(id)}`);
}
