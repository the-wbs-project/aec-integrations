import { z } from 'zod';

import {
  LinkRefSchema,
  paginatedResponseSchema,
  PageQuerySchema,
  VendorLinkSchema,
} from './common';
import { IntegrationListItemSchema } from './integrations';

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
 * category / discipline / phase, and products on a vendor detail. The vendor
 * field is hydrated as `VendorLink` (id + display fields + logo) per Phase 2
 * Spec §7.2 so cards can render without a second fetch.
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
  vendor: VendorLinkSchema,
  primary_category: LinkRefSchema.nullable(),
  integration_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  rating_overall_avg: z.number().nullable(),
  rating_onboarding_avg: z.number().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type ProductListItem = z.infer<typeof ProductListItemSchema>;

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
  disciplines: z.array(LinkRefSchema),
  phases: z.array(LinkRefSchema),
  integrations_as_source: z.array(IntegrationListItemSchema),
  integrations_as_target: z.array(IntegrationListItemSchema),
  related_products: z.array(ProductListItemSchema),
});

export type ProductDetail = z.infer<typeof ProductDetailSchema>;

/**
 * Query for `GET /api/products`. `category_id` / `discipline_id` / `phase_id`
 * / `vendor_id` accept the taxonomy / vendor UUIDs; the values come from the
 * taxonomy hydration on detail pages, so the page can link to itself filtered
 * by chip.
 */
export const ProductsListQuerySchema = PageQuerySchema.extend({
  sort: ProductSortSchema,
  search: z.string().optional(),
  category_id: z.string().uuid().optional(),
  discipline_id: z.string().uuid().optional(),
  phase_id: z.string().uuid().optional(),
  vendor_id: z.string().uuid().optional(),
  product_role: ProductRoleSchema.optional(),
  has_api_docs: z.coerce.boolean().optional(),
});

export type ProductsListQuery = z.infer<typeof ProductsListQuerySchema>;

export const ProductsListResponseSchema = paginatedResponseSchema(ProductListItemSchema);

export type ProductsListResponse = z.infer<typeof ProductsListResponseSchema>;
