import { z } from 'zod';

import { MaintenanceSchema, paginatedResponseSchema, PageQuerySchema } from './common';
import { ProductListItemSchema } from './products';

/**
 * Public sort key for `GET /api/vendors`. Phase 2 Spec §7.4: default
 * `created DESC`. The `name` key maps to the `company_name` column
 * server-side (vendors have no plain `name` column); direction follows the
 * §7.4 default-direction rule (`created → DESC`, `name → ASC`,
 * `updated → DESC`).
 */
export const VendorSortSchema = z.enum(['created', 'name', 'updated']).default('created');

export type VendorSort = z.infer<typeof VendorSortSchema>;

/**
 * Lean vendor shape returned by `GET /api/vendors` and used inside any
 * response that lists vendors. Logo is included so vendor cards can render
 * without a follow-up fetch. `headquarters` and `founded_year` are included
 * here (not only on `VendorDetail`) so `/vendors` index rows can show HQ and
 * founded year without a follow-up fetch — AECI-59 acceptance criteria.
 */
export const VendorListItemSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  company_name: z.string().min(1),
  logo_url: z.string().url().nullable(),
  verified: z.boolean(),
  headquarters: z.string().nullable(),
  founded_year: z.number().int().nullable(),
  product_count: z.number().int().min(0),
  integration_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type VendorListItem = z.infer<typeof VendorListItemSchema>;

/**
 * Full vendor detail returned by `GET /api/vendors/:slug`. Embeds the
 * vendor's products as `ProductListItem[]` (Phase 2 Spec §7.2) so the detail
 * page renders without chain-fetching. `headquarters` and `founded_year`
 * already live on `VendorListItem`; the detail shape adds the editorial
 * description and website, plus external/social links rendered in the hero.
 *
 * `linkedin_url` and the four B2 social platforms (`x_url`, `facebook_url`,
 * `instagram_url`, `youtube_url`) mirror their stored columns verbatim — the
 * review app curates and forwards full canonical URLs via `POST /api/promote`.
 * All are nullable — a vendor without a given link renders no icon for it.
 */
export const VendorDetailSchema = VendorListItemSchema.extend({
  description: z.string().nullable(),
  website: z.string().url().nullable(),
  linkedin_url: z.string().url().nullable(),
  x_url: z.string().url().nullable(),
  facebook_url: z.string().url().nullable(),
  instagram_url: z.string().url().nullable(),
  youtube_url: z.string().url().nullable(),
  products: z.array(ProductListItemSchema),
  // The maintenance marker's inputs (AECI-616) — see `MaintenanceSchema`. Distinct
  // from `verified` (inherited from `VendorListItem`): that is an AECi-verified vendor
  // ACCOUNT, this is who maintains the catalog record.
  maintenance: MaintenanceSchema.default({ maintained_by: 'aeci', last_reviewed_at: null }),
});

export type VendorDetail = z.infer<typeof VendorDetailSchema>;

/**
 * Query for `GET /api/vendors`. `verified` uses `z.coerce.boolean()` so
 * `?verified=true` (a string) parses correctly when the API Worker hands the
 * raw `URLSearchParams` to Zod.
 */
export const VendorsListQuerySchema = PageQuerySchema.extend({
  sort: VendorSortSchema,
  search: z.string().optional(),
  verified: z.coerce.boolean().optional(),
});

export type VendorsListQuery = z.infer<typeof VendorsListQuerySchema>;

export const VendorsListResponseSchema = paginatedResponseSchema(VendorListItemSchema);

export type VendorsListResponse = z.infer<typeof VendorsListResponseSchema>;
