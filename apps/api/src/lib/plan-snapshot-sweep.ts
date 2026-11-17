/**
 * The plan-change snapshot sweep (AECI-1621, ADR 0056; `ANALYTICS.md` §11d).
 *
 * The `plan-snapshot` cron (`11-59/15 * * * *`) enqueues one message on
 * `RECONCILE_QUEUE`, and the consumer runs {@link runPlanSnapshotSweep}. It reads the
 * due rows of `plan_change_snapshots` (`r2_key IS NULL AND due_at <= now`), builds each
 * snapshot (`lib/plan-change-evidence.ts`), writes it to the `UPLOADS` bucket under
 * `evidence/plan-snapshots/`, confirms it with `head`, and then stamps `r2_key` and
 * `written_at`. The write follows the page-view archive (`lib/page-views-archive.ts`):
 * JSON body, `put` with `sha256` and `customMetadata`, `head` to verify, then D1.
 *
 * ── THE BUCKET LOCK ────────────────────────────────────────────────────────────
 * `evidence/` sits under a 4-year R2 bucket lock, which refuses an overwrite. So the
 * sweep `head`s the key FIRST. An object already there was written by an earlier run
 * whose D1 stamp failed, and the sweep ADOPTS it: it stamps the row from the stored
 * object and writes nothing. A retry therefore never needs to overwrite.
 *
 * ── FAILURE ────────────────────────────────────────────────────────────────────
 * A row that fails gets `attempts + 1` and `last_error`, and the sweep moves on. The
 * next run retries it. Rows are taken fewest attempts first, then oldest due, so a row
 * that keeps failing cannot starve the rest. The data-quality check
 * `plan_snapshot_overdue` reports a row still unwritten 24 hours after it was due. A
 * D1 read that throws is rethrown, so the queue retries the run.
 *
 * The bookkeeping UPDATEs carry no `audit_log` row: the table is log-class under
 * ADR 0022 and the writes are EX-002 sweep bookkeeping (`CODE_REVIEW_EXEMPTIONS.md`).
 */

import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { planChangeSnapshots } from '../db/schema';
import { sha256HexBytes } from './hash';
import {
  buildPlanChangeSnapshot,
  planSnapshotKey,
  PLAN_SNAPSHOT_SCHEMA,
  type PlanChangeSnapshotRow,
} from './plan-change-evidence';

/** Rows per run. At the 15-minute cadence that is 100 an hour, far above the rate of
 *  plan changes. */
export const PLAN_SNAPSHOT_BATCH = 25;

/** The run heartbeat, `outcome:ok|failed|skipped`, on every run. */
export const PLAN_SNAPSHOT_RUN_METRIC = 'aeci.plan_snapshot.run';

/** The PostHog log source. */
export const PLAN_SNAPSHOT_SOURCE = 'plan-snapshot-sweep';

const ERROR_MAX = 500;

/** The R2 calls the sweep makes. `R2Bucket` satisfies it, and a spec passes a fake. */
export interface EvidenceBucket {
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
      sha256: string;
    },
  ): Promise<{ size: number } | null>;
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
}

export interface PlanSnapshotSweepResult {
  /** Due rows read this run, up to {@link PLAN_SNAPSHOT_BATCH}. */
  due: number;
  /** Snapshots written and confirmed. */
  written: number;
  /** Objects an earlier run had written, stamped without a write. */
  adopted: number;
  /** Rows that failed this run. They stay due. */
  failed: number;
}

export interface PlanSnapshotSweepOptions {
  now: Date;
  commitSha: string;
  limit?: number;
}

/** Stamp the row written. Guarded on `r2_key IS NULL`, so a double-fired run that
 *  already stamped it changes nothing. */
async function stamp(db: Db, id: string, key: string, at: string): Promise<void> {
  await db
    .update(planChangeSnapshots)
    .set({ r2Key: key, writtenAt: at, lastError: null })
    .where(and(eq(planChangeSnapshots.id, id), isNull(planChangeSnapshots.r2Key)));
}

/** Write one row's snapshot, or adopt the object already there. */
async function writeOne(
  db: Db,
  bucket: EvidenceBucket,
  row: PlanChangeSnapshotRow,
  opts: PlanSnapshotSweepOptions,
): Promise<'written' | 'adopted'> {
  const key = planSnapshotKey(row);
  const at = opts.now.toISOString();
  if (await bucket.head(key)) {
    await stamp(db, row.id, key, at);
    return 'adopted';
  }
  const snapshot = await buildPlanChangeSnapshot(db, row, {
    takenAt: opts.now,
    commitSha: opts.commitSha,
  });
  const body = new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`).buffer as ArrayBuffer;
  const sha256 = await sha256HexBytes(body);
  const customMetadata = {
    schema: String(PLAN_SNAPSHOT_SCHEMA),
    sha256,
    product_id: row.productId,
    kind: row.kind,
    phase: row.phase,
  };
  const put = await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata,
    sha256,
  });
  if (!put) throw new Error(`put_refused key=${key}`);
  const head = await bucket.head(key);
  if (!head || head.size !== body.byteLength || head.customMetadata?.sha256 !== sha256) {
    throw new Error(`head_mismatch key=${key}`);
  }
  await stamp(db, row.id, key, at);
  return 'written';
}

/**
 * Run one sweep. Never throws for one row: its failure is recorded on the row. A
 * failing due-row READ throws, and the caller rethrows it for a queue retry.
 */
export async function runPlanSnapshotSweep(
  db: Db,
  bucket: EvidenceBucket,
  opts: PlanSnapshotSweepOptions,
): Promise<PlanSnapshotSweepResult> {
  const rows = await db
    .select({
      id: planChangeSnapshots.id,
      productId: planChangeSnapshots.productId,
      kind: planChangeSnapshots.kind,
      phase: planChangeSnapshots.phase,
      cause: planChangeSnapshots.cause,
      licenseId: planChangeSnapshots.licenseId,
      eventAt: planChangeSnapshots.eventAt,
    })
    .from(planChangeSnapshots)
    .where(
      and(
        isNull(planChangeSnapshots.r2Key),
        lte(planChangeSnapshots.dueAt, opts.now.toISOString()),
      ),
    )
    .orderBy(
      asc(planChangeSnapshots.attempts),
      asc(planChangeSnapshots.dueAt),
      asc(planChangeSnapshots.id),
    )
    .limit(opts.limit ?? PLAN_SNAPSHOT_BATCH);

  const result: PlanSnapshotSweepResult = { due: rows.length, written: 0, adopted: 0, failed: 0 };
  // One row at a time: each does a handful of D1 reads and two R2 calls, and serial
  // work keeps the Worker well under its six-connection ceiling.
  for (const row of rows) {
    try {
      result[await writeOne(db, bucket, row, opts)] += 1;
    } catch (error) {
      result.failed += 1;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX);
      try {
        await db
          .update(planChangeSnapshots)
          .set({ attempts: sql`${planChangeSnapshots.attempts} + 1`, lastError: message })
          .where(eq(planChangeSnapshots.id, row.id));
      } catch (bookkeeping) {
        // The row stays due with its old count, and the next run retries it.
        console.warn(
          `plan-snapshot-sweep: could not record the failure of ${row.id}`,
          bookkeeping instanceof Error ? bookkeeping.message : bookkeeping,
        );
      }
    }
  }
  return result;
}
