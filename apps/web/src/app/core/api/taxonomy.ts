/**
 * Typed accessors for the taxonomy API surface (apps/api `GET /api/categories`,
 * `GET /api/categories/:slug`, `GET /api/audiences/:slug`,
 * `GET /api/phases/:slug`). Wraps `ServerApiClient.request<T>` so each SSR call
 * site stays free of stringly-typed paths and `NOT_FOUND` envelope decoding.
 *
 * Anchor: Phase 2 Spec §3.1 / §7 — the API Worker is reached by the SSR Worker
 * via `env.API.fetch(...)` (service binding). Helpers here wrap that server-only
 * `ServerApiClient` and run during SSR; the resolvers' browser hydration-miss
 * branch fetches the same endpoints via the same-origin `/api/*` passthrough
 * (`core/api/http-get-or-null.ts`), not this client. ("No public API surface" =
 * no separate public API product / no ingress on the API Worker's own host.)
 */
import type { CategoriesListResponse, CategoryDetail, TaxonomyResponse } from '@aeci/shared';

import type { ServerApiClient } from '../../../server-api-client';
import type { TaxonomyKind } from '../../shared/taxonomy-badge/taxonomy-badge';
import { fetchOrNull } from './fetch-or-null';

/**
 * Detail shape shared by the three browse endpoints. `CategoryDetail`,
 * `AudienceDetail`, and `PhaseDetail` are structurally identical
 * (`taxonomyDetailShape` in `@aeci/shared`); one alias keeps the browse
 * resolver/page generic across kinds without three near-identical signatures.
 */
export type TaxonomyTermDetail = CategoryDetail;

/**
 * Maps a taxonomy kind to its URL/API path segment (`category` → `categories`).
 * Shared by the fetch helper, the browse resolver (canonical URL + page-view
 * route), and the route table so the pluralization lives in one place.
 */
export const KIND_PATH_SEGMENT: Record<TaxonomyKind, string> = {
  category: 'categories',
  audience: 'audiences',
  phase: 'phases',
};

/**
 * Fetch a taxonomy term (category / audience / phase) by slug, with its
 * tagged products embedded. Returns `null` on the canonical `NOT_FOUND`
 * envelope (HTTP 404 with `error.code === 'NOT_FOUND'`) so the resolver can
 * render the inline NotFound panel without try/catch noise. Any other API
 * error rethrows.
 *
 * Slug is encoded with `encodeURIComponent` defensively — fixtures and real
 * data should already be URL-safe (lowercase, hyphens), but a leaked
 * uppercase / unicode slug should not produce a malformed path.
 */
export async function fetchTaxonomyTermBySlug(
  client: ServerApiClient,
  kind: TaxonomyKind,
  slug: string,
): Promise<TaxonomyTermDetail | null> {
  const segment = KIND_PATH_SEGMENT[kind];
  return fetchOrNull<TaxonomyTermDetail>(client, `/api/${segment}/${encodeURIComponent(slug)}`);
}

/**
 * Fetch the flat list of all terms for one facet with product counts
 * (`GET /api/{categories|audiences|phases}`). Not paginated — the taxonomy is
 * small (≈30 terms) by design (see `CategoriesListResponseSchema`, whose shape
 * is shared by all three facets). Powers the `/categories`, `/audiences`, and
 * `/phases` index pages (AECI-157).
 */
export async function fetchTaxonomyList(
  client: ServerApiClient,
  kind: TaxonomyKind,
): Promise<CategoriesListResponse> {
  return client.request<CategoriesListResponse>(`/api/${KIND_PATH_SEGMENT[kind]}`);
}

/**
 * Fetch the aggregate taxonomy (`GET /api/taxonomy → { categories, audiences,
 * phases }`), each facet a `TaxonomyTermWithCount[]` carrying live
 * `product_count`. One round-trip for all three facets — the natural shape for
 * the home "Browse by" grids (AECI-184), which read **live** taxonomy counts,
 * never `stats_cache`. The endpoint is read-through KV-cached in the API Worker
 * (5-min TTL); consumed here via the SSR service binding, its own
 * `private, no-store` edge directive does not apply.
 */
export async function fetchTaxonomy(client: ServerApiClient): Promise<TaxonomyResponse> {
  return client.request<TaxonomyResponse>('/api/taxonomy');
}
