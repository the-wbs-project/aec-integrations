/**
 * Contests ride with their edge through a promote cross-table move (AECI-1110).
 *
 * Promote moves an edge between `integrations` and `connector_evidenced_pairs` when its
 * routing key changes (AECI-721 / AECI-888, `REVIEW_APP_PROMOTE_API.md` §3.4a). The move
 * inserts the destination under the preserved id, re-homes the claims, then DELETEs the
 * source row. `integration_field_challenges` is an `ON DELETE CASCADE` child of both
 * tables (AECI-1092, migration 0050), so before this module the DELETE took every
 * contest on the edge with it, open or closed, protest history included.
 *
 * The rule now, in the move's own batch, between the claim re-home and the DELETE:
 *
 *   1. **Every contest on the source row is re-anchored onto the destination row**,
 *      whatever its status. The id is preserved across the move, so the contest's wire
 *      `integration_id` does not change; only `anchor` does. Closed contests keep their
 *      decision, their protest columns and their workflow, so no history is lost.
 *   2. **A `direction` contest's two values are re-framed** (`a_to_b` ↔ `b_to_a`) when the
 *      move crosses frames, by the same rule the claims use (AECI-996): the pair's A is
 *      the lower id, an `integrations` row's frame is source → target, and they differ
 *      exactly when the payload's source sorts second.
 *   3. **An OPEN `mechanism_kind` contest is closed as `withdrawn` on a move INTO
 *      `connector_evidenced_pairs`.** That table has no `mechanism_kind` column
 *      (`EVIDENCED_PAIR_CONTEST_FIELDS`), and the move is itself upstream's answer to
 *      "which mechanism": the edge is connector-delivered. It is then re-anchored like
 *      every other row, so its history survives. A closed one is simply re-anchored.
 *   4. **Each write carries its audit row in the same batch** (`integration.contest.reanchored`,
 *      plus `integration.contest.withdrawn` and the workflow closure for rule 3), and
 *      `updated_at` moves, so both vendors' `contests` cursors see the change.
 *
 * Only an unclaimed, AECi-seeded row can move: the AECI-1005 / AECI-1088 fence refuses the
 * move on a vendor-held row before any of this is planned.
 *
 * **Race.** The contests are read at plan time. A contest filed, withdrawn or decided
 * between that read and the batch must not be lost to the cascade or re-anchored without
 * an audit row. Each guarded UPDATE is followed by a `changes() = 0` sentinel, and a last
 * sentinel just before the source DELETE aborts the batch if any contest still sits on
 * the source. Nothing is written, and the job errors with
 * `CONTEST_CHANGED_DURING_PROMOTE` (409). Re-pushing plans against the new state.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrationFieldChallenges, workflowInstances } from '../db/schema';
import { workflowTransitionInsert, type BatchStmt } from '../lib/audit';
import { ONE_ROW } from '../lib/integration-claims';
import {
  anchorColumns,
  anchorColumnSql,
  contestAnchorWhere,
  CONTEST_ENTITY_TYPE,
  type ContestAnchor,
  type ContestRow,
} from '../lib/integration-contests';

/** The audit action for a contest moved from one anchor table to the other. */
export const CONTEST_REANCHORED_ACTION = 'integration.contest.reanchored';

/** `metadata.reason` on a contest a move closes, and on its workflow transition. */
export const MOVED_TO_CONNECTOR_TIER_REASON = 'edge-moved-to-connector-tier';

/** The token every sentinel in this module raises. `json()` on a non-JSON string raises
 *  "malformed JSON", which rolls the whole batch back. */
const RACE_TOKEN = 'contest-changed-during-promote';

/** The contests on one anchor row, every status, oldest first so audit order is stable. */
export async function loadContestsOnAnchor(db: Db, anchor: ContestAnchor): Promise<ContestRow[]> {
  return db
    .select()
    .from(integrationFieldChallenges)
    .where(contestAnchorWhere(anchor))
    .orderBy(integrationFieldChallenges.createdAt, integrationFieldChallenges.id);
}

/** What a later re-read compares against to tell a contest race from the other
 *  promote sentinels, which all raise the same SQLite error. */
export interface PlannedContestMove {
  from: ContestAnchor;
  fingerprint: string;
}

function fingerprintOf(rows: readonly Pick<ContestRow, 'id' | 'status'>[]): string {
  return rows
    .map((r) => `${r.id}:${r.status}`)
    .sort()
    .join('|');
}

/**
 * True when a planned move's contests no longer match what the plan read, so the
 * rolled-back batch was the contest sentinel's doing. Called only after a batch failed.
 */
export async function anyContestMoveRaced(
  db: Db,
  planned: readonly PlannedContestMove[],
): Promise<boolean> {
  for (const move of planned) {
    const rows = await db
      .select({ id: integrationFieldChallenges.id, status: integrationFieldChallenges.status })
      .from(integrationFieldChallenges)
      .where(contestAnchorWhere(move.from));
    if (fingerprintOf(rows) !== move.fingerprint) return true;
  }
  return false;
}

/** Aborts the batch when the UPDATE just before it matched no row. */
function contestMoveRowSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${RACE_TOKEN}) END` })
    .from(ONE_ROW);
}

/**
 * Aborts the batch when any contest still sits on the source row. Placed directly
 * before the source DELETE, so a contest filed after the plan read can never be
 * cascaded away. Reads from a one-row constant (ADR 0035), so it always returns a row.
 */
function noContestLeftOnSourceSentinel(db: Db, from: ContestAnchor) {
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM "integration_field_challenges" WHERE ${anchorColumnSql(from.kind)} = ${from.id}) THEN json(${RACE_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/**
 * The workflow closure for a contest this move withdraws: the instance moves to
 * `withdrawn` / `cancelled` and an `open → withdrawn` transition is written, exactly as
 * `closeWorkflow` in `routes/vendor-contests.ts` does for a withdraw. Written here rather
 * than imported, because `vendor-contests.ts` reaches `promote.ts` through
 * `integration-retire-write.ts`, and importing it would close an import cycle. The
 * `correction_request` type and the `cancelled` outcome must stay in step with it.
 */
function withdrawWorkflowStatements(
  db: Db,
  contest: ContestRow,
  entry: { reason: string; metadata: Record<string, unknown> },
  now: string,
): BatchStmt[] {
  const workflowId = contest.workflowId ?? crypto.randomUUID();
  const instance = contest.workflowId
    ? db
        .update(workflowInstances)
        .set({ currentState: 'withdrawn', completedAt: now, finalOutcome: 'cancelled' })
        .where(eq(workflowInstances.id, workflowId))
    : db.insert(workflowInstances).values({
        id: workflowId,
        workflowType: 'correction_request',
        entityId: contest.id,
        currentState: 'withdrawn',
        completedAt: now,
        finalOutcome: 'cancelled',
      });
  return [
    instance,
    workflowTransitionInsert(db, {
      workflowId,
      fromState: 'open',
      toState: 'withdrawn',
      actorId: null,
      reason: entry.reason,
      metadata: entry.metadata,
    }),
  ];
}

/** `a_to_b` ↔ `b_to_a`. `both`, `NULL` and anything unrecognised are their own mirror. */
function flipDirection(value: string | null): string | null {
  if (value === 'a_to_b') return 'b_to_a';
  if (value === 'b_to_a') return 'a_to_b';
  return value;
}

/**
 * Plan the contest half of a cross-table move. The statements go into the move between
 * the claim re-home and the source DELETE; the destination row must already be inserted,
 * because the new anchor is a foreign key. The audit entries go into promote's collector,
 * which inserts them in the same batch.
 */
export function planContestMove(
  db: Db,
  args: {
    contests: readonly ContestRow[];
    from: ContestAnchor;
    to: ContestAnchor;
    /** The AECI-996 frame test the claims use: the payload's source sorts second. */
    frameReversed: boolean;
    now: string;
  },
): { stmts: BatchStmt[]; audits: AuditLogEntry[]; planned: PlannedContestMove } {
  const { contests, from, to, frameReversed, now } = args;
  const stmts: BatchStmt[] = [];
  const audits: AuditLogEntry[] = [];
  const actor = { actorId: null, actorType: 'system' as const };
  const fromColumn =
    from.kind === 'evidenced_pair'
      ? integrationFieldChallenges.evidencedPairId
      : integrationFieldChallenges.integrationId;

  for (const contest of contests) {
    const baseMetadata = {
      contestId: contest.id,
      field: contest.field,
      fromAnchor: from.kind,
      toAnchor: to.kind,
      anchorId: to.id,
    };

    // Rule 3: an open `mechanism_kind` contest cannot live on a pair. Close it first,
    // guarded on `open`, then re-anchor it with the rest so its history survives.
    let status = contest.status;
    if (to.kind === 'evidenced_pair' && contest.field === 'mechanism_kind' && status === 'open') {
      const metadata = { ...baseMetadata, reason: MOVED_TO_CONNECTOR_TIER_REASON };
      const workflow = withdrawWorkflowStatements(
        db,
        contest,
        { reason: MOVED_TO_CONNECTOR_TIER_REASON, metadata },
        now,
      );
      stmts.push(
        db
          .update(integrationFieldChallenges)
          .set({ status: 'withdrawn', updatedAt: now })
          .where(
            and(
              eq(integrationFieldChallenges.id, contest.id),
              eq(integrationFieldChallenges.status, 'open'),
            ),
          ),
        contestMoveRowSentinel(db),
        ...workflow,
      );
      audits.push({
        ...actor,
        action: 'integration.contest.withdrawn',
        entityType: CONTEST_ENTITY_TYPE,
        entityId: contest.id,
        beforeState: { status: 'open' },
        afterState: { status: 'withdrawn' },
        metadata,
      });
      status = 'withdrawn';
    }

    // Rules 1 and 2: move the anchor, both columns in ONE statement so
    // `integration_field_challenges_anchor_check` never sees zero or two set.
    const reframe = frameReversed && contest.field === 'direction';
    const values = reframe
      ? {
          currentValue: flipDirection(contest.currentValue),
          proposedValue: flipDirection(contest.proposedValue),
        }
      : null;
    stmts.push(
      db
        .update(integrationFieldChallenges)
        .set({ ...anchorColumns(to), ...(values ?? {}), updatedAt: now })
        .where(and(eq(integrationFieldChallenges.id, contest.id), eq(fromColumn, from.id))),
      contestMoveRowSentinel(db),
    );
    audits.push({
      ...actor,
      action: CONTEST_REANCHORED_ACTION,
      entityType: CONTEST_ENTITY_TYPE,
      entityId: contest.id,
      beforeState: {
        ...anchorColumns(from),
        status,
        ...(values
          ? { current_value: contest.currentValue, proposed_value: contest.proposedValue }
          : {}),
      },
      afterState: {
        ...anchorColumns(to),
        status,
        ...(values
          ? { current_value: values.currentValue, proposed_value: values.proposedValue }
          : {}),
      },
      metadata: { ...baseMetadata, ...(values ? { reframed: true } : {}) },
    });
  }

  stmts.push(noContestLeftOnSourceSentinel(db, from));
  // The fingerprint is what the plan read on the source. After a failed batch (which
  // rolled back, so the source still holds its contests) a re-read that differs says
  // the contest sentinels fired.
  return { stmts, audits, planned: { from, fingerprint: fingerprintOf(contests) } };
}
