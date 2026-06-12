import { z } from 'zod';

import {
  LinkRefSchema,
  paginatedResponseSchema,
  PageQuerySchema,
  uuidList,
  VendorLinkSchema,
} from './common';
import { IntegrationListItemSchema } from './integrations';
import { PublicReviewSchema } from './reviews';

/**
 * Product role enum. Mirrors the `product_role` column on the `products`
 * table (docs/DATABASE_SCHEMA.md §3).
 */
export const ProductRoleSchema = z.enum(['application', 'connector', 'hybrid']);

export type ProductRole = z.infer<typeof ProductRoleSchema>;

/**
 * Public sort key for `GET /api/products`. Phase 2 Spec §7.4: default
 * `created DESC`. Server-side maps `created → DESC`, `name → ASC`,
 * `updated → DESC` per the §7.4 default-direction rule.
 */
export const ProductSortSchema = z.enum(['created', 'name', 'updated']).default('created');

export type ProductSort = z.infer<typeof ProductSortSchema>;

/**
 * Lean product shape returned by every list endpoint that surfaces products:
 * `GET /api/products`, related products on a product detail, products under a
 * category / audience / phase, and products on a vendor detail. The vendor
 * field is hydrated as `VendorLink` (id + display fields + logo) per Phase 2
 * Spec §7.2 so cards can render without a second fetch.
 *
 * `vendor` is nullable: `product_vendors` has no DB constraint forcing a
 * product to carry at least one link (AECI-115). When absent we surface `null`
 * and the SSR layer renders an empty state — rather than fabricating a sentinel
 * vendor that would render a broken `/vendors/unknown` link.
 *
 * `primary_category` carries the highest-display-order category the product
 * belongs to (or `null` when the product has no categories). Added so the
 * AECI-58 index page can render a category cell on each `ProductCard` row
 * without a chain-fetch — same §7.2 rule that drives `vendor` hydration.
 */
export const ProductListItemSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  logo_url: z.string().url().nullable(),
  product_role: ProductRoleSchema,
  vendor: VendorLinkSchema.nullable(),
  primary_category: LinkRefSchema.nullable(),
  integration_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  rating_overall_avg: z.number().nullable(),
  rating_onboarding_avg: z.number().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type ProductListItem = z.infer<typeof ProductListItemSchema>;

// `usefulness` is narrative value ("how teams use it"), NOT a taxonomy facet. Each
// group elaborates one audience or phase term by `slug`/`name` (same field types as
// LinkRef, but it carries NO `id` — it is slug-based, not a hydrated LinkRef; do not
// "fix" this by extending LinkRefSchema). `points` holds >= 1 bullet, in display order.
export const UsefulnessGroupSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  points: z.array(z.string().min(1)).min(1),
});

export type UsefulnessGroup = z.infer<typeof UsefulnessGroupSchema>;

export const ProductUsefulnessSchema = z.object({
  audiences: z.array(UsefulnessGroupSchema),
  phases: z.array(UsefulnessGroupSchema),
});

export type ProductUsefulness = z.infer<typeof ProductUsefulnessSchema>;

/**
 * Full product detail returned by `GET /api/products/:slug`. Embeds every
 * relation the detail page renders (taxonomy chips, integrations as source /
 * target, related products) so the page is a single fetch — Phase 2 Spec §7.2
 * forbids chain-fetching.
 */
export const ProductDetailSchema = ProductListItemSchema.extend({
  description: z.string().nullable(),
  website: z.string().url().nullable(),
  tool_integrations_url: z.string().url().nullable(),
  api_docs_url: z.string().url().nullable(),
  has_api_docs: z.boolean(),
  categories: z.array(LinkRefSchema),
  audiences: z.array(LinkRefSchema),
  phases: z.array(LinkRefSchema),
  // Narrative value grouped by audience/phase, distinct from the `audiences`/`phases`
  // facet LinkRef[] above. `null` when the source has nothing for either facet;
  // otherwise either facet array may be empty.
  usefulness: ProductUsefulnessSchema.nullable(),
  integrations_as_source: z.array(IntegrationListItemSchema),
  integrations_as_target: z.array(IntegrationListItemSchema),
  related_products: z.array(ProductListItemSchema),
  // First page of approved reviews, newest-first, SSR'd into the cached product
  // page so the reviews section renders without a client round-trip (AECI-199 /
  // §5.4). `review_count` (inherited from ProductListItem) is the approved total
  // for paginating the rest via `GET /api/products/:slug/reviews`. The ≥5 gate
  // (§5.5) nulls `rating_overall_avg` / `rating_onboarding_avg` (inherited) when
  // `review_count < 5` — a single-review average is statistically misleading.
  reviews: z.array(PublicReviewSchema),
});

export type ProductDetail = z.infer<typeof ProductDetailSchema>;

/**
 * Query for `GET /api/products`. The three taxonomy dimensions
 * (`category_id` / `audience_id` / `phase_id`) accept a **comma-separated UUID
 * list** for multi-select faceting (AECI-223) — **OR within a dimension, AND
 * across dimensions** — decoded to `string[]` by `uuidList`. The param names are
 * unchanged, so a single id (a detail-page taxonomy chip link, or a browse
 * page's locked `{kind}_id`) is just a one-element list. `vendor_id` stays a
 * single UUID (a non-faceted scope, out of scope for AECI-223).
 */
export const ProductsListQuerySchema = PageQuerySchema.extend({
  sort: ProductSortSchema,
  search: z.string().optional(),
  category_id: uuidList.optional(),
  audience_id: uuidList.optional(),
  phase_id: uuidList.optional(),
  vendor_id: z.string().uuid().optional(),
  product_role: ProductRoleSchema.optional(),
  has_api_docs: z.coerce.boolean().optional(),
});

export type ProductsListQuery = z.infer<typeof ProductsListQuerySchema>;

export const ProductsListResponseSchema = paginatedResponseSchema(ProductListItemSchema);

export type ProductsListResponse = z.infer<typeof ProductsListResponseSchema>;
