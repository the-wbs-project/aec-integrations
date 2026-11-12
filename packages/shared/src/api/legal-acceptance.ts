import { z } from 'zod';

import { LegalAgreementDocumentSchema } from './agreements';

/**
 * The vendor portal's acceptance screen (AECI-1677). Source of truth:
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.24, `VENDOR_SIGNUP_PROCESS.md` §4,
 * `API_CONTRACTS.md` §6.14 "Legal acceptance", `AUTH_AND_RLS.md`, ADR 0055.
 *
 *   GET  /api/vendor/legal-acceptance          `requireVendor()`. A read: never rate-limited.
 *   POST /api/vendor/legal-acceptance          `requireVendor()`, `rateLimit('write')`,
 *                                              then the owner-seat check.
 *   GET  /api/admin/legal-acceptances          `requireAdmin()`. A read: never rate-limited.
 *
 * Two modes. `required` (ruling 24): the agreement is in force and the company holds no
 * acceptance of a version in force, so the portal opens only this screen. `optional`
 * (ruling 25, counsel Q3): the company is covered, and a published version that needs
 * acceptance waits. An owner may dismiss it. Until an owner accepts, the earlier version
 * keeps applying to the company. While no version of an agreement is in force, nothing
 * is pending for it, in either mode.
 */

export const LEGAL_ACCEPTANCE_MODES = ['required', 'optional'] as const;
export const LegalAcceptanceModeSchema = z.enum(LEGAL_ACCEPTANCE_MODES);
export type LegalAcceptanceMode = z.infer<typeof LegalAcceptanceModeSchema>;

/** The longest title and legal name the screen takes, as on the claim form. */
export const LEGAL_ACCEPT_SIGNER_TITLE_MAX = 100;
export const LEGAL_ACCEPT_LEGAL_NAME_MAX = 200;

/** One version this session must or may accept. */
export const VendorLegalPendingSchema = z.object({
  document: LegalAgreementDocumentSchema,
  version: z.string(),
  mode: LegalAcceptanceModeSchema,
  /** ISO timestamp of the effective moment, 12:00 UTC of the effective day. */
  effective_at: z.string(),
  /** The effective moment has passed. */
  in_force: z.boolean(),
  /** The "What changes" bullets of the version's `legal_versions` row, plain text and
   *  unescaped. Empty when the version has no row (it took effect through a code bump). */
  summary: z.array(z.string()),
  /** `/legal/<slug>/v<version>`, the fixed copy of exactly this version. */
  page_path: z.string(),
});
export type VendorLegalPending = z.infer<typeof VendorLegalPendingSchema>;

/** `GET /api/vendor/legal-acceptance`, computed for the session's vendor. */
export const VendorLegalAcceptanceResponseSchema = z.object({
  /** A `required` item is pending: the portal opens only the acceptance screen, and the
   *  API refuses this vendor's other writes with `403 LEGAL_ACCEPTANCE_REQUIRED`. */
  blocked: z.boolean(),
  /** This seat is an owner seat, so it may accept. A member seat may not. */
  can_accept: z.boolean(),
  /** Owner seat: the `required` item first, then any `optional` ones. Member seat: the
   *  `required` item only, for the message. Empty when nothing is pending. */
  pending: z.array(VendorLegalPendingSchema),
  /** The names of the company's working owner seats, for a member's message while
   *  blocked. Empty otherwise. The Seats tab shows the same names to every seat. */
  owner_names: z.array(z.string()),
  /** What the screen pre-fills, for an owner seat with something pending. */
  signer: z
    .object({
      /** This seat's title from its own newest claim, else null (an invited seat). */
      title: z.string().nullable(),
      /** `vendors.legal_name`, else the newest claim's legal name, else null. */
      legal_name: z.string().nullable(),
    })
    .nullable(),
});
export type VendorLegalAcceptanceResponse = z.infer<typeof VendorLegalAcceptanceResponseSchema>;

/** `POST /api/vendor/legal-acceptance`. Strict. `accepted` is `true` or the body fails. */
export const AcceptLegalVersionRequestSchema = z
  .object({
    document: LegalAgreementDocumentSchema,
    version: z.string().trim().min(1).max(20),
    accepted: z.literal(true),
    signer_title: z.string().trim().min(1).max(LEGAL_ACCEPT_SIGNER_TITLE_MAX),
    company_legal_name: z.string().trim().min(1).max(LEGAL_ACCEPT_LEGAL_NAME_MAX),
  })
  .strict();
export type AcceptLegalVersionRequest = z.infer<typeof AcceptLegalVersionRequestSchema>;

/** `POST /api/vendor/legal-acceptance` → 201, with the state after the accept. */
export const AcceptLegalVersionResponseSchema = z.object({
  document: LegalAgreementDocumentSchema,
  version: z.string(),
  accepted_at: z.string(),
  state: VendorLegalAcceptanceResponseSchema,
});
export type AcceptLegalVersionResponse = z.infer<typeof AcceptLegalVersionResponseSchema>;

// ─── Admin: who has accepted ────────────────────────────────────────────────────

/** Which companies a version is counted over. `claimed`: every vendor with a seat.
 *  `monthly_card`: those holding a live monthly card subscription (the Managed plan
 *  click, counsel Q3). */
export const LEGAL_ACCEPTANCE_AUDIENCES = ['claimed', 'monthly_card'] as const;
export const LegalAcceptanceAudienceSchema = z.enum(LEGAL_ACCEPTANCE_AUDIENCES);

export const AdminLegalAcceptanceCompanySchema = z.object({
  vendor_id: z.string(),
  slug: z.string(),
  company_name: z.string(),
});
export type AdminLegalAcceptanceCompany = z.infer<typeof AdminLegalAcceptanceCompanySchema>;

/** One final version (in force, dated, or published) and who has accepted it. */
export const AdminLegalAcceptanceVersionSchema = z.object({
  document: LegalAgreementDocumentSchema,
  version: z.string(),
  /** ISO timestamp of the effective moment. */
  effective_at: z.string(),
  in_force: z.boolean(),
  /** A `legal_versions` row exists. */
  published: z.boolean(),
  /** The row's answer, or null when there is no row. */
  requires_acceptance: z.boolean().nullable(),
  audience: LegalAcceptanceAudienceSchema,
  /** Companies holding an acceptance of this version or a later final one. */
  accepted_count: z.number().int().nonnegative(),
  not_yet_count: z.number().int().nonnegative(),
  /** Every company not yet counted as accepted, by name. */
  not_yet: z.array(AdminLegalAcceptanceCompanySchema),
});
export type AdminLegalAcceptanceVersion = z.infer<typeof AdminLegalAcceptanceVersionSchema>;

/** `GET /api/admin/legal-acceptances`. Newest version first per document. Empty while no
 *  version of either agreement is final. */
export const AdminLegalAcceptancesResponseSchema = z.object({
  versions: z.array(AdminLegalAcceptanceVersionSchema),
});
export type AdminLegalAcceptancesResponse = z.infer<typeof AdminLegalAcceptancesResponseSchema>;
