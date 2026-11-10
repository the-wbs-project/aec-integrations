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

/** `agreement_acceptances.source`: where the acceptance was given. No CHECK either.
 *  `grant` (AECI-1615): an owner seat accepted a granted subscription in the portal, or
 *  AECi recorded a signed deal that accepts it. */
export const AGREEMENT_ACCEPTANCE_SOURCES = ['claim', 'checkout', 'grant'] as const;
export const AgreementAcceptanceSourceSchema = z.enum(AGREEMENT_ACCEPTANCE_SOURCES);
export type AgreementAcceptanceSource = z.infer<typeof AgreementAcceptanceSourceSchema>;

/**
 * The current version of each agreement. An acceptance of any other version is refused
 * with `VALIDATION_FAILED`. Keep it a plain object literal: a web spec (E2.3, AECI-1361)
 * asserts each value equals the `version` frontmatter of the agreement's Markdown under
 * `apps/web/src/content/legal/`. Bump the Markdown and this map in the same change.
 */
export const LEGAL_AGREEMENT_CURRENT_VERSIONS = {
  vendor_terms: '1.2',
  managed_plan: '1.1',
} as const satisfies Record<LegalAgreementDocument, string>;

/**
 * Every version of each agreement that was ever current, oldest first. The current
 * version is always the last entry (`agreements.spec.ts`). Only the Stripe checkout
 * webhook reads it (AECI-1500, ruling R1 on AECI-1339): the acceptance records the
 * version the Checkout page showed, even when a bump has landed since, so a webhook
 * never fails for good on a version that was current when the vendor accepted it. A
 * version that was never published is still refused. Append the old version here
 * when you bump the map above.
 */
export const LEGAL_AGREEMENT_KNOWN_VERSIONS = {
  vendor_terms: ['1.0', '1.1', '1.2'],
  managed_plan: ['1.0', '1.1'],
} as const satisfies Record<LegalAgreementDocument, readonly string[]>;

/**
 * How a `grant` acceptance was given (AECI-1615, `agreement_acceptances.method`). No CHECK.
 * `portal_checkbox`: an owner seat ticked the box on the Billing tab. `signed_deal`: AECi
 * recorded a deal, signed by a person with authority, that names the agreement by version
 * and date and says signing accepts it. NULL on every claim and checkout row.
 */
export const AGREEMENT_ACCEPTANCE_METHODS = ['portal_checkbox', 'signed_deal'] as const;
export const AgreementAcceptanceMethodSchema = z.enum(AGREEMENT_ACCEPTANCE_METHODS);
export type AgreementAcceptanceMethod = z.infer<typeof AgreementAcceptanceMethodSchema>;

/**
 * The SHA-256 (lowercase hex) of the exact bytes of each published version's Markdown
 * (AECI-1615, counsel Q5): the current file under `apps/web/src/content/legal/` and each
 * archive under `apps/web/src/content/legal/versions/`. The API Worker cannot read the
 * Markdown, so a `grant` acceptance stamps `text_sha256` from here.
 * `agreement-text-hash.spec.ts` recomputes every value from the files and fails on drift:
 * an edit to a published agreement's text changes its hash, so it needs a version bump
 * (or, for a draft with no effective date, an update here in the same change).
 */
export const LEGAL_AGREEMENT_TEXT_SHA256 = {
  vendor_terms: {
    '1.0': '628113b220f006e9918498e538bf6c86e9d69046da70dc32ec4f16d8f8a71d52',
    '1.1': '9ab3fe5b38411a45e2d0c6e5134c4e44fe9b7b44ba385af669901c2e214b1ca0',
    '1.2': '5a9592f8db571b06352dede158bb442c2ebd5a7cc4ad29e8211391577dcae043',
  },
  managed_plan: {
    '1.0': '3f8e28e5e4309330aa9b5f1dd6cc51a572317c6f4691564fbb6f65b23797032d',
    '1.1': '1682f12d76ee9aa86efae72470707140f0a77fd2118c733b755554d189f4b577',
  },
} as const satisfies Record<LegalAgreementDocument, Record<string, string>>;

/**
 * The label beside each agreement's acceptance checkbox, and the SHA-256 (lowercase hex,
 * UTF-8) of that exact string (AECI-1615 ruling 16, Chris 2026-11-10). An acceptance row
 * stamps `checkbox_label_sha256` from here as evidence of the box it was given on.
 *
 * `text` is the en-US source of the web label: the i18n source text of
 * `@@vendor.billing.grantPending.acceptLabel` / `acceptLabelNoLink` (managed plan) and
 * `@@requests.terms.label` (vendor terms), with the link reduced to its words. It is also
 * the plain wording of Stripe's terms box (`managedPlanAgreementMessage`). Specs in
 * `packages/shared`, `apps/web` and `apps/api` hold the hash, the rendered labels and the
 * Stripe message to it: change one and the others fail.
 */
export const AGREEMENT_CHECKBOX_LABELS = {
  vendor_terms: {
    text: 'I have read and accept the Vendor Terms on behalf of the company named above, and I am authorized to bind that company.',
    sha256: '54d3ba3d324678dd21543c62d5a3929b094594394843c1ae14cfe0c719a8a9db',
  },
  managed_plan: {
    text: 'I have read and accept the Managed plan agreement.',
    sha256: '7c53c65e548b7f0b22127e5044b1d5f2c3a4f485e4ac5c3bc3588909d5e38553',
  },
} as const satisfies Record<LegalAgreementDocument, { text: string; sha256: string }>;

/** The text hash of one version, or `null` when none is recorded. */
export function legalAgreementTextSha256(
  document: LegalAgreementDocument,
  version: string,
): string | null {
  return (LEGAL_AGREEMENT_TEXT_SHA256[document] as Record<string, string>)[version] ?? null;
}

/** Whether `version` was ever a published version of `document`. */
export function isKnownLegalAgreementVersion(
  document: LegalAgreementDocument,
  version: string,
): boolean {
  return (LEGAL_AGREEMENT_KNOWN_VERSIONS[document] as readonly string[]).includes(version);
}

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
