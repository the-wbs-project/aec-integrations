import { z } from 'zod';

import { AdminVendorRequestSchema } from './admin-requests';
import { EntitlementTierSchema } from './vendor';
import {
  AdminAuditRowSchema,
  VendorOwnedIntegrationsSchema,
  VendorProductRolesSchema,
} from './admin-vendors';
import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Admin claim → vendor-account grant contracts (AECI-519 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §3). The admin-facing action surface that
 * turns an approved vendor CLAIM into a live verified vendor account, behind
 * `requireAdmin()`:
 *
 *   PATCH /api/admin/claims/:id — approve (grant) / reject a claim.
 *
 * This is a sibling of `PATCH /api/admin/requests/:id` (`admin-requests.ts`),
 * NOT a replacement: corrections still moderate through the requests endpoint;
 * claims moderate here so approval can run the §3 grant batch (link the seat,
 * write the billing account, resolve the request) rather than a plain resolve. The
 * `/admin/claims` LIST + reviewer UI is AECI-521; the claim-decision emails are
 * AECI-528; this issue is the grant mechanics.
 *
 * Since AECI-1367 (`VENDOR_SIGNUP_PROCESS.md` §3 step 2) every approval lands on
 * Free: the grant writes the seat, the billing account when the vendor has none, and
 * the claim's acceptance link, and never a license. AECI-1215's plan
 * choice is gone. `ClaimGrantSummary.tier` reports the vendor's live state.
 */

/**
 * The approve arm's retired fields (AECI-1367, `VENDOR_SIGNUP_PROCESS.md` §3 step 2).
 * Every approval lands on Free, so the operator no longer picks a plan and there is no
 * offline arrangement to record. A body that still names `plan` or `entitlement` is a
 * stale client that believes it is choosing something, so it is refused with a 400 on
 * that field rather than silently stripped. Managed is bought later, as licenses on the
 * vendor's billing account.
 */
const RETIRED_APPROVE_FIELD = z
  .never({
    error: 'Claim approval no longer takes a plan: every approval lands on Free (AECI-1367).',
  })
  .optional();

/**
 * Body for `PATCH /api/admin/claims/:id`, discriminated on `action`. `reason` is
 * optional for both actions (recorded in the workflow transition + audit metadata,
 * not stored on the row — `vendor_requests` has no reason column, matching
 * `ModerateRequestSchema`). It is an INTERNAL decision note: admin-visible in the
 * audit log and NEVER emailed to the claimant (the claim-rejected email never
 * carries the reviewer's reason, §9; since AECI-1420 it may carry the system's
 * account-conflict reason, which is a fact about the recipient's own account).
 *
 * `approve` takes no plan (AECI-1367): a body with `plan` or `entitlement` is a 400
 * `VALIDATION_FAILED` on that field. `reject` carries neither and strips unknown keys,
 * as everywhere.
 */
const ModerateClaimApproveSchema = z.object({
  action: z.literal('approve'),
  reason: z.string().max(500).optional(),
  plan: RETIRED_APPROVE_FIELD,
  entitlement: RETIRED_APPROVE_FIELD,
});

const ModerateClaimRejectSchema = z.object({
  action: z.literal('reject'),
  reason: z.string().max(500).optional(),
});

export const ModerateClaimSchema = z.discriminatedUnion('action', [
  ModerateClaimApproveSchema,
  ModerateClaimRejectSchema,
]);
export type ModerateClaimInput = z.infer<typeof ModerateClaimSchema>;

/**
 * The grant outcome surfaced on a successful `approve`, so the reviewer
 * confirmation can distinguish "linked an existing account" from "provisioned a
 * new one", and show the vendor's resulting state.
 *  - `identity_outcome` — `linked` (an auth user already owned the email) vs
 *    `invited` (one was provisioned; onboarding is the claim-approved email).
 *  - `verified` — the vendor's `vendors.verified` MIRROR (§2.1). A grant never moves
 *    it (AECI-1367), so this is the value the vendor already had.
 *  - `seat_created` — a brand-new `profiles` row was written (grant landed before
 *    the claimant's first sign-in), vs an existing row upgraded in place.
 *  - `tier` — the vendor's live entitlement tier, resolved fail-closed by `tierFor`
 *    (`@aeci/shared/entitlements`). The grant writes no entitlement, so this is
 *    `unclaimed` (Free) unless the vendor already held an `active` row.
 *
 * Since AECI-1367 every approval lands on Free. The summary lost `plan` (there is no
 * choice to report) and `entitlement_created` (the grant never writes an entitlement).
 *
 * `tier` is REQUIRED, not optional (AECI-612 / §6.7, R10): the `/admin/claims`
 * `ClaimQueue` ignores unknown keys, so a construction site that forgot it would ship
 * `undefined` silently. Required is what makes `validateResponseInDev` catch it.
 */
export const ClaimGrantSummarySchema = z.object({
  user_id: z.string().uuid(),
  vendor_id: z.string().uuid(),
  verified: z.boolean(),
  identity_outcome: z.enum(['linked', 'invited']),
  seat_created: z.boolean(),
  tier: EntitlementTierSchema,
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
 * from a FIRST claim (empty roster).
 *
 * `email` is the seat's sign-in address from the GoTrue seam (AECI-1277). The
 * surface labels a seat by `display_name`, else by `email`, so a seat whose holder
 * never set a name (every Google sign-in, until they do) still says who holds it.
 * Admin-only: it rides `/api/admin/*` and nothing else. `null` either because the
 * seam was unreachable or because the account has no address; the claim's
 * `seat_emails_available` says which.
 */
export const AdminVendorSeatSchema = z.object({
  display_name: z.string().nullable(),
  email: z.string().nullable(),
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
 * The claimant's existing seat, classified against the claim's resolved vendor
 * (AECI-1420, `STAGE_2_VENDOR_PORTAL_SPEC.md` §2). One account belongs to one
 * vendor (`STAGE_2_SPEC.md` §8.3), so a claim from an address seated elsewhere
 * would be refused at grant with `409 GRANT_CONFLICT`. This says so before the
 * reviewer presses Grant.
 *  - `none` — the account exists with no seat, or with a seat on THIS vendor. A
 *    second seat on the same vendor is the expected case, not a conflict.
 *  - `admin` — the account is a site admin and cannot hold a vendor seat.
 *  - `other_vendor` — the account holds a seat on another vendor, named here.
 */
export const AdminClaimantSeatSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('admin') }),
  z.object({
    kind: z.literal('other_vendor'),
    vendor: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  }),
]);
export type AdminClaimantSeat = z.infer<typeof AdminClaimantSeatSchema>;

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
  /** Whether the GoTrue email lookup for `existing_seats` succeeded (AECI-1277),
   *  the same three-state discipline as `AdminVendorDetail.seat_emails_available`.
   *  `false` ⇒ every seat `email` is `null` because the seam was unavailable, NOT
   *  because the accounts have no address. `true` when there was nothing to look up. */
  seat_emails_available: z.boolean(),
  related_requests: RelatedRequestRefSchema.array().nullable(),
  /**
   * The vendor this claim acts on, already RESOLVED: for a `target_type='vendor'`
   * claim that is the target itself; for a `target_type='product'` claim it is the
   * product's PRIMARY vendor — the same resolution `resolveTargetVendor` runs on the
   * grant path, so the queue's links always name the vendor a grant would actually
   * touch. `null` when there is no vendor to act on (a product with no
   * `product_vendors` row) or when the enrichment query degraded.
   *
   * Drives the "Manage billing" link to the vendor's Billing tab and the vendor
   * audit-trail link: `target_id` alone cannot, because on a product claim it is a
   * PRODUCT id. AECI-1375 dropped the entitlement readout that sat beside it.
   */
  entitlement_vendor: LinkRefSchema.nullable(),
  /**
   * The §5.2 **payer test**, answerable from the card (AECI-738) — the resolved
   * vendor's owned products split by `products.product_role`, scoped to the same
   * `entitlement_vendor` a grant would touch.
   *
   * `null` = the signal was UNAVAILABLE (the vendor resolution or this query
   * degraded), consistent with `existing_seats` / `related_requests`. A vendor
   * that genuinely owns nothing is NOT null — it is a zeroed breakdown, because
   * "no products on record" is a real, reviewable answer and "we could not look"
   * is a different one.
   */
  product_roles: VendorProductRolesSchema.nullable(),
  /**
   * `true` ⇒ every product this vendor owns is `'connector'` (and it owns at
   * least one). Since AECI-1367 (Chris's ruling 2026-10-14) such a claim is
   * approved like any other. The flag is informational: the queue shows
   * "Connector vendor: contact them directly", and the `claim-submitted-alert`
   * email carries the same line.
   *
   * `false` covers two different situations and the UI must not conflate them —
   * the vendor owns an `application`/`hybrid` product (an ordinary paying
   * vendor), or it owns no products at all (**unknown, never exempt**).
   * `product_roles.total` separates them. `null` = signal unavailable, and moves
   * with `product_roles`.
   */
  is_pure_connector_vendor: z.boolean().nullable(),
  /**
   * The live integrations that vendor owns (`built_by_vendor_id`), over BOTH
   * delivered-tier tables (AECI-1041). This is the owner half of the §5.2 payer
   * test (step 1a, `STAGE_2_SPEC.md` §8.10). A reviewer signal: since AECI-1367
   * every claim, connector or not, takes the ordinary Grant.
   *
   * `null` = the signal was UNAVAILABLE, like `product_roles`. A vendor that owns
   * nothing is a zeroed object, not `null`. It warns and never gates.
   */
  owned_integrations: VendorOwnedIntegrationsSchema.nullable(),
  /**
   * The free-text operator note (AECI-739): what was said out of band. `null` when
   * no note has been written; **never `undefined`** (R10).
   *
   * On the queue as well as the detail page, deliberately: the note has to be
   * legible from the LIST, which is where the operator actually looks.
   *
   * It is admin-authored, admin-only and **never** claimant-facing — it is not
   * emailed, and it is not an `AdminNote` (that is the closed-enum data-caveat
   * envelope). Written through `PATCH /api/admin/claims/:id/notes`; the audit_log
   * rows that write emits ARE the note's history, so this field is only ever the
   * current text.
   */
  admin_notes: z.string().nullable(),
  /**
   * The product page the claimant came from (AECI-1364), shown as "Came from" on the
   * queue and the detail. Since `docs/VENDOR_SIGNUP_PROCESS.md` decision 1 a claim is
   * on the company: a claim sent from a product page is stored with the vendor as its
   * target and the product in `vendor_requests.context_product_id`. `null` for a
   * company-page claim, a claim stored before the change (its target is still the
   * product), or a product that has since been removed. Required, never `undefined`
   * (R10).
   */
  context_product: LinkRefSchema.nullable(),
  /**
   * AECI-1322: `true` when the claim was resolved through the grant. Read as
   * `status = 'resolved' AND resolved_by_id IS NOT NULL`. A claim the Linear webhook
   * resolved (issue moved to Done) has no `resolved_by_id` and reads `false`, so the
   * console says "Resolved without a grant" instead of implying a seat exists.
   */
  granted: z.boolean(),
  /**
   * AECI-1368: when this claim was routed to the company's owners, because the
   * company already had an unbanned owner seat (`STAGE_2_VENDOR_PORTAL_SPEC.md`
   * §11a.10). While set, the owners decide first and the queue shows "With owners
   * until" this plus 7 days. Grant and Reject stay enabled: it warns, never gates.
   * `null` for a claim that was never routed, or one the fallback handed back.
   *
   * An owner who accepts the claim resolves it with `resolved_by_id` set to the
   * owner, so `granted` reads `true` for it. The seat itself comes later, when the
   * claimant redeems the invite, and it is a member seat, not an owner seat.
   */
  routed_to_owners_at: z.string().nullable(),
  /** AECI-1368: when the `claim_owner_fallback` cron handed a routed claim back to
   *  AECi after 7 days with no owner decision, or `null`. */
  owner_fallback_at: z.string().nullable(),
  /**
   * AECI-1420: the claimant's existing seat, beside `has_auth_account`. Read from
   * the claimant's `profiles` row (looked up by the auth user id the GoTrue
   * lookup returned) and classified against `entitlement_vendor`'s id, the vendor
   * a grant would seat. `null` = unknown: no account, the lookup was unavailable
   * or failed, or the profile read degraded. The queue and the detail page show
   * a red box for `admin` and `other_vendor`, and the queue disables Grant.
   */
  claimant_seat: AdminClaimantSeatSchema.nullable(),
});
export type AdminClaim = z.infer<typeof AdminClaimSchema>;

/** Claim-review queue filter. Mirrors `ListVendorRequestsQuerySchema` but has no
 *  `kind` — the endpoint is claims-only. `status` defaults to `open` (the working
 *  queue).
 *
 *  The enum carries all FOUR statuses (AECI-739). It offered only
 *  `open|resolved|rejected` until then, which meant an `in_review` claim — the
 *  status the Linear webhook writes when its issue moves to a `started` state
 *  (`STATE_TYPE_TO_STATUS`, `routes/webhooks.ts`) — was invisible in every queue
 *  tab while still being addressable at `/admin/claims/:id`. A detail route must
 *  not imply a status the list cannot then find. */
export const ListVendorClaimsQuerySchema = PageQuerySchema.extend({
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']).default('open'),
});
export type ListVendorClaimsQuery = z.infer<typeof ListVendorClaimsQuerySchema>;

/** Paginated envelope for `GET /api/admin/claims`. */
export const ListVendorClaimsResponseSchema = paginatedResponseSchema(AdminClaimSchema);
export type ListVendorClaimsResponse = z.infer<typeof ListVendorClaimsResponseSchema>;

// ---------------------------------------------------------------------------
// Claim detail + operator note (AECI-739 / §5.2 step 6)
// ---------------------------------------------------------------------------

/**
 * One open claim that makes THIS claim read as a duplicate — the explanation
 * behind the queue's `is_duplicate` chip (AECI-739).
 *
 * §5.2 step 5 records the trap: a claim parked `open` (the prescribed handling
 * for a pure-connector vendor) stays inside the `openClaims` group-by that
 * computes `is_duplicate`, so **every later claim on that vendor renders the
 * chip** — including a legitimate one from a real endpoint contact. This makes
 * the cause nameable rather than leaving the reviewer to guess. The chip's
 * SEMANTICS are deliberately unchanged; only its legibility.
 *
 * `match_reason` says which of the list's two rules fired:
 *  - `target`    — another open claim on the same `(target_type, target_id)`.
 *  - `submitter` — another open claim from the same submitter on that target.
 * A row matching both reports `target`, the broader signal.
 */
export const ClaimDuplicateSiblingSchema = z.object({
  id: z.string().uuid(),
  submitter_email: z.string(),
  submitter_name: z.string().nullable(),
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']),
  created_at: z.string(),
  match_reason: z.enum(['target', 'submitter']),
  /** Whether that sibling carries an operator note — i.e. whether it is a
   *  DELIBERATELY parked claim rather than an unattended one. */
  has_notes: z.boolean(),
});
export type ClaimDuplicateSibling = z.infer<typeof ClaimDuplicateSiblingSchema>;

/**
 * `GET /api/admin/claims/:id` — one claim, every signal the queue card carries,
 * plus the duplicate explanation the list has no room for.
 *
 * `duplicate_siblings` is an array, never `null`: unlike the queue's fail-soft
 * enrichment signals it is computed in the same round trip as `is_duplicate`
 * itself, and `is_duplicate` on this response IS `duplicate_siblings.length > 0`
 * — so the two can never disagree with each other or with the list.
 */
export const AdminClaimDetailSchema = AdminClaimSchema.extend({
  duplicate_siblings: ClaimDuplicateSiblingSchema.array(),
});
export type AdminClaimDetail = z.infer<typeof AdminClaimDetailSchema>;

/**
 * `PATCH /api/admin/claims/:id/notes` — write or clear the operator note.
 *
 * A sub-resource rather than a third `ModerateClaimSchema.action`: moderation is a one-way status
 * transition that grants or declines, and a note is neither. It is writable at
 * ANY status — a resolved or rejected claim is exactly where "why we parked it,
 * and what happened next" matters most.
 *
 * `null` (or a string that trims to empty) CLEARS the note. 2000 chars, not
 * `ModerateClaimSchema.reason`'s 500: this is a running record of an out-of-band
 * conversation, not a transition reason.
 */
export const SaveClaimNotesSchema = z.object({
  notes: z.string().max(2000).nullable(),
});
export type SaveClaimNotesInput = z.infer<typeof SaveClaimNotesSchema>;

// ─── GET /api/admin/claims/:id/audit (AECI-1276) ─────────────────────────────

export const AdminClaimAuditQuerySchema = PageQuerySchema;
export type AdminClaimAuditQuery = z.infer<typeof AdminClaimAuditQuerySchema>;

/**
 * The claim's audit trail on `/admin/claims/:id`. **One disjunct**: every claim
 * writer files under `entity_type = 'vendor_request'` with the claim id
 * (`vendor_request.created`, `vendor_claim.note_updated`, `vendor_claim.granted`,
 * `vendor_claim.rejected`, plus the Linear webhook's `vendor_request.status_changed`),
 * so `audit_log_entity_idx` answers it directly.
 *
 * A Managed grant's `vendor_entitlement.granted` row is filed against the VENDOR
 * and stays on the vendor's audit tab. It is not here.
 *
 * Same shape as `AdminConnectorAuditResponseSchema`: `actor_emails_available` is
 * `false` when the email seam failed, so an absent email reads as "unknown".
 */
export const AdminClaimAuditResponseSchema = paginatedResponseSchema(AdminAuditRowSchema).extend({
  actor_emails_available: z.boolean(),
});
export type AdminClaimAuditResponse = z.infer<typeof AdminClaimAuditResponseSchema>;
