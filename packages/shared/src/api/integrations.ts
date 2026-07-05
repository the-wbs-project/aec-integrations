import { z } from 'zod';

import {
  paginatedResponseSchema,
  PageQuerySchema,
  ProductLinkSchema,
  VendorLinkSchema,
} from './common';

/**
 * Integration mechanism enum. Mirrors the `mechanism_kind` column on the
 * `integrations` table (docs/DATABASE_SCHEMA.md §3) and stays in lockstep with
 * the directory editorial taxonomy in PRODUCT.md.
 */
export const IntegrationMechanismKindSchema = z.enum([
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
]);

export type IntegrationMechanismKind = z.infer<typeof IntegrationMechanismKindSchema>;

export const IntegrationDirectionSchema = z.enum(['one-way', 'bidirectional']);

export type IntegrationDirection = z.infer<typeof IntegrationDirectionSchema>;

/**
 * Direction of a mechanism (or, in Layer B, a claim) **relative to the page's
 * context product** (Stage 1.5 §3.2). The stored integration/claim direction is
 * canonical to the row's own endpoints; the API translates it into the visitor's
 * frame before it leaves the Worker (the browser never re-derives it). `outbound`
 * = flows from the context product to the other; `inbound` = the reverse; `both`
 * = bidirectional. Lives here (not in `product-pairs`) so both the pair page and
 * the product-detail integrations table can reference it without an import cycle.
 */
export const ContextDirectionSchema = z.enum(['outbound', 'inbound', 'both']);

export type ContextDirection = z.infer<typeof ContextDirectionSchema>;

/**
 * Public sort key for `GET /api/integrations`. Phase 2 Spec §7.4: default
 * `name ASC`. Server-side maps `name → ASC`, `created → DESC` per §7.4.
 */
export const IntegrationSortSchema = z.enum(['name', 'created']).default('name');

export type IntegrationSort = z.infer<typeof IntegrationSortSchema>;

/**
 * Lean shape returned by `GET /api/integrations` list rows and embedded in
 * `ProductDetail.integrations_as_source` / `integrations_as_target`. Source
 * and target products are hydrated as `ProductLink` (id + name + slug + logo)
 * per Phase 2 Spec §7.2.
 */
export const IntegrationListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  // Nullable: the `mechanism_kind` column is nullable (AECI-115), mirroring
  // sibling `direction`. An absent value surfaces as `null` and the UI renders
  // an empty state, rather than silently coercing to `'native'`. An out-of-enum
  // *non-null* value is a data-integrity violation the mapper throws on.
  mechanism_kind: IntegrationMechanismKindSchema.nullable(),
  mechanism_name: z.string().nullable(),
  direction: IntegrationDirectionSchema.nullable(),
  source: ProductLinkSchema,
  target: ProductLinkSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type IntegrationListItem = z.infer<typeof IntegrationListItemSchema>;

/**
 * Product-detail embed of an integration — the rows in
 * `ProductDetail.integrations_as_source` / `integrations_as_target`. Extends the
 * list item with `context_direction`: the effective flow direction **relative to
 * the page's product**, made claims-aware (Stage 1.5 §3.2). It is derived on the
 * server from the mechanism's `data_object` claims when it has them (the same
 * signal the pair page surfaces), else the stored row `direction` translated to
 * this product's frame, else `null` (unknown → the table renders an em-dash).
 *
 * Precomputed server-side and rendered verbatim so the table's Direction column
 * can never contradict the pair page (superseding the stored-`direction`-only
 * framing of §3.2). Only this embed carries it — the bare `IntegrationListItem`
 * used by `/api/integrations` and the home rail has no single context product.
 */
export const ProductIntegrationItemSchema = IntegrationListItemSchema.extend({
  context_direction: ContextDirectionSchema.nullable(),
});

export type ProductIntegrationItem = z.infer<typeof ProductIntegrationItemSchema>;

/**
 * Full integration detail returned by `GET /api/integrations/:id`. Adds the
 * description, links, optional vendor / connector product, and editorial
 * metadata (pricing, maturity) on top of the list-item shape.
 */
export const IntegrationDetailSchema = IntegrationListItemSchema.extend({
  description: z.string().nullable(),
  listing_url: z.string().url().nullable(),
  docs_url: z.string().url().nullable(),
  mechanism_url: z.string().url().nullable(),
  built_by_vendor: VendorLinkSchema.nullable(),
  powered_by_product: ProductLinkSchema.nullable(),
  pricing_model: z.string().nullable(),
  maturity: z.string().nullable(),
});

export type IntegrationDetail = z.infer<typeof IntegrationDetailSchema>;

/**
 * Query for `GET /api/integrations`. Filter fields use the camelCase names
 * called out in the AECI-50 acceptance criteria (`sourceProductId`,
 * `targetProductId`); enum-valued filters keep the snake_case form that
 * matches the underlying columns.
 */
export const IntegrationsListQuerySchema = PageQuerySchema.extend({
  sort: IntegrationSortSchema,
  search: z.string().optional(),
  sourceProductId: z.string().uuid().optional(),
  targetProductId: z.string().uuid().optional(),
  mechanism_kind: IntegrationMechanismKindSchema.optional(),
  direction: IntegrationDirectionSchema.optional(),
});

export type IntegrationsListQuery = z.infer<typeof IntegrationsListQuerySchema>;

export const IntegrationsListResponseSchema = paginatedResponseSchema(IntegrationListItemSchema);

export type IntegrationsListResponse = z.infer<typeof IntegrationsListResponseSchema>;
