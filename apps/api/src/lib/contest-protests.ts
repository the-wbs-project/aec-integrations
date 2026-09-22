/**
 * Protests to AECi on a declined integration contest (AECI-1009 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12). The rules the vendor and admin
 * protest handlers, the two contest lists and the contest submit share.
 *
 * Four things live here so no handler re-derives them:
 *
 *   1. **Eligibility.** {@link assertProtestable} and {@link submitterProtestFields} combine the shared window rule
 *      (`contestProtestWindow` in `@aeci/shared`, which the portal also runs) with
 *      the two live-state checks: the vendor that decided still holds the claimed
 *      row, and the field still holds the value the contest was about.
 *   2. **The wire mapping** of the protest columns ({@link toContestProtest}) and the
 *      submitter-side window and cooldown fields ({@link submitterProtestFields}).
 *   3. **The two contest-submit refusals** a protest adds: an open protest on the
 *      field, and a lost protest's 90-day cooldown ({@link protestSubmitRefusal}).
 *   4. **The race runner** ({@link runGuardedProtestBatch}). The contest runner
 *      tells its aborts apart by re-reading `status === 'open'`, which is wrong for a
 *      protest: the row is `declined`. This one re-reads and asks the handler.
 *
 * AECi's ruling is advice. Nothing here writes `integrations`, and nothing here
 * is public: no public read selects a `protest_*` column.
 */

import {
  addContestDays,
  ApiErrorCode,
  CONTEST_PROTEST_COOLDOWN_DAYS,
  contestProtestPhase,
  contestProtestWindow,
  type ContestProtest,
  type ContestProtestBasis,
  type IntegrationContestField,
} from '@aeci/shared';
import { and, eq, gt } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrationFieldChallenges } from '../db/schema';
import { ApiError } from '../errors';
import type { BatchStmt, BatchTuple } from './audit';
import { isClaimed } from './integration-claims';
import {
  isContestRaceError,
  storedFieldValue,
  type ContestIntegrationContext,
  type ContestRow,
} from './integration-contests';

/** `audit_log.action` values a protest writes. `lapsed` is the contest's own
 *  `open → declined` on a silence basis, kept apart from `declined` so the log
 *  never shows the submitter's seat as the one that declined. */
export const PROTEST_ACTIONS = {
  lapsed: 'integration.contest.lapsed',
  protested: 'integration.contest.protested',
  replied: 'integration.contest.protest_replied',
  withdrawn: 'integration.contest.protest_withdrawn',
  upheld: 'integration.contest.protest_upheld',
  rejected: 'integration.contest.protest_rejected',
} as const;

// ─── Evidence ────────────────────────────────────────────────────────────────

/** Order-preserving dedupe of the evidence links a body carried. */
export function dedupeEvidence(urls: readonly string[]): string[] {
  return [...new Set(urls)];
}

/** A stored evidence column → the wire array. A malformed value reads as `[]`, so
 *  one bad row cannot fail a list. */
export function parseEvidence(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

// ─── Wire mapping ────────────────────────────────────────────────────────────

/** The protest on a row, or `null` when there is none. No profile id is mapped. */
export function toContestProtest(row: ContestRow): ContestProtest | null {
  if (!row.protestStatus || !row.protestBasis || !row.protestedAt) return null;
  return {
    status: row.protestStatus as ContestProtest['status'],
    basis: row.protestBasis as ContestProtestBasis,
    reason: row.protestReason ?? '',
    evidence_urls: parseEvidence(row.protestEvidence),
    protested_at: row.protestedAt,
    reply_due_at: row.protestReplyDueAt ?? row.protestedAt,
    reply: row.protestReply,
    reply_evidence_urls: parseEvidence(row.protestReplyEvidence),
    replied_at: row.protestRepliedAt,
    decision_note: row.protestDecisionNote,
    decided_at: row.protestDecidedAt,
  };
}

/** The shared window rule, fed from a row. */
export function windowFor(row: ContestRow) {
  return contestProtestWindow({
    routed_to: row.routedTo,
    owner_vendor_id: row.ownerVendorId,
    status: row.status,
    protest_status: row.protestStatus,
    created_at: row.createdAt,
    decided_at: row.decidedAt,
  });
}

/** Does the vendor that decided (the snapshot owner) still hold the claimed row? */
export function ownerStillHolds(
  row: Pick<ContestRow, 'ownerVendorId'>,
  integration: Pick<ContestIntegrationContext, 'claimedAt' | 'builtByVendorId'>,
): boolean {
  return (
    row.ownerVendorId !== null &&
    isClaimed(integration) &&
    integration.builtByVendorId === row.ownerVendorId
  );
}

/** Does the field still hold the value the contest was about? `null` equals `null`. */
export function valueUnchanged(
  row: Pick<ContestRow, 'field' | 'currentValue'>,
  integration: Parameters<typeof storedFieldValue>[0],
): boolean {
  return storedFieldValue(integration, row.field as IntegrationContestField) === row.currentValue;
}

/**
 * The submitter-side fields of a contest on the vendor list (§11b.12.9):
 * the protest window while the row can still be protested (it may open in the
 * future), and the cooldown end while a lost protest still blocks a new contest.
 */
export function submitterProtestFields(
  row: ContestRow,
  integration: ContestIntegrationContext,
  now: string,
): {
  protest_opens_at: string | null;
  protest_closes_at: string | null;
  protest_basis: ContestProtestBasis | null;
  cooldown_until: string | null;
} {
  const window = windowFor(row);
  const live =
    window !== null &&
    contestProtestPhase(window, now) !== 'closed' &&
    ownerStillHolds(row, integration) &&
    valueUnchanged(row, integration);
  return {
    protest_opens_at: live ? window.opens_at : null,
    protest_closes_at: live ? window.closes_at : null,
    protest_basis: live ? window.basis : null,
    cooldown_until: cooldownUntil(row, integration, now),
  };
}

/** When this row's lost protest stops blocking a new contest on its field, or
 *  `null` when it does not block one. */
export function cooldownUntil(
  row: ContestRow,
  integration: Parameters<typeof storedFieldValue>[0],
  now: string,
): string | null {
  if (row.protestStatus !== 'rejected' || !row.protestDecidedAt) return null;
  const until = addContestDays(row.protestDecidedAt, CONTEST_PROTEST_COOLDOWN_DAYS);
  if (Date.parse(now) >= Date.parse(until)) return null;
  // "Unless the value on record changes" (ruled): any owner edit lifts it.
  return valueUnchanged(row, integration) ? until : null;
}

// ─── Eligibility at filing ───────────────────────────────────────────────────

export type ProtestUnavailableReason =
  | 'aeci_routed'
  | 'owner_unknown'
  | 'already_protested'
  | 'not_declined'
  | 'owner_not_silent_yet'
  | 'window_closed'
  | 'contest_changed';

export function protestNotAvailable(
  reason: ProtestUnavailableReason,
  extra: Record<string, unknown> = {},
): ApiError {
  const messages: Record<ProtestUnavailableReason, string> = {
    aeci_routed: 'AEC Integrations decides this contest, so there is no owner decision to protest.',
    owner_unknown: 'This contest has no owner decision to protest.',
    already_protested: 'This contest already has a protest.',
    not_declined: 'Only a declined contest, or one the owner has not answered, can be protested.',
    owner_not_silent_yet:
      'The owner has 30 days to answer before an unanswered contest can be protested.',
    window_closed: 'The 30 days to protest this contest have passed.',
    contest_changed:
      'The contest changed while you were writing, for example the owner answered it. Reload and look again.',
  };
  return new ApiError(409, ApiErrorCode.PROTEST_NOT_AVAILABLE, messages[reason], {
    details: { reason, ...extra },
  });
}

/**
 * The window checks of §11b.12.2, in the order the file route reports them.
 * Returns the basis and the silence-decline date, or throws
 * `409 PROTEST_NOT_AVAILABLE`.
 */
export function assertProtestable(
  row: ContestRow,
  now: string,
): { basis: ContestProtestBasis; opensAt: string; closesAt: string } {
  if (row.routedTo !== 'owner') throw protestNotAvailable('aeci_routed');
  if (row.ownerVendorId === null) throw protestNotAvailable('owner_unknown');
  if (row.protestStatus !== null) throw protestNotAvailable('already_protested');
  const window = windowFor(row);
  if (!window) throw protestNotAvailable('not_declined');
  const phase = contestProtestPhase(window, now);
  if (phase === 'not_yet') {
    throw protestNotAvailable('owner_not_silent_yet', { opens_at: window.opens_at });
  }
  if (phase === 'closed') throw protestNotAvailable('window_closed');
  return { basis: window.basis, opensAt: window.opens_at, closesAt: window.closes_at };
}

// ─── The two contest-submit refusals ─────────────────────────────────────────

/**
 * `409 CONTEST_PROTEST_OPEN`, then `409 CONTEST_COOLDOWN`, for a NEW contest on
 * (integration, field, vendor), or `null` when neither applies (§11b.12.8).
 *
 * `liveValue` is the field's value now, in storage form. Handler reads only: a
 * protest and a new contest filed at the same instant can both land once, which is
 * harmless because neither writes anything public.
 */
export async function protestSubmitRefusal(
  db: Db,
  args: {
    integrationId: string;
    field: IntegrationContestField;
    vendorId: string;
    liveValue: string | null;
    now: string;
  },
): Promise<ApiError | null> {
  const scope = and(
    eq(integrationFieldChallenges.integrationId, args.integrationId),
    eq(integrationFieldChallenges.field, args.field),
    eq(integrationFieldChallenges.submitterVendorId, args.vendorId),
  );
  const open = await db.query.integrationFieldChallenges.findFirst({
    columns: { id: true },
    where: and(scope, eq(integrationFieldChallenges.protestStatus, 'open')),
  });
  if (open) {
    return new ApiError(
      409,
      ApiErrorCode.CONTEST_PROTEST_OPEN,
      'You already asked AEC Integrations to review a contest on this field. Wait for its answer, or withdraw that request first.',
      { details: { contest_id: open.id } },
    );
  }
  const since = addContestDays(args.now, -CONTEST_PROTEST_COOLDOWN_DAYS);
  const lost = await db.query.integrationFieldChallenges.findMany({
    columns: { protestDecidedAt: true, currentValue: true },
    where: and(
      scope,
      eq(integrationFieldChallenges.protestStatus, 'rejected'),
      gt(integrationFieldChallenges.protestDecidedAt, since),
    ),
  });
  const blocking = lost
    .filter((r) => r.protestDecidedAt !== null && r.currentValue === args.liveValue)
    .map((r) => addContestDays(r.protestDecidedAt as string, CONTEST_PROTEST_COOLDOWN_DAYS))
    .filter((until) => Date.parse(args.now) < Date.parse(until))
    .sort();
  const until = blocking.at(-1);
  if (!until) return null;
  return new ApiError(
    409,
    ApiErrorCode.CONTEST_COOLDOWN,
    'AEC Integrations agreed with the owner on this field, so it cannot be contested again yet unless its value changes.',
    { details: { until } },
  );
}

// ─── The race runner ─────────────────────────────────────────────────────────

/**
 * Run a protest batch whose guarded `UPDATE` is followed immediately by the
 * `changes() = 0` sentinel (`contestStillOpenSentinel`, generic despite its name),
 * then any integration-state sentinels. Any `json()` abort rolls the whole batch
 * back. `classify` re-reads and returns the error to answer; anything that is not
 * an abort rethrows. Returns the committed row.
 */
export async function runGuardedProtestBatch(
  db: Db,
  id: string,
  stmts: BatchStmt[],
  classify: () => Promise<ApiError>,
): Promise<ContestRow> {
  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    if (!isContestRaceError(error)) throw error;
    throw await classify();
  }
  const row = await db.query.integrationFieldChallenges.findFirst({
    where: eq(integrationFieldChallenges.id, id),
  });
  if (!row) throw new ApiError(404, ApiErrorCode.NOT_FOUND, 'contest not found');
  return row;
}

export function protestNotOpen(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.PROTEST_NOT_OPEN,
    'This protest is already decided or withdrawn.',
  );
}
