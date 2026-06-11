import { z } from 'zod';

/**
 * Admin-surface contracts (`/api/admin/*`).
 *
 * Phase 5.12 (AECI-203) ships only the admin shell's badge feed —
 * `GET /api/admin/summary`. The full moderation queue (`GET /api/admin/reviews`,
 * paginated) and the moderation action (`PATCH /api/admin/reviews/:id`) are Phase
 * 5.13 and land their schemas here alongside this one. Source of truth is
 * `docs/API_CONTRACTS.md` §6.10 and `STAGE_1_PHASE_5_SPEC.md` §7.
 *
 * i18n note: this package is framework-agnostic (no `$localize`) — any strings
 * here are for API consumers / logs, never rendered by the Angular admin shell.
 */

/**
 * Response for `GET /api/admin/summary` (AECI-203 / Phase 5.12).
 *
 * The aggregate counts the admin shell renders as nav badges. Phase 5.12 exposes
 * only `pending_reviews` — the moderation-queue badge (`STAGE_1_SPEC.md` §22.1).
 * Phase 6 extends this with request counts (vendor claims / corrections).
 *
 * Deliberately a bare object (no pagination envelope): the SSR `ServerApiClient`
 * returns `response.json()` verbatim, and the resolver reads `pending_reviews`
 * directly. A 200 also doubles as the SSR admin-gate signal (the resolver maps a
 * 401/403 to a 404 render — don't reveal the surface).
 */
export const AdminSummaryResponseSchema = z.object({
  pending_reviews: z.number().int().nonnegative(),
});
export type AdminSummaryResponse = z.infer<typeof AdminSummaryResponseSchema>;
