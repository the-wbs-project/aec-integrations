import { z } from 'zod';

import { AdminVendorRequestSchema } from './admin-requests';

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
 * `vendor_requests` has no reason column, matching `ModerateRequestSchema`).
 * `entitlement` is only meaningful on `approve`.
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
