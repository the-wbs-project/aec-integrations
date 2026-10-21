/**
 * The nightly traffic classification writer (AECI-1345, D19 Phase 2;
 * `DATABASE_SCHEMA.md` §9.7, `ADMIN_PANEL_SPEC.md` §13 D19).
 *
 * Classifies every `page_views` row of one UTC day with `classifyPageView` and
 * stores one `page_view_classifications` row per view for the current
 * `TRAFFIC_CLASSIFIER_VERSION`. The day's rows and context come from
 * `buildClassificationDay`, the same function the shadow runner calls, so the
 * stored population is the one the shadow report measured (D19(h)).
 *
 * Shape of a run:
 *
 *  1. `buildClassificationDay` reads the day, the detectors and the ASN registry.
 *  2. Every row is classified in memory. Internal rows are classified too; no
 *     internal flag is stored, because readers apply `NOT_INTERNAL` at read time
 *     and a later operator anchor can turn a row internal after it is written.
 *  3. The rows are inserted {@link CLASSIFICATION_ROWS_PER_STATEMENT} at a time as
 *     one JSON array bound to `json_each(?)`, with
 *     `ON CONFLICT (page_view_id, classifier_version) DO NOTHING`. A re-run of the
 *     same version writes nothing; a new version writes a second row beside the
 *     first. This table is not the promote ledger, so the promote rule against
 *     `DO NOTHING` does not apply here.
 *
 * The statements run one after another, not in one `db.batch`: each is
 * independently idempotent, so a failure part-way leaves a prefix that the queue
 * retry completes without duplicating anything.
 *
 * Derived and log-class under ADR 0022: no `audit_log` row. It sends nothing and
 * changes no reported number (Phase 3, AECI-1346, switches the readers).
 */

import { and, count, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViewClassifications } from '../db/schema';
import { shiftDay } from './admin-analytics';
import { chunked } from './promote-claims';
import { buildClassificationDay } from './traffic-shadow';
import {
  classifierFingerprint,
  classifierRuleInputs,
  classifyPageView,
  SPA_FOLLOWUP_WINDOW_MINUTES,
  SUSPECTED_MIN_SIGNAL_FAMILIES,
  TRAFFIC_CLASSES,
  TRAFFIC_CLASSIFIER_VERSION,
  type ReasonCode,
  type TrafficClass,
} from './traffic-classifier';

/** The heartbeat, emitted on every run including failures (`scheduled.ts`). */
export const TRAFFIC_CLASSIFY_RUN_METRIC = 'aeci.traffic_classify.run';

/**
 * Rows per insert statement. The whole chunk is ONE bound value (a JSON array), so
 * D1's 100-parameter cap never binds. The ceiling that does is D1's 2,000,000-byte
 * limit on a string value: a worst-case row serializes to under 600 bytes, so 500
 * rows is under 300 KB. Sized off the documented limit, not a local run: the test
 * harness accepts far more (`lib/vendor-snapshot.ts` has the same note).
 */
export const CLASSIFICATION_ROWS_PER_STATEMENT = 500;

/** D1's documented maximum size of one string or BLOB value, in bytes. */
export const D1_MAX_VALUE_BYTES = 2_000_000;

export type ClassCounts = Record<TrafficClass, number>;

/** One row as it travels inside the bound JSON array. Short keys keep it small. */
export interface ClassificationPayloadRow {
  /** `page_views.id` */
  i: number;
  /** class */
  c: TrafficClass;
  /** reason codes, `REASON_CODES` order */
  r: ReasonCode[];
}

export interface TrafficClassifyResult {
  day: string;
  classifierVersion: string;
  fingerprint: string;
  /** `page_views` rows in the day, internal rows included. */
  rowsSeen: number;
  /** New rows this run stored. 0 on a same-version re-run. */
  rowsWritten: number;
  /** Over every row seen, internal included. Always all four classes. */
  countsByClass: ClassCounts;
  /** Rows carrying an `evidence_*` code. */
  evidenceIncomplete: number;
  /** `detectSwarms` hit its candidate cap; the swarm context is partial. */
  swarmTruncated: boolean;
}

/** The classification day for a run at `at`: the prior complete UTC day. */
export function classifyDayFor(at: Date): string {
  return shiftDay(at.toISOString().slice(0, 10), -1);
}

/**
 * The tunables `job_runs.detail` records beside the version and fingerprint
 * (`POST_LAUNCH_MONITORING.md` §3c step 4). Only the scalar constants and the
 * swarm block: the full `classifierRuleInputs()` carries the ASN and bot tables
 * and would push the row toward the 64 KB detail cap. The fingerprint covers
 * the rest.
 */
export function classifierRunConstants() {
  return {
    SUSPECTED_MIN_SIGNAL_FAMILIES,
    SPA_FOLLOWUP_WINDOW_MINUTES,
    swarm: classifierRuleInputs().swarm,
  };
}

function zeroCounts(): ClassCounts {
  return Object.fromEntries(TRAFFIC_CLASSES.map((c) => [c, 0])) as ClassCounts;
}

async function storedCount(db: Db, day: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(pageViewClassifications)
    .where(
      and(
        eq(pageViewClassifications.viewDay, day),
        eq(pageViewClassifications.classifierVersion, TRAFFIC_CLASSIFIER_VERSION),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Classify and store one UTC day. Throws on a D1 failure; the caller rethrows so
 * the queue retries, which is safe because the insert is idempotent per version.
 */
export async function classifyDay(
  db: Db,
  day: string,
  now: Date = new Date(),
): Promise<TrafficClassifyResult> {
  const built = await buildClassificationDay(db, day);
  const evaluatedAt = now.toISOString();

  const countsByClass = zeroCounts();
  let evidenceIncomplete = 0;
  const payload: ClassificationPayloadRow[] = built.rows.map((row) => {
    const result = classifyPageView(row, built.ctx);
    countsByClass[result.class] += 1;
    if (!result.evidenceComplete) evidenceIncomplete += 1;
    return { i: row.id, c: result.class, r: result.reasonCodes };
  });

  const before = await storedCount(db, day);
  for (const chunk of chunked(payload, CLASSIFICATION_ROWS_PER_STATEMENT)) {
    // `WHERE true` is required: SQLite cannot otherwise tell the upsert clause
    // from a join constraint after `INSERT … SELECT … FROM`.
    await db.run(sql`
      INSERT INTO page_view_classifications (
        page_view_id, class, reason_codes, classifier_version, evaluated_at,
        evidence_from, evidence_to, view_day, created_at
      )
      SELECT
        json_extract(value, '$.i'), json_extract(value, '$.c'), json_extract(value, '$.r'),
        ${TRAFFIC_CLASSIFIER_VERSION}, ${evaluatedAt},
        ${built.evidence.from}, ${built.evidence.to}, ${day}, ${evaluatedAt}
      FROM json_each(${JSON.stringify(chunk)})
      WHERE true
      ON CONFLICT (page_view_id, classifier_version) DO NOTHING
    `);
  }
  const after = await storedCount(db, day);

  return {
    day,
    classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
    fingerprint: await classifierFingerprint(),
    rowsSeen: built.rows.length,
    rowsWritten: after - before,
    countsByClass,
    evidenceIncomplete,
    swarmTruncated: built.swarm.truncated,
  };
}
