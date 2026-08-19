import { z } from 'zod';

import { CAPABILITIES, ENTITLEMENT_STATUSES, TIERS } from '../entitlements';

/**
 * Admin entitlement action contracts (AECI-610 declares the shapes; AECI-532
 * builds the endpoint — `docs/STAGE_2_PAID_TIERS_SPEC.md` §5).
 *
 *   PATCH /api/admin/vendors/:id/entitlement — set / renew / clear
 *
 * behind `requireAdmin()`. This module exists **separately from
 * `../entitlements`** on purpose: the registry is consumed by the lazy
 * `/vendor` Angular route and must import no zod (§3.1 / §10 R11 — one value
 * import from an `api/*` module once dragged the schema set plus a 327 kB zod
 * chunk into the Angular initial graph). The dependency runs one way only:
 * `api/*` → registry, never back.
 *
 * **`verified` is never in the request body.** `vendors.verified` is a MIRROR
 * of the entitlement row (§2.1), written in the same batch by
 * `lib/vendor-entitlement.ts` and by nothing else. A payload that set it
 * directly — AECI-532's original shape — would create a second direct writer
 * and break the mirror invariant. It appears on the RESPONSE as a read-only
 * readout of where the mirror landed.
 *
 * The arrangement fields are a superset of `ClaimEntitlementSchema`
 * (`./admin-claims`), whose caps they reuse. `amount` stays a free-form
 * `string`, not a number: currency-agnostic ("USD 5,000 / yr") and
 * payer-model-agnostic (§8.1(4)).
 */

/** The tier ladder as a wire enum — derived, so a new rung needs no edit here. */
export const EntitlementTierSchema = z.enum(TIERS);

/** The §2.2 status vocabulary as a wire enum — the same list as the DB CHECK. */
export const EntitlementStatusSchema = z.enum(ENTITLEMENT_STATUSES);

/** The capability vocabulary as a wire enum — derived, so a new capability id
 *  needs no edit here. Consumed by the §4 `GET /api/vendor/me` readout below. */
export const CapabilitySchema = z.enum(CAPABILITIES);

/**
 * The entitlement block on `GET /api/vendor/me` (§4 / AECI-611).
 *
 * Built entirely from `AuthenticatedSession` — the same `entitlementTier` the
 * write gate asserts on — so the dashboard's readout and the 403 it would get
 * from a write **cannot disagree**, and the block costs no extra round-trip.
 *
 * `tier` is always present and is `'unclaimed'` for a vendor with no active
 * entitlement (fail-closed, §3.1). `status` / `period_end` are `null` when there
 * is no readable `vendor_entitlements` row at all — `null` means "no term on
 * record", never "unknown". `capabilities` is the expansion of `tier` through
 * `TIER_CAPABILITIES`, shipped so the dashboard disables controls off one field
 * rather than re-deriving the ladder in the browser.
 *
 * **This block is never gated** (§4.3 / R13): a `revoked` or `expired`
 * entitlement still returns 200 here, carrying the downgraded values. Gating it
 * would 404 the whole dashboard — `vendorMeResolver` maps 401/403/404 onto a 404
 * render — and hide the renewal notice from exactly the cohort being billed.
 *
 * Required, not optional (R10): a missed construction site must fail
 * `validateResponseInDev` rather than ship as `undefined`.
 */
export const VendorEntitlementBlockSchema = z.object({
  tier: EntitlementTierSchema,
  status: EntitlementStatusSchema.nullable(),
  /** `null` = perpetual or no term on record, not "unknown". */
  period_end: z.string().nullable(),
  capabilities: z.array(CapabilitySchema),
});
export type VendorEntitlementBlock = z.infer<typeof VendorEntitlementBlockSchema>;

/**
 * An ISO-8601 term boundary. Accepts a date-only value (`2027-08-14`, what a
 * date picker submits) as well as a full timestamp; the handler normalizes on
 * write. Rejecting date-only would make the admin control unusable without
 * client-side formatting.
 */
export const EntitlementTermDateSchema = z.union([z.string().date(), z.string().datetime()]);

/**
 * The offline arrangement recorded on the entitlement row. Every field
 * optional: an admin may record a term with no paperwork reference yet, and
 * `clear` carries none of them. Caps match the shipped `ClaimEntitlementSchema`
 * so the two surfaces can never disagree about what fits.
 */
export const EntitlementArrangementSchema = z.object({
  payer: z.string().max(200).optional(),
  amount: z.string().max(100).optional(),
  terms: z.string().max(500).optional(),
  arranged_by: z.string().max(200).optional(),
  invoice_ref: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
});
export type EntitlementArrangement = z.infer<typeof EntitlementArrangementSchema>;

/**
 * Body for `PATCH /api/admin/vendors/:id/entitlement` (§5.1).
 *
 *  - `set`    — grant or replace an entitlement (422 if one is already `active`)
 *  - `renew`  — extend the term of the active entitlement
 *  - `clear`  — end it (422 if already inactive); this is the only writer that
 *               takes `vendors.verified` back down (§5)
 *
 * `tier` defaults to the paid entry rung on `set`, so the common case is a
 * two-field call. `reason` is an INTERNAL audit note (cf. `ModerateClaimSchema`)
 * — recorded in `audit_log` metadata, never emailed to the vendor.
 */
export const SetVendorEntitlementSchema = EntitlementArrangementSchema.extend({
  action: z.enum(['set', 'renew', 'clear']),
  tier: EntitlementTierSchema.optional(),
  period_start: EntitlementTermDateSchema.optional(),
  period_end: EntitlementTermDateSchema.optional(),
  reason: z.string().max(500).optional(),
});
export type SetVendorEntitlementInput = z.infer<typeof SetVendorEntitlementSchema>;

/**
 * The entitlement readout returned by the action (and reused by the
 * `/admin/claims` entitlement column).
 *
 * Nullable, not optional, on everything that can genuinely be absent: R10 —
 * a required field shipping as `undefined` from a missed construction site is
 * exactly what `validateResponseInDev` is there to catch, and `.optional()`
 * would hide it. A vendor with no entitlement row at all is represented by the
 * endpoint returning `entitlement: null`, not by a half-populated object.
 */
export const VendorEntitlementResponseSchema = z.object({
  vendor_id: z.string().uuid(),
  tier: EntitlementTierSchema,
  status: EntitlementStatusSchema,
  period_start: z.string().nullable(),
  /** `null` = perpetual (the §2.4 backfilled rows), not "unknown". */
  period_end: z.string().nullable(),
  granted_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  /** Read-only readout of the mirror (§2.1). Never accepted on the request. */
  verified: z.boolean(),
  payer: z.string().nullable(),
  amount: z.string().nullable(),
  terms: z.string().nullable(),
  arranged_by: z.string().nullable(),
  invoice_ref: z.string().nullable(),
  notes: z.string().nullable(),
});
export type VendorEntitlementResponse = z.infer<typeof VendorEntitlementResponseSchema>;
