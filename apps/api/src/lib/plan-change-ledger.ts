/**
 * The plan-change ranking-evidence ledger (AECI-1621, ADR 0056; `DATABASE_SCHEMA.md`
 * §9.16; `SEARCH_RANKING.md` "Substantiation and retention").
 *
 * The Terms promise that a plan never influences ranking. Counsel's Q23 answer asks us to
 * hold records made at the time that show it. So every plan start or end on a product
 * schedules two snapshots of that product's ranking inputs and positions: one at the
 * event, and one 30 days later, which shows a cancellation caused no later demotion.
 *
 * This module is the WRITE half, and it is pure. `assemble()` in `lib/license.ts`, the
 * one choke point for every license write, calls {@link planChangeMoves} and
 * {@link planChangeSnapshotInserts} and puts the rows in the same `db.batch` as the
 * license change. The READ half, which builds and stores the snapshot, is
 * `lib/plan-change-evidence.ts` and `lib/plan-snapshot-sweep.ts`.
 *
 * Log-class under ADR 0022: the license write's own `audit_log` row records the event.
 *
 * The module name avoids `rank`, `listing`, `sort` and `search` on purpose. Those names
 * are firewalled by `ranking-firewall.spec.ts`, which forbids plan columns in them. This
 * module reads plan state by design, so it must live outside the firewall.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';

import type { Db } from '../db/client';
import { planChangeSnapshots } from '../db/schema';
import type { BatchStmt } from './audit';

/** How long after the event the follow-up snapshot is due (ruled 2026-11-16). */
export const PLAN_SNAPSHOT_FOLLOWUP_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows per INSERT. At most 12 bound columns a row, and D1 caps a statement at 100
 *  parameters. */
const ROWS_PER_INSERT = 8;

/** The license columns the diff reads. `LicenseBefore` satisfies it. */
export interface PlanChangeLicense {
  id: string;
  endedAt: string | null;
  assignedProductId: string | null;
}

export interface PlanChangeMove {
  productId: string;
  kind: 'start' | 'end';
  licenseId: string;
  /** The audit action of the write that moved the license, e.g. `license.lapsed`. */
  cause: string;
}

/** The cause recorded when no audit entry names the license. Not expected. */
const UNKNOWN_CAUSE = 'license.unknown';

/** Product id → its live license, over one license set. A product holds at most one
 *  live license (`licenses_live_product_idx`). */
function liveByProduct(set: readonly PlanChangeLicense[]): Map<string, PlanChangeLicense> {
  const out = new Map<string, PlanChangeLicense>();
  for (const l of set) {
    if (l.endedAt === null && l.assignedProductId !== null) out.set(l.assignedProductId, l);
  }
  return out;
}

/**
 * The products whose plan state a batch changes, from the vendor's FULL license set
 * before and after it. A product that loses one live license and gains another in the
 * same batch (a term-end carry-over) did not change plan, so it has no move.
 *
 * `entries` are the batch's audit entries, used only to name each move's cause.
 */
export function planChangeMoves(
  before: readonly PlanChangeLicense[],
  after: readonly PlanChangeLicense[],
  entries: readonly AuditLogEntry[],
): PlanChangeMove[] {
  const cause = new Map<string, string>();
  for (const entry of entries) {
    const id = (entry.metadata as Record<string, unknown> | undefined)?.license_id;
    if (typeof id === 'string') cause.set(id, entry.action);
  }
  const was = liveByProduct(before);
  const is = liveByProduct(after);
  const moves: PlanChangeMove[] = [];
  for (const [productId, license] of was) {
    if (is.has(productId)) continue;
    moves.push({
      productId,
      kind: 'end',
      licenseId: license.id,
      cause: cause.get(license.id) ?? UNKNOWN_CAUSE,
    });
  }
  for (const [productId, license] of is) {
    if (was.has(productId)) continue;
    moves.push({
      productId,
      kind: 'start',
      licenseId: license.id,
      cause: cause.get(license.id) ?? UNKNOWN_CAUSE,
    });
  }
  return moves;
}

/** `event_at` + {@link PLAN_SNAPSHOT_FOLLOWUP_DAYS}, in the stored ISO spelling. */
export function followupDueAt(eventAt: string): string {
  return new Date(Date.parse(eventAt) + PLAN_SNAPSHOT_FOLLOWUP_DAYS * DAY_MS).toISOString();
}

/**
 * Two ledger rows per move, an `event` row due now and a `followup` row due 30 days
 * later, chunked under D1's parameter cap. No moves, no statements.
 */
export function planChangeSnapshotInserts(
  db: Db,
  moves: readonly PlanChangeMove[],
  now: string,
): BatchStmt[] {
  const rows = moves.flatMap((m) => {
    const base = {
      productId: m.productId,
      kind: m.kind,
      licenseId: m.licenseId,
      cause: m.cause,
      eventAt: now,
    };
    return [
      { ...base, id: crypto.randomUUID(), phase: 'event' as const, dueAt: now },
      { ...base, id: crypto.randomUUID(), phase: 'followup' as const, dueAt: followupDueAt(now) },
    ];
  });
  const stmts: BatchStmt[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    stmts.push(db.insert(planChangeSnapshots).values(rows.slice(i, i + ROWS_PER_INSERT)));
  }
  return stmts;
}
