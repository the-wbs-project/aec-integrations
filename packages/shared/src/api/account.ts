import { z } from 'zod';

import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';
import { ReviewStatusSchema } from './reviews';

/**
 * Account contracts (AECI-202 / Phase 5.11): the signed-in user's own account
 * surface — read identity, edit the display name, and the GDPR right-to-erasure
 * delete. These back `apps/web/src/app/account/` and the `GET`/`PATCH`/`DELETE
 * /api/account` handlers (`apps/api/src/routes/account.ts`).
 *
 * `STAGE_1_PHASE_5_SPEC.md` §6 / `API_CONTRACTS.md` §6.8. `email` is read-only —
 * it comes from the verified session JWT, never a body field — so it is absent
 * from `UpdateAccountSchema`. The `GET`/`PATCH` shapes are a Phase-5.11 addition
 * beyond §6.8 (which documents only `DELETE`); flagged for doc reconciliation.
 *
 * i18n note: this package is framework-agnostic (no `$localize`), so the Zod
 * messages here are plain English for API consumers / logs. The Angular form
 * renders its own `$localize` copy keyed off field validity (ADR 0009).
 */

// ─── Profile read / update ──────────────────────────────────────────────────

/**
 * Mutable profile fields for `PATCH /api/account`. Only `display_name` is
 * editable today; it is nullable so the user can clear it back to the "Verified
 * reviewer" fallback. The server trims and stores `''`-after-trim as a rejected
 * value (min length 1) — pass an explicit `null` to clear.
 */
export const UpdateAccountSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, 'Display name must be at least 1 character.')
    .max(80, 'Keep your display name under 80 characters.')
    .nullable(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountSchema>;

/** Returned by `GET /api/account` and `PATCH /api/account`. `email` is read-only
 *  (from the session JWT); `display_name` is null when unset. `role` is the
 *  caller's own `profiles.role` (e.g. `'admin'` / `'reviewer'`), re-fetched from
 *  the verified session on every request — the web client reads it to decide
 *  whether to surface admin affordances (AECI-259). */
export interface AccountProfileResponse {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
}

// ─── Delete (GDPR erasure) ──────────────────────────────────────────────────

/** Returned by `DELETE /api/account` (API_CONTRACTS §6.8). */
export interface DeleteAccountResponse {
  message: string;
}

// ─── Own reviews list (AECI-225 / Phase 5.11) ────────────────────────────────

/**
 * Reviewer-scoped reviews contract (AECI-225): the query, item, and envelope for
 * `GET /api/account/reviews` — the signed-in user's OWN submitted reviews on
 * `/account`. Source of truth is `STAGE_1_PHASE_5_SPEC.md` §6.1 / `API_CONTRACTS.md`
 * §6.8. The endpoint is auth-gated and scoped server-side to
 * `reviewer_id = session.userId` (never a client-supplied id).
 *
 * Unlike the public `PublicReview` (approved-only, no PII), this list returns the
 * caller's reviews in **every** status (`pending` / `approved` / `rejected`) plus
 * `rejection_reason`, so the user can see where each review stands. It is a
 * different slice from the admin `AdminReview` too — no `reviewer_email`,
 * `toxicity_score`, `locale`, or moderation columns (the author has no need for,
 * and no right to, those admin-only signals).
 *
 * Pagination is **page-based** (`PageQuerySchema`), consistent with every other
 * list endpoint (Phase 2 Spec §7.3) — the issue's "cursor" wording is a deviation
 * noted in `API_CONTRACTS.md` §6.8. Order is fixed newest-first server-side, so
 * there is no `sort` param.
 */
export const AccountReviewsQuerySchema = PageQuerySchema;
export type AccountReviewsQuery = z.infer<typeof AccountReviewsQuerySchema>;

/** A single own-review row for `GET /api/account/reviews`. `product` is the
 *  hydrated `{ id, name, slug }` ref so the card links to the product; the two
 *  ratings echo what the user submitted. `rejection_reason` is non-null only on
 *  a `rejected` review. */
export const AccountReviewSchema = z.object({
  id: z.string().uuid(),
  product: LinkRefSchema,
  rating_overall: z.number().int().min(1).max(5),
  rating_onboarding: z.number().int().min(1).max(5),
  title: z.string(),
  status: ReviewStatusSchema,
  rejection_reason: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type AccountReview = z.infer<typeof AccountReviewSchema>;

/** Paginated envelope for `GET /api/account/reviews`. Plain
 *  `PaginatedResponse<AccountReview>`. */
export const AccountReviewsResponseSchema = paginatedResponseSchema(AccountReviewSchema);
export type AccountReviewsResponse = z.infer<typeof AccountReviewsResponseSchema>;
