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
 *   POST  /api/vendor/billing/checkout           start a Stripe Checkout purchase (E9.3)
 *   POST  /api/vendor/billing/licenses/add       add licenses to the subscription (E9.3)
 *   POST  /api/vendor/billing/portal             open the Stripe Customer Portal (E9.3)
 *
 * All of them sit behind `requireVendor()` then `requireSeatOwner()`: billing is an
 * owner's act (decision 10), so a member seat gets `403`. None takes a capability
 * gate: the fourth named exception of `API_CONTRACTS.md` §6.14 invariant 3. A lapsed
 * vendor must still be able to see and manage its licenses.
 *
 * The acceptances stay on their own read, `GET /api/vendor/billing/acceptances`
 * (`agreements.ts`). No Stripe id appears here. Since E9.3 (AECI-1501) the read carries
 * a `stripe` summary of the account's subscription and `stripe_checkout_available`.
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

// ─── The Stripe subscription (E9.3, AECI-1501) ───────────────────────────────

/** The two billing intervals a Managed subscription can have. One per billing account:
 *  intervals are never mixed (ruling 2026-10-20, AECI-1339). */
export const STRIPE_BILLING_INTERVALS = ['year', 'month'] as const;
export const StripeBillingIntervalSchema = z.enum(STRIPE_BILLING_INTERVALS);
export type StripeBillingInterval = z.infer<typeof StripeBillingIntervalSchema>;

/** The most licenses one checkout or one add may ask for. A guard against a typo, not a
 *  commercial cap: a larger order is a conversation with AECi. */
export const STRIPE_LICENSE_QUANTITY_MAX = 100;

const StripeLicenseQuantitySchema = z.number().int().min(1).max(STRIPE_LICENSE_QUANTITY_MAX);

/**
 * The account's live Stripe subscription as the Billing tab shows it. Derived from the
 * live `source = 'stripe'` licenses in D1, refined by at most one Stripe read.
 *
 * `synced: true` means `quantity`, `current_period_end` and `cancel_at_period_end` came
 * from Stripe on this request. `synced: false` means the Stripe read failed or was not
 * possible, and every field is the D1 view: `quantity` is the live license count,
 * `current_period_end` is the latest annual `ends_at` (always `null` for monthly), and
 * `cancel_at_period_end` is true when any of those licenses is flagged to end at term
 * end. A Stripe outage never fails the read.
 */
export const VendorBillingStripeSchema = z.object({
  interval: StripeBillingIntervalSchema,
  /** Licenses on the subscription. Stripe's item quantity when synced. After an add it
   *  can run ahead of the live license count until the webhook lands the new rows. */
  quantity: z.number().int().nonnegative(),
  /** ISO timestamp of the current period's end, or `null` when unknown. */
  current_period_end: z.string().nullable(),
  /** The subscription ends at the period end instead of renewing. */
  cancel_at_period_end: z.boolean(),
  synced: z.boolean(),
});
export type VendorBillingStripe = z.infer<typeof VendorBillingStripeSchema>;

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
  /** The live Stripe subscription, or `null` when the account has no live Stripe
   *  license. See {@link VendorBillingStripeSchema}. */
  stripe: VendorBillingStripeSchema.nullable(),
  /** Whether this tier lets an owner start a purchase, add licenses or open the portal
   *  (`STRIPE_CHECKOUT_ENABLED`, the secret key and `PUBLIC_SITE_URL`). False on
   *  production until the E9 switch-on. When false the three writes answer `503
   *  STRIPE_UNAVAILABLE` and the tab hides the buy panel. */
  stripe_checkout_available: z.boolean(),
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

/**
 * The answer to both E5.2 writes (200): the license as it stands after the write, in
 * the Billing read's shape. An assign also changes `assignable_products`, which this
 * body does not carry: a caller that shows that list re-reads `GET /api/vendor/billing`.
 */
export const VendorLicenseResponseSchema = z.object({
  license: VendorBillingLicenseSchema,
});
export type VendorLicenseResponse = z.infer<typeof VendorLicenseResponseSchema>;

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

// ─── POST /api/vendor/billing/checkout (E9.3) ────────────────────────────────

/** Start a Managed purchase. Refused with `409 STRIPE_SUBSCRIPTION_EXISTS` when the
 *  account already has a live Stripe subscription in the same interval (use add), and
 *  `409 LICENSE_INTERVAL_MISMATCH` when it has one in the other interval. */
export const StripeCheckoutRequestSchema = z
  .object({
    quantity: StripeLicenseQuantitySchema,
    interval: StripeBillingIntervalSchema,
  })
  .strict();
export type StripeCheckoutRequest = z.infer<typeof StripeCheckoutRequestSchema>;

/** `200` from checkout and portal: the Stripe-hosted page to send the browser to. */
export const StripeRedirectResponseSchema = z.object({
  url: z.string().url(),
});
export type StripeRedirectResponse = z.infer<typeof StripeRedirectResponseSchema>;

// ─── POST /api/vendor/billing/licenses/add (E9.3) ────────────────────────────

/** Add licenses to the live subscription, same interval, pro-rated and invoiced now. */
export const AddStripeLicensesRequestSchema = z
  .object({
    quantity: StripeLicenseQuantitySchema,
  })
  .strict();
export type AddStripeLicensesRequest = z.infer<typeof AddStripeLicensesRequestSchema>;

/** `200`: Stripe accepted the new quantity. The licenses land when the webhook
 *  processes the paid invoice, so the tab re-reads `GET /api/vendor/billing`. */
export const AddStripeLicensesResponseSchema = z.object({
  ok: z.literal(true),
  pending: z.literal(true),
});
export type AddStripeLicensesResponse = z.infer<typeof AddStripeLicensesResponseSchema>;
