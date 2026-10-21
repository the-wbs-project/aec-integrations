/**
 * The one module that writes `agreement_acceptances` (AECI-1362, E2.4 of
 * `docs/VENDOR_SIGNUP_PROCESS.md` §4; `DATABASE_SCHEMA.md` §8.6d).
 *
 * Three INSERT callers: the claim insert and the typed-in listing request (AECI-1366, the
 * vendor terms box on the claim form), and the Stripe checkout webhook (E9, the Managed
 * plan agreement box, not built yet). Since AECI-1435 an anonymous claim or listing
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
 * A vendor may only accept the CURRENT version of an agreement. A stale or unknown
 * version (a form loaded before a bump, a forged body) is refused with
 * `400 VALIDATION_FAILED` before any statement exists. The current versions are
 * `LEGAL_AGREEMENT_CURRENT_VERSIONS` in `@aeci/shared`.
 *
 * ── IP AND USER AGENT ──────────────────────────────────────────────────────────
 * Recorded on the claim path only (§4). The checkout acceptance is written from the
 * Stripe webhook, whose request comes from Stripe, so its `CF-Connecting-IP` would be
 * Stripe's address. A `checkout` acceptance therefore stores NULL for both even if the
 * caller passes headers. `CF-Connecting-IP` survives the SSR→API service binding
 * (`rate-limit-middleware.ts`), so on the claim path it is the claimant's address.
 *
 * ── WHAT THE AUDIT ROW CARRIES ─────────────────────────────────────────────────
 * The audit row is forwarded to PostHog, so it carries no email, IP or user agent.
 * Those stay in the acceptance row, which is the evidence. The audit row names the
 * acceptance id, the document, version and source, and the linked ids.
 */

import {
  AGREEMENT_ACCEPTANCE_SOURCES,
  ApiErrorCode,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_DOCUMENTS,
  type AgreementAcceptanceSource,
  type LegalAgreementDocument,
} from '@aeci/shared';
import type { AuditLogActorType, AuditLogEntry } from '@aeci/shared/audit-log';
import type { VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { asc, desc, eq, inArray, or, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances, billingAccounts } from '../db/schema';
import { ApiError } from '../errors';
import { auditInsert, type BatchStmt } from './audit';

/** The audit action. Registered in `@aeci/shared/audit-vendor-actions`. */
export const AGREEMENT_ACCEPTED_ACTION = 'agreement.accepted';

/** The approval link's audit action (AECI-1367). Registered beside the one above. */
export const AGREEMENT_LINKED_ACTION = 'agreement.linked';

/** `audit_log.entity_type`; `entity_id` is the acceptance id. */
export const AGREEMENT_ACCEPTANCE_ENTITY_TYPE = 'agreement_acceptance';

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

export interface AgreementAcceptanceParams {
  /** Validated at runtime: a webhook may hand over a string from Stripe metadata. */
  document: LegalAgreementDocument | string;
  /** Must equal `LEGAL_AGREEMENT_CURRENT_VERSIONS[document]`. */
  version: string;
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
  /** `audit_log.actor_id`: a `profiles.id` that exists, or null (anonymous, webhook). */
  actorId?: string | null;
  actorType: AuditLogActorType;
  /** The vendor's plan before the write, for the audit row's snapshot columns. */
  vendorPlan?: VendorPlanSnapshot | null;
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
  const current = LEGAL_AGREEMENT_CURRENT_VERSIONS[p.document];
  if (p.version !== current) {
    throw validationFailed(
      'version',
      `Version ${p.version} of ${p.document} is not the current version (${current})`,
    );
  }
  const email = p.email.trim();
  if (!email) throw validationFailed('email', 'An acceptance needs an email');
  const acceptedAtMs = Date.parse(p.acceptedAt);
  if (Number.isNaN(acceptedAtMs)) {
    throw validationFailed('accepted_at', 'An acceptance needs a valid time');
  }
  const acceptedAt = new Date(acceptedAtMs).toISOString();

  const evidence =
    p.source !== 'claim'
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
