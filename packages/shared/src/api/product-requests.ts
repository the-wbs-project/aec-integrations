import { z } from 'zod';

import { AdminReasonSchema } from './admin-reason';
import {
  LinkRefSchema,
  PageQuerySchema,
  ProductLinkSchema,
  paginatedResponseSchema,
} from './common';
import { HttpsUrlSchema } from './https-url';

/**
 * Product requests (AECI-1377, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6): a seated
 * vendor asks AEC Integrations to add the OTHER product of an integration, because
 * the catalog does not list it. A request never creates an integration. The vendor
 * finishes that itself once the product exists.
 *
 *   POST  /api/vendor/product-requests     — ask (201 `{ request }`).
 *   GET   /api/vendor/product-requests     — the vendor's requests, newest first, ≤ 50.
 *   GET   /api/admin/product-requests      — the admin queue, by status, paginated.
 *   PATCH /api/admin/product-requests/:id  — decide an open request.
 *
 * Wire shapes: `API_CONTRACTS.md` §6.14 (vendor) and §6.10 (admin). Table:
 * `DATABASE_SCHEMA.md` §8.1b.
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are
 * Zod's field errors. The portal form renders its own copy.
 */

/** Every status a request can hold. `open` until an operator decides it. */
export const PRODUCT_REQUEST_STATUSES = ['open', 'added', 'already_listed', 'declined'] as const;
export const ProductRequestStatusSchema = z.enum(PRODUCT_REQUEST_STATUSES);
export type ProductRequestStatus = z.infer<typeof ProductRequestStatusSchema>;

/** The three decisions. Each is also the status it leaves the request in. */
export const PRODUCT_REQUEST_OUTCOMES = ['added', 'already_listed', 'declined'] as const;
export type ProductRequestOutcome = (typeof PRODUCT_REQUEST_OUTCOMES)[number];

export const PRODUCT_REQUEST_NAME_MAX = 200;
export const PRODUCT_REQUEST_MAKER_MAX = 200;
export const PRODUCT_REQUEST_WEBSITE_MAX = 500;
export const PRODUCT_REQUEST_BODY_MAX = 2000;

/** Most requests `GET /api/vendor/product-requests` returns. No pagination. */
export const VENDOR_PRODUCT_REQUEST_LIST_LIMIT = 50;

// ─── The vendor's request ────────────────────────────────────────────────────

/**
 * Body of `POST /api/vendor/product-requests`. `.strict()`: any other key is a `400`.
 *
 * `website` and `body` are optional. A form sends `''` for an empty field, so `''`
 * reads as "not supplied" for both, as on the claim form. The server stores a missing
 * website as NULL and a missing note as `''`. A supplied website is the shared
 * `HttpsUrlSchema` rule (https only, no credentials), capped at 500.
 */
export const CreateProductRequestSchema = z
  .object({
    /** The caller's own promoted product: the Integrations tab it asked from. */
    context_product_id: z.string().uuid(),
    name: z
      .string()
      .trim()
      .min(1, 'The product name is required.')
      .max(PRODUCT_REQUEST_NAME_MAX, 'Keep the name under 200 characters.'),
    maker: z
      .string()
      .trim()
      .min(1, 'The company that makes it is required.')
      .max(PRODUCT_REQUEST_MAKER_MAX, 'Keep the company name under 200 characters.'),
    website: z
      .string()
      .trim()
      .max(PRODUCT_REQUEST_WEBSITE_MAX, 'Keep the website under 500 characters.')
      .refine(
        (value) => value === '' || HttpsUrlSchema.safeParse(value).success,
        'Use an https:// link with no username or password.',
      )
      .optional(),
    body: z
      .string()
      .trim()
      .max(PRODUCT_REQUEST_BODY_MAX, 'Keep this under 2000 characters.')
      .optional(),
  })
  .strict();
export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;
export type CreateProductRequestInput = z.input<typeof CreateProductRequestSchema>;

/**
 * One request as the vendor sees it. `resolved_product` is the catalog product an
 * `added` or `already_listed` decision linked, else `null`. `decline_reason` is set
 * on `declined` only, and the vendor is shown it (ruled 2026-10-15). The deciding
 * admin is never on this shape.
 */
export const VendorProductRequestSchema = z.object({
  id: z.string().uuid(),
  status: ProductRequestStatusSchema,
  /** The product the request came from. Its Integrations tab is the deep link. */
  context_product_id: z.string().uuid(),
  name: z.string(),
  maker: z.string(),
  website: z.string().nullable(),
  /** `''` when the vendor wrote nothing. */
  body: z.string(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
  decline_reason: z.string().nullable(),
  resolved_product: ProductLinkSchema.nullable(),
});
export type VendorProductRequest = z.infer<typeof VendorProductRequestSchema>;

/** `201` of `POST /api/vendor/product-requests`. */
export const CreateProductRequestResponseSchema = z.object({
  request: VendorProductRequestSchema,
});
export type CreateProductRequestResponse = z.infer<typeof CreateProductRequestResponseSchema>;

/** `200` of `GET /api/vendor/product-requests`: newest first, at most 50. */
export const ListVendorProductRequestsResponseSchema = z.object({
  requests: z.array(VendorProductRequestSchema),
});
export type ListVendorProductRequestsResponse = z.infer<
  typeof ListVendorProductRequestsResponseSchema
>;

// ─── The admin queue ─────────────────────────────────────────────────────────

/** Query of `GET /api/admin/product-requests`. `status` defaults to `open`. */
export const ListProductRequestsQuerySchema = PageQuerySchema.extend({
  status: ProductRequestStatusSchema.default('open'),
});
export type ListProductRequestsQuery = z.infer<typeof ListProductRequestsQuerySchema>;

/**
 * One request as the operator sees it. `vendor` and `context_product` are joined at
 * read time and are `null` when the row they name is gone (no FK, §8.1b).
 * `requested_by` and `resolved_by` are profile ids with no FK, so they survive an
 * erasure.
 */
export const AdminProductRequestSchema = z.object({
  id: z.string().uuid(),
  status: ProductRequestStatusSchema,
  vendor_id: z.string(),
  vendor: LinkRefSchema.nullable(),
  requested_by: z.string(),
  context_product_id: z.string(),
  context_product: LinkRefSchema.nullable(),
  name: z.string(),
  maker: z.string(),
  website: z.string().nullable(),
  body: z.string(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
  resolved_by: z.string().nullable(),
  decline_reason: z.string().nullable(),
  resolved_product: ProductLinkSchema.nullable(),
});
export type AdminProductRequest = z.infer<typeof AdminProductRequestSchema>;

export const ListProductRequestsResponseSchema = paginatedResponseSchema(AdminProductRequestSchema);
export type ListProductRequestsResponse = z.infer<typeof ListProductRequestsResponseSchema>;

/**
 * Body of `PATCH /api/admin/product-requests/:id`, discriminated on `outcome`.
 *
 *   - `added`: AECi created and promoted the product. `product_id` is that product.
 *   - `already_listed`: the product was in the catalog under another name.
 *   - `declined`: AECi will not list it. `reason` (1 to 1,000) is shown to the vendor.
 *
 * `product_id` must name a PROMOTED product, else `422 PRODUCT_NOT_PROMOTED`.
 */
export const DecideProductRequestSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.enum(['added', 'already_listed']),
      product_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('declined'),
      reason: AdminReasonSchema,
    })
    .strict(),
]);
export type DecideProductRequest = z.infer<typeof DecideProductRequestSchema>;
