import { z } from 'zod';

import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Admin requests moderation contracts (AECI-216 / Phase 6.9) — the admin-facing
 * read + action surface for vendor claim/correction requests, behind
 * `requireAdmin()`:
 *
 *   GET   /api/admin/requests     — the requests queue, filtered by kind/status,
 *                                    paginated.
 *   PATCH /api/admin/requests/:id — resolve / reject an open (or in-review) request.
 *
 * Source of truth: `STAGE_1_PHASE_6_SPEC.md` §8.1, `API_CONTRACTS.md` §6.10. The
 * row shape mirrors the `vendor_requests` table (DATABASE_SCHEMA §8.1) plus a
 * read-time-computed `is_duplicate` flag (Phase 6 Spec §7.2 — no column; derived
 * by the list handler). The site→Linear sync (§6.5 / AECI-213) and the
 * submit-time domain-match + duplicate Linear note (§7 / AECI-215) are owned by
 * separate issues.
 *
 * Pagination uses `PageQuerySchema` (page/perPage), not `API_CONTRACTS.md`'s
 * stale `PaginationQuerySchema` (offset/limit) — matches the rest of Phase 5/6
 * (the §0 note at API_CONTRACTS §6 flags §6.10 as pending exactly this
 * realignment).
 */

/** Moderation queue filter (`API_CONTRACTS.md` §6.10). `status` defaults to
 *  `open` (the working queue). The filter enum is `open|resolved|rejected` per
 *  the contract — note that `in_review` rows (set by the inbound Linear webhook,
 *  AECI-212) are not reachable by any filter value; see the row schema below. */
export const ListVendorRequestsQuerySchema = PageQuerySchema.extend({
  kind: z.enum(['claim', 'correction']).optional(),
  status: z.enum(['open', 'resolved', 'rejected']).default('open'),
});
export type ListVendorRequestsQuery = z.infer<typeof ListVendorRequestsQuerySchema>;

/**
 * Admin-only request row (`API_CONTRACTS.md` §6.10). Mirrors the `vendor_requests`
 * columns. Notes:
 *  - `status` includes `in_review` even though the query filter does not — a row
 *    can legitimately be `in_review` (the inbound Linear webhook moves an actively
 *    worked issue there), and a PATCH-from-`in_review` response must validate.
 *  - `domain_match` is surfaced verbatim from the DB (`pending|match|no_match|
 *    manual_review`), so a permissive `z.string()` — NOT `z.enum(['yes','no'])`.
 *    It deviates from §7.1's yes/no framing; computing it is a 6.8 (AECI-215)
 *    concern, so today every row reads `pending`.
 *  - `is_duplicate` is COMPUTED at read time (no column): an OPEN sibling request
 *    shares the same `(kind, target_type, target_id)` or `(submitter_email,
 *    target_type, target_id)` (Phase 6 Spec §7.2). Informational only.
 *  - target is the loose-polymorphic `(target_type, target_id)` pair — no FK, no
 *    name/slug hydration here (the dashboard UI resolves links itself).
 */
export const AdminVendorRequestSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['claim', 'correction']),
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']),
  target_type: z.enum(['product', 'vendor']),
  target_id: z.string().uuid(),
  submitter_email: z.string(),
  submitter_name: z.string().nullable(),
  submitter_role: z.string().nullable(),
  domain_match: z.string(),
  body: z.string(),
  source_url: z.string().nullable(),
  is_duplicate: z.boolean(),
  linear_issue_id: z.string().nullable(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
  resolved_by: z.string().uuid().nullable(),
});
export type AdminVendorRequest = z.infer<typeof AdminVendorRequestSchema>;

/** Paginated envelope for `GET /api/admin/requests`. */
export const ListVendorRequestsResponseSchema = paginatedResponseSchema(AdminVendorRequestSchema);
export type ListVendorRequestsResponse = z.infer<typeof ListVendorRequestsResponseSchema>;

/**
 * Body for `PATCH /api/admin/requests/:id`. `reason` is optional for BOTH actions
 * (unlike `ModerateReviewSchema`, where reject requires one) — `vendor_requests`
 * has no rejection-reason column, so the reason is recorded in the
 * `workflow_transition.reason` + audit metadata, not stored on the row.
 */
export const ModerateRequestSchema = z.object({
  action: z.enum(['resolve', 'reject']),
  reason: z.string().max(500).optional(),
});
export type ModerateRequestInput = z.infer<typeof ModerateRequestSchema>;

/** `PATCH /api/admin/requests/:id` returns the moderated request (`AdminVendorRequest`). */
export type ModerateRequestResponse = AdminVendorRequest;
