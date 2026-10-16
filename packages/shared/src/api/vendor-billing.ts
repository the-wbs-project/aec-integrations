import { z } from 'zod';

import { LICENSE_SOURCES } from '../entitlements';

import { CreateSeatInviteSchema } from './vendor';

/**
 * The vendor Billing tab contracts (AECI-1335, E5; `docs/VENDOR_SIGNUP_PROCESS.md` §2
 * decisions 10, 11, 16, 17 and §3 steps 3 and 6). Every E5 body and response lives
 * here, so the read (E5.1) and the writes (E5.2, E5.3) never edit the same file.
 *
 *   GET   /api/vendor/billing                    the tab's one read (E5.1)
 *   POST  /api/vendor/licenses/:id/assign        put a pool license on a product (E5.2)
 *   PATCH /api/vendor/licenses/:id               the release-at-renewal flag (E5.2)
 *   PUT   /api/vendor/billing/email              the billing email (E5.3)
 *
 * All four sit behind `requireVendor()` then `requireSeatOwner()`: billing is an
 * owner's act (decision 10), so a member seat gets `403`. None takes a capability
 * gate: the fourth named exception of `API_CONTRACTS.md` §6.14 invariant 3. A lapsed
 * vendor must still be able to see and manage its licenses.
 *
 * The acceptances stay on their own read, `GET /api/vendor/billing/acceptances`
 * (`agreements.ts`). No `stripe_*` field appears here: the Stripe link is E9.
 *
 * ── WHAT THE VENDOR DOES NOT SEE ────────────────────────────────────────────────
 * The admin read (`admin-vendor-billing.ts`) also carries `cancel_reason`,
 * `terms_version`, `granted_by`, `created_at` and the Stripe ids. Those are AECi's
 * records. `reference` IS shown: it is the vendor's own invoice or PO number
 * (ruling of 2026-10-16, Paid Tiers §8.1).
 */

/** The most licenses one vendor Billing read returns. The admin cap, for the same
 *  reason: a real account sits far below it, and live licenses sort first. */
export const VENDOR_BILLING_LICENSES_MAX = 500;

/** A product as the Billing tab names it. */
export const VendorBillingProductSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type VendorBillingProduct = z.infer<typeof VendorBillingProductSchema>;

/** The caller's billing account (decision 16). */
export const VendorBillingAccountSchema = z.object({
  id: z.string(),
  /** Nullable until checkout or an owner sets it (decision 16). */
  billing_email: z.string().nullable(),
});
export type VendorBillingAccount = z.infer<typeof VendorBillingAccountSchema>;

/** The open early-unassign request on a license (AECI-1373). At most one, by the
 *  partial unique index `license_release_requests_open_license_key`. */
export const VendorBillingOpenReleaseRequestSchema = z.object({
  id: z.string(),
  created_at: z.string(),
});
export type VendorBillingOpenReleaseRequest = z.infer<typeof VendorBillingOpenReleaseRequestSchema>;

/**
 * One license as the owner sees it. Dates are the stored ISO strings, the same
 * columns and formats as `AdminBillingLicenseSchema`. `live` is `ended_at === null`,
 * the stored state (`DATABASE_SCHEMA.md` §8.6c), never derived from `ends_at`.
 */
export const VendorBillingLicenseSchema = z.object({
  id: z.string(),
  source: z.enum(LICENSE_SOURCES),
  starts_at: z.string(),
  /** Scheduled end. `null` = monthly. */
  ends_at: z.string().nullable(),
  /** Stored end. `null` = live. */
  ended_at: z.string().nullable(),
  /** `LICENSE_END_REASONS`, unconstrained in D1. `null` while live. */
  end_reason: z.string().nullable(),
  live: z.boolean(),
  /** The vendor's invoice number, PO or grant note. */
  reference: z.string().nullable(),
  /** `null` = in the pool. An ended license keeps its product as history. */
  assigned_product: VendorBillingProductSchema.nullable(),
  assigned_at: z.string().nullable(),
  /** Decision 11: the owner asked to free this slot at the next renewal. */
  release_at_renewal: z.boolean(),
  /** Decision 15: ends at term end instead of renewing. */
  cancel_at_term_end: z.boolean(),
  /** The open early-unassign request, if any. */
  open_release_request: VendorBillingOpenReleaseRequestSchema.nullable(),
});
export type VendorBillingLicense = z.infer<typeof VendorBillingLicenseSchema>;

/** `GET /api/vendor/billing`. */
export const VendorBillingResponseSchema = z.object({
  /** `null`: the vendor has no billing account, an E1 back-fill defect. */
  billing_account: VendorBillingAccountSchema.nullable(),
  /** Live first (oldest first), then ended (most recently ended first). Capped at
   *  {@link VENDOR_BILLING_LICENSES_MAX}. */
  licenses: z.array(VendorBillingLicenseSchema),
  licenses_truncated: z.boolean(),
  /**
   * The products a pool license can go on: owned by this vendor (`product_vendors`)
   * and holding no live license from ANY vendor, a co-owner included. Sorted by name,
   * case-insensitively, `id` breaking ties.
   */
  assignable_products: z.array(VendorBillingProductSchema),
});
export type VendorBillingResponse = z.infer<typeof VendorBillingResponseSchema>;

// ─── POST /api/vendor/licenses/:id/assign (E5.2) ─────────────────────────────

/** Put a pool license on one of the vendor's products. */
export const AssignLicenseRequestSchema = z
  .object({
    product_id: z.string().trim().min(1),
  })
  .strict();
export type AssignLicenseRequest = z.infer<typeof AssignLicenseRequestSchema>;

// ─── PATCH /api/vendor/licenses/:id (E5.2) ───────────────────────────────────

/** Set or clear the release-at-renewal flag (decision 11). The only field. */
export const UpdateLicenseRequestSchema = z
  .object({
    release_at_renewal: z.boolean(),
  })
  .strict();
export type UpdateLicenseRequest = z.infer<typeof UpdateLicenseRequestSchema>;

// ─── PUT /api/vendor/billing/email (E5.3) ────────────────────────────────────

/**
 * Set or clear the billing email (decision 16). The seat-invite address rule,
 * trimmed and lower-cased, so the erasure match in `routes/account.ts` compares
 * like with like. `null` clears it.
 */
export const UpdateBillingEmailRequestSchema = z
  .object({
    billing_email: CreateSeatInviteSchema.shape.email.toLowerCase().nullable(),
  })
  .strict();
export type UpdateBillingEmailRequest = z.infer<typeof UpdateBillingEmailRequestSchema>;

/** `200`: the account as stored after the write, the same block `GET /api/vendor/billing`
 *  returns, so the tab can patch its state without a refetch. */
export const UpdateBillingEmailResponseSchema = z.object({
  billing_account: VendorBillingAccountSchema,
});
export type UpdateBillingEmailResponse = z.infer<typeof UpdateBillingEmailResponseSchema>;
