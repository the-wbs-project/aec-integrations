import { z } from 'zod';

import { PageQuerySchema, ProductLinkSchema, paginatedResponseSchema } from './common';
import { PublicReviewSchema, PublicVendorResponseSchema } from './reviews';

/**
 * Vendor replies to reviews (AECI-1173, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c).
 *
 * A seat on a vendor that owns a product answers one approved review of it, in
 * public. AECi approves every reply before it shows (pre-moderation). The table
 * is `review_responses` (`DATABASE_SCHEMA.md` §7.3); the wire shapes are in
 * `API_CONTRACTS.md` §6.6, §6.10 and §6.14.
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are
 * for API consumers and logs; the Angular surfaces render their own copy.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The five reply statuses (§11c.6). Mirrored by the D1 CHECK
 * `review_responses_status_check`, written once at table creation;
 * `migration-0058.spec.ts` in the API Worker asserts the two agree. `removed` is
 * final.
 */
export const REVIEW_RESPONSE_STATUSES = [
  'pending',
  'published',
  'rejected',
  'withdrawn',
  'removed',
] as const;

export const ReviewResponseStatusSchema = z.enum(REVIEW_RESPONSE_STATUSES);
export type ReviewResponseStatus = z.infer<typeof ReviewResponseStatusSchema>;

/** §11c.5: the trimmed body is 1 to 2,000 characters. */
export const REVIEW_RESPONSE_BODY_MAX = 2000;

/** The `reply_status` filter on `GET /api/vendor/reviews`: no reply yet, or one
 *  of the five statuses. */
export const REVIEW_REPLY_STATUS_FILTERS = ['none', ...REVIEW_RESPONSE_STATUSES] as const;
export const ReviewReplyStatusFilterSchema = z.enum(REVIEW_REPLY_STATUS_FILTERS);
export type ReviewReplyStatusFilter = z.infer<typeof ReviewReplyStatusFilterSchema>;

// ─── Public reply (the shape a visitor reads) ───────────────────────────────

// `PublicVendorResponseSchema` lives in `./reviews`, beside the `PublicReviewSchema`
// that carries it as `vendor_responses`. Defining it here would make the two
// modules import each other. Re-exported so this file stays the reply vocabulary.
export { PublicVendorResponseSchema, type PublicVendorResponse } from './reviews';

// ─── Vendor writes (AECI-1176) ───────────────────────────────────────────────

/**
 * Body of `POST /api/vendor/reviews/:reviewId/response` (create or resubmit) and
 * `PATCH` (edit). Trimmed first, so a body of spaces is a `400`. No title, no
 * rating, no attachment, no vendor id: the vendor comes from the session.
 */
export const ReviewResponseBodySchema = z.object({
  body: z.string().trim().min(1).max(REVIEW_RESPONSE_BODY_MAX),
});
export type ReviewResponseBodyInput = z.infer<typeof ReviewResponseBodySchema>;

/**
 * The caller's own reply, in any status (`API_CONTRACTS.md` §6.14). The vendor
 * sees its rejection or removal reason (ruling 7). `moderated_by` and the author
 * never cross the wire.
 */
export const VendorReviewResponseSchema = z.object({
  id: z.string().uuid(),
  status: ReviewResponseStatusSchema,
  body: z.string(),
  /** Set when rejected or removed; shown to the vendor. */
  rejection_reason: z.string().nullable(),
  published_at: z.string().nullable(),
  moderated_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type VendorReviewResponse = z.infer<typeof VendorReviewResponseSchema>;

/** `201` on create, `200` on resubmit, edit and withdraw. */
export const VendorReviewResponseResultSchema = z.object({
  response: VendorReviewResponseSchema,
});
export type VendorReviewResponseResult = z.infer<typeof VendorReviewResponseResultSchema>;

// ─── Vendor list (AECI-1176) ─────────────────────────────────────────────────

/** `GET /api/vendor/reviews`. A `product_id` the caller does not own narrows to
 *  an empty page, never a `404`. */
export const ListVendorReviewsQuerySchema = PageQuerySchema.extend({
  product_id: z.string().uuid().optional(),
  reply_status: ReviewReplyStatusFilterSchema.optional(),
});
export type ListVendorReviewsQuery = z.infer<typeof ListVendorReviewsQuerySchema>;

/**
 * One approved review of a product the caller owns.
 *
 * `review` is the public shape without `vendor_responses` (`API_CONTRACTS.md`
 * §6.14). The caller's own reply is `response` and the co-owners' are
 * `other_responses`, so the public array would say the same thing twice.
 */
export const VendorReviewItemSchema = z.object({
  review: PublicReviewSchema.omit({ vendor_responses: true }),
  product: ProductLinkSchema,
  /** The caller's own reply, any status. `null` when it has not replied. */
  response: VendorReviewResponseSchema.nullable(),
  /** Co-owners' published replies, in public order. */
  other_responses: z.array(PublicVendorResponseSchema),
  /** The caller's plan holds `review.reply` for this product. Withdraw is never
   *  gated, so a `false` here still allows it. */
  can_reply: z.boolean(),
});
export type VendorReviewItem = z.infer<typeof VendorReviewItemSchema>;

export const ListVendorReviewsResponseSchema = paginatedResponseSchema(VendorReviewItemSchema);
export type ListVendorReviewsResponse = z.infer<typeof ListVendorReviewsResponseSchema>;
