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
 *
 * NO ZOD (AECI-2033). The schemas are in `./agreement-schemas`. The public `/legal/*`
 * and `/docs/*` pages read the tables here, so this file must stay free of `zod` and
 * `api/*` schema imports (`eslint.config.mjs`).
 */

/** `agreement_acceptances.document`. The table has no CHECK; this is the vocabulary. */
export const LEGAL_AGREEMENT_DOCUMENTS = ['vendor_terms', 'managed_plan'] as const;
export type LegalAgreementDocument = (typeof LEGAL_AGREEMENT_DOCUMENTS)[number];

/** `agreement_acceptances.source`: where the acceptance was given. No CHECK either.
 *  `grant` (AECI-1615): an owner seat accepted a granted subscription in the portal, or
 *  AECi recorded a signed deal that accepts it. `portal` (AECI-1677): an owner seat
 *  accepted a newer version of an agreement on the portal's acceptance screen. */
export const AGREEMENT_ACCEPTANCE_SOURCES = ['claim', 'checkout', 'grant', 'portal'] as const;
export type AgreementAcceptanceSource = (typeof AGREEMENT_ACCEPTANCE_SOURCES)[number];

/**
 * The BUILD's current version of each agreement: the current file's frontmatter
 * `version`. Keep it a plain object literal: a web spec (E2.3, AECI-1361) asserts each
 * value equals the `version` frontmatter of the agreement's Markdown under
 * `apps/web/src/content/legal/`. Bump the Markdown and this map in the same change.
 *
 * **Not "the version in force now" (AECI-1689).** A published upcoming version replaces
 * it at its effective moment with no deploy. Every reader that stamps or shows the
 * current version asks `legalAgreementVersionInForce` (`./legal-in-force`), and
 * `legal-current-readers.spec.ts` fails on any other reader.
 */
export const LEGAL_AGREEMENT_CURRENT_VERSIONS = {
  vendor_terms: '1.3',
  managed_plan: '1.1',
} as const satisfies Record<LegalAgreementDocument, string>;

/**
 * A version of an agreement whose text is published but not yet in force
 * (AECI-1610). `effectiveOn` is the day it takes effect, `YYYY-MM-DD` read as UTC.
 */
export interface LegalAgreementUpcomingVersion {
  readonly version: string;
  readonly effectiveOn: string;
}

/**
 * The version of each agreement that is published but not yet in force, if any.
 * The web manifest `LEGAL_UPCOMING` (`apps/web/src/app/legal/legal-manifest.ts`) is
 * the source: `legal-page.component.spec.ts` asserts this map equals its
 * `vendor-terms` and `managed-plan-agreement` entries. Add an entry here in the same
 * change that adds the upcoming file, and remove it in the bump-day change. Empty
 * today. The admin publish (`/api/admin/legal-versions`, AECI-1688) reads it: only the
 * version listed here can be published, on its `effectiveOn` day at 12:00 UTC
 * (`legalEffectiveAtMs`). Since AECI-1689 the version becomes the one in force at that
 * moment, with no deploy, but only once it has a `legal_versions` row
 * (`legalAgreementVersionInForce`). So from the change that adds it, it needs its
 * `LEGAL_AGREEMENT_TEXT_SHA256` entry: `agreement-text-hash.spec.ts` requires it.
 */
export const LEGAL_AGREEMENT_UPCOMING_VERSIONS: Readonly<
  Partial<Record<LegalAgreementDocument, LegalAgreementUpcomingVersion>>
> = {};

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
  vendor_terms: ['1.0', '1.1', '1.2', '1.3'],
  managed_plan: ['1.0', '1.1'],
} as const satisfies Record<LegalAgreementDocument, readonly string[]>;

/**
 * The day each known version of each agreement takes effect, `YYYY-MM-DD` read as UTC,
 * or `null` for a draft that never took effect (AECI-1677). The effective moment is
 * 12:00 UTC of that day (`legalEffectiveAtMs`). This map is how the API Worker knows a
 * version is in force: it cannot read the Markdown, whose frontmatter `effective_date`
 * is the source. `legal-page.component.spec.ts` (apps/web) asserts every entry equals
 * that version's frontmatter, the current file and each archive.
 *
 * **A draft version is never in force, and stays `null` for good.** Every acceptance of
 * the versions listed `null` today was given while the page said "draft, not yet in
 * force" (counsel Q42), so none of them may ever count as an acceptance of a version in
 * force. `agreements.spec.ts` pins those entries `null`. The effective-date change must
 * therefore bump the version: make the final text a new version with its own entry here.
 * Keep it a plain object literal. Add the new version's entry when you append it to
 * `LEGAL_AGREEMENT_KNOWN_VERSIONS`.
 *
 * Today every entry is `null`: no agreement is in force, so the acceptance screen never
 * shows and nothing is blocked (`apps/api/src/lib/legal-acceptance.ts`).
 */
export const LEGAL_AGREEMENT_EFFECTIVE_ON = {
  vendor_terms: { '1.0': null, '1.1': null, '1.2': null, '1.3': null },
  managed_plan: { '1.0': null, '1.1': null },
} as const satisfies Record<LegalAgreementDocument, Record<string, string | null>>;

/** The effective day of one version, or `null` for a draft or a version this map lacks. */
export function legalAgreementEffectiveOn(
  document: LegalAgreementDocument,
  version: string,
): string | null {
  return (LEGAL_AGREEMENT_EFFECTIVE_ON[document] as Record<string, string | null>)[version] ?? null;
}

/**
 * The label beside the box on the portal's acceptance screen (AECI-1677), as the server
 * records it. The claim box's wording (`AGREEMENT_CHECKBOX_LABELS`), adapted to name the
 * version and the company. `companyName` is `vendors.company_name`, which the screen shows
 * above the box. The web label (`@@vendor.legalAccept.label.*`) renders this exact text
 * in en-US: `vendor-legal-acceptance.component.spec.ts` holds the two together.
 */
export function portalAcceptanceLabel(
  document: LegalAgreementDocument,
  version: string,
  companyName: string,
): string {
  return document === 'vendor_terms'
    ? `I have read and accept the Vendor Terms, version ${version}, on behalf of ${companyName}, and I am authorized to bind that company.`
    : `I have read and accept the Managed plan agreement, version ${version}, on behalf of ${companyName}.`;
}

/**
 * How a `grant` acceptance was given (AECI-1615, `agreement_acceptances.method`). No CHECK.
 * `portal_checkbox`: an owner seat ticked the box on the Billing tab. `signed_deal`: AECi
 * recorded a deal, signed by a person with authority, that names the agreement by version
 * and date and says signing accepts it. NULL on every claim and checkout row.
 */
export const AGREEMENT_ACCEPTANCE_METHODS = ['portal_checkbox', 'signed_deal'] as const;
export type AgreementAcceptanceMethod = (typeof AGREEMENT_ACCEPTANCE_METHODS)[number];

/**
 * The SHA-256 (lowercase hex) of the exact bytes of each published version's Markdown
 * (AECI-1615, counsel Q5): the current file under `apps/web/src/content/legal/`, each
 * archive under `apps/web/src/content/legal/versions/`, and since AECI-1689 the upcoming
 * file there, which can be in force before bump day. The API Worker cannot read the
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
    '1.3': 'e94bca9b5bdbad730326c28f61f91f04c394474d2b55f8d10a03a366c5ffcdd4',
  },
  managed_plan: {
    '1.0': '3f8e28e5e4309330aa9b5f1dd6cc51a572317c6f4691564fbb6f65b23797032d',
    '1.1': '10615f853902c330628ebec9ce72c643cdc8b89a6708169f2333a792ff021dd1',
  },
} as const satisfies Record<LegalAgreementDocument, Record<string, string>>;

/**
 * The label beside each agreement's acceptance checkbox, and the SHA-256 (lowercase hex,
 * UTF-8) of that exact string (AECI-1615 ruling 16, Chris 2026-11-10). An acceptance row
 * stamps `checkbox_label_sha256` and, since AECI-1619, the text itself (`checkbox_label`)
 * from here as evidence of the box it was given on.
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

/**
 * The two policies the Vendor Terms incorporate (AECI-1619, counsel Q14). A claim
 * acceptance records the version of each that the claim box named
 * (`agreement_acceptances.listing_accuracy_version` / `review_guidelines_version`).
 * Only the Vendor Terms incorporate them, so only a claim row carries them.
 */
export const LEGAL_POLICY_DOCUMENTS = ['listing_accuracy', 'review_guidelines'] as const;
export type LegalPolicyDocument = (typeof LEGAL_POLICY_DOCUMENTS)[number];

/**
 * The BUILD's current version of each policy. Keep it a plain object literal: a web spec
 * (`legal-page.component.spec.ts`) asserts each value equals the `version` frontmatter of
 * `listing-accuracy-policy.md` / `review-guidelines.md`. Bump both in the same change.
 * Like the agreement map, it is not "the version in force now": readers ask
 * `legalPolicyVersionInForce` (AECI-1689).
 */
export const LEGAL_POLICY_CURRENT_VERSIONS = {
  listing_accuracy: '1.0',
  review_guidelines: '1.0',
} as const satisfies Record<LegalPolicyDocument, string>;

/**
 * The version of each policy that is published but not yet in force, if any
 * (AECI-1689). Mirrors the `listing-accuracy` and `review-guidelines` entries of the web
 * manifest `LEGAL_UPCOMING`, and `legal-page.component.spec.ts` pins the two equal. Since
 * AECI-1969 (ruling 54) only the version listed here can be published on `/admin/legal`,
 * and it switches in at 12:00 UTC of `effectiveOn` only once it has a `legal_versions` row
 * (`legalPolicyVersionInForce`). Publishing emails every claimed company. Empty today.
 */
export const LEGAL_POLICY_UPCOMING_VERSIONS: Readonly<
  Partial<Record<LegalPolicyDocument, LegalAgreementUpcomingVersion>>
> = {};

/** Every version of each policy that was ever current, oldest first. A claim may record
 *  any of them: a submit made before a bump is confirmed with the versions it showed. */
export const LEGAL_POLICY_KNOWN_VERSIONS = {
  listing_accuracy: ['1.0'],
  review_guidelines: ['1.0'],
} as const satisfies Record<LegalPolicyDocument, readonly string[]>;

/**
 * Whether an acceptance may record `version` of `policy`: it was ever current, or it is the
 * upcoming version, which a publish may have put in force before bump day appends it to
 * `LEGAL_POLICY_KNOWN_VERSIONS` (AECI-1969; the agreements' `isRecordableLegalAgreementVersion`).
 * Without the second arm every claim would be refused from the moment a published policy
 * version switched in until its bump day.
 */
export function isKnownLegalPolicyVersion(
  policy: LegalPolicyDocument,
  version: string,
  upcoming: Readonly<
    Partial<Record<LegalPolicyDocument, LegalAgreementUpcomingVersion>>
  > = LEGAL_POLICY_UPCOMING_VERSIONS,
): boolean {
  return (
    (LEGAL_POLICY_KNOWN_VERSIONS[policy] as readonly string[]).includes(version) ||
    upcoming[policy]?.version === version
  );
}

/**
 * The two documents every account holder is bound by (AECI-1637, counsel Q34, ruling 12):
 * the Terms of Service and the Privacy Policy. Like the agreements, a new version is
 * published on `/admin/legal` (`legal_versions`), and switches in only once published
 * (`legalReaderVersionInForce`, ruling 2 of 2026-11-13). A material version is emailed to
 * every account (`legal-account-change`). Signing in records an acceptance of the Terms
 * version in force (`terms_acceptances`). A Terms version that needs acceptance (it reduces
 * rights) applies to an account only from that record, never on continued use. A Privacy
 * version never needs acceptance (ruling 4).
 *
 * Not part of `LEGAL_AGREEMENT_DOCUMENTS` on purpose: the checkbox labels, the text hashes
 * and the vendor acceptance screen are keyed on the two agreements only.
 */
export const LEGAL_READER_DOCUMENTS = ['terms', 'privacy'] as const;
export type LegalReaderDocument = (typeof LEGAL_READER_DOCUMENTS)[number];

/**
 * Every document `/admin/legal` can publish: the two agreements, the two reader documents
 * and, since AECI-1969 (counsel Q68, ruling 54), the two policies the Vendor Terms
 * incorporate. A policy version is emailed to every claimed company by the Vendor Terms
 * change notice, and switches in only once published, like an agreement.
 */
export const LEGAL_PUBLISHABLE_DOCUMENTS = [
  ...LEGAL_AGREEMENT_DOCUMENTS,
  ...LEGAL_READER_DOCUMENTS,
  ...LEGAL_POLICY_DOCUMENTS,
] as const;
export type LegalPublishableDocument = (typeof LEGAL_PUBLISHABLE_DOCUMENTS)[number];

/** Whether a document is one of the two policies the Vendor Terms incorporate (AECI-1969). */
export function isLegalPolicyDocument(document: string): document is LegalPolicyDocument {
  return (LEGAL_POLICY_DOCUMENTS as readonly string[]).includes(document);
}

/**
 * The documents whose change notice goes to COMPANIES (`legal-terms-change`): the two
 * agreements and the two policies (AECI-1969). The reader documents go to accounts.
 */
export const LEGAL_COMPANY_NOTICE_DOCUMENTS = [
  ...LEGAL_AGREEMENT_DOCUMENTS,
  ...LEGAL_POLICY_DOCUMENTS,
] as const;
export type LegalCompanyNoticeDocument = (typeof LEGAL_COMPANY_NOTICE_DOCUMENTS)[number];

/** Whether a document's notice goes to companies, not accounts. */
export function isLegalCompanyNoticeDocument(
  document: string,
): document is LegalCompanyNoticeDocument {
  return (LEGAL_COMPANY_NOTICE_DOCUMENTS as readonly string[]).includes(document);
}

/** Whether a document is one of the two reader documents. */
export function isLegalReaderDocument(document: string): document is LegalReaderDocument {
  return (LEGAL_READER_DOCUMENTS as readonly string[]).includes(document);
}

/**
 * The BUILD's current version of each reader document. Keep it a plain object literal:
 * `legal-page.component.spec.ts` (web) asserts each value equals the `version` frontmatter
 * of `terms-of-service.md` / `privacy-policy.md`. Like the agreement map, it is not "the
 * version in force now": readers ask `legalReaderVersionInForce`.
 */
export const LEGAL_READER_CURRENT_VERSIONS = {
  terms: '1.1',
  privacy: '1.1',
} as const satisfies Record<LegalReaderDocument, string>;

/**
 * The version of each reader document that is published but not yet in force, if any.
 * Mirrors the `terms` and `privacy` entries of the web manifest `LEGAL_UPCOMING`, and
 * `legal-page.component.spec.ts` pins the two equal. Only the version listed here can be
 * published, and it switches in at 12:00 UTC of `effectiveOn` only once it has a
 * `legal_versions` row. Empty today.
 */
export const LEGAL_READER_UPCOMING_VERSIONS: Readonly<
  Partial<Record<LegalReaderDocument, LegalAgreementUpcomingVersion>>
> = {};

/** Every version of each reader document that was ever current, oldest first. */
export const LEGAL_READER_KNOWN_VERSIONS = {
  terms: ['1.0', '1.1'],
  privacy: ['1.0', '1.1'],
} as const satisfies Record<LegalReaderDocument, readonly string[]>;

/**
 * The day each known version of each reader document takes effect, `YYYY-MM-DD` read as
 * UTC, or `null` for a draft that never took effect. The same rules as
 * `LEGAL_AGREEMENT_EFFECTIVE_ON`: `legal-page.component.spec.ts` (web) asserts each entry
 * equals that version's frontmatter `effective_date`, and a draft stays `null` for good.
 * Every entry is `null` today: no Terms version is in force, so a sign-in records nothing
 * (`apps/api/src/lib/reader-legal-acceptance.ts`).
 */
export const LEGAL_READER_EFFECTIVE_ON = {
  terms: { '1.0': null, '1.1': null },
  privacy: { '1.0': null, '1.1': null },
} as const satisfies Record<LegalReaderDocument, Record<string, string | null>>;

/**
 * The line beside the sign-in buttons on `/auth/login` (AECI-1637, ruling of 2026-11-13:
 * signing in is the acceptance). Signing in records an acceptance of the Terms version in
 * force, and the server stores exactly this text (`terms_acceptances.checkbox_label`) with
 * its SHA-256. The login page renders it in en-US with "Terms of Service" and "Privacy
 * Policy" as links, and `login.component.spec.ts` (web) pins the rendered text to this
 * constant. Change both together, and only with the legal text that names it.
 */
export const SIGN_IN_TERMS_LINE =
  'By signing in, you agree to our Terms of Service and Privacy Policy.';

/**
 * The label of the one box a reader ticks at the first sign-in after a Terms of Service
 * version that reduces their rights (AECI-1637, counsel Q63, ruling 53, which narrows
 * ruling 43). "Reduces their rights" is the version's `requires_acceptance` publish flag,
 * set on `/admin/legal`, never read from the text. Every other sign-in keeps
 * {@link SIGN_IN_TERMS_LINE} and shows no box.
 *
 * The box starts unticked on `/auth/terms`, and Continue does nothing until it is ticked.
 * `POST /api/auth/terms/accept` stores exactly this text (`terms_acceptances.checkbox_label`)
 * with its SHA-256 and `checkbox_default_unticked = 1`. The page renders it in en-US
 * (`@@auth.terms.boxLabel`), and `terms-accept.component.spec.ts` (web) pins the rendered
 * text to this constant. Change both together, and only with the legal text that names it.
 */
export const TERMS_CHANGE_BOX_LABEL = 'I have read and accept the updated Terms of Service.';

/**
 * The Plans page (`/docs/vendors/plans`) as versioned content (AECI-1619, ruling 16). A
 * checkout or grant acceptance records the version current when it was given
 * (`agreement_acceptances.plans_page_version`) and the SHA-256 of that version's snapshot
 * file (`plans_page_sha256`), so the record points at the page as it stood.
 */
export const PLANS_PAGE_CURRENT_VERSION = '1.4';

/** Every Plans version that was ever current, oldest first. The current one is last. */
export const PLANS_PAGE_KNOWN_VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4'] as const;

/**
 * SHA-256 (lowercase hex) of each Plans version's snapshot file under
 * `apps/web/src/content/docs/vendors/versions/plans/`. `pnpm docs:plans-snapshot`
 * writes the current version's file. `agreement-text-hash.spec.ts` (here) and
 * `plans-snapshot.spec.ts` (web) recompute every hash from its file, so a drift fails.
 */
export const PLANS_PAGE_SHA256: Record<string, string> = {
  '1.0': '49393a154d24095a1ccd8c1db69ca6e3e827e8850bfc93d0182d0d43d0aa375b',
  '1.1': '6fc4c1a2f600aef26039db0570bf4d1ea4bbc29a71aa5b6b3a4acd005194fa51',
  '1.2': '43b54841d2485bd9c28373297ed5bbbd20cba52390a59b286c68c78a127c1a94',
  '1.3': '77d287d2955f34d4da76d05c40d0c467d2111b37c96602b9cd0201af7f32100e',
  '1.4': '946f6a799e36451a9eacffe34cec32bdd17090f6f296a5750b9e5c628c8d5046',
};

/** Whether `version` was ever a published Plans version. */
export function isKnownPlansPageVersion(version: string): boolean {
  return (PLANS_PAGE_KNOWN_VERSIONS as readonly string[]).includes(version);
}

/** The snapshot hash of one Plans version, or `null` when none is recorded. */
export function plansPageSha256(version: string): string | null {
  return PLANS_PAGE_SHA256[version] ?? null;
}

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
