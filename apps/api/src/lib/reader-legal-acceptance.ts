/**
 * The sign-in acceptance of the Terms of Service (AECI-1637, counsel Q34, ruling 12, ruling
 * 43: signing in is the acceptance, and ruling 53 / counsel Q63: a tick box for a version
 * that reduces rights; `STAGE_1_SPEC.md` §27.4, `AUTH_AND_RLS.md` §3.1b, ADR 0055).
 *
 * The login page shows one line beside the sign-in buttons (`SIGN_IN_TERMS_LINE`). The
 * sign-in is the click. When the SSR `/auth/callback` calls `POST /api/auth/profile/ensure`,
 * that handler calls {@link recordSignInTermsAcceptance}, which writes one
 * `terms_acceptances` row for the Terms version in force, with its `terms.accepted` audit
 * row, in one `db.batch`. Once per account per version. The one exception is the tick box
 * below. Nothing else gates anything: a session that began before a new version stays on
 * the earlier one until its next sign-in.
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
 * ── `requires_acceptance`: THE TICK BOX (counsel Q63, ruling 53) ────────────────────
 * The flag says a published version reduces rights. It is set at publish time, never read
 * from the text. Counsel's Q63 answer: the line beside the sign-in buttons does not bind an
 * account holder to such a change, so it needs a box the reader ticks. Ruling 53 narrows
 * ruling 43: the box shows ONLY at the first sign-in after a rights-reducing version.
 *
 * {@link termsBoxPendingVersion} decides it. A box is pending when some published Terms
 * version with the flag is in force, took effect after the account was created, and no
 * acceptance covers it (a row for a version whose moment is at or after it). An account
 * created by this sign-in never sees the box: the reduction is not against it, so it gets
 * the line row, which then covers the reduction on later sign-ins.
 * When a box is pending the sign-in writes NO line row, because the sign-in alone does not
 * bind that version. The ensure reports `terms_acceptance: { version }`, the callback sends
 * the reader to `/auth/terms`, and {@link writeTermsBoxAcceptance} writes the row when they
 * tick: the box label (`TERMS_CHANGE_BOX_LABEL`), its hash and `checkbox_default_unticked`
 * true. Until then the earlier version keeps applying. A reader who never signs in again,
 * or leaves the page without ticking, stays on it, and the next sign-in asks again.
 * Every other sign-in writes the line row exactly as before, flag or not.
 *
 * ── NEVER FAILS THE SIGN-IN ──────────────────────────────────────────────────────
 * Every failure is logged and swallowed: a lost row only means the earlier version keeps
 * applying until the next sign-in. A racing second sign-in trips the unique
 * `(profile_id, document, version)` index, which fails that batch whole, so no orphan audit
 * row is left.
 */

import {
  ApiErrorCode,
  legalEffectiveAtMs,
  legalMomentReached,
  legalPublishedRowMismatched,
  legalReaderEffectiveOnOf,
  legalReaderUpcomingOf,
  legalReaderVersionInForce,
  LEGAL_IN_FORCE_MAPS,
  SIGN_IN_TERMS_LINE,
  TERMS_CHANGE_BOX_LABEL,
  type LegalInForceMaps,
  type TermsPending,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { legalVersions, profiles, termsAcceptances } from '../db/schema';
import { ApiError } from '../errors';
import { acceptanceRequestEvidence } from './agreement-acceptances';
import { auditInsert, type BatchTuple } from './audit';
import { sha256Hex } from './hash';
import { summaryOf } from './legal-versions';

const DOC = 'terms';

/** `audit_log.action` of a sign-in Terms acceptance. */
export const TERMS_ACCEPTED_ACTION = 'terms.accepted';
/** `audit_log.entity_type` of a `terms_acceptances` row; `entity_id` is its id. */
export const TERMS_ACCEPTANCE_ENTITY_TYPE = 'terms_acceptance';
/** `audit_log.metadata.source` of the write. */
export const SIGN_IN_ACCEPTANCE_SOURCE = 'auth-callback';
/** `audit_log.metadata.source` of a tick-box acceptance (`POST /api/auth/terms/accept`). */
export const TERMS_BOX_ACCEPTANCE_SOURCE = 'terms-box';

/** The `legal_versions` columns this module reads (the `terms` rows only). */
export interface ReaderPublishedLite {
  id: string;
  document: string;
  version: string;
  effectiveAt: number;
  pdfSha256: string;
  /** The publish flag: this version reduces a reader's rights (module header). */
  requiresAcceptance: boolean;
}

/** The `terms_acceptances` columns the box decision reads, for one account. */
export interface ReaderAcceptedLite {
  version: string;
  /** True on a tick-box row, false on a line row. */
  checkboxDefaultUnticked: boolean;
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

/**
 * The Terms version this account must tick a box for, or `null` (module header). Pure.
 * `profileCreatedAtMs` is when the account was created: a reduction that took effect
 * before it is not against this account. Pass `Infinity` for an account this sign-in made.
 */
export function termsBoxPendingVersion(
  published: readonly ReaderPublishedLite[],
  accepted: readonly ReaderAcceptedLite[],
  profileCreatedAtMs: number,
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string | null {
  const inForce = readerTermsInForce(published, nowMs, maps);
  if (inForce === null) return null;
  let latestReduction: number | null = null;
  for (const r of published) {
    if (r.document !== DOC || !r.requiresAcceptance) continue;
    const at = readerTermsEffectiveAtMs(r.version, published, maps);
    if (at === null || !legalMomentReached(at, nowMs) || !(at > profileCreatedAtMs)) continue;
    if (latestReduction === null || at > latestReduction) latestReduction = at;
  }
  if (latestReduction === null) return null;
  // Any acceptance of a version from the reduction on covers it. A box row does by being
  // ticked. A line row for such a version is only ever written when no box was due (an
  // account created after the reduction, or by that sign-in), so it covers it too.
  const covered = accepted.some((a) => {
    const at = readerTermsEffectiveAtMs(a.version, published, maps);
    return at !== null && at >= latestReduction;
  });
  return covered ? null : inForce;
}

/** What one account's Terms decision reads, in one `db.batch`. */
async function loadReaderTermsState(db: Db, profileId: string) {
  const [published, accepted, profile] = await db.batch([
    db
      .select({
        id: legalVersions.id,
        document: legalVersions.document,
        version: legalVersions.version,
        effectiveAt: legalVersions.effectiveAt,
        pdfSha256: legalVersions.pdfSha256,
        requiresAcceptance: legalVersions.requiresAcceptance,
      })
      .from(legalVersions)
      .where(eq(legalVersions.document, DOC)),
    db
      .select({
        version: termsAcceptances.version,
        checkboxDefaultUnticked: termsAcceptances.checkboxDefaultUnticked,
      })
      .from(termsAcceptances)
      .where(and(eq(termsAcceptances.profileId, profileId), eq(termsAcceptances.document, DOC))),
    db.select({ createdAt: profiles.createdAt }).from(profiles).where(eq(profiles.id, profileId)),
  ]);
  const createdMs = profile[0] ? Date.parse(profile[0].createdAt) : Number.NaN;
  return { published, accepted, profileCreatedAtMs: createdMs };
}

export interface SignInAcceptanceInput {
  profileId: string;
  /** The verified session's email. `''` when the token carries none. */
  email: string | null | undefined;
  /** The inbound request's headers: `CF-Connecting-IP` and `User-Agent`. */
  headers: Headers | null | undefined;
  now: Date;
  /** The ensure created the profile on this call: the box never shows (module header). */
  created?: boolean;
  maps?: LegalInForceMaps;
}

/** What a sign-in did about the Terms. */
export interface SignInAcceptanceResult {
  /** The audit entry to forward post-commit, or `null` when no row was written. */
  entry: AuditLogEntry | null;
  /** The version the reader must tick a box for before continuing, or `null`. */
  boxVersion: string | null;
}

const NOTHING: SignInAcceptanceResult = { entry: null, boxVersion: null };

interface AcceptanceRowInput {
  profileId: string;
  email: string | null | undefined;
  headers: Headers | null | undefined;
  now: Date;
  version: string;
  row: ReaderPublishedLite | null;
  label: string;
  defaultUnticked: boolean;
  source: string;
}

/** The `terms_acceptances` row and its audit row, in one `db.batch`. */
async function insertAcceptance(db: Db, input: AcceptanceRowInput): Promise<AuditLogEntry> {
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
      version: input.version,
      accepted_at: acceptedAt,
      legal_version_id: input.row?.id ?? null,
      checkbox: input.defaultUnticked,
    },
    metadata: { source: input.source },
  };
  await db.batch([
    db.insert(termsAcceptances).values({
      id,
      document: DOC,
      version: input.version,
      legalVersionId: input.row?.id ?? null,
      profileId: input.profileId,
      email: input.email ?? '',
      acceptedAt,
      ip: evidence.ip,
      userAgent: evidence.userAgent,
      checkboxLabel: input.label,
      checkboxLabelSha256: await sha256Hex(input.label),
      checkboxDefaultUnticked: input.defaultUnticked,
      pdfSha256: input.row?.pdfSha256 ?? null,
    }),
    auditInsert(db, entry),
  ] as BatchTuple);
  return entry;
}

/**
 * The sign-in's Terms step, in one read batch and at most one write batch. When a box is
 * pending it writes nothing and returns the version (module header). Otherwise it writes the
 * line row for the version in force, once per account per version. Throws on a failed read
 * or write; the caller logs and continues ({@link recordSignInTermsAcceptance}).
 */
export async function writeSignInTermsAcceptance(
  db: Db,
  input: SignInAcceptanceInput,
): Promise<SignInAcceptanceResult> {
  const maps = input.maps ?? LEGAL_IN_FORCE_MAPS;
  const nowMs = input.now.getTime();
  if (!readerTermsMayBeInForce(nowMs, maps)) return NOTHING;

  const state = await loadReaderTermsState(db, input.profileId);
  const { published, accepted } = state;
  const version = readerTermsInForce(published, nowMs, maps);
  if (version === null) return NOTHING;

  const boxVersion = termsBoxPendingVersion(
    published,
    accepted,
    input.created ? Number.POSITIVE_INFINITY : state.profileCreatedAtMs,
    nowMs,
    maps,
  );
  if (boxVersion !== null) return { entry: null, boxVersion };
  if (accepted.some((a) => a.version === version)) return NOTHING;

  const entry = await insertAcceptance(db, {
    profileId: input.profileId,
    email: input.email,
    headers: input.headers,
    now: input.now,
    version,
    row: published.find((r) => r.version === version) ?? null,
    label: SIGN_IN_TERMS_LINE,
    // There is no box: the line is shown and the sign-in is the act.
    defaultUnticked: false,
    source: SIGN_IN_ACCEPTANCE_SOURCE,
  });
  return { entry, boxVersion: null };
}

/**
 * {@link writeSignInTermsAcceptance}, never throwing: a failure is logged and the sign-in
 * goes on with no box (module header). The earlier version keeps applying, and the next
 * sign-in tries again.
 */
export async function recordSignInTermsAcceptance(
  db: Db,
  input: SignInAcceptanceInput,
): Promise<SignInAcceptanceResult> {
  try {
    return await writeSignInTermsAcceptance(db, input);
  } catch (error) {
    console.error('reader-legal-acceptance: the sign-in Terms acceptance was not written', error);
    return NOTHING;
  }
}

/** `422 LEGAL_ACCEPTANCE_NOT_PENDING` for a box this account has no reason to tick now. */
function termsNotPending(version: string): ApiError {
  return new ApiError(
    422,
    ApiErrorCode.LEGAL_ACCEPTANCE_NOT_PENDING,
    `Version ${version} of the Terms of Service is not waiting for your acceptance. Reload the page.`,
    { field: 'version', details: { document: DOC, version } },
  );
}

export interface TermsBoxAcceptanceInput {
  profileId: string;
  email: string | null | undefined;
  headers: Headers | null | undefined;
  now: Date;
  /** The version the page showed. */
  version: string;
  maps?: LegalInForceMaps;
}

/** What {@link writeTermsBoxAcceptance} did. */
export interface TermsBoxAcceptanceResult {
  /** The audit entry to forward, or `null` when this box was already ticked. */
  entry: AuditLogEntry | null;
  acceptedAt: string;
}

/**
 * The reader ticked the box (`POST /api/auth/terms/accept`). The pending check runs afresh:
 * `version` must be the one {@link termsBoxPendingVersion} names now. A box already ticked
 * for it answers with that acceptance and writes nothing. Anything else is
 * `422 LEGAL_ACCEPTANCE_NOT_PENDING`, nothing written: a stale page, a forged body, or no
 * rights-reducing version in force. One `terms_acceptances` row and its audit row in one
 * `db.batch`. A racing second tick trips the unique index and fails its batch whole, then
 * answers with the winner's acceptance.
 */
export async function writeTermsBoxAcceptance(
  db: Db,
  input: TermsBoxAcceptanceInput,
): Promise<TermsBoxAcceptanceResult> {
  const maps = input.maps ?? LEGAL_IN_FORCE_MAPS;
  const nowMs = input.now.getTime();
  if (!readerTermsMayBeInForce(nowMs, maps)) throw termsNotPending(input.version);

  const state = await loadReaderTermsState(db, input.profileId);
  if (Number.isNaN(state.profileCreatedAtMs)) throw termsNotPending(input.version);
  const pending = termsBoxPendingVersion(
    state.published,
    state.accepted,
    state.profileCreatedAtMs,
    nowMs,
    maps,
  );
  if (pending !== input.version) {
    const already = await ticked(db, input.profileId, input.version);
    if (already) return { entry: null, acceptedAt: already };
    throw termsNotPending(input.version);
  }

  try {
    const entry = await insertAcceptance(db, {
      profileId: input.profileId,
      email: input.email,
      headers: input.headers,
      now: input.now,
      version: pending,
      row: state.published.find((r) => r.version === pending) ?? null,
      label: TERMS_CHANGE_BOX_LABEL,
      defaultUnticked: true,
      source: TERMS_BOX_ACCEPTANCE_SOURCE,
    });
    return { entry, acceptedAt: input.now.toISOString() };
  } catch (error) {
    // A second tab's tick won the unique index: that acceptance stands, so answer with it.
    const already = await ticked(db, input.profileId, pending);
    if (already) return { entry: null, acceptedAt: already };
    throw error;
  }
}

/** The `accepted_at` of this account's tick-box row for `version`, or `null`. */
async function ticked(db: Db, profileId: string, version: string): Promise<string | null> {
  const rows = await db
    .select({
      acceptedAt: termsAcceptances.acceptedAt,
      unticked: termsAcceptances.checkboxDefaultUnticked,
    })
    .from(termsAcceptances)
    .where(
      and(
        eq(termsAcceptances.profileId, profileId),
        eq(termsAcceptances.document, DOC),
        eq(termsAcceptances.version, version),
      ),
    );
  return rows[0]?.unticked ? rows[0].acceptedAt : null;
}

/**
 * What `/auth/terms` shows (`GET /api/auth/terms/pending`, counsel Q3 and Q63): the version
 * waiting for this account's tick, its effective moment, the published summary of its
 * changes and the version that applies to the account until then (its latest acceptance by
 * effective moment). `null` when no box waits, so the page goes on. A read: no write, no
 * audit row. While no Terms version can be in force (today) it reads nothing.
 */
export async function readTermsBoxPending(
  db: Db,
  profileId: string,
  now: Date,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): Promise<TermsPending | null> {
  const nowMs = now.getTime();
  if (!readerTermsMayBeInForce(nowMs, maps)) return null;
  const state = await loadReaderTermsState(db, profileId);
  if (Number.isNaN(state.profileCreatedAtMs)) return null;
  const version = termsBoxPendingVersion(
    state.published,
    state.accepted,
    state.profileCreatedAtMs,
    nowMs,
    maps,
  );
  if (version === null) return null;
  const at = readerTermsEffectiveAtMs(version, state.published, maps);
  const row = state.published.find((r) => r.version === version);
  const summaryRows = row
    ? await db
        .select({ summaryJson: legalVersions.summaryJson })
        .from(legalVersions)
        .where(eq(legalVersions.id, row.id))
    : [];
  let previous: { version: string; at: number } | null = null;
  for (const a of state.accepted) {
    const aAt = readerTermsEffectiveAtMs(a.version, state.published, maps);
    if (aAt === null || (previous && aAt <= previous.at)) continue;
    previous = { version: a.version, at: aAt };
  }
  return {
    version,
    effective_at: new Date(at ?? nowMs).toISOString(),
    summary: summaryRows[0] ? summaryOf(summaryRows[0]) : [],
    previous_version: previous?.version ?? null,
  };
}
