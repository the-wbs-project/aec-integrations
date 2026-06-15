import { z } from 'zod';

import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Review-submission contract (AECI-197 / Phase 5.6): the body and response for
 * `POST /api/reviews`, the first authenticated user write in the product.
 *
 * Source of truth is `docs/API_CONTRACTS.md` §6.6 and the `reviews` table
 * (`STAGE_1_PHASE_5_SPEC.md` §5.2 / the baseline migration). The endpoint is an
 * auth-gated insert of a `status='pending'` row for the Phase 5 moderation
 * pipeline to pick up.
 *
 * Server-set, never-client-supplied columns are deliberately ABSENT from the
 * schema: `reviewer_id` (the verified token `sub`, set by `requireAuth()`),
 * `status` (always `'pending'`), and `locale` (resolved from the trusted
 * `x-aeci-locale` header → `DEFAULT_LOCALE`, see `routes/reviews.ts`). The
 * client supplies only the fields below.
 *
 * i18n note: this package is framework-agnostic (no `$localize`), so the
 * messages here are plain English for API consumers / logs. The Angular review
 * form (Phase 5.9) never renders them — it shows `$localize` copy keyed off
 * field validity, mirroring the `requests.ts` pattern. See ADR 0009.
 */

/** Wire body for `POST /api/reviews`. Matches `API_CONTRACTS.md` §6.6 exactly. */
export const SubmitReviewSchema = z.object({
  product_id: z.string().uuid(),
  rating_overall: z.number().int().min(1).max(5),
  rating_onboarding: z.number().int().min(1).max(5),
  title: z.string().min(5).max(100),
  body: z.string().min(50).max(2000),
  role_at_company: z.enum(['practitioner', 'manager', 'IT', 'exec', 'other']).optional(),
  years_using: z.number().int().min(0).max(50).optional(),
  would_recommend: z.enum(['yes', 'no', 'maybe']).optional(),
});
export type SubmitReviewInput = z.infer<typeof SubmitReviewSchema>;

/** 201 envelope for `POST /api/reviews`. `message` is a user-facing,
 *  locale-appropriate acknowledgment; `status` is always `'pending'`. */
export type SubmitReviewResponse = {
  id: string;
  status: 'pending';
  message: string;
};

/**
 * The moderation lifecycle of a review. A submitted review enters `pending`;
 * an admin moves it to `approved` or `rejected` (§7.2). Extracted here so the
 * admin queue, the account-reviews list, and the frontend status badge all
 * share one source of truth rather than re-declaring the enum inline.
 */
export const ReviewStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

/**
 * Public read contract for approved reviews (AECI-199 / Phase 5.8): the item
 * shape for `GET /api/products/:slug/reviews` and the `ProductDetail.reviews`
 * SSR embed. Source of truth is `docs/API_CONTRACTS.md` §6.6 /
 * `STAGE_1_PHASE_5_SPEC.md` §5.4.
 *
 * No PII: `reviewer_id`, reviewer email, `status`, `toxicity_score`, moderation
 * columns, and `updated_at` are deliberately ABSENT — only approved, public
 * fields cross the wire. The endpoint returns approved reviews only, paginated,
 * newest-first.
 */
export const PublicReviewSchema = z.object({
  id: z.string().uuid(),
  rating_overall: z.number().int().min(1).max(5),
  rating_onboarding: z.number().int().min(1).max(5),
  title: z.string(),
  body: z.string(),
  role_at_company: z.string().nullable(),
  years_using: z.number().int().nullable(),
  would_recommend: z.enum(['yes', 'no', 'maybe']).nullable(),
  verified_work_email: z.boolean(),
  created_at: z.string().datetime(),
});
export type PublicReview = z.infer<typeof PublicReviewSchema>;

/**
 * Query params for `GET /api/products/:slug/reviews` — page-based pagination
 * only. Order is fixed newest-first server-side (§5.4), so there is no `sort`
 * param. New work uses `PageQuerySchema` (page/perPage), not the older
 * `PaginationQuerySchema` the doc text still references (API_CONTRACTS §0 note).
 */
export const ProductReviewsQuerySchema = PageQuerySchema;
export type ProductReviewsQuery = z.infer<typeof ProductReviewsQuerySchema>;

/** Paginated envelope for `GET /api/products/:slug/reviews`. Plain
 *  `PaginatedResponse<PublicReview>` — the ratings summary lives only on
 *  `ProductDetail`, not on this list (§5.4 / §5.5). */
export const ProductReviewsResponseSchema = paginatedResponseSchema(PublicReviewSchema);
export type ProductReviewsResponse = z.infer<typeof ProductReviewsResponseSchema>;

/**
 * Admin moderation contract (AECI-204 / Phase 5.13): the query, item, and write
 * shapes for the two admin endpoints
 *
 *   GET   /api/admin/reviews     — the moderation queue (any status)
 *   PATCH /api/admin/reviews/:id — approve / reject a pending review
 *
 * Source of truth is `docs/API_CONTRACTS.md` §6.10 and `STAGE_1_PHASE_5_SPEC.md`
 * §7.2 / §22.1. Both endpoints are admin-only (`requireAdmin()`); the item shape
 * carries fields the public `PublicReview` contract deliberately hides —
 * `status`, the `toxicity_score` Perspective triage signal, the moderation
 * columns, and the author's `reviewer_email`.
 *
 * Contract note (deviates from `API_CONTRACTS.md` §6.10 as written):
 * `reviewer_email` is `string | null`, NOT `string`. A review whose author has
 * deleted their account is anonymized (`reviewer_id` → NULL via the `SetNull`
 * FK), so there is no email to surface; the field is also null if the
 * `auth.users` lookup fails (the queue degrades rather than 500-ing).
 */

/** Moderation queue filter (`API_CONTRACTS.md` §6.10). `PageQuerySchema`
 *  (page/perPage), not the doc's stale `PaginationQuerySchema` — matches the
 *  rest of Phase 5 (`product-reviews`). `queue_age` is oldest-first (work the
 *  backlog), `created_at` is newest-first. */
export const ListPendingReviewsQuerySchema = PageQuerySchema.extend({
  status: ReviewStatusSchema.default('pending'),
  sort: z.enum(['queue_age', 'created_at']).default('queue_age'),
});
export type ListPendingReviewsQuery = z.infer<typeof ListPendingReviewsQuerySchema>;

/** Admin-only review item (`API_CONTRACTS.md` §6.10). A superset of
 *  `PublicReview`: adds the hydrated `product` ref, the moderation columns
 *  (`status`, `rejection_reason`, `moderated_at`), and the admin-only
 *  `toxicity_score` + `reviewer_email`. */
export const AdminReviewSchema = z.object({
  id: z.string().uuid(),
  product: LinkRefSchema,
  reviewer_email: z.string().nullable(),
  rating_overall: z.number().int().min(1).max(5),
  rating_onboarding: z.number().int().min(1).max(5),
  title: z.string(),
  body: z.string(),
  role_at_company: z.string().nullable(),
  years_using: z.number().int().nullable(),
  would_recommend: z.enum(['yes', 'no', 'maybe']).nullable(),
  verified_work_email: z.boolean(),
  locale: z.string(),
  status: ReviewStatusSchema,
  toxicity_score: z.number().nullable(),
  rejection_reason: z.string().nullable(),
  moderated_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});
export type AdminReview = z.infer<typeof AdminReviewSchema>;

/** Paginated envelope for `GET /api/admin/reviews`. */
export const ListPendingReviewsResponseSchema = paginatedResponseSchema(AdminReviewSchema);
export type ListPendingReviewsResponse = z.infer<typeof ListPendingReviewsResponseSchema>;

/**
 * Body for `PATCH /api/admin/reviews/:id`. `rejection_reason` is optional at the
 * field level (approve never sends one) but REQUIRED, non-empty, when
 * `action === 'reject'` — enforced by the cross-field refine, which surfaces as
 * the canonical `VALIDATION_FAILED` envelope keyed to `rejection_reason`.
 */
export const ModerateReviewSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    rejection_reason: z.string().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'reject' && (value.rejection_reason ?? '').trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejection_reason'],
        message: 'rejection_reason is required when rejecting a review',
      });
    }
  });
export type ModerateReviewInput = z.infer<typeof ModerateReviewSchema>;

/**
 * Advisory "consider a ban" prompt (AECI-218 / Phase 6.11 — Spec §9 / §22.3). The
 * moderate-review response carries this **only** when a *reject* pushes the
 * reviewer's total rejected-review count to **3 or more** (and the review was not
 * anonymized — `reviewer_id` is known). It is informational: the admin decides
 * whether to ban via `PATCH /api/admin/reviewers/:id`. `reviewer_id` is the ban
 * target (= the profile id); `reviewer_email` is the same admin-only lookup the
 * queue uses (null on failure).
 */
export const RepeatOffenderPromptSchema = z.object({
  reviewer_id: z.string().uuid(),
  reviewer_email: z.string().nullable(),
  rejected_count: z.number().int(),
});
export type RepeatOffenderPrompt = z.infer<typeof RepeatOffenderPromptSchema>;

/**
 * `PATCH /api/admin/reviews/:id` response envelope. The moderated `review` plus an
 * optional `repeat_offender` prompt (AECI-218): non-null only on the reject that
 * makes the reviewer's rejected count ≥ 3; always null on approve / 1st–2nd
 * rejection / anonymized reviews. Wrapping (rather than returning a bare
 * `AdminReview`) lets the prompt ride back with the action — faithful to "when the
 * reviewer's 3rd review is rejected, surface a prompt".
 */
export const ModerateReviewResponseSchema = z.object({
  review: AdminReviewSchema,
  repeat_offender: RepeatOffenderPromptSchema.nullable(),
});
export type ModerateReviewResponse = z.infer<typeof ModerateReviewResponseSchema>;
