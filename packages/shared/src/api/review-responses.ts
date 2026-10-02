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

// ─── Admin queue (AECI-1177) ─────────────────────────────────────────────────

/** The status of the review a reply answers, as the admin queue shows it. Every
 *  status the D1 CHECK allows, because a review can leave `approved` after a reply
 *  was written (§11c.11), and the card warns when it has. */
export const AdminReviewResponseReviewStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'archived',
]);

/**
 * `GET /api/admin/review-responses` (`API_CONTRACTS.md` §6.10,
 * `ADMIN_PANEL_SPEC.md` §5.13). The status tabs map one-to-one onto `status`.
 * Ordered `updated_at ASC, id ASC`, oldest first.
 */
export const ListAdminReviewResponsesQuerySchema = PageQuerySchema.extend({
  status: ReviewResponseStatusSchema.default('pending'),
});
export type ListAdminReviewResponsesQuery = z.infer<typeof ListAdminReviewResponsesQuerySchema>;

/** One reply as an admin reads it: the reply, its review in full, the product,
 *  the vendor and the seat that last wrote it. */
export const AdminReviewResponseSchema = z.object({
  id: z.string().uuid(),
  status: ReviewResponseStatusSchema,
  body: z.string(),
  rejection_reason: z.string().nullable(),
  vendor: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string() }),
  /** `false` when the vendor no longer owns the product: the reply will not
   *  render even if approved (§11c.11 rule 3). */
  vendor_owns_product: z.boolean(),
  /** The seat that last wrote it. `null` when the account was erased or the
   *  GoTrue seam is unavailable. */
  author_email: z.string().nullable(),
  product: ProductLinkSchema,
  review: z.object({
    id: z.string().uuid(),
    status: AdminReviewResponseReviewStatusSchema,
    title: z.string(),
    body: z.string(),
    rating_overall: z.number().int().min(1).max(5),
    rating_onboarding: z.number().int().min(1).max(5),
    created_at: z.string(),
  }),
  moderated_at: z.string().nullable(),
  published_at: z.string().nullable(),
  created_at: z.string(),
  /** On a pending row: when it entered the queue. */
  updated_at: z.string(),
});
export type AdminReviewResponse = z.infer<typeof AdminReviewResponseSchema>;

export const ListAdminReviewResponsesResponseSchema =
  paginatedResponseSchema(AdminReviewResponseSchema);
export type ListAdminReviewResponsesResponse = z.infer<
  typeof ListAdminReviewResponsesResponseSchema
>;

/** The reason on a reject or remove. Shown to the vendor (ruling 7). */
export const REVIEW_RESPONSE_REASON_MAX = 1000;

const decisionReason = z.string().trim().min(1).max(REVIEW_RESPONSE_REASON_MAX);

/**
 * The `updated_at` of the version the admin read, echoed back verbatim from the
 * queue row. The API compares it as an exact string with the stored value. A
 * vendor edit or a withdraw-and-resubmit moves `updated_at` without moving the
 * status, so the status check alone would let an admin approve text they never
 * saw. A mismatch is `409 REVIEW_RESPONSE_CHANGED` (§11c.7).
 */
const expectedUpdatedAt = z.string().min(1).max(64);

/**
 * Body of `PATCH /api/admin/review-responses/:id`. A reason is REQUIRED for
 * reject and remove. Approve takes none. Every decision carries
 * `expected_updated_at`, the version the admin decided on. The from-state each
 * decision needs is in {@link REVIEW_RESPONSE_DECISIONS}.
 */
export const DecideReviewResponseSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), expected_updated_at: expectedUpdatedAt }),
  z.object({
    decision: z.literal('reject'),
    reason: decisionReason,
    expected_updated_at: expectedUpdatedAt,
  }),
  z.object({
    decision: z.literal('remove'),
    reason: decisionReason,
    expected_updated_at: expectedUpdatedAt,
  }),
]);
export type DecideReviewResponseInput = z.infer<typeof DecideReviewResponseSchema>;
export type ReviewResponseDecision = DecideReviewResponseInput['decision'];

/**
 * The admin half of the §11c.6 state machine, as data. Each decision has exactly
 * one from-state, and any other is `409 REVIEW_RESPONSE_WRONG_STATE`. `purges`
 * says whether public visibility changes, so whether `product:{slug}` is purged
 * after commit. The web queue reads `from` to decide which buttons a card
 * carries, so the screen and the API cannot disagree.
 */
export const REVIEW_RESPONSE_DECISIONS = {
  approve: { from: 'pending', to: 'published', purges: true },
  reject: { from: 'pending', to: 'rejected', purges: false },
  remove: { from: 'published', to: 'removed', purges: true },
} as const satisfies Record<
  ReviewResponseDecision,
  { from: ReviewResponseStatus; to: ReviewResponseStatus; purges: boolean }
>;

/** The decisions an admin may take on a reply in `status`. Empty for every
 *  status but `pending` and `published`. */
export function reviewResponseDecisionsFor(
  status: ReviewResponseStatus,
): readonly ReviewResponseDecision[] {
  return (Object.keys(REVIEW_RESPONSE_DECISIONS) as ReviewResponseDecision[]).filter(
    (d) => REVIEW_RESPONSE_DECISIONS[d].from === status,
  );
}
