/**
 * The sign-in acceptance of the Terms of Service (AECI-1637, counsel Q34, ruling 12, and
 * Chris's ruling of 2026-11-13: signing in is the acceptance; `STAGE_1_SPEC.md` §27.4,
 * `AUTH_AND_RLS.md` §3.1b, ADR 0055).
 *
 * The login page shows one line beside the sign-in buttons (`SIGN_IN_TERMS_LINE`). The
 * sign-in is the click. When the SSR `/auth/callback` calls `POST /api/auth/profile/ensure`,
 * that handler calls {@link recordSignInTermsAcceptance}, which writes one
 * `terms_acceptances` row for the Terms version in force, with its `terms.accepted` audit
 * row, in one `db.batch`. Once per account per version. Nothing gates anything: a session
 * that began before a new version stays on the earlier one until its next sign-in.
 *
 * ── WHICH VERSION IS IN FORCE ────────────────────────────────────────────────────
 * The version `legalReaderVersionInForce` names, but only when code dates it:
 *   1. `LEGAL_READER_EFFECTIVE_ON` names it with a day that has come. A version listed
 *      there as `null` is a draft and never in force, row or not.
 *   2. Or it is the upcoming version (`LEGAL_READER_UPCOMING_VERSIONS`) AND a
 *      `legal_versions` row published it with the manifest's moment (ruling 2 of
 *      2026-11-13). A row whose date was moved is in force nowhere
 *      (`legalPublishedRowMismatched`).
 * Because this needs code, {@link readerTermsMayBeInForce} knows WITHOUT a read when no
 * version can be in force. Today every entry is `null` and nothing is upcoming, so a
 * sign-in reads nothing and writes nothing. `reader-legal-acceptance.spec.ts` pins this.
 *
 * ── `requires_acceptance` ────────────────────────────────────────────────────────
 * The row is written for EVERY Terms version in force, whatever its publish flag. The flag
 * says the version reduces rights: it binds an account holder only from the sign-in that
 * writes this row, never on continued use, and the change email says so
 * (`reader-terms-accept`). It does not change what is written here.
 *
 * ── NEVER FAILS THE SIGN-IN ──────────────────────────────────────────────────────
 * Every failure is logged and swallowed: a lost row only means the earlier version keeps
 * applying until the next sign-in. A racing second sign-in trips the unique
 * `(profile_id, document, version)` index, which fails that batch whole, so no orphan audit
 * row is left.
 */

import {
  legalEffectiveAtMs,
  legalMomentReached,
  legalPublishedRowMismatched,
  legalReaderEffectiveOnOf,
  legalReaderUpcomingOf,
  legalReaderVersionInForce,
  LEGAL_IN_FORCE_MAPS,
  SIGN_IN_TERMS_LINE,
  type LegalInForceMaps,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { legalVersions, termsAcceptances } from '../db/schema';
import { acceptanceRequestEvidence } from './agreement-acceptances';
import { auditInsert, type BatchTuple } from './audit';
import { sha256Hex } from './hash';

const DOC = 'terms';

/** `audit_log.action` of a sign-in Terms acceptance. */
export const TERMS_ACCEPTED_ACTION = 'terms.accepted';
/** `audit_log.entity_type` of a `terms_acceptances` row; `entity_id` is its id. */
export const TERMS_ACCEPTANCE_ENTITY_TYPE = 'terms_acceptance';
/** `audit_log.metadata.source` of the write. */
export const SIGN_IN_ACCEPTANCE_SOURCE = 'auth-callback';

/** The `legal_versions` columns this module reads (the `terms` rows only). */
export interface ReaderPublishedLite {
  id: string;
  document: string;
  version: string;
  effectiveAt: number;
  pdfSha256: string;
}

/**
 * Whether any Terms version CAN be in force at `nowMs`: some version code dates has
 * reached its moment (a dated entry of `LEGAL_READER_EFFECTIVE_ON`, or the upcoming
 * entry). False means none is, whatever D1 holds, so a caller skips every read. False
 * today, always.
 */
export function readerTermsMayBeInForce(
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): boolean {
  const dated = Object.values(legalReaderEffectiveOnOf(maps)[DOC]).some(
    (day) => day !== null && legalMomentReached(legalEffectiveAtMs(day), nowMs),
  );
  if (dated) return true;
  const upcoming = legalReaderUpcomingOf(maps)[DOC];
  return (
    upcoming !== undefined && legalMomentReached(legalEffectiveAtMs(upcoming.effectiveOn), nowMs)
  );
}

/** The effective moment of a Terms version code dates, epoch ms, or `null` (module header). */
export function readerTermsEffectiveAtMs(
  version: string,
  published: readonly ReaderPublishedLite[],
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): number | null {
  const dated = legalReaderEffectiveOnOf(maps)[DOC];
  if (Object.hasOwn(dated, version)) {
    const day = dated[version];
    if (!day) return null;
    const ms = legalEffectiveAtMs(day);
    return Number.isNaN(ms) ? null : ms;
  }
  const upcoming = legalReaderUpcomingOf(maps)[DOC];
  if (!upcoming || upcoming.version !== version) return null;
  const row = published.find((r) => r.document === DOC && r.version === version);
  if (!row || legalPublishedRowMismatched(row, maps)) return null;
  return Number.isFinite(row.effectiveAt) ? row.effectiveAt : null;
}

/** The Terms version in force at `nowMs`, or `null` when none is (module header). Pure. */
export function readerTermsInForce(
  published: readonly ReaderPublishedLite[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string | null {
  const version = legalReaderVersionInForce(DOC, published, nowMs, maps);
  const at = readerTermsEffectiveAtMs(version, published, maps);
  return at !== null && legalMomentReached(at, nowMs) ? version : null;
}

export interface SignInAcceptanceInput {
  profileId: string;
  /** The verified session's email. `''` when the token carries none. */
  email: string | null | undefined;
  /** The inbound request's headers: `CF-Connecting-IP` and `User-Agent`. */
  headers: Headers | null | undefined;
  now: Date;
  maps?: LegalInForceMaps;
}

/**
 * Write the sign-in acceptance of the Terms version in force, with its audit row, in one
 * `db.batch`. Returns the audit entry to forward post-commit, or `null` when nothing was
 * written: no version in force, or this account already holds a row for it. Throws on a
 * failed read or write; the caller logs and continues ({@link recordSignInTermsAcceptance}).
 */
export async function writeSignInTermsAcceptance(
  db: Db,
  input: SignInAcceptanceInput,
): Promise<AuditLogEntry | null> {
  const maps = input.maps ?? LEGAL_IN_FORCE_MAPS;
  const nowMs = input.now.getTime();
  if (!readerTermsMayBeInForce(nowMs, maps)) return null;

  const [published, accepted] = await db.batch([
    db
      .select({
        id: legalVersions.id,
        document: legalVersions.document,
        version: legalVersions.version,
        effectiveAt: legalVersions.effectiveAt,
        pdfSha256: legalVersions.pdfSha256,
      })
      .from(legalVersions)
      .where(eq(legalVersions.document, DOC)),
    db
      .select({ version: termsAcceptances.version })
      .from(termsAcceptances)
      .where(
        and(eq(termsAcceptances.profileId, input.profileId), eq(termsAcceptances.document, DOC)),
      ),
  ]);
  const version = readerTermsInForce(published, nowMs, maps);
  if (version === null || accepted.some((a) => a.version === version)) return null;

  const row = published.find((r) => r.version === version) ?? null;
  const evidence = acceptanceRequestEvidence(input.headers);
  const acceptedAt = input.now.toISOString();
  const id = crypto.randomUUID();
  const entry: AuditLogEntry = {
    actorId: input.profileId,
    actorType: 'user',
    action: TERMS_ACCEPTED_ACTION,
    entityType: TERMS_ACCEPTANCE_ENTITY_TYPE,
    entityId: id,
    beforeState: null,
    // No email, IP or user agent: this entry is forwarded to PostHog.
    afterState: {
      document: DOC,
      version,
      accepted_at: acceptedAt,
      legal_version_id: row?.id ?? null,
    },
    metadata: { source: SIGN_IN_ACCEPTANCE_SOURCE },
  };
  await db.batch([
    db.insert(termsAcceptances).values({
      id,
      document: DOC,
      version,
      legalVersionId: row?.id ?? null,
      profileId: input.profileId,
      email: input.email ?? '',
      acceptedAt,
      ip: evidence.ip,
      userAgent: evidence.userAgent,
      checkboxLabel: SIGN_IN_TERMS_LINE,
      checkboxLabelSha256: await sha256Hex(SIGN_IN_TERMS_LINE),
      // There is no box: the line is shown and the sign-in is the act.
      checkboxDefaultUnticked: false,
      pdfSha256: row?.pdfSha256 ?? null,
    }),
    auditInsert(db, entry),
  ] as BatchTuple);
  return entry;
}

/**
 * {@link writeSignInTermsAcceptance}, never throwing: a failure is logged and the sign-in
 * goes on (module header). Returns the audit entry to forward, or `null`.
 */
export async function recordSignInTermsAcceptance(
  db: Db,
  input: SignInAcceptanceInput,
): Promise<AuditLogEntry | null> {
  try {
    return await writeSignInTermsAcceptance(db, input);
  } catch (error) {
    console.error('reader-legal-acceptance: the sign-in Terms acceptance was not written', error);
    return null;
  }
}
