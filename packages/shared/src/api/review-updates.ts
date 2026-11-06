import { z } from 'zod';

import { PageQuerySchema, ProductLinkSchema, paginatedResponseSchema } from './common';

/**
 * Reviewer updates to published reviews (AECI-1613, `STAGE_1_SPEC.md` §4.7a).
 *
 * A reviewer adds an update to one of their own APPROVED reviews, for example
 * after the vendor fixed the problem the review describes. The original review
 * never changes. AECi approves every update before it shows (pre-moderation), and
 * the product page renders it under the original with its own date. The table is
 * `review_updates` (`DATABASE_SCHEMA.md` §7.4).
 *
 * An update may re-rate the product. It carries BOTH ratings or NEITHER, and the
 * latest approved update that carries ratings is the review's rating in the
 * product's averages. `review_count` does not move: an update is not a review.
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are
 * for API consumers and logs; the Angular surfaces render their own copy.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The four update statuses. Mirrored by the hand-written D1 column CHECK
 * `review_updates_status_check` in migration 0106; `migration-0106.spec.ts` in
 * the API Worker asserts the two agree. `removed` is final for that row.
 */
export const REVIEW_UPDATE_STATUSES = ['pending', 'approved', 'rejected', 'removed'] as const;

export const ReviewUpdateStatusSchema = z.enum(REVIEW_UPDATE_STATUSES);
export type ReviewUpdateStatus = z.infer<typeof ReviewUpdateStatusSchema>;

/** The trimmed body is 50 to 2,000 characters, the same bounds as a review body. */
export const REVIEW_UPDATE_BODY_MIN = 50;
export const REVIEW_UPDATE_BODY_MAX = 2000;

export { PublicReviewUpdateSchema, type PublicReviewUpdate } from './reviews';

const rating = z.number().int().min(1).max(5);

// ─── Reviewer write ──────────────────────────────────────────────────────────

/**
 * Body of `POST /api/account/reviews/:reviewId/updates`. The body is trimmed
 * first, so a body of spaces is a `400`. The two ratings are optional together:
 * send both to re-rate, or neither. One without the other is `400
 * VALIDATION_FAILED` keyed to the missing field.
 */
export const SubmitReviewUpdateSchema = z
  .object({
    body: z.string().trim().min(REVIEW_UPDATE_BODY_MIN).max(REVIEW_UPDATE_BODY_MAX),
    rating_overall: rating.nullable().optional(),
    rating_onboarding: rating.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const overall = value.rating_overall ?? null;
    const onboarding = value.rating_onboarding ?? null;
    if ((overall === null) === (onboarding === null)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [overall === null ? 'rating_overall' : 'rating_onboarding'],
      message: 'An update re-rates both ratings or neither.',
    });
  });
export type SubmitReviewUpdateInput = z.infer<typeof SubmitReviewUpdateSchema>;

/**
 * One of the caller's own updates, in any status (`GET /api/account/reviews`
 * `updates[]`, and the `201` of the submit). The reviewer sees the moderator's
 * reason on a rejected or removed update. `moderated_by` and the toxicity score
 * never cross the wire.
 */
export const AccountReviewUpdateSchema = z.object({
  id: z.string().uuid(),
  status: ReviewUpdateStatusSchema,
  body: z.string(),
  rating_overall: rating.nullable(),
  rating_onboarding: rating.nullable(),
  /** Set when rejected or removed; shown to the reviewer. */
  rejection_reason: z.string().nullable(),
  published_at: z.string().nullable(),
  moderated_at: z.string().nullable(),
  created_at: z.string(),
});
export type AccountReviewUpdate = z.infer<typeof AccountReviewUpdateSchema>;

/** `201` envelope for the submit. `status` is always `pending`. */
export const SubmitReviewUpdateResponseSchema = z.object({
  update: AccountReviewUpdateSchema,
});
export type SubmitReviewUpdateResponse = z.infer<typeof SubmitReviewUpdateResponseSchema>;

// ─── Admin queue ─────────────────────────────────────────────────────────────

/**
 * `GET /api/admin/review-updates` (`API_CONTRACTS.md` §6.10,
 * `ADMIN_PANEL_SPEC.md` §5.20). The status tabs map one-to-one onto `status`.
 * Ordered `created_at ASC, id ASC`, oldest first. An update is immutable after
 * submit, so `created_at` is when it entered the queue.
 */
export const ListAdminReviewUpdatesQuerySchema = PageQuerySchema.extend({
  status: ReviewUpdateStatusSchema.default('pending'),
});
export type ListAdminReviewUpdatesQuery = z.infer<typeof ListAdminReviewUpdatesQuerySchema>;

/** The status of the review an update belongs to. Every status the D1 CHECK
 *  allows, because a review could in principle leave `approved` after the update
 *  was written. The card warns when it has. */
export const AdminReviewUpdateReviewStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'archived',
]);

/**
 * One update as an admin reads it: the update, the original review in full
 * beside it, the product, and the reviewer's address.
 */
export const AdminReviewUpdateSchema = z.object({
  id: z.string().uuid(),
  status: ReviewUpdateStatusSchema,
  body: z.string(),
  rating_overall: rating.nullable(),
  rating_onboarding: rating.nullable(),
  rejection_reason: z.string().nullable(),
  /** The moderation triage signal, as on reviews. `null` when unscored. */
  toxicity_score: z.number().nullable(),
  /** `null` when the review was anonymized or the GoTrue seam is unavailable. */
  reviewer_email: z.string().nullable(),
  product: ProductLinkSchema,
  /** The original review, exactly as it was published. */
  review: z.object({
    id: z.string().uuid(),
    status: AdminReviewUpdateReviewStatusSchema,
    title: z.string(),
    body: z.string(),
    rating_overall: rating,
    rating_onboarding: rating,
    created_at: z.string(),
  }),
  moderated_at: z.string().nullable(),
  published_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AdminReviewUpdate = z.infer<typeof AdminReviewUpdateSchema>;

export const ListAdminReviewUpdatesResponseSchema =
  paginatedResponseSchema(AdminReviewUpdateSchema);
export type ListAdminReviewUpdatesResponse = z.infer<typeof ListAdminReviewUpdatesResponseSchema>;

/** The reason on a reject or remove. Shown to the reviewer. */
export const REVIEW_UPDATE_REASON_MAX = 1000;

const decisionReason = z.string().trim().min(1).max(REVIEW_UPDATE_REASON_MAX);

/**
 * Body of `PATCH /api/admin/review-updates/:id`. A reason is REQUIRED for reject
 * and remove; approve takes none. No version field: an update is immutable after
 * submit, so the status guard alone decides. The from-state each action needs is
 * in {@link REVIEW_UPDATE_DECISIONS}.
 */
export const DecideReviewUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), reason: decisionReason }),
  z.object({ action: z.literal('remove'), reason: decisionReason }),
]);
export type DecideReviewUpdateInput = z.infer<typeof DecideReviewUpdateSchema>;
export type ReviewUpdateDecision = DecideReviewUpdateInput['action'];

/**
 * The admin half of the update state machine, as data. Each action has exactly
 * one from-state, and any other is `409 REVIEW_UPDATE_WRONG_STATE`. `purges` says
 * whether the public page changes, so whether `product:{slug}` is purged and the
 * product's averages recomputed after commit. The web queue reads `from` to
 * decide which buttons a card carries, so the screen and the API cannot disagree.
 */
export const REVIEW_UPDATE_DECISIONS = {
  approve: { from: 'pending', to: 'approved', purges: true },
  reject: { from: 'pending', to: 'rejected', purges: false },
  remove: { from: 'approved', to: 'removed', purges: true },
} as const satisfies Record<
  ReviewUpdateDecision,
  { from: ReviewUpdateStatus; to: ReviewUpdateStatus; purges: boolean }
>;

/** The actions an admin may take on an update in `status`. Empty for
 *  `rejected` and `removed`. */
export function reviewUpdateDecisionsFor(
  status: ReviewUpdateStatus,
): readonly ReviewUpdateDecision[] {
  return (Object.keys(REVIEW_UPDATE_DECISIONS) as ReviewUpdateDecision[]).filter(
    (d) => REVIEW_UPDATE_DECISIONS[d].from === status,
  );
}
