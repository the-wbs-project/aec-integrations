/**
 * The one module that writes `agreement_acceptances` (AECI-1362, E2.4 of
 * `docs/VENDOR_SIGNUP_PROCESS.md` §4; `DATABASE_SCHEMA.md` §8.6d).
 *
 * Four INSERT callers: the claim insert and the typed-in listing request (AECI-1366, the
 * vendor terms box on the claim form), the Stripe checkout webhook (AECI-1500,
 * `lib/stripe-webhook-events.ts`, the Managed plan agreement box), and the grant
 * activation (AECI-1615, `lib/license-grants.ts`: an owner's in-portal accept or a
 * recorded signed deal, `source: 'grant'`). Since AECI-1435 an anonymous claim or listing
 * request writes its acceptance at confirm, not at submit: the version, IP and user
 * agent are the submit's, carried on the pending `request_confirmations` row, and the
 * time is the confirm's. One UPDATE caller:
 * the claim approval (AECI-1367) links the claim's acceptances to the new seat, the
 * vendor and its billing account through `linkClaimAcceptanceStatements`. Like `lib/audit.ts` and
 * `lib/billing-account.ts`, this module never runs a batch. It RETURNS the acceptance
 * INSERT plus its `agreement.accepted` audit row, and the caller appends both to its own
 * `db.batch`, so the acceptance commits or rolls back with the claim or the license it
 * belongs to (§26.1). The audit entry comes back too, so the caller can
 * `forwardAuditLog` it in `waitUntil` after the commit.
 *
 * ── VERSION GATE ───────────────────────────────────────────────────────────────
 * A vendor may only accept the version of an agreement IN FORCE at request time. A stale
 * or unknown version (a form loaded before a bump or a switch, a forged body) is refused
 * with `400 VALIDATION_FAILED` before any statement exists. Since AECI-1689 the caller
 * passes that version (`inForce`, read by `loadLegalInForce` in `lib/legal-in-force.ts`):
 * a published upcoming version is in force from its effective moment, before bump day.
 * Without it, the gate uses the version in force with no publish known, which is the
 * build's current version (`legalAgreementVersionInForce` in `@aeci/shared`).
 *
 * One exception (AECI-1500, ruling R1 on AECI-1339): the Stripe checkout webhook
 * passes `allowSupersededVersion`. It records the version the Checkout page showed,
 * which a bump may have superseded by the time Stripe delivers the event. The vendor
 * did accept that version, and a webhook must never fail for good. The version must
 * still be a KNOWN one (`LEGAL_AGREEMENT_KNOWN_VERSIONS`) or the upcoming one, which a
 * switch may have put in force before bump day (`isRecordableLegalAgreementVersion`), and
 * only `source: 'checkout'` may use the option.
 *
 * A second exception (AECI-1615): a `grant` acceptance passes `pinnedVersion`, the
 * version the grant pinned at create. The version must equal it, current or not, so the
 * grant-date version keeps governing after a bump.
 *
 * A third (AECI-1677): a `portal` acceptance passes `portalVersion`, the version
 * `lib/legal-acceptance.ts` found pending for the company right now. That may be a
 * published version not yet current in code, or one in force through a `legal_versions`
 * row before the bump deploy. The version must equal it, and only `source: 'portal'` may
 * pass it. This module stays synchronous, so the caller does that read.
 *
 * ── IP AND USER AGENT ──────────────────────────────────────────────────────────
 * Recorded on the claim path and on a portal grant accept (AECI-1615,
 * `method: 'portal_checkbox'`), whose request comes from the owner's browser. NOT on
 * a `portal` acceptance (AECI-1677), though it comes from the owner's browser too: the
 * Privacy Policy's "Agreement acceptance records" names the IP address and browser only
 * "for a claim or an in-portal acceptance of a granted subscription". Recording them here
 * waits for that sentence to change (`docs/LEGAL_IMPACT_REVIEW.md` §3). Flip
 * `PORTAL_RECORDS_EVIDENCE` in the same change. The
 * checkout acceptance is written from the Stripe webhook, whose request comes from
 * Stripe, so its `CF-Connecting-IP` would be Stripe's address. A signed-deal grant is
 * recorded from the admin's browser, not the signer's. Those two store NULL for both
 * even if the caller passes headers. `CF-Connecting-IP` survives the SSR→API service binding
 * (`rate-limit-middleware.ts`), so on the claim path it is the claimant's address.
 *
 * ── THE CHECKBOX (AECI-1615 ruling 16) ─────────────────────────────────────────
 * Every path that shows a box records which box: `checkbox_label_sha256` is the SHA-256
 * of the exact label (`AGREEMENT_CHECKBOX_LABELS`), and `checkbox_default_unticked` is 1
 * because every box starts unticked. The claim path shows the vendor terms box; Stripe
 * checkout and the portal grant accept show the Managed plan sentence. A signed deal has
 * no box, so both stay NULL. Since AECI-1619 the row also stores the label text itself
 * (`checkbox_label`), beside its hash, because ruling 16 asks for the text, not a hash.
 *
 * ── POLICY AND PLANS VERSIONS (AECI-1619, counsel Q14, ruling 16) ──────────────
 * A claim records the versions of the two policies the Vendor Terms incorporate, the
 * Listing Accuracy Policy and the Review Guidelines (`policyVersions`). Only the claim
 * path may pass them. A checkout or grant records the Plans page version current when it
 * was given (`plansVersion`), and this module stamps `plans_page_sha256` from
 * `PLANS_PAGE_SHA256`. Only those two paths may pass it. Each version must be a KNOWN one,
 * else `400 VALIDATION_FAILED`. Both are optional: a claim confirmed from a submit made
 * before the columns, and a checkout whose session predates the metadata, record NULL
 * rather than a version nobody showed.
 *
 * ── WHAT THE AUDIT ROW CARRIES ─────────────────────────────────────────────────
 * The audit row is forwarded to PostHog, so it carries no email, IP or user agent.
 * Those stay in the acceptance row, which is the evidence. The audit row names the
 * acceptance id, the document, version and source, the linked ids, and the policy and
 * Plans versions (AECI-1619). Not the label text: the hash already names it. The signer's name
 * and title and the company's legal name (AECI-1617) stay out of it for the same reason.
 */

import {
  AGREEMENT_ACCEPTANCE_SOURCES,
  AGREEMENT_CHECKBOX_LABELS,
  ApiErrorCode,
  type AgreementAcceptanceMethod,
  isKnownLegalPolicyVersion,
  isKnownPlansPageVersion,
  isRecordableLegalAgreementVersion,
  LEGAL_AGREEMENT_DOCUMENTS,
  legalAgreementVersionInForce,
  legalVersionsInForce,
  type LegalInForceVersions,
  plansPageSha256,
  type AgreementAcceptanceSource,
  type LegalAgreementDocument,
} from '@aeci/shared';
import type { AuditLogActorType, AuditLogEntry } from '@aeci/shared/audit-log';
import type { VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { asc, desc, eq, inArray, or, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances, billingAccounts, profiles, vendors } from '../db/schema';
import { ApiError } from '../errors';
import { auditInsert, type BatchStmt } from './audit';

/** The audit action. Registered in `@aeci/shared/audit-vendor-actions`. */
export const AGREEMENT_ACCEPTED_ACTION = 'agreement.accepted';

/** The approval link's audit action (AECI-1367). Registered beside the one above. */
export const AGREEMENT_LINKED_ACTION = 'agreement.linked';

/** `audit_log.entity_type`; `entity_id` is the acceptance id. */
export const AGREEMENT_ACCEPTANCE_ENTITY_TYPE = 'agreement_acceptance';

/**
 * Whether a `portal` acceptance stores the IP address and browser (module header). False
 * until the Privacy Policy names this acceptance. `agreement-acceptances.spec.ts` pins it.
 */
export const PORTAL_RECORDS_EVIDENCE = false;

/** The longest user agent stored. Longer strings are cut, never refused. */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * A stored user agent: trimmed, cut to {@link USER_AGENT_MAX_LENGTH} characters, and
 * `null` when absent or blank. No UA helper existed in `apps/api` before this one.
 */
export function truncateUserAgent(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, USER_AGENT_MAX_LENGTH);
}

/** The request evidence a claim-path acceptance stores. Both null when unknown. */
export interface AcceptanceRequestEvidence {
  ip: string | null;
  userAgent: string | null;
}

/** Read `CF-Connecting-IP` and `User-Agent` off the request headers. */
export function acceptanceRequestEvidence(
  headers: Headers | null | undefined,
): AcceptanceRequestEvidence {
  if (!headers) return { ip: null, userAgent: null };
  const ip = headers.get('cf-connecting-ip')?.trim() || null;
  return { ip, userAgent: truncateUserAgent(headers.get('user-agent')) };
}

/**
 * Who signed (AECI-1617, counsel Q11). A claim takes it from the form. A checkout has no
 * form, so `loadCheckoutSigner` reads it before the session opens, the session's metadata
 * carries it, and the webhook copies it here. Each is nullable: a pending claim from before
 * these fields has no title or legal name, and neither does a seat with no claim on record.
 */
export interface AcceptanceSigner {
  name: string | null;
  title: string | null;
  companyLegalName: string | null;
}

export interface AgreementAcceptanceParams {
  /** Validated at runtime: a webhook may hand over a string from Stripe metadata. */
  document: LegalAgreementDocument | string;
  /** Must equal the version in force (`inForce`), unless `allowSupersededVersion`,
   *  `grant` or `portalVersion` is set. */
  version: string;
  /**
   * AECI-1689: the agreement versions in force at request time (`loadLegalInForce`).
   * Every request path passes it. Absent (a spec, a caller with no D1 read), the gate
   * uses the version in force with no publish known: the build's current version.
   */
  inForce?: LegalInForceVersions | null;
  /**
   * Accept any KNOWN version of the document, not only the current one (module header,
   * ruling R1). Only for `source: 'checkout'`: any other source with it set is refused.
   * An unknown version is refused either way.
   */
  allowSupersededVersion?: boolean;
  source: AgreementAcceptanceSource | string;
  /** The accepting person's email. Required: there may be no profile yet. */
  email: string;
  /** Null at claim time. E3 fills it at approval; E9 has it at checkout. */
  profileId?: string | null;
  vendorId?: string | null;
  billingAccountId?: string | null;
  /** The claim this acceptance was given on. */
  vendorRequestId?: string | null;
  /** The typed-in listing request this acceptance was given on (AECI-1366). */
  listingRequestId?: string | null;
  /** The plan agreement's Stripe Checkout session. Unique when present. */
  stripeCheckoutSessionId?: string | null;
  /** ISO timestamp of the acceptance. Normalised here. */
  acceptedAt: string;
  /**
   * The claim request's headers, for `CF-Connecting-IP` and `User-Agent`. Absent on the
   * webhook path, and ignored when `source` is `checkout` (module header).
   */
  requestHeaders?: Headers | null;
  /**
   * The claim-path evidence captured earlier (AECI-1435). A confirmed anonymous claim
   * is accepted at confirm, but the IP and user agent are the SUBMIT's, stored on the
   * pending `request_confirmations` row. When present it wins over `requestHeaders`.
   * Ignored when `source` is `checkout`, like the headers.
   */
  evidence?: AcceptanceRequestEvidence | null;
  /** Who signed. Stored on the row and never in the audit entry (module header). */
  signer?: AcceptanceSigner | null;
  /**
   * AECI-1615: the grant fields, required with `source: 'grant'` and refused with any
   * other source. `pinnedVersion` replaces the current-version gate: `version` must
   * equal it.
   */
  grant?: AcceptanceGrantFields | null;
  /**
   * AECI-1677: the version `lib/legal-acceptance.ts` found pending for this company,
   * required with `source: 'portal'` and refused with any other source. Replaces the
   * current-version gate: `version` must equal it.
   */
  portalVersion?: string | null;
  /**
   * AECI-1615 ruling 16: the checkbox the acceptance was given on. Pass it only when
   * the caller knows the exact label shown. Absent (a signed deal) writes NULL to both
   * columns.
   */
  checkbox?: AcceptanceCheckbox | null;
  /**
   * AECI-1619: the policy versions the claim box named. Claim only, and since AECI-1677
   * a `portal` acceptance of the Vendor Terms, which incorporate them: any other source
   * with it set is refused. Absent or null writes NULL (a legacy pending claim).
   */
  policyVersions?: AcceptancePolicyVersions | null;
  /**
   * AECI-1619: the Plans page version current at acceptance. Checkout and grant only,
   * and since AECI-1677 a `portal` acceptance of the Managed plan agreement: any other
   * with it set is refused. The builder stamps `plans_page_sha256` from it.
   * Absent or null writes NULL to both (a checkout session from before the metadata).
   */
  plansVersion?: string | null;
  /** `audit_log.actor_id`: a `profiles.id` that exists, or null (anonymous, webhook). */
  actorId?: string | null;
  actorType: AuditLogActorType;
  /** The vendor's plan before the write, for the audit row's snapshot columns. */
  vendorPlan?: VendorPlanSnapshot | null;
}

/** The versions of the two policies the Vendor Terms incorporate (AECI-1619). */
export interface AcceptancePolicyVersions {
  listingAccuracy: string;
  reviewGuidelines: string;
}

/**
 * The policy versions the claim box names at request time: the ones in force
 * (`inForce`, AECI-1689). A policy switches on its date alone, so without `inForce` the
 * answer is computed from the clock with no D1 read.
 */
export function currentPolicyVersions(
  inForce: LegalInForceVersions = legalVersionsInForce([], Date.now()),
): AcceptancePolicyVersions {
  return {
    listingAccuracy: inForce.policies.listing_accuracy,
    reviewGuidelines: inForce.policies.review_guidelines,
  };
}

/**
 * The policy versions a pending submit stored (AECI-1619), or null when it stored none.
 * A row written before migration 0118 holds NULL in both, and the acceptance then
 * records NULL: the code cannot prove which versions that form named.
 */
export function storedPolicyVersions(row: {
  listingAccuracyVersion: string | null;
  reviewGuidelinesVersion: string | null;
}): AcceptancePolicyVersions | null {
  if (row.listingAccuracyVersion === null || row.reviewGuidelinesVersion === null) return null;
  return {
    listingAccuracy: row.listingAccuracyVersion,
    reviewGuidelines: row.reviewGuidelinesVersion,
  };
}

/** The box an acceptance was ticked in (AECI-1615 ruling 16). */
export interface AcceptanceCheckbox {
  /** The exact label shown (`AGREEMENT_CHECKBOX_LABELS[document].text`). AECI-1619. */
  labelText: string;
  /** SHA-256 of the exact label shown (`AGREEMENT_CHECKBOX_LABELS[document].sha256`). */
  labelSha256: string;
  /** Whether the box started unticked. */
  defaultUnticked: boolean;
}

/**
 * The checkbox evidence for a box that shows `document`'s shared label and starts
 * unticked: the claim's vendor terms box, Stripe's required terms box and the portal
 * grant accept all do.
 */
export function uncheckedBoxFor(document: LegalAgreementDocument): AcceptanceCheckbox {
  const label = AGREEMENT_CHECKBOX_LABELS[document];
  return { labelText: label.text, labelSha256: label.sha256, defaultUnticked: true };
}

/**
 * The claim box for a claim-path acceptance of vendor terms `version`. A confirmed
 * anonymous claim carries the SUBMIT's version (AECI-1435), and the label is part of the
 * text it quotes, so a submit under an older version may have shown an older label. Only
 * the label of the version in force (`inForce`, AECI-1689) is known here, so any other
 * version records NULL.
 */
export function claimBoxFor(
  version: string,
  inForce: LegalInForceVersions = legalVersionsInForce([], Date.now()),
): AcceptanceCheckbox | null {
  return version === inForce.agreements.vendor_terms ? uncheckedBoxFor('vendor_terms') : null;
}

/** The `grant`-source columns (AECI-1615). */
export interface AcceptanceGrantFields {
  licenseGrantId: string;
  /** The grant's term end, ISO. */
  grantEndsAt: string;
  /** The version the grant pinned at create. */
  pinnedVersion: string;
  method: AgreementAcceptanceMethod;
  /** SHA-256 of the agreement text at the version. */
  textSha256: string | null;
  /** `owner` on a portal accept; null on a signed deal. */
  seatRole: string | null;
  dealReference?: string | null;
  dealSignedAt?: string | null;
}

export interface AgreementAcceptanceBatch {
  /** The acceptance INSERT, then its audit row. Append both to the caller's batch. */
  stmts: BatchStmt[];
  /** Forward with `forwardAuditLog` after the batch commits. */
  auditEntry: AuditLogEntry;
  acceptanceId: string;
}

function validationFailed(field: string, message: string): ApiError {
  return new ApiError(400, ApiErrorCode.VALIDATION_FAILED, message, { field });
}

function isDocument(value: string): value is LegalAgreementDocument {
  return (LEGAL_AGREEMENT_DOCUMENTS as readonly string[]).includes(value);
}

function isSource(value: string): value is AgreementAcceptanceSource {
  return (AGREEMENT_ACCEPTANCE_SOURCES as readonly string[]).includes(value);
}

/**
 * The acceptance INSERT and its `agreement.accepted` audit row. Throws
 * `400 VALIDATION_FAILED` on an unknown document or source, a stale or unknown version,
 * a blank email, or an unparseable `acceptedAt`. Never runs a batch.
 */
export function agreementAcceptanceStatements(
  db: Db,
  p: AgreementAcceptanceParams,
): AgreementAcceptanceBatch {
  if (!isDocument(p.document)) {
    throw validationFailed('document', `Unknown agreement: ${p.document}`);
  }
  if (!isSource(p.source)) {
    throw validationFailed('source', `Unknown acceptance source: ${p.source}`);
  }
  const current =
    p.inForce?.agreements[p.document] ?? legalAgreementVersionInForce(p.document, [], Date.now());
  if ((p.source === 'grant') !== Boolean(p.grant)) {
    throw validationFailed('source', 'Only a grant acceptance carries grant fields');
  }
  const portalVersion = p.portalVersion ?? null;
  if ((p.source === 'portal') !== (portalVersion !== null)) {
    throw validationFailed('source', 'Only a portal acceptance names its pending version');
  }
  if (portalVersion !== null) {
    if (p.allowSupersededVersion) {
      throw validationFailed('source', 'A portal acceptance names its pending version instead');
    }
    if (p.version !== portalVersion) {
      throw validationFailed(
        'version',
        `Version ${p.version} of ${p.document} is not the version waiting for acceptance (${portalVersion})`,
      );
    }
  } else if (p.grant) {
    if (p.allowSupersededVersion) {
      throw validationFailed('source', 'A grant acceptance pins its version instead');
    }
    if (
      p.version !== p.grant.pinnedVersion ||
      !isRecordableLegalAgreementVersion(p.document, p.version)
    ) {
      throw validationFailed(
        'version',
        `Version ${p.version} of ${p.document} is not the version this grant pins (${p.grant.pinnedVersion})`,
      );
    }
  } else if (p.allowSupersededVersion) {
    if (p.source !== 'checkout') {
      throw validationFailed('source', 'Only a checkout acceptance may record an older version');
    }
    if (!isRecordableLegalAgreementVersion(p.document, p.version)) {
      throw validationFailed(
        'version',
        `Version ${p.version} of ${p.document} was never published (current: ${current})`,
      );
    }
  } else if (p.version !== current) {
    throw validationFailed(
      'version',
      `Version ${p.version} of ${p.document} is not the current version (${current})`,
    );
  }
  const policyVersions = p.policyVersions ?? null;
  if (policyVersions) {
    if (p.source !== 'claim' && !(p.source === 'portal' && p.document === 'vendor_terms')) {
      throw validationFailed(
        'policy_versions',
        'Only a claim or a portal Vendor Terms acceptance records policy versions',
      );
    }
    if (!isKnownLegalPolicyVersion('listing_accuracy', policyVersions.listingAccuracy)) {
      throw validationFailed(
        'listing_accuracy_version',
        `Version ${policyVersions.listingAccuracy} of the Listing Accuracy Policy was never published`,
      );
    }
    if (!isKnownLegalPolicyVersion('review_guidelines', policyVersions.reviewGuidelines)) {
      throw validationFailed(
        'review_guidelines_version',
        `Version ${policyVersions.reviewGuidelines} of the Review Guidelines was never published`,
      );
    }
  }
  const plansVersion = p.plansVersion ?? null;
  if (plansVersion !== null) {
    if (
      p.source !== 'checkout' &&
      p.source !== 'grant' &&
      !(p.source === 'portal' && p.document === 'managed_plan')
    ) {
      throw validationFailed(
        'plans_version',
        'Only a checkout, grant or portal Managed plan acceptance records the Plans page',
      );
    }
    if (!isKnownPlansPageVersion(plansVersion)) {
      throw validationFailed(
        'plans_version',
        `Version ${plansVersion} of the Plans page was never published`,
      );
    }
  }
  const email = p.email.trim();
  if (!email) throw validationFailed('email', 'An acceptance needs an email');
  const acceptedAtMs = Date.parse(p.acceptedAt);
  if (Number.isNaN(acceptedAtMs)) {
    throw validationFailed('accepted_at', 'An acceptance needs a valid time');
  }
  const acceptedAt = new Date(acceptedAtMs).toISOString();

  // The claim path and a portal grant accept come from the accepting person's browser.
  const recordsEvidence =
    p.source === 'claim' ||
    (p.source === 'grant' && p.grant?.method === 'portal_checkbox') ||
    (p.source === 'portal' && PORTAL_RECORDS_EVIDENCE);
  const evidence = !recordsEvidence
    ? { ip: null, userAgent: null }
    : p.evidence
      ? { ip: p.evidence.ip, userAgent: truncateUserAgent(p.evidence.userAgent) }
      : acceptanceRequestEvidence(p.requestHeaders);

  const id = crypto.randomUUID();
  const row = {
    id,
    document: p.document,
    version: p.version,
    source: p.source,
    email,
    profileId: p.profileId ?? null,
    vendorId: p.vendorId ?? null,
    billingAccountId: p.billingAccountId ?? null,
    vendorRequestId: p.vendorRequestId ?? null,
    listingRequestId: p.listingRequestId ?? null,
    stripeCheckoutSessionId: p.stripeCheckoutSessionId ?? null,
    acceptedAt,
    ip: evidence.ip,
    userAgent: evidence.userAgent,
    signerName: p.signer?.name ?? null,
    signerTitle: p.signer?.title ?? null,
    companyLegalName: p.signer?.companyLegalName ?? null,
    licenseGrantId: p.grant?.licenseGrantId ?? null,
    grantEndsAt: p.grant?.grantEndsAt ?? null,
    method: p.grant?.method ?? null,
    textSha256: p.grant?.textSha256 ?? null,
    seatRole: p.grant?.seatRole ?? null,
    dealReference: p.grant?.dealReference ?? null,
    dealSignedAt: p.grant?.dealSignedAt ?? null,
    checkboxLabelSha256: p.checkbox?.labelSha256 ?? null,
    checkboxDefaultUnticked: p.checkbox ? p.checkbox.defaultUnticked : null,
    checkboxLabel: p.checkbox?.labelText ?? null,
    listingAccuracyVersion: policyVersions?.listingAccuracy ?? null,
    reviewGuidelinesVersion: policyVersions?.reviewGuidelines ?? null,
    plansPageVersion: plansVersion,
    plansPageSha256: plansVersion === null ? null : plansPageSha256(plansVersion),
  };

  // No email, IP or user agent: this entry is forwarded to PostHog (module header).
  const linked = {
    document: row.document,
    version: row.version,
    source: row.source,
    accepted_at: acceptedAt,
    vendor_id: row.vendorId,
    billing_account_id: row.billingAccountId,
    vendor_request_id: row.vendorRequestId,
    listing_request_id: row.listingRequestId,
    stripe_checkout_session_id: row.stripeCheckoutSessionId,
    // AECI-1619. Version strings only, never the label text or any personal data.
    listing_accuracy_version: row.listingAccuracyVersion,
    review_guidelines_version: row.reviewGuidelinesVersion,
    plans_page_version: row.plansPageVersion,
    ...(p.grant
      ? {
          license_grant_id: row.licenseGrantId,
          grant_ends_at: row.grantEndsAt,
          method: row.method,
          text_sha256: row.textSha256,
        }
      : {}),
  };
  const auditEntry: AuditLogEntry = {
    actorId: p.actorId ?? null,
    actorType: p.actorType,
    action: AGREEMENT_ACCEPTED_ACTION,
    entityType: AGREEMENT_ACCEPTANCE_ENTITY_TYPE,
    entityId: id,
    vendorId: row.vendorId,
    vendorPlan: p.vendorPlan ?? null,
    beforeState: null,
    afterState: linked,
    metadata: { source: row.source, document: row.document, version: row.version },
  };

  return {
    stmts: [db.insert(agreementAcceptances).values(row), auditInsert(db, auditEntry)],
    auditEntry,
    acceptanceId: id,
  };
}

/**
 * The ids of the acceptances given on one claim, in a stable order. The approval reads
 * them before it builds its batch, so `linkClaimAcceptanceStatements` emits nothing
 * when there are none. No index on `vendor_request_id`: a claim has at most a handful
 * of rows, and the read runs once per approval.
 */
export async function loadClaimAcceptanceIds(db: Db, vendorRequestId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agreementAcceptances.id })
    .from(agreementAcceptances)
    .where(eq(agreementAcceptances.vendorRequestId, vendorRequestId))
    .orderBy(asc(agreementAcceptances.id));
  return rows.map((r) => r.id);
}

export interface LinkClaimAcceptanceParams {
  /** The claim the acceptances were given on. */
  vendorRequestId: string;
  /** `loadClaimAcceptanceIds`. Empty → the whole call is a no-op. */
  acceptanceIds: readonly string[];
  /** The seat the approval granted (`profiles.id`). */
  profileId: string;
  vendorId: string;
  /** The vendor's billing account: the existing one, or the one this batch creates. */
  billingAccountId: string;
  /** The approving admin. */
  actorId: string;
  actorType: AuditLogActorType;
  vendorPlan: VendorPlanSnapshot;
  /** `metadata.source`, so the row reads as part of the approval. */
  source: string;
}

export interface LinkClaimAcceptanceBatch {
  stmts: BatchStmt[];
  /** `null` when the claim has no acceptances: nothing changed, nothing to audit. */
  auditEntry: AuditLogEntry | null;
}

const NO_LINK: LinkClaimAcceptanceBatch = Object.freeze({
  stmts: Object.freeze([]) as unknown as BatchStmt[],
  auditEntry: null,
});

/**
 * The approval's link (AECI-1367, `DATABASE_SCHEMA.md` §8.6d). At claim time an
 * acceptance names only the email and the claim. When the claim is approved this fills
 * `profile_id`, `vendor_id` and `billing_account_id` on every row with that
 * `vendor_request_id`, so the evidence points at the account it now belongs to. It
 * changes nothing else: the document, version, time, IP and user agent are the
 * evidence and stay as accepted.
 *
 * One `agreement.linked` audit row covers the claim. It is filed under the claim
 * (`entity_type = 'vendor_request'`) and names every acceptance id it linked. Returns
 * the frozen no-op when the claim has no acceptances.
 */
export function linkClaimAcceptanceStatements(
  db: Db,
  p: LinkClaimAcceptanceParams,
): LinkClaimAcceptanceBatch {
  if (p.acceptanceIds.length === 0) return NO_LINK;

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: AGREEMENT_LINKED_ACTION,
    entityType: 'vendor_request',
    entityId: p.vendorRequestId,
    vendorId: p.vendorId,
    vendorPlan: p.vendorPlan,
    beforeState: null,
    afterState: {
      acceptance_ids: [...p.acceptanceIds],
      profile_id: p.profileId,
      vendor_id: p.vendorId,
      billing_account_id: p.billingAccountId,
    },
    metadata: { source: p.source, vendorId: p.vendorId },
  };

  return {
    stmts: [
      db
        .update(agreementAcceptances)
        .set({
          profileId: p.profileId,
          vendorId: p.vendorId,
          billingAccountId: p.billingAccountId,
        })
        .where(eq(agreementAcceptances.vendorRequestId, p.vendorRequestId)),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
  };
}

/**
 * "The acceptances of this vendor": rows naming the vendor directly, plus rows filed only
 * under one of its billing accounts (a checkout acceptance written before the caller knew
 * the vendor id). Both legs are indexed.
 */
export function acceptancesOfVendor(db: Db, vendorId: string): SQL | undefined {
  return or(
    eq(agreementAcceptances.vendorId, vendorId),
    inArray(
      agreementAcceptances.billingAccountId,
      db
        .select({ id: billingAccounts.id })
        .from(billingAccounts)
        .where(eq(billingAccounts.vendorId, vendorId)),
    ),
  );
}

/** One vendor's acceptances, newest first. `id` breaks a tie on the ISO timestamp. */
export function listVendorAcceptances(db: Db, vendorId: string) {
  return db
    .select()
    .from(agreementAcceptances)
    .where(acceptancesOfVendor(db, vendorId))
    .orderBy(desc(agreementAcceptances.acceptedAt), desc(agreementAcceptances.id));
}

export type AgreementAcceptanceRow = typeof agreementAcceptances.$inferSelect;

/**
 * Who a Checkout Session records as signing (AECI-1617, AECI-1625).
 *
 *   - **Legal name:** `vendors.legal_name` first. Else the newest claim acceptance that
 *     recorded one, for a vendor whose column is still empty. Never
 *     `billing_accounts.name` or `vendors.company_name`: neither is a legal name, and the
 *     acceptance row is evidence.
 *   - **Title:** what the buyer typed on the buy form (`typedTitle`). Else this seat's own
 *     newest claim acceptance that recorded one. A seat that joined by invitation has no
 *     claim, which is why the buy form asks.
 *   - **Name:** the profile's display name, which is what the seat calls itself today,
 *     else the seat's own claim.
 */
export async function loadCheckoutSigner(
  db: Db,
  profileId: string,
  vendorId: string,
  typedTitle?: string | null,
): Promise<AcceptanceSigner> {
  const [profile, vendor, rows] = await Promise.all([
    db.query.profiles.findFirst({
      columns: { displayName: true },
      where: eq(profiles.id, profileId),
    }),
    db.query.vendors.findFirst({
      columns: { legalName: true },
      where: eq(vendors.id, vendorId),
    }),
    listVendorAcceptances(db, vendorId),
  ]);
  const claims = rows.filter((row) => row.source === 'claim');
  const own = claims.filter((row) => row.profileId === profileId);
  return {
    name: profile?.displayName?.trim() || own.find((row) => row.signerName)?.signerName || null,
    title: typedTitle?.trim() || own.find((row) => row.signerTitle)?.signerTitle || null,
    companyLegalName:
      vendor?.legalName || claims.find((row) => row.companyLegalName)?.companyLegalName || null,
  };
}
