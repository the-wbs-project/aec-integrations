import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';

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
