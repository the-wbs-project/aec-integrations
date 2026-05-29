/**
 * Typed accessors for the taxonomy API surface (apps/api `GET /api/categories`,
 * `GET /api/categories/:slug`, `GET /api/disciplines/:slug`,
 * `GET /api/phases/:slug`). Wraps `ServerApiClient.request<T>` so each SSR call
 * site stays free of stringly-typed paths and `NOT_FOUND` envelope decoding.
 *
 * Anchor: Phase 2 Spec §3.1 / §6.2 — "No public API surface; every call goes
 * through `env.API.fetch(...)` via the service binding." Helpers here are
 * server-only and must never be reached from browser code.
 */
import type { CategoriesListResponse, CategoryDetail } from '@aeci/shared';

import { isServerApiError, type ServerApiClient } from '../../../server-api-client';
import type { TaxonomyKind } from '../../shared/taxonomy-badge/taxonomy-badge';

/**
 * Detail shape shared by the three browse endpoints. `CategoryDetail`,
 * `DisciplineDetail`, and `PhaseDetail` are structurally identical
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
  discipline: 'disciplines',
  phase: 'phases',
};

/**
 * Fetch a taxonomy term (category / discipline / phase) by slug, with its
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
  try {
    return await client.request<TaxonomyTermDetail>(`/api/${segment}/${encodeURIComponent(slug)}`);
  } catch (err) {
    // Structural check, not `instanceof` — see `isServerApiError` for why.
    if (isServerApiError(err) && err.status === 404 && err.code === 'NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch the flat list of all categories with product counts (`GET
 * /api/categories`). Not paginated — the taxonomy is small (≈30 terms) by
 * design (see `CategoriesListResponseSchema`).
 */
export async function fetchCategoriesList(
  client: ServerApiClient,
): Promise<CategoriesListResponse> {
  return client.request<CategoriesListResponse>('/api/categories');
}
