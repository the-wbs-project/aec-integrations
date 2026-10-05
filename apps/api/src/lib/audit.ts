/**
 * D1 batch builders for the audit-log + workflow-transition writes (ADR 0016 /
 * AECI-249, the §26.1 "no state change without an audit row" invariant).
 *
 * D1 has no interactive transactions — only atomic `db.batch([...])`. So instead
 * of awaiting a write inside a `$transaction` (the retired Prisma path), each
 * helper RETURNS a Drizzle insert *statement* the caller pushes into its batch
 * array. The state-change write and its audit/transition row then commit or roll
 * back as a single unit. The best-effort §26.5 forward is decoupled —
 * call `forwardAuditLog` / `forwardWorkflowTransition` from `@aeci/shared` AFTER
 * the batch commits (via `ctx.waitUntil`).
 *
 * Usage:
 *   const stmts: BatchStmt[] = [
 *     db.update(reviews).set({ status: 'approved' }).where(eq(reviews.id, id)),
 *     workflowTransitionInsert(db, { workflowId, fromState: 'pending', toState: 'approved', ... }),
 *     auditInsert(db, { actorId, actorType: 'admin', action: 'review.approved', ... }),
 *   ];
 *   await db.batch(stmts as BatchTuple);
 *   ctx.waitUntil(forwardAuditLog(entry, forward));
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import type { BatchItem } from 'drizzle-orm/batch';

import type { Db } from '../db/client';
import { auditLog, workflowTransitions } from '../db/schema';

/** A single statement in a `db.batch([...])`. */
export type BatchStmt = BatchItem<'sqlite'>;

/** Non-empty tuple shape `db.batch()` expects; cast a `BatchStmt[]` to this. */
export type BatchTuple = [BatchStmt, ...BatchStmt[]];

/**
 * Build the `audit_log` insert for the caller's batch. `created_at` is filled by
 * the schema's `$defaultFn` at build time.
 *
 * `id` is minted HERE, onto the caller's entry (`entry.id ??= randomUUID()`), not
 * left to the schema default (AECI-1184). The write's post-commit consumers get
 * the entry object back, so the recrawl cause linkage can record which audit row
 * caused a queued URL without a read. A caller-supplied id is kept. The mutation
 * is the contract: one entry object is one audit row. Passing the same object into
 * two batches that BOTH commit reuses the id and trips the PK. Rebuilding a batch
 * after it rolled back (the erasure's seat-race retry in `routes/account.ts`) is
 * safe, because the first insert never landed. JSON columns
 * (`before/after_state`, `metadata`) are omitted when absent (→ SQL NULL),
 * mirroring the old `?? undefined` Prisma behaviour.
 */
export function auditInsert(db: Db, entry: AuditLogEntry): BatchStmt {
  entry.id ??= crypto.randomUUID();
  return db.insert(auditLog).values({
    id: entry.id,
    actorId: entry.actorId ?? null,
    actorType: entry.actorType,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    beforeState: entry.beforeState ?? undefined,
    afterState: entry.afterState ?? undefined,
    metadata: entry.metadata ?? undefined,
  });
}

/**
 * Build the `workflow_transitions` insert for the caller's batch. `id` +
 * `created_at` are filled by `$defaultFn`s; `metadata` is omitted when absent.
 */
export function workflowTransitionInsert(db: Db, entry: WorkflowTransitionEntry): BatchStmt {
  return db.insert(workflowTransitions).values({
    workflowId: entry.workflowId,
    fromState: entry.fromState ?? null,
    toState: entry.toState,
    actorId: entry.actorId ?? null,
    reason: entry.reason ?? null,
    metadata: entry.metadata ?? undefined,
  });
}
