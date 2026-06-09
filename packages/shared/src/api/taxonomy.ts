import { z } from 'zod';

import { LinkRefSchema } from './common';
import { ProductListItemSchema } from './products';

/**
 * A taxonomy term (category / audience / phase) with the count of products
 * tagged with it. Used by `GET /api/categories` (and the audiences / phases
 * equivalents inside `TaxonomyResponse`).
 */
export const TaxonomyTermWithCountSchema = LinkRefSchema.extend({
  description: z.string().nullable(),
  display_order: z.number().int(),
  product_count: z.number().int().min(0),
});

export type TaxonomyTermWithCount = z.infer<typeof TaxonomyTermWithCountSchema>;

/**
 * Full taxonomy fetch returned by `GET /api/taxonomy` — the lookup the SSR
 * Worker uses to render nav, footer, and the `/categories` flat list. All
 * three lists hydrate as `TaxonomyTermWithCount[]` so callers don't need a
 * second roundtrip to count products.
 */
export const TaxonomyResponseSchema = z.object({
  categories: z.array(TaxonomyTermWithCountSchema),
  audiences: z.array(TaxonomyTermWithCountSchema),
  phases: z.array(TaxonomyTermWithCountSchema),
});

export type TaxonomyResponse = z.infer<typeof TaxonomyResponseSchema>;

/**
 * Response for the flat taxonomy list endpoints — `GET /api/categories`,
 * `GET /api/audiences`, and `GET /api/phases` — all generalised through
 * `createTaxonomyListHandler`. The three share this shape. Not paginated —
 * the taxonomy is small (≈30 terms) by design.
 */
export const CategoriesListResponseSchema = z.object({
  data: z.array(TaxonomyTermWithCountSchema),
});

export type CategoriesListResponse = z.infer<typeof CategoriesListResponseSchema>;

/**
 * Detail responses for `GET /api/categories/:slug`, `/audiences/:slug`,
 * `/phases/:slug`. Embed the products that carry the term as
 * `ProductListItem[]` per Phase 2 Spec §7.2. Three distinct schemas (not
 * aliases) so future divergence — e.g. audience-specific fields — is cheap.
 */
const taxonomyDetailShape = TaxonomyTermWithCountSchema.extend({
  products: z.array(ProductListItemSchema),
});

export const CategoryDetailSchema = taxonomyDetailShape;
export type CategoryDetail = z.infer<typeof CategoryDetailSchema>;

export const AudienceDetailSchema = taxonomyDetailShape;
export type AudienceDetail = z.infer<typeof AudienceDetailSchema>;

export const PhaseDetailSchema = taxonomyDetailShape;
export type PhaseDetail = z.infer<typeof PhaseDetailSchema>;
