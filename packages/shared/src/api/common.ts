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
 *
 * `verified` mirrors `vendors.verified` (the AECi-verified-vendor-account bit,
 * flipped by the AECI-519 claim grant) so the SSR trust surfaces can render the
 * verified badge (AECI-523) wherever a product/integration shows its built-by
 * vendor. Required — the DB column is `NOT NULL DEFAULT false`, so the mapper
 * always emits a real boolean (matching the required `verified` on
 * `VendorListItem` / `VendorDetail`).
 */
export const VendorLinkSchema = LinkRefSchema.extend({
  logo_url: z.string().url().nullable(),
  verified: z.boolean(),
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

/** Who is on the hook for a record's accuracy (`*.maintained_by`). */
export const MAINTAINED_BY = ['aeci', 'vendor'] as const;

/**
 * The maintenance marker's payload (AECI-616 / `STAGE_2_ATTESTATIONS_SPEC.md` §13),
 * carried by every detail surface that renders `aec-maintenance-marker`: product
 * detail, vendor detail, and the product-PAIR page.
 *
 * `last_reviewed_at` is when a human LAST ACTUALLY RE-CHECKED the record, and it is
 * `null` for the overwhelming majority of rows — nothing was backfilled, deliberately,
 * because seeding it from `updated_at` / `created_at` / `promoted_at` would manufacture
 * the fake freshness the marker exists to expose. `null` renders bare attribution with
 * no date, which is the honest reading, not missing data.
 *
 * Both fields carry defaults for the **same reason `SyncHeadlineSchema.single_source`
 * does**: the SSR and API Workers deploy per-commit but not atomically, so an SSR
 * Worker running this schema has to parse a response from an API Worker that predates
 * the fields.
 */
export const MaintenanceSchema = z.object({
  maintained_by: z.enum(MAINTAINED_BY).default('aeci'),
  last_reviewed_at: z.string().nullable().default(null),
});

export type Maintenance = z.infer<typeof MaintenanceSchema>;

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

const UUID_SCHEMA = z.string().uuid();

/**
 * A comma-separated list of UUIDs in a single query param, decoded to a
 * `string[]` (AECI-223). Powers true multi-select facets — **OR within a
 * dimension** — while keeping the existing param names (`category_id` /
 * `audience_id` / `phase_id`) so the edge cache-key allowlist and the
 * detail-page chip links keep working with a single id.
 *
 * Semantics: split on `,`, trim, drop empties; require ≥1 element; every
 * element must be a UUID. A single id is just a one-element list, so existing
 * one-id callers (chip links, a browse page's locked `{kind}_id`) are
 * unaffected.
 *
 * Implemented as one `transform` that raises issues via `ctx` (rather than a
 * `.pipe()` into `z.array(...)`) so a bad/empty value reports its ZodError at
 * the *param key* (`category_id`), not a nested array index (`category_id.0`).
 * `errors.ts`'s `firstFieldFromZodError` joins the issue path, so this keeps
 * the `VALIDATION_FAILED` `field` clean for the SSR client.
 */
export const uuidList = z.string().transform((raw, ctx) => {
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (ids.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Expected at least one UUID' });
    return z.NEVER;
  }
  for (const id of ids) {
    if (!UUID_SCHEMA.safeParse(id).success) {
      ctx.addIssue({ code: 'custom', message: `Invalid UUID: ${id}` });
      return z.NEVER;
    }
  }
  return ids;
});
