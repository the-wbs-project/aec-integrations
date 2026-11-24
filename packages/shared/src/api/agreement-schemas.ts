import { z } from 'zod';

import {
  LEGAL_AGREEMENT_DOCUMENTS,
  AGREEMENT_ACCEPTANCE_SOURCES,
  AGREEMENT_ACCEPTANCE_METHODS,
  LEGAL_READER_DOCUMENTS,
  LEGAL_PUBLISHABLE_DOCUMENTS,
  LEGAL_COMPANY_NOTICE_DOCUMENTS,
} from './agreements';

/**
 * The Zod half of the legal agreement contract (AECI-2033).
 *
 * The version tables, hashes and labels live in `./agreements`, which imports no zod.
 * The public `/legal/*` and `/docs/*` pages read those tables, and when the schemas
 * below sat in the same file, that read loaded the whole of zod on every one of
 * those pages. Keep schemas here and constants there, and never re-export
 * one file from the other.
 */

export const LegalAgreementDocumentSchema = z.enum(LEGAL_AGREEMENT_DOCUMENTS);
export const AgreementAcceptanceSourceSchema = z.enum(AGREEMENT_ACCEPTANCE_SOURCES);
export const AgreementAcceptanceMethodSchema = z.enum(AGREEMENT_ACCEPTANCE_METHODS);
export const LegalReaderDocumentSchema = z.enum(LEGAL_READER_DOCUMENTS);
export const LegalPublishableDocumentSchema = z.enum(LEGAL_PUBLISHABLE_DOCUMENTS);
export const LegalCompanyNoticeDocumentSchema = z.enum(LEGAL_COMPANY_NOTICE_DOCUMENTS);

/**
 * One acceptance as an owner seat sees it on the Billing tab. Never carries `ip` or
 * `user_agent`: those are evidence for AECi, not portal data.
 */
export const VendorAgreementAcceptanceSchema = z.object({
  id: z.string(),
  document: LegalAgreementDocumentSchema,
  version: z.string(),
  source: AgreementAcceptanceSourceSchema,
  email: z.string(),
  profile_id: z.string().nullable(),
  billing_account_id: z.string().nullable(),
  vendor_request_id: z.string().nullable(),
  stripe_checkout_session_id: z.string().nullable(),
  accepted_at: z.string(),
  // AECI-1617: who signed. NULL on a checkout row and on a row older than the columns.
  signer_name: z.string().nullable(),
  signer_title: z.string().nullable(),
  company_legal_name: z.string().nullable(),
  // AECI-1615: a `grant` acceptance. Every one is NULL on a claim or checkout row.
  /** `AGREEMENT_ACCEPTANCE_METHODS`. A plain string so an unknown token cannot break
   *  the page. */
  method: z.string().nullable(),
  /** The `license_grants.id` the acceptance activated. */
  license_grant_id: z.string().nullable(),
  /** The grant's term end, as granted. */
  grant_ends_at: z.string().nullable(),
  /** SHA-256 of the agreement text at that version (`LEGAL_AGREEMENT_TEXT_SHA256`). */
  text_sha256: z.string().nullable(),
  /** `owner` on a portal acceptance. NULL on a signed deal. */
  seat_role: z.string().nullable(),
  /** A signed deal's reference (contract number, e-signature envelope). */
  deal_reference: z.string().nullable(),
  /** When the signed deal was signed. */
  deal_signed_at: z.string().nullable(),
  // AECI-1615 ruling 16: the checkbox the acceptance was given on. Both NULL on a
  // signed deal and on a row older than the columns.
  /** SHA-256 of the exact label shown beside the box (`AGREEMENT_CHECKBOX_LABELS`). */
  checkbox_label_sha256: z.string().nullable(),
  /** Whether the box started unticked. */
  checkbox_default_unticked: z.boolean().nullable(),
  // AECI-1619 (ruling 16, counsel Q14). Every one is NULL on a row older than the columns.
  /** The exact label shown beside the box (`AGREEMENT_CHECKBOX_LABELS[doc].text`). NULL
   *  on a signed deal and on a claim under an older terms version. */
  checkbox_label: z.string().nullable(),
  /** The Listing Accuracy Policy version the claim box named. Claim rows only. */
  listing_accuracy_version: z.string().nullable(),
  /** The Review Guidelines version the claim box named. Claim rows only. */
  review_guidelines_version: z.string().nullable(),
  /** The Plans page version current at acceptance. Checkout and grant rows only. */
  plans_page_version: z.string().nullable(),
  /** SHA-256 of that Plans version's snapshot file (`PLANS_PAGE_SHA256`). */
  plans_page_sha256: z.string().nullable(),
});
export type VendorAgreementAcceptance = z.infer<typeof VendorAgreementAcceptanceSchema>;

/** `GET /api/vendor/billing/acceptances`. Newest first, unpaginated. */
export const VendorAgreementAcceptancesResponseSchema = z.object({
  acceptances: z.array(VendorAgreementAcceptanceSchema),
});
export type VendorAgreementAcceptancesResponse = z.infer<
  typeof VendorAgreementAcceptancesResponseSchema
>;

/** One acceptance as AECi sees it: the vendor row plus the evidence columns. */
export const AdminAgreementAcceptanceSchema = VendorAgreementAcceptanceSchema.extend({
  vendor_id: z.string().nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  /** AECI-1636: when the daily sweep removed `ip` and `user_agent`, 90 days after
   *  acceptance. NULL while they are kept, and on a row that never recorded them. */
  evidence_removed_at: z.string().nullable(),
  created_at: z.string(),
});
export type AdminAgreementAcceptance = z.infer<typeof AdminAgreementAcceptanceSchema>;

/** `GET /api/admin/vendors/:id/acceptances`. Newest first, unpaginated. */
export const AdminAgreementAcceptancesResponseSchema = z.object({
  acceptances: z.array(AdminAgreementAcceptanceSchema),
});
export type AdminAgreementAcceptancesResponse = z.infer<
  typeof AdminAgreementAcceptancesResponseSchema
>;
