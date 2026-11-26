/**
 * Re-creating a workflow instance the legal retention prune deleted (AECI-1913).
 *
 * The prune deletes a `workflow_instances` row four years after its last action
 * (`./legal-retention-prune`, `STAGE_1_SPEC.md` §26.6). The FK cascade removes its
 * transitions and sets the contest links (`integration_field_challenges.workflow_id`,
 * `.protest_workflow_id`) to NULL. A later action on the same request or contest must
 * still land in the workflow history, so its writer re-creates the instance in the same
 * batch as the transition it records.
 *
 * **The id is deterministic** ({@link restoredWorkflowId}), never a fresh UUID. Two
 * concurrent writers that both saw no instance then insert the same primary key, the
 * second batch fails whole, and its caller retries against the restored row. A random id
 * would let both commit, leaving two instances for one entity that later `findFirst`
 * lookups would split between. The id is free again once the prune deletes the restored
 * row, so a second restore four years later reuses it.
 */

import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrationFieldChallenges, workflowInstances } from '../db/schema';
import type { BatchStmt } from './audit';

/** What a restored instance stands for: a vendor request, a field contest, or a protest
 *  (a contest's second `correction_request` instance). */
export type RestoredWorkflowKind = 'request' | 'contest' | 'protest';

/** The deterministic id of a restored instance. Text, like every `uuidPk` value: nothing
 *  parses a workflow id as a UUID. */
export function restoredWorkflowId(kind: RestoredWorkflowKind, entityId: string): string {
  return `restored-${kind}-${entityId}`;
}

/**
 * The instance id a contest action writes its transition under, and the statements that
 * make it exist. With a live link, one UPDATE of `state` (or none when `state` is
 * omitted). With the link gone, an INSERT of the restored instance and the relink of the
 * contest's column, both before any transition that names it (the transition's FK target).
 */
export function contestWorkflowStmts(
  db: Db,
  contest: { id: string; workflowId?: string | null; protestWorkflowId?: string | null },
  which: 'contest' | 'protest',
  now: string,
  state?: { currentState: string; completedAt?: string; finalOutcome?: string },
): { workflowId: string; stmts: BatchStmt[] } {
  const linked = which === 'contest' ? contest.workflowId : contest.protestWorkflowId;
  if (linked) {
    return {
      workflowId: linked,
      stmts: state
        ? [db.update(workflowInstances).set(state).where(eq(workflowInstances.id, linked))]
        : [],
    };
  }
  const workflowId = restoredWorkflowId(which, contest.id);
  const column =
    which === 'contest'
      ? integrationFieldChallenges.workflowId
      : integrationFieldChallenges.protestWorkflowId;
  return {
    workflowId,
    stmts: [
      db.insert(workflowInstances).values({
        id: workflowId,
        workflowType: 'correction_request',
        entityId: contest.id,
        initiatedAt: now,
        currentState: 'open',
        ...state,
      }),
      db
        .update(integrationFieldChallenges)
        .set(which === 'contest' ? { workflowId } : { protestWorkflowId: workflowId })
        .where(and(eq(integrationFieldChallenges.id, contest.id), isNull(column))),
    ],
  };
}
