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
import { sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

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
    // AECI-1192 / AECI-1193 (`DATABASE_SCHEMA.md` §8.4).
    vendorId: entry.vendorId ?? null,
    productId: entry.productId ?? null,
    vendorTier: entry.vendorPlan?.tier ?? null,
    vendorEntitlementStatus: entry.vendorPlan?.status ?? null,
  });
}

/**
 * {@link auditInsert}, but the row lands only when `where` matches a row of `from`
 * at commit time (AECI-1333). An `INSERT … SELECT … FROM <from> WHERE <where>`, so
 * a batch can audit a guarded UPDATE that may match nothing, without aborting the
 * rest of the batch the way a `json()` sentinel would. Use it when one batch holds
 * many independent guarded writes (a cron sweep), so one lost row costs one row.
 *
 * Every value is bound as a parameter. `created_at` is set here, because a
 * `$defaultFn` does not run on an INSERT … SELECT. The caller must re-read which
 * rows its guard matched before it forwards the entries post-commit. `where` must
 * match at most one row: the entry has one `id`, so a second match trips the PK.
 */
export function auditInsertWhere(
  db: Db,
  entry: AuditLogEntry,
  guard: { from: SQLiteTable; where: SQL | undefined },
): BatchStmt {
  entry.id ??= crypto.randomUUID();
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  const val = (v: string | null) => sql`${v}`;
  return db.insert(auditLog).select(
    db
      .select({
        id: val(entry.id).as('id'),
        actorId: val(entry.actorId ?? null).as('actor_id'),
        actorType: val(entry.actorType).as('actor_type'),
        action: val(entry.action).as('action'),
        entityType: val(entry.entityType ?? null).as('entity_type'),
        entityId: val(entry.entityId ?? null).as('entity_id'),
        beforeState: val(json(entry.beforeState)).as('before_state'),
        afterState: val(json(entry.afterState)).as('after_state'),
        metadata: val(json(entry.metadata)).as('metadata'),
        vendorId: val(entry.vendorId ?? null).as('vendor_id'),
        productId: val(entry.productId ?? null).as('product_id'),
        vendorTier: val(entry.vendorPlan?.tier ?? null).as('vendor_tier'),
        vendorEntitlementStatus: val(entry.vendorPlan?.status ?? null).as(
          'vendor_entitlement_status',
        ),
        createdAt: val(new Date().toISOString()).as('created_at'),
      })
      .from(guard.from)
      .where(guard.where),
  );
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
