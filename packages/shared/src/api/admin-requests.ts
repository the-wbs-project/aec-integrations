import { z } from 'zod';

import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';
import { PlanInterestSchema } from './requests';

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
 *  - target is the loose-polymorphic `(target_type, target_id)` pair — no FK. The
 *    list/PATCH handlers HYDRATE it into `target` (a `LinkRef`: id/name/slug) by
 *    resolving `target_id` against the products OR vendors table (AECI-217), so the
 *    `/admin/requests` UI can render a real detail link without a by-id route. A
 *    null `target` means the referenced row is missing (deleted/un-promoted) — the
 *    UI falls back to a non-linked label. `target_type`/`target_id` stay on the row
 *    (the discriminator the UI uses to pick `/products` vs `/vendors`).
 */
export const AdminVendorRequestSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['claim', 'correction']),
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']),
  target_type: z.enum(['product', 'vendor']),
  target_id: z.string().uuid(),
  target: LinkRefSchema.nullable(),
  submitter_email: z.string(),
  submitter_name: z.string().nullable(),
  submitter_role: z.string().nullable(),
  /** AECI-847 identity signal, claims only. The claimant's own LinkedIn profile
   *  URL, host-anchored to `linkedin.com` by `ClaimFormSchema` at submit. `null`
   *  for every correction, and for any claim where the optional field was skipped
   *  or that predates the column. `/admin/claims` renders it as the reviewer's
   *  primary person link, falling back to the built name-search URL when null. */
  submitter_linkedin_url: z.string().nullable(),
  /** AECI-1293: the claimant's answer to "Which plan are you interested in?", or
   *  `null` when not answered, for a correction, or for a claim that predates the
   *  column. Shown beside the plan radios on `/admin/claims`, which stay unselected
   *  whatever it says (`STAGE_2_PAID_TIERS_SPEC.md` §13.6). */
  plan_interest: PlanInterestSchema.nullable(),
  domain_match: z.string(),
  body: z.string(),
  source_url: z.string().nullable(),
  is_duplicate: z.boolean(),
  /** Reviewer signal (AECI-527 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §2): does a
   *  Supabase `auth.users` row already exist for `submitter_email`? `true` →
   *  approving this claim LINKS that account; `false` → it PROVISIONS a new one.
   *  `null` means unknown, and unknown is common by design: always null for
   *  `kind='correction'` (a correction has no account to link), null when the
   *  Supabase admin creds are absent or the GoTrue lookup failed, and null on the
   *  single-row PATCH confirmation (which does not fan out — the same posture as
   *  `is_duplicate: false` there). Informational only; it never gates a decision.
   *  Rendered by AECI-521's `/admin/claims` surface. */
  has_auth_account: z.boolean().nullable(),
  linear_issue_id: z.string().nullable(),
  /** AECI-261: the linked Linear issue's web permalink (`issue.url`), or null when
   *  unlinked or persisted before this column existed. Drives the /admin/requests link. */
  linear_issue_url: z.string().nullable(),
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

// ─── Listing requests (AECI-1293) ────────────────────────────────────────────

/**
 * The listing request queue (`VENDOR_PROGRAM_PAGE_SPEC.md` §15.5): a product or
 * company the visitor typed into the claim dialog because it is not in the catalog.
 * Its own table, `listing_requests`, so its own endpoints:
 *
 *   GET   /api/admin/listing-requests     — the queue, by status, paginated.
 *   PATCH /api/admin/listing-requests/:id — resolve / reject an open request.
 *
 * Rendered as the second section of `/admin/requests`. Moderation reuses
 * `ModerateRequestSchema` (reason optional, recorded in the audit row only).
 */
export const ListListingRequestsQuerySchema = PageQuerySchema.extend({
  status: z.enum(['open', 'resolved', 'rejected']).default('open'),
});
export type ListListingRequestsQuery = z.infer<typeof ListListingRequestsQuerySchema>;

export const AdminListingRequestSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['open', 'resolved', 'rejected']),
  listing_name: z.string(),
  /** `https://` only (`HttpsUrlSchema` at submit). Rendered as text plus a new-tab link. */
  website: z.string(),
  submitter_email: z.string(),
  submitter_name: z.string().nullable(),
  submitter_role: z.string().nullable(),
  submitter_linkedin_url: z.string().nullable(),
  plan_interest: PlanInterestSchema.nullable(),
  /** "Additional comments". `''` when the visitor wrote none. */
  body: z.string(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
  /** The deciding admin's profile id. No FK (§15.4), so it survives an erasure. */
  resolved_by: z.string().nullable(),
});
export type AdminListingRequest = z.infer<typeof AdminListingRequestSchema>;

export const ListListingRequestsResponseSchema = paginatedResponseSchema(AdminListingRequestSchema);
export type ListListingRequestsResponse = z.infer<typeof ListListingRequestsResponseSchema>;
