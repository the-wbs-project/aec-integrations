import { z, type ZodType } from 'zod';

/**
 * Canonical error envelope returned by the API Worker for every non-2xx
 * response. Defined in docs/API_CONTRACTS.md §3.3. The Phase 2 centralized
 * error middleware will produce values that satisfy this schema; consumers
 * (SSR Worker) parse against it when they need runtime-safe error handling.
 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
    details: z.unknown().optional(),
  }),
  trace_id: z.string(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Minimal link to another entity. The Phase 2 hydration rule (Phase 2 Spec §7.2,
 * documented in docs/API_CONTRACTS.md §3.4) is that detail responses embed the
 * display fields of related entities rather than just IDs. `LinkRef` is the
 * baseline shape for that hydration — id + name + slug, enough for any anchor
 * tag plus its label. Richer refs (with a logo) extend this.
 */
export const LinkRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
});

export type LinkRef = z.infer<typeof LinkRefSchema>;

/**
 * Hydration shape used wherever a product detail or integration detail needs
 * to render its vendor (id + display fields + logo). Extends LinkRef so all
 * consumers can rely on `id`, `name`, `slug` being present.
 */
export const VendorLinkSchema = LinkRefSchema.extend({
  logo_url: z.string().url().nullable(),
});

export type VendorLink = z.infer<typeof VendorLinkSchema>;

/**
 * Hydration shape used wherever a list or detail response references another
 * product (integration source/target, related products, etc.). Same structural
 * shape as VendorLink today; kept as a distinct symbol so future divergence is
 * cheap.
 */
export const ProductLinkSchema = LinkRefSchema.extend({
  logo_url: z.string().url().nullable(),
});

export type ProductLink = z.infer<typeof ProductLinkSchema>;

/**
 * Page-based pagination query — every list endpoint accepts these as query
 * params. Replaces the AECI-40 offset/limit primitive per Phase 2 Spec §7.3.
 * `z.coerce.number()` lets endpoints feed `URLSearchParams` directly without
 * pre-parsing.
 *
 * `perPage` is capped at 100 server-side (Phase 2 Spec §7.3); default 24 lines
 * up with the example query in Phase 2 Spec §7.1 (`?page=1&perPage=24`).
 */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(24),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

/**
 * Generic shape for every paginated list response. The runtime schema is
 * produced by `paginatedResponseSchema(itemSchema)`; the TypeScript type
 * mirrors that shape for places that only need the static contract.
 */
export type PaginatedResponse<T> = {
  data: T[];
  page: number;
  perPage: number;
  total: number;
};

/**
 * Build a runtime Zod schema for `PaginatedResponse<T>` from an item schema.
 * Use this once per list endpoint so the wrapping shape stays consistent.
 */
export const paginatedResponseSchema = <T extends ZodType>(itemSchema: T) =>
  z.object({
    data: z.array(itemSchema),
    page: z.number().int().min(1),
    perPage: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
  });

/**
 * Server-side helper for mapping a public sort key to a direction. Phase 2
 * Spec §7.4 fixes the default-direction rule: `created → DESC`, `name → ASC`,
 * `updated → DESC`. Public queries carry only the combined sort key; the
 * API Worker resolves direction when building the Prisma query.
 */
export const SortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrderSchema>;
