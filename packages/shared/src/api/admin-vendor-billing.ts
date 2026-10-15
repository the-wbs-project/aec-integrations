import { z } from 'zod';

import { AdminAgreementAcceptanceSchema } from './agreements';

/**
 * The admin Billing view contract (AECI-1372, E4.3; `docs/VENDOR_SIGNUP_PROCESS.md`
 * decision 17 and §3; `docs/ADMIN_PANEL_SPEC.md` §5.7).
 *
 *   GET /api/admin/vendors/:id/billing, behind `requireAdmin()`. A read: no audit row,
 *   never rate-limited.
 *
 * One payload for the Billing tab on `/admin/vendors/:id`: the vendor's billing account
 * with its owner seats, every license on it, the agreement acceptances, and the
 * early-unassign requests (E4.4 fills these; the array ships empty until then).
 *
 * ── `billing_account: null` IS A DEFECT, NOT A STATE ─────────────────────────────
 * Every vendor with a seat or an entitlement was back-filled a billing account (E1,
 * AECI-1354), and every claim approval creates one. A vendor that still has none is a
 * vendor the back-fill missed. The response is a 200 with `billing_account: null` and an
 * empty `licenses`, so the tab can say so plainly. An unknown vendor is a 404.
 *
 * ── BOUNDED ──────────────────────────────────────────────────────────────────────
 * Licenses are capped at {@link ADMIN_BILLING_LICENSES_MAX} and acceptances at
 * {@link ADMIN_BILLING_ACCEPTANCES_MAX}. A grant writes at most 50 licenses, and a
 * Stripe subscription is one row per unit, so a real account sits far below the cap.
 * Live licenses sort first, so a truncated list drops the oldest ENDED licenses, never a
 * live one below the cap. `*_truncated` says when the cap bit.
 *
 * ── VOCABULARY COLUMNS ARE PLAIN STRINGS ────────────────────────────────────────
 * `source`, `end_reason` and `cancel_reason` are unconstrained in D1 (a CHECK change is
 * a table recreate). The writers validate against `LICENSE_SOURCES`,
 * `LICENSE_END_REASONS` and `LICENSE_CANCEL_REASONS` in `@aeci/shared/entitlements`.
 * This read takes `z.string()` so a row written by some future writer cannot break the
 * page; the UI labels the known values and shows any other token as is.
 */

/** The most licenses one Billing read returns. */
export const ADMIN_BILLING_LICENSES_MAX = 500;

/** The most agreement acceptances one Billing read returns. */
export const ADMIN_BILLING_ACCEPTANCES_MAX = 200;

/** One owner seat on the vendor: the seats that may buy (decision 10). */
export const AdminBillingOwnerSeatSchema = z.object({
  user_id: z.string(),
  display_name: z.string().nullable(),
  /** From GoTrue. `null` when the account has none or the lookup failed: see
   *  `seat_emails_available` on the account. */
  email: z.string().nullable(),
  banned: z.boolean(),
});
export type AdminBillingOwnerSeat = z.infer<typeof AdminBillingOwnerSeatSchema>;

/** The vendor's billing account (decision 16). */
export const AdminBillingAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Nullable until checkout (decision 16). */
  billing_email: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  created_at: z.string(),
  owner_seats: z.array(AdminBillingOwnerSeatSchema),
  /** `false`: the GoTrue lookup could not run, so a `null` seat email says nothing. */
  seat_emails_available: z.boolean(),
});
export type AdminBillingAccount = z.infer<typeof AdminBillingAccountSchema>;

/** The product a license is on. */
export const AdminBillingAssignedProductSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type AdminBillingAssignedProduct = z.infer<typeof AdminBillingAssignedProductSchema>;

/**
 * One license row as the Billing tab reads it. `live` is `ended_at === null`, the
 * stored state (`DATABASE_SCHEMA.md` §8.6c): it is never derived from `ends_at`.
 */
export const AdminBillingLicenseSchema = z.object({
  id: z.string(),
  /** `LICENSE_SOURCES`, unconstrained in D1. */
  source: z.string(),
  starts_at: z.string(),
  /** Scheduled end. `null` = monthly. */
  ends_at: z.string().nullable(),
  /** Stored end. `null` = live. */
  ended_at: z.string().nullable(),
  /** `LICENSE_END_REASONS`. `null` while live. */
  end_reason: z.string().nullable(),
  live: z.boolean(),
  /** Invoice number, PO or grant note. */
  reference: z.string().nullable(),
  /** `null` = unassigned. An ended license keeps its product as history. */
  assigned_product: AdminBillingAssignedProductSchema.nullable(),
  assigned_at: z.string().nullable(),
  /** Decision 11: the owner asked to free this slot at the next renewal. */
  release_at_renewal: z.boolean(),
  /** Decision 15: ends at term end instead of renewing. */
  cancel_at_term_end: z.boolean(),
  /** `LICENSE_CANCEL_REASONS`. `null` unless flagged. */
  cancel_reason: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  /** A pointer to the agreement version. The acceptance record is `acceptances`. */
  terms_version: z.string().nullable(),
  /** The admin's `profiles.id` for an AECi grant. */
  granted_by: z.string().nullable(),
  created_at: z.string(),
});
export type AdminBillingLicense = z.infer<typeof AdminBillingLicenseSchema>;

/**
 * The early-unassign request states (decision 11). E4.4 (AECI-1373) writes them. Defined
 * here so the Billing payload is typed before the table exists.
 */
export const LICENSE_RELEASE_REQUEST_STATUSES = ['open', 'approved', 'declined'] as const;
export const LicenseReleaseRequestStatusSchema = z.enum(LICENSE_RELEASE_REQUEST_STATUSES);
export type LicenseReleaseRequestStatus = z.infer<typeof LicenseReleaseRequestStatusSchema>;

/**
 * One early-unassign request: a vendor owner asks AECi to take a license off its
 * product before renewal (decision 11). The minimal shape the Billing tab renders.
 * E4.4 (AECI-1373) may extend it.
 */
export const AdminLicenseReleaseRequestSchema = z.object({
  id: z.string(),
  license_id: z.string(),
  status: LicenseReleaseRequestStatusSchema,
  reason: z.string(),
  /** The requesting owner seat's `profiles.id`. `null` after an erasure. */
  requested_by: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  decision_note: z.string().nullable(),
});
export type AdminLicenseReleaseRequest = z.infer<typeof AdminLicenseReleaseRequestSchema>;

/** `GET /api/admin/vendors/:id/billing`. */
export const AdminVendorBillingResponseSchema = z.object({
  vendor_id: z.string(),
  /** `null`: the vendor has no billing account, an E1 back-fill defect. */
  billing_account: AdminBillingAccountSchema.nullable(),
  /** Live first (oldest first), then ended (most recently ended first). */
  licenses: z.array(AdminBillingLicenseSchema),
  licenses_truncated: z.boolean(),
  /** Newest first. Read whether or not the account exists: a claim acceptance names
   *  the vendor directly. */
  acceptances: z.array(AdminAgreementAcceptanceSchema),
  acceptances_truncated: z.boolean(),
  /** Empty until E4.4 (AECI-1373). */
  release_requests: z.array(AdminLicenseReleaseRequestSchema),
});
export type AdminVendorBillingResponse = z.infer<typeof AdminVendorBillingResponseSchema>;
