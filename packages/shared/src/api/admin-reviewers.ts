import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Reviewer ban-management contracts (AECI-218 / Phase 6.11) — the admin-facing
 * ban/unban action + the currently-banned list, behind `requireAdmin()`:
 *
 *   GET   /api/admin/reviewers      — the currently-banned reviewers, paginated.
 *   PATCH /api/admin/reviewers/:id  — ban / unban a reviewer (a `profiles` row).
 *
 * Source of truth: `STAGE_1_PHASE_6_SPEC.md` §9, `STAGE_1_SPEC.md` §22.3,
 * `API_CONTRACTS.md` §6.10. Ban *enforcement* (rejecting a banned user's review
 * submit) already shipped in Phase 5 (AECI-197); this is the *management* half —
 * setting/clearing `profiles.banned_at` + `ban_reason`.
 *
 * `:id` is the profile id (= `auth.users.id` = `reviews.reviewer_id`). The
 * reviewer's email is admin-only and lives only in `auth.users.email` (no column
 * on `profiles`), so the list resolves it through the **GoTrue Admin API seam**
 * (`fetchAuthUserEmails`, `lib/supabase-admin.ts` — `AUTH_AND_RLS.md` §3.1 seam
 * #2), the same seam the moderation queue uses; it degrades to `null` on a lookup
 * failure, never a 500.
 *
 * The banned-only LIST is superseded as a screen by `/admin/users?banned=true`
 * (AECI-692) but kept as an endpoint; the PATCH stays the sole writer of
 * `profiles.banned_at` for every surface.
 *
 * i18n note: this package is framework-agnostic (no `$localize`) — any strings
 * here are for API consumers / logs, never rendered by the Angular admin shell.
 */

/**
 * Body for `PATCH /api/admin/reviewers/:id`. `reason` is optional at the field
 * level (unban never needs one) but REQUIRED, non-empty, when `action === 'ban'`
 * — enforced by the cross-field refine, which surfaces as the canonical
 * `VALIDATION_FAILED` envelope keyed to `reason`. Mirrors `ModerateReviewSchema`'s
 * reject-reason rule. On ban the reason is stored on `profiles.ban_reason`; on
 * unban both columns are cleared.
 */
export const BanReviewerSchema = z
  .object({
    action: z.enum(['ban', 'unban']),
    reason: z.string().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'ban' && (value.reason ?? '').trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'reason is required when banning a reviewer',
      });
    }
  });
export type BanReviewerInput = z.infer<typeof BanReviewerSchema>;

/** `PATCH /api/admin/reviewers/:id` returns the reviewer's post-action ban state.
 *  `banned_at`/`ban_reason` are null after an unban. */
export const BanReviewerResponseSchema = z.object({
  reviewer_id: z.string().uuid(),
  banned_at: z.string().datetime().nullable(),
  ban_reason: z.string().nullable(),
});
export type BanReviewerResponse = z.infer<typeof BanReviewerResponseSchema>;

/** A currently-banned reviewer row (`GET /api/admin/reviewers`). `reviewer_email`
 *  is admin-only (`auth.users.email`) and null when the lookup fails. `banned_at`
 *  is non-null by construction (the list filters `banned_at IS NOT NULL`). */
export const BannedReviewerSchema = z.object({
  reviewer_id: z.string().uuid(),
  reviewer_email: z.string().nullable(),
  banned_at: z.string().datetime(),
  ban_reason: z.string().nullable(),
});
export type BannedReviewer = z.infer<typeof BannedReviewerSchema>;

/** Query for `GET /api/admin/reviewers` — page/perPage only; the view is always
 *  the currently-banned set (newest ban first). */
export const ListBannedReviewersQuerySchema = PageQuerySchema;
export type ListBannedReviewersQuery = z.infer<typeof ListBannedReviewersQuerySchema>;

/** Paginated envelope for `GET /api/admin/reviewers`. */
export const ListBannedReviewersResponseSchema = paginatedResponseSchema(BannedReviewerSchema);
export type ListBannedReviewersResponse = z.infer<typeof ListBannedReviewersResponseSchema>;
