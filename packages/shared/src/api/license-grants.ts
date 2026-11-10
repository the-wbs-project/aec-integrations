import { z } from 'zod';

import { AgreementAcceptanceMethodSchema } from './agreements';

/**
 * Granted subscriptions that wait for an acceptance (AECI-1615, counsel Q5;
 * `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 5; `DATABASE_SCHEMA.md` §8.6h).
 *
 * An AECi grant (complimentary or invoice, and the ban-term grant of AECI-1589) no
 * longer writes live licenses. It writes one `license_grants` row, `pending_acceptance`.
 * The licenses are written only when the grant activates:
 *
 *   - an owner seat accepts it on the Billing tab
 *     (`POST /api/vendor/license-grants/:id/accept`), or
 *   - the admin records a signed deal on the grant form (`signed_deal`), which activates
 *     it in the create batch (ruling R5 of 2026-11-10).
 *
 * The activation batch writes the acceptance row, the licenses and the grant's status
 * together. A grant nobody accepts expires at its `ends_at` (the 11:00 sweep). AECi may
 * withdraw a pending grant (`PATCH /api/admin/license-grants/:id`).
 *
 * Grants live before AECI-1615 have no `license_grants` row and stay live (ruling R3).
 */

/** `license_grants.status`. No CHECK in D1: a CHECK change is a table recreate. */
export const LICENSE_GRANT_STATUSES = [
  'pending_acceptance',
  'accepted',
  'withdrawn',
  'expired',
] as const;
export const LicenseGrantStatusSchema = z.enum(LICENSE_GRANT_STATUSES);
export type LicenseGrantStatus = z.infer<typeof LicenseGrantStatusSchema>;

/** `license_grants.kind`. `grant`: N unassigned licenses. `ban_term`: one license per
 *  product the ban took off Managed, assigned at activation (AECI-1589). No CHECK. */
export const LICENSE_GRANT_KINDS = ['grant', 'ban_term'] as const;
export const LicenseGrantKindSchema = z.enum(LICENSE_GRANT_KINDS);
export type LicenseGrantKind = z.infer<typeof LicenseGrantKindSchema>;

/** A date-only value or a full timestamp; the handler normalises on write. Local copy of
 *  `EntitlementTermDateSchema`, which lives in `admin-licenses.ts` (that module imports
 *  this one). */
const GrantDateSchema = z.union([z.string().date(), z.string().datetime()]);

/** One ban-term item as `license_grants.items_json` stores it. */
export const LicenseGrantItemSchema = z.object({
  ended_license_id: z.string(),
  product_id: z.string(),
  /** Normalised ISO timestamp. */
  ends_at: z.string(),
});
export type LicenseGrantItem = z.infer<typeof LicenseGrantItemSchema>;

// ─── The signed deal (ruling R5) ─────────────────────────────────────────────

export const SIGNED_DEAL_TEXT_MAX = 200;
export const SIGNED_DEAL_ROLE_MAX = 100;

/**
 * A signed deal the admin records on the grant form. Counsel Q5: the deal is signed by
 * a person with authority, names the agreement by version and date, and says signing
 * accepts it. Every field is required when the block is sent. `version_named` must equal
 * the version the grant pins (the current one), checked in the handler: a substituted
 * version needs a new acceptance. `signed_at` must not be in the future.
 */
export const SignedDealSchema = z
  .object({
    signer_name: z.string().trim().min(1).max(SIGNED_DEAL_TEXT_MAX),
    signer_role: z.string().trim().min(1).max(SIGNED_DEAL_ROLE_MAX),
    company_legal_name: z.string().trim().min(1).max(SIGNED_DEAL_TEXT_MAX),
    signer_email: z.string().trim().toLowerCase().email().max(254),
    deal_reference: z.string().trim().min(1).max(SIGNED_DEAL_TEXT_MAX),
    version_named: z.string().trim().min(1).max(20),
    version_date_named: z.string().date(),
    signing_accepts: z.literal(true),
    signed_at: GrantDateSchema,
  })
  .strict();
export type SignedDealInput = z.infer<typeof SignedDealSchema>;

// ─── AECi's view of a grant ──────────────────────────────────────────────────

/** One grant as the admin Billing tab and the admin grant responses show it. */
export const AdminLicenseGrantSchema = z.object({
  id: z.string(),
  kind: LicenseGrantKindSchema,
  status: LicenseGrantStatusSchema,
  /** `complimentary` | `invoice`. A ban-term grant is always `complimentary`. */
  source: z.string(),
  quantity: z.number().int().positive(),
  /** The requested start. `null`: the licenses start at activation. */
  starts_at: z.string().nullable(),
  /** The term end. A ban-term grant's latest item end. */
  ends_at: z.string(),
  reference: z.string().nullable(),
  /** AECi's internal note. Never shown to the vendor. */
  notes: z.string().nullable(),
  /** The Managed plan agreement version pinned at grant. It governs for the whole term. */
  terms_version: z.string(),
  /** Ban-term items; empty on a `grant`. */
  items: z.array(LicenseGrantItemSchema),
  granted_by: z.string().nullable(),
  acceptance_id: z.string().nullable(),
  /** The acceptance's `method`, when accepted. */
  acceptance_method: AgreementAcceptanceMethodSchema.nullable(),
  /** When the grant left `pending_acceptance` (accepted, withdrawn or expired). */
  decided_at: z.string().nullable(),
  /** The owner seat or admin who accepted or withdrew it. `null` on an expiry. */
  decided_by: z.string().nullable(),
  withdraw_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AdminLicenseGrant = z.infer<typeof AdminLicenseGrantSchema>;

// ─── PATCH /api/admin/license-grants/:id ─────────────────────────────────────

export const LICENSE_GRANT_WITHDRAW_REASON_MAX = 500;

/** Withdraw a pending grant. The reason stays in AECi's records. */
export const WithdrawLicenseGrantSchema = z
  .object({
    action: z.literal('withdraw'),
    reason: z.string().trim().min(1).max(LICENSE_GRANT_WITHDRAW_REASON_MAX),
  })
  .strict();
export type WithdrawLicenseGrantInput = z.infer<typeof WithdrawLicenseGrantSchema>;

/** `200`: the grant as stored after the withdraw. */
export const WithdrawLicenseGrantResponseSchema = z.object({
  vendor_id: z.string(),
  grant: AdminLicenseGrantSchema,
});
export type WithdrawLicenseGrantResponse = z.infer<typeof WithdrawLicenseGrantResponseSchema>;

// ─── POST /api/vendor/license-grants/:id/accept ──────────────────────────────

/** The longest signer title the accept takes. The buy form's limit. */
export const LICENSE_GRANT_SIGNER_TITLE_MAX = 100;

/**
 * An owner seat accepts a pending grant. `accepted` is the ticked box. `version` is the
 * agreement version the page showed: it must equal the grant's pinned version, or the
 * accept is `409 LICENSE_GRANT_VERSION_CHANGED`. `signer_title` is the typed title.
 */
export const AcceptLicenseGrantSchema = z
  .object({
    accepted: z.literal(true),
    version: z.string().trim().min(1).max(20),
    signer_title: z.string().trim().min(1).max(LICENSE_GRANT_SIGNER_TITLE_MAX),
  })
  .strict();
export type AcceptLicenseGrantInput = z.infer<typeof AcceptLicenseGrantSchema>;

/**
 * Something the owner should know that did not stop the accept. `product_already_licensed`
 * (ruling R6): a ban-term item's product took a live license while the grant waited, so
 * that subscription landed in the pool unassigned. `product_not_owned`: the product left
 * the vendor while the grant waited, so that subscription landed in the pool too.
 */
export const AcceptLicenseGrantWarningSchema = z.object({
  code: z.enum(['product_already_licensed', 'product_not_owned']),
  product_id: z.string(),
  message: z.string(),
});
export type AcceptLicenseGrantWarning = z.infer<typeof AcceptLicenseGrantWarningSchema>;

/** `200`: the grant is accepted and its licenses exist. The tab re-reads Billing. */
export const AcceptLicenseGrantResponseSchema = z.object({
  grant_id: z.string(),
  status: z.literal('accepted'),
  acceptance_id: z.string(),
  license_ids: z.array(z.string()),
  warnings: z.array(AcceptLicenseGrantWarningSchema),
});
export type AcceptLicenseGrantResponse = z.infer<typeof AcceptLicenseGrantResponseSchema>;
