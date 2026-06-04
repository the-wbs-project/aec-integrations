/**
 * Typed accessors for the taxonomy API surface (apps/api `GET /api/categories`,
 * `GET /api/categories/:slug`, `GET /api/audiences/:slug`,
 * `GET /api/phases/:slug`). Wraps `ServerApiClient.request<T>` so each SSR call
 * site stays free of stringly-typed paths and `NOT_FOUND` envelope decoding.
 *
 * Anchor: Phase 2 Spec §3.1 / §6.2 — "No public API surface; every call goes
 * through `env.API.fetch(...)` via the service binding." Helpers here are
 * server-only and must never be reached from browser code.
 */
import type { CategoriesListResponse, CategoryDetail } from '@aeci/shared';

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
 * Fetch the flat list of all categories with product counts (`GET
 * /api/categories`). Not paginated — the taxonomy is small (≈30 terms) by
 * design (see `CategoriesListResponseSchema`).
 */
export async function fetchCategoriesList(
  client: ServerApiClient,
): Promise<CategoriesListResponse> {
  return client.request<CategoriesListResponse>('/api/categories');
}
