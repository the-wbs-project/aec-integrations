import { z } from 'zod';

/**
 * Legal agreement acceptances (AECI-1362, E2.4 of `docs/VENDOR_SIGNUP_PROCESS.md` §4,
 * decisions 3, 9 and 17). Source of truth: `DATABASE_SCHEMA.md` §8.6d and
 * `API_CONTRACTS.md` (`GET /api/vendor/billing/acceptances`,
 * `GET /api/admin/vendors/:id/acceptances`).
 *
 * Two agreements a vendor accepts: the vendor terms at claim and the Managed plan
 * agreement at Stripe checkout. Every acceptance is stored in `agreement_acceptances`
 * by `apps/api/src/lib/agreement-acceptances.ts`, which refuses any version that is not
 * the current one below.
 *
 * NAMING. `packages/shared/src/agreement.ts` (root barrel) is the unrelated integration
 * agreement-state module (`AGREEMENT_STATES`, `computeAgreement`). Everything here is
 * prefixed `LEGAL_AGREEMENT_*`, `LegalAgreement*` or `AgreementAcceptance*` so the two
 * barrels never collide.
 */

/** `agreement_acceptances.document`. The table has no CHECK; this is the vocabulary. */
export const LEGAL_AGREEMENT_DOCUMENTS = ['vendor_terms', 'managed_plan'] as const;
export const LegalAgreementDocumentSchema = z.enum(LEGAL_AGREEMENT_DOCUMENTS);
export type LegalAgreementDocument = z.infer<typeof LegalAgreementDocumentSchema>;

/** `agreement_acceptances.source`: where the acceptance was given. No CHECK either. */
export const AGREEMENT_ACCEPTANCE_SOURCES = ['claim', 'checkout'] as const;
export const AgreementAcceptanceSourceSchema = z.enum(AGREEMENT_ACCEPTANCE_SOURCES);
export type AgreementAcceptanceSource = z.infer<typeof AgreementAcceptanceSourceSchema>;

/**
 * The current version of each agreement. An acceptance of any other version is refused
 * with `VALIDATION_FAILED`. Keep it a plain object literal: a web spec (E2.3, AECI-1361)
 * asserts each value equals the `version` frontmatter of the agreement's Markdown under
 * `apps/web/src/content/legal/`. Bump the Markdown and this map in the same change.
 */
export const LEGAL_AGREEMENT_CURRENT_VERSIONS = {
  vendor_terms: '1.0',
  managed_plan: '1.0',
} as const satisfies Record<LegalAgreementDocument, string>;

/** Whether `version` is the current version of `document`. */
export function isCurrentLegalAgreementVersion(
  document: LegalAgreementDocument,
  version: string,
): boolean {
  return LEGAL_AGREEMENT_CURRENT_VERSIONS[document] === version;
}

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
