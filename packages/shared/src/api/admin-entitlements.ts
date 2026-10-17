import { z } from 'zod';

import { CAPABILITIES, ENTITLEMENT_STATUSES, TIERS } from '../entitlements';

import { PlanPriceSchema } from './admin-plan-pricing';

/**
 * Entitlement read-side contracts (`docs/STAGE_2_PAID_TIERS_SPEC.md` §4).
 *
 * WHAT IS LEFT. AECI-1375 retired `PATCH /api/admin/vendors/:id/entitlement`
 * (set / renew / clear) and with it every write-only shape this file held
 * (`SetVendorEntitlementSchema`, `PaidEntitlementTierSchema`, the arrangement
 * schema, `VendorEntitlementResponseSchema`). Licenses are the plan now
 * (AECI-1355), written on the admin Billing tab (`admin-licenses.ts`). What
 * remains is read by the vendor portal and the license contracts: the tier,
 * status and capability enums, the `GET /api/vendor/me` entitlement block, and
 * the term-date shape. E1.8 and E1.9 remove this file with the
 * `vendor_entitlements` table and its readers.
 *
 * This module exists **separately from `../entitlements`** on purpose: the
 * registry is consumed by the lazy `/vendor` Angular route and must import no
 * zod (§3.1 / §10 R11 — one value import from an `api/*` module once dragged
 * the schema set plus a 327 kB zod chunk into the Angular initial graph). The
 * dependency runs one way only: `api/*` → registry, never back.
 */

/**
 * The tier ladder as a wire enum — derived, so a new rung needs no edit here.
 *
 * **This is the READ shape.** It includes `unclaimed`, because the session block
 * (§4) and the grant summary (§6) must be able to *report* that a vendor has no
 * entitlement.
 */
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
  /**
   * `vendor_entitlements.ended_at`: when the row left `active` (AECI-1218,
   * `STAGE_2_PAID_TIERS_SPEC.md` §13.11). The pilot-ended banner's date line.
   * `null` for no row, and for a row that has not ended.
   */
  ended_at: z.string().nullable(),
  capabilities: z.array(CapabilitySchema),
  /**
   * The vendor's plan price overrides (ruling 2026-10-08, §13.13). Display only.
   * Both `null` = the default sentence. Unlike the fields above this is read
   * from `vendor_plan_pricing`, not the session, so every builder takes it.
   */
  price: PlanPriceSchema,
});
export type VendorEntitlementBlock = z.infer<typeof VendorEntitlementBlockSchema>;

/**
 * An ISO-8601 term boundary. Accepts a date-only value (`2027-08-14`, what a
 * date picker submits) as well as a full timestamp; the handler normalizes on
 * write. The license grant and extend bodies use it (`admin-licenses.ts`).
 */
export const EntitlementTermDateSchema = z.union([z.string().date(), z.string().datetime()]);
