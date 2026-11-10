/**
 * Removing the IP address and browser from agreement acceptances 90 days after
 * acceptance (AECI-1636, ruling 11, counsel Q27b; `DATABASE_SCHEMA.md` §8.6d).
 *
 * The Privacy Policy "Retention" and Vendor Terms "Accepting these terms" promise it:
 * "The IP address and browser ... are deleted 90 days after acceptance." Email, time and
 * version stay, because they prove the acceptance. The row itself is never deleted
 * (`NEVER_PRUNED` in `./retention-prune`).
 *
 * The daily job, in order:
 *
 *  1. Read up to {@link EVIDENCE_REMOVAL_CHUNK} ids accepted before the cutoff that
 *     still hold an `ip` or a `user_agent`, oldest first.
 *  2. One `db.batch`: a guarded UPDATE that nulls both and stamps `evidence_removed_at`,
 *     and one `agreement.evidence_removed` audit row listing the ids. The UPDATE
 *     re-tests the cutoff and the not-null guard, so a replayed queue message changes
 *     nothing.
 *  3. Repeat up to {@link EVIDENCE_REMOVAL_MAX_CHUNKS} times. Any rest waits a day.
 *
 * The sweep ignores `source`. Claim rows and portal grant rows carry both values.
 * Checkout and signed-deal rows never do, so the guard skips them and they keep a NULL
 * `evidence_removed_at`: the admin view reads that as "Not recorded".
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, inArray, isNotNull, lt, or } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances } from '../db/schema';
import { AGREEMENT_ACCEPTANCE_ENTITY_TYPE } from './agreement-acceptances';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';

/** How long the IP address and browser are kept after `accepted_at`. */
export const ACCEPTANCE_EVIDENCE_DAYS = 90;
/** Ids per batch. D1 caps bound parameters per query at 100. */
export const EVIDENCE_REMOVAL_CHUNK = 80;
/** Batches per run. 800 rows a day is far above the claim rate. */
export const EVIDENCE_REMOVAL_MAX_CHUNKS = 10;

/** `audit_log.action`. Not a vendor receipt: the row names no vendor. */
export const AGREEMENT_EVIDENCE_REMOVED_ACTION = 'agreement.evidence_removed';
export const ACCEPTANCE_EVIDENCE_REMOVAL_SOURCE = 'acceptance-evidence-removal';
export const ACCEPTANCE_EVIDENCE_REMOVAL_RUN_METRIC = 'aeci.agreement.evidence_removal.run';

const DAY_MS = 86_400_000;

/** The ISO instant before which an acceptance's IP and browser are removed. */
export function acceptanceEvidenceCutoff(now: Date): string {
  return new Date(now.getTime() - ACCEPTANCE_EVIDENCE_DAYS * DAY_MS).toISOString();
}

export interface AcceptanceEvidenceRemovalResult {
  /** Rows whose IP and browser were removed this run. */
  removed: number;
  /** Batches committed, one audit row each. */
  batches: number;
  /** True when rows were still due after the last batch. The next run continues. */
  truncated: boolean;
  cutoff: string;
  /** One per batch, in commit order, for the post-commit forward. */
  auditEntries: AuditLogEntry[];
}

/**
 * Null `ip` and `user_agent` on every acceptance older than 90 days. Throws only on a
 * D1 error. A failed batch rolls back whole, so its rows stay due.
 */
export async function runAcceptanceEvidenceRemoval(
  db: Db,
  deps: { now?: Date } = {},
): Promise<AcceptanceEvidenceRemovalResult> {
  const now = deps.now ?? new Date();
  const cutoff = acceptanceEvidenceCutoff(now);
  const removedAt = now.toISOString();
  // `accepted_at` is always written by `toISOString()`, so ISO TEXT compares lexically.
  // The boundary: an acceptance exactly 90 days old is kept until the next run.
  const due = and(
    lt(agreementAcceptances.acceptedAt, cutoff),
    or(isNotNull(agreementAcceptances.ip), isNotNull(agreementAcceptances.userAgent)),
  );

  const auditEntries: AuditLogEntry[] = [];
  let removed = 0;
  let truncated = false;

  for (let chunk = 0; chunk < EVIDENCE_REMOVAL_MAX_CHUNKS; chunk++) {
    const rows = await db
      .select({ id: agreementAcceptances.id })
      .from(agreementAcceptances)
      .where(due)
      .orderBy(asc(agreementAcceptances.acceptedAt), asc(agreementAcceptances.id))
      .limit(EVIDENCE_REMOVAL_CHUNK);
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    const auditEntry: AuditLogEntry = {
      actorId: null,
      actorType: 'system',
      action: AGREEMENT_EVIDENCE_REMOVED_ACTION,
      entityType: AGREEMENT_ACCEPTANCE_ENTITY_TYPE,
      // Ids only. No email, IP or user agent: this row is forwarded to PostHog.
      metadata: {
        source: ACCEPTANCE_EVIDENCE_REMOVAL_SOURCE,
        cutoff,
        count: ids.length,
        acceptance_ids: ids,
      },
    };
    const stmts: BatchStmt[] = [
      db
        .update(agreementAcceptances)
        .set({ ip: null, userAgent: null, evidenceRemovedAt: removedAt })
        .where(and(inArray(agreementAcceptances.id, ids), due)),
      auditInsert(db, auditEntry),
    ];
    await db.batch(stmts as BatchTuple);
    auditEntries.push(auditEntry);
    removed += ids.length;

    if (rows.length < EVIDENCE_REMOVAL_CHUNK) break;
    if (chunk === EVIDENCE_REMOVAL_MAX_CHUNKS - 1) {
      const more = await db
        .select({ id: agreementAcceptances.id })
        .from(agreementAcceptances)
        .where(due)
        .limit(1);
      truncated = more.length > 0;
    }
  }

  return { removed, batches: auditEntries.length, truncated, cutoff, auditEntries };
}
