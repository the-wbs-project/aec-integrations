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
 * The aggregate counts the admin shell renders as nav badges. Phase 5.12 exposed
 * only `pending_reviews` — the moderation-queue badge (`STAGE_1_SPEC.md` §22.1).
 * **AECI-922 added the other two Operations queues**, so the console's nav can
 * show one number per screen and their sum on the closed Operations trigger:
 *
 *   `pending_reviews`   `reviews.status = 'pending'`
 *   `pending_requests`  open `vendor_requests` of kind `correction`
 *   `pending_claims`    open `vendor_requests` of kind `claim`
 *
 * **The three are disjoint and the UI sums them.** Requests and claims are the
 * same table split by `kind`, so `pending_requests` is corrections-ONLY — an
 * all-kinds count would put every open claim into the total twice. The server
 * owns that rule in `apps/api/src/lib/admin-queue-counts.ts`, which is the sole
 * implementation behind both this endpoint and `GET /api/account`.
 *
 * Deliberately a bare object (no pagination envelope): the SSR `ServerApiClient`
 * returns `response.json()` verbatim, and the resolver reads the counts
 * directly. A 200 also doubles as the SSR admin-gate signal (the resolver maps a
 * 401/403 to a 404 render — don't reveal the surface).
 */
export const AdminSummaryResponseSchema = z.object({
  pending_reviews: z.number().int().nonnegative(),
  pending_requests: z.number().int().nonnegative(),
  pending_claims: z.number().int().nonnegative(),
  /** Rows awaiting a manual Google Request Indexing (AECI-946). Unlike the
   *  three above this needs no predicate: a row in `gsc_recrawl_queue` is
   *  pending by construction, because Done deletes it. */
  pending_reindex: z.number().int().nonnegative(),
  /** Open integration field contests routed to AECi (AECI-1008). Disjoint from
   *  the three Operations queues above: a different table. Optional on the wire
   *  type for deploy skew, and because the console does not render it until the
   *  `/admin/contests` screen ships (AECI-1008 PR C). The server always sends it. */
  pending_contests: z.number().int().nonnegative().optional(),
});
export type AdminSummaryResponse = z.infer<typeof AdminSummaryResponseSchema>;
