import { z } from 'zod';

import { AdminVendorRequestSchema } from './admin-requests';
import {
  EntitlementTermDateSchema,
  EntitlementTierSchema,
  VendorEntitlementResponseSchema,
} from './admin-entitlements';
import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';

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
 * open the entitlement, resolve the request) rather than a plain resolve. The
 * `/admin/claims` LIST + reviewer UI is AECI-521; the claim-decision emails are
 * AECI-528; this issue is the grant mechanics.
 *
 * Since AECI-612 (`STAGE_2_PAID_TIERS_SPEC.md` §6) the grant also opens the
 * `vendor_entitlements` row that `vendors.verified` now MIRRORS, in the same
 * `db.batch` — which is why `ClaimGrantSummary` reports a `tier` and whether the
 * row was created.
 */

/**
 * The offline PO/invoice arrangement carried by a claim approval. `amount` is a
 * free-form string to stay currency-agnostic (e.g. "USD 5,000 / yr").
 *
 * **Two destinations since AECI-612** (`STAGE_2_PAID_TIERS_SPEC.md` §6.6). It keeps
 * landing verbatim in the grant's `audit_log` metadata — per §2.1 the audit log IS the
 * entitlement history ledger, so the metadata write is the history — and it now ALSO
 * populates the `vendor_entitlements` row the grant creates in the same `db.batch`.
 * The former "`vendors.verified` IS the launch entitlement bit, so this lives in the
 * audit trail and never in a column" (AECI-519 / `STAGE_2_SPEC.md` §8.3(1)) is
 * superseded: `verified` is now a MIRROR of that row (§2.1).
 *
 * `invoice_ref` / `period_start` / `period_end` are ADDITIVE (AECI-612): the shipped
 * `/admin/claims` approve form sends only `notes`, so it needs no change, but an admin
 * who knows the term at approval time can record it without a second round-trip through
 * `PATCH /api/admin/vendors/:id/entitlement`. Every field is a structural subset of
 * `EntitlementArrangementSchema` (`./admin-entitlements`) with matching caps, so the
 * claim body passes straight through to `activateEntitlementStatements` and the two
 * surfaces can never disagree about what fits.
 */
export const ClaimEntitlementSchema = z.object({
  payer: z.string().max(200).optional(),
  amount: z.string().max(100).optional(),
  terms: z.string().max(500).optional(),
  arranged_by: z.string().max(200).optional(),
  invoice_ref: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  /** ISO-8601 term boundaries; date-only is accepted (what a date picker submits). */
  period_start: EntitlementTermDateSchema.optional(),
  period_end: EntitlementTermDateSchema.optional(),
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
 * new one", and show the resulting verification + entitlement state.
 *  - `identity_outcome` — `linked` (an auth user already owned the email) vs
 *    `invited` (one was provisioned; onboarding is the AECI-528 claim-approved email).
 *  - `verified` — where the `vendors.verified` MIRROR landed after the grant (§2.1).
 *  - `seat_created` — a brand-new `profiles` row was written (grant landed before
 *    the claimant's first sign-in), vs an existing row upgraded in place.
 *  - `tier` — the vendor's entitlement tier after the grant, resolved fail-closed by
 *    `tierFor` (`@aeci/shared/entitlements`): `unclaimed` when no `active` row backs
 *    the seat, which is the honest readout for a drifted vendor.
 *  - `entitlement_created` — a `vendor_entitlements` row was INSERTed by this grant,
 *    vs one that already existed (the second-seat no-op, or a reactivation).
 *
 * `tier` and `entitlement_created` are REQUIRED, not optional (AECI-612 / §6.7, R10):
 * the `/admin/claims` `ClaimQueue` ignores unknown keys, so a construction site that
 * forgot one would ship `undefined` silently. Required is what makes
 * `validateResponseInDev` catch it.
 */
export const ClaimGrantSummarySchema = z.object({
  user_id: z.string().uuid(),
  vendor_id: z.string().uuid(),
  verified: z.boolean(),
  identity_outcome: z.enum(['linked', 'invited']),
  seat_created: z.boolean(),
  tier: EntitlementTierSchema,
  entitlement_created: z.boolean(),
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
  /**
   * The vendor this claim's entitlement applies to (AECI-532 /
   * `STAGE_2_PAID_TIERS_SPEC.md` §5), already RESOLVED: for a `target_type='vendor'`
   * claim that is the target itself; for a `target_type='product'` claim it is the
   * product's PRIMARY vendor — the same resolution `resolveTargetVendor` runs on the
   * grant path, so the queue's entitlement control always names the row a grant would
   * actually touch. `null` when there is no vendor to act on (a product with no
   * `product_vendors` row) or when the enrichment query degraded.
   *
   * Present so the `/admin/claims` entitlement control can address
   * `PATCH /api/admin/vendors/:id/entitlement` — `target_id` alone cannot, because on
   * a product claim it is a PRODUCT id.
   */
  entitlement_vendor: LinkRefSchema.nullable(),
  /**
   * That vendor's current entitlement, or `null` for "no entitlement on record"
   * (never claimed, or the row was cleared) — the same readout the PATCH returns, so
   * a successful action drops straight into the row with no refetch.
   *
   * Required, not optional (R10): a missed construction site must fail
   * `validateResponseInDev`, not ship as `undefined`.
   */
  entitlement: VendorEntitlementResponseSchema.nullable(),
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
