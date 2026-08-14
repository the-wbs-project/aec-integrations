import { z } from 'zod';

import { AdminVendorRequestSchema } from './admin-requests';
import { PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Admin claim → verified-account grant contracts (AECI-519 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §3). The admin-facing action surface that
 * turns an approved vendor CLAIM into a live verified vendor account, behind
 * `requireAdmin()`:
 *
 *   PATCH /api/admin/claims/:id — approve (grant) / reject a claim.
 *
 * This is a sibling of `PATCH /api/admin/requests/:id` (`admin-requests.ts`),
 * NOT a replacement: corrections still moderate through the requests endpoint;
 * claims moderate here so approval can run the §3 grant batch (link the seat,
 * flip `vendors.verified`, resolve the request) rather than a plain resolve. The
 * `/admin/claims` LIST + reviewer UI is AECI-521; the claim-decision emails are
 * AECI-528; this issue is the grant mechanics.
 */

/**
 * The offline PO/invoice arrangement recorded in the grant's `audit_log`
 * metadata. `vendors.verified` IS the launch entitlement bit (§3 / `STAGE_2_SPEC.md`
 * §8.3(1)); a formal entitlement model is deferred to AECI-515, so this arrangement
 * lives in the audit trail, never in a new column. `amount` is a free-form string
 * to stay currency-agnostic (e.g. "USD 5,000 / yr").
 */
export const ClaimEntitlementSchema = z.object({
  payer: z.string().max(200).optional(),
  amount: z.string().max(100).optional(),
  terms: z.string().max(500).optional(),
  arranged_by: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
});
export type ClaimEntitlement = z.infer<typeof ClaimEntitlementSchema>;

/**
 * Body for `PATCH /api/admin/claims/:id`. `reason` is optional for both actions
 * (recorded in the workflow transition + audit metadata, not stored on the row —
 * `vendor_requests` has no reason column, matching `ModerateRequestSchema`). It is
 * an INTERNAL decision note: admin-visible in the audit log and NEVER emailed to the
 * claimant (the claim-rejected email is neutral by design, §9). `entitlement` is
 * only meaningful on `approve`.
 */
export const ModerateClaimSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(500).optional(),
  entitlement: ClaimEntitlementSchema.optional(),
});
export type ModerateClaimInput = z.infer<typeof ModerateClaimSchema>;

/**
 * The grant outcome surfaced on a successful `approve`, so the reviewer
 * confirmation can distinguish "linked an existing account" from "provisioned a
 * new one", and show the resulting verification state.
 *  - `identity_outcome` — `linked` (an auth user already owned the email) vs
 *    `invited` (one was provisioned; onboarding is the AECI-528 claim-approved email).
 *  - `verified` — the vendor's verification state after the grant (true).
 *  - `seat_created` — a brand-new `profiles` row was written (grant landed before
 *    the claimant's first sign-in), vs an existing row upgraded in place.
 */
export const ClaimGrantSummarySchema = z.object({
  user_id: z.string().uuid(),
  vendor_id: z.string().uuid(),
  verified: z.boolean(),
  identity_outcome: z.enum(['linked', 'invited']),
  seat_created: z.boolean(),
});
export type ClaimGrantSummary = z.infer<typeof ClaimGrantSummarySchema>;

/**
 * `PATCH /api/admin/claims/:id` response: the moderated claim row plus, on an
 * approve, the `grant` summary (`null` on a reject). Wrapped rather than flat (cf.
 * `ModerateRequestResponse`, which is a bare row) because the grant carries state
 * that lives on the vendor + the seat, not on the claim row.
 */
export const ModerateClaimResponseSchema = z.object({
  request: AdminVendorRequestSchema,
  grant: ClaimGrantSummarySchema.nullable(),
});
export type ModerateClaimResponse = z.infer<typeof ModerateClaimResponseSchema>;

// ─── Claim-review LIST (AECI-521 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §5) ─────────
//
// The reviewer-assist queue: `GET /api/admin/claims` returns the pending vendor
// CLAIMS enriched with the verification signals a human weighs before granting
// (`STAGE_2_SPEC.md` §8.1(1) — no auto-grant). It clones the requests LIST
// envelope (`ListVendorRequestsResponse`) but adds three claim-only signals to
// each row. The `domain_match` + `has_auth_account` reviewer signals already ride
// on `AdminVendorRequest`; the LinkedIn/person search link is built client-side
// from `submitter_*` (a link only — real enrichment providers are a deferred
// DPA/GDPR decision, §8.3(4) / §11).

/**
 * A currently-active seat on the claimed vendor (§5 "existing seats" signal): a
 * `profiles` row with `role='vendor_admin'`, a matching `vendor_id`, and no ban.
 * Lets the reviewer tell a SECOND-SEAT request (the vendor already has admins)
 * from a FIRST claim (empty roster). No email — a seat belongs to the claimed
 * vendor, so `display_name` + when-granted + work-email-verified is the useful
 * signal without exposing a second party's address.
 */
export const AdminVendorSeatSchema = z.object({
  display_name: z.string().nullable(),
  work_email_verified: z.boolean(),
  created_at: z.string(),
});
export type AdminVendorSeat = z.infer<typeof AdminVendorSeatSchema>;

/**
 * A prior/sibling request from the claim's `submitter_email` (§5 "duplicate/
 * prior-request context"), excluding the claim itself. Any kind/status — a prior
 * correction or a rejected earlier claim is exactly the context the reviewer
 * wants. Pairs with `duplicate_of_request_id` (the explicit Phase-6 chain) and
 * the read-time `is_duplicate` flag.
 */
export const RelatedRequestRefSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['claim', 'correction']),
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']),
  target_type: z.enum(['product', 'vendor']),
  created_at: z.string(),
});
export type RelatedRequestRef = z.infer<typeof RelatedRequestRefSchema>;

/**
 * A claim row on the review queue: the full `AdminVendorRequest` (so the surface
 * reuses the requests-queue rendering for the shared fields) plus the three
 * claim-only signals. The two enrichment arrays are **nullable on purpose**:
 *  - `null` — the signal was UNAVAILABLE (its query failed / degraded); the UI
 *    renders "unavailable" and the review still proceeds (AC: graceful degrade).
 *  - `[]`  — the signal was COMPUTED and empty (a genuine first claim / no priors).
 */
export const AdminClaimSchema = AdminVendorRequestSchema.extend({
  /** The Phase-6 duplicate chain (`vendor_requests.duplicate_of_request_id`) —
   *  the earliest matching open request this one was flagged against, or null. */
  duplicate_of_request_id: z.string().uuid().nullable(),
  existing_seats: AdminVendorSeatSchema.array().nullable(),
  related_requests: RelatedRequestRefSchema.array().nullable(),
});
export type AdminClaim = z.infer<typeof AdminClaimSchema>;

/** Claim-review queue filter. Mirrors `ListVendorRequestsQuerySchema` but has no
 *  `kind` — the endpoint is claims-only. `status` defaults to `open` (the working
 *  queue); the `open|resolved|rejected` enum matches the requests contract. */
export const ListVendorClaimsQuerySchema = PageQuerySchema.extend({
  status: z.enum(['open', 'resolved', 'rejected']).default('open'),
});
export type ListVendorClaimsQuery = z.infer<typeof ListVendorClaimsQuerySchema>;

/** Paginated envelope for `GET /api/admin/claims`. */
export const ListVendorClaimsResponseSchema = paginatedResponseSchema(AdminClaimSchema);
export type ListVendorClaimsResponse = z.infer<typeof ListVendorClaimsResponseSchema>;
