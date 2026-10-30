/**
 * The permanent `page_views` archive (AECI-1228, ADR 0050, `ADMIN_PANEL_SPEC.md`
 * §7.4 rule 5).
 *
 * The 03:00 retention job calls {@link archiveDueDays} before the prune. It copies
 * each UTC day of `page_views`, and the `page_view_classifications` of that day's
 * views, to the `PAGE_VIEWS_ARCHIVE` R2 bucket as gzip NDJSON. The prune then
 * refuses any day this module has not confirmed (`findArchiveGap` in
 * `./retention-prune`). D1 Time Travel recovers about 30 days, so without this a
 * pruned row is gone for good.
 *
 * ─── When a day is due ───────────────────────────────────────────────────────
 *
 * A day is archived once it is {@link PAGE_VIEWS_ARCHIVE_AGE_DAYS} (371) days old.
 * Past that age no backfill reclassifies the day, so the copy matches D1 at prune
 * time, and the job has 29 nights to recover from a failure before the 400-day
 * prune wants the day. Every day from the oldest `page_views` row to the due line
 * is archived, empty days included. An empty day writes two empty objects and a
 * ledger row with zero counts. That keeps "which days are due" a single ledger
 * range read, with no per-day probe.
 *
 * ─── One day, in order ───────────────────────────────────────────────────────
 *
 *   1. Read every `page_views` row of the day with `SELECT *`, paged by the `id`
 *      cursor. `SELECT *` keeps every D1 column under its D1 name with its D1 value,
 *      0/1 booleans included. The classifications of those rows are read the same way.
 *   2. Serialize each set as NDJSON and gzip it into a buffer.
 *   3. `put` both objects. R2 checks the SHA-256 on upload. `customMetadata`
 *      carries `{rows, sha256}`.
 *   4. `head` both objects and check the size and metadata. Then count the day
 *      again in D1. The counts must equal the rows serialized.
 *   5. Only then write the `page_views_archive_days` ledger row.
 *
 * A failure at any step writes no ledger row, so the next night retries the day.
 * A retry overwrites the objects with the day's current rows. The ledger write is
 * log-class and writes no `audit_log` row (ADR 0022, 2026-10-29 amendment).
 *
 * Every read goes through the Drizzle client. R2 is a binding, not an outbound
 * `fetch`, so the Worker connection limit does not apply and no body is left unread.
 */

import { PAGE_VIEWS_ARCHIVE_AGE_DAYS } from '@aeci/shared';
import { and, asc, count, gte, inArray, lt, lte, min, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViewClassifications, pageViews, pageViewsArchiveDays } from '../db/schema';
import { shiftDay } from './admin-analytics';
import { daysBetween } from './retention-prune';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Most days one run archives, oldest first. A backlog drains over several nights. */
export const MAX_ARCHIVE_DAYS_PER_RUN = 7;

/** Rows per `SELECT *` page. Each page binds four values, whatever its size. */
export const ARCHIVE_PAGE_ROWS = 1000;

/** The two archived tables, in the order they are written. */
export const ARCHIVED_TABLES = ['page_views', 'page_view_classifications'] as const;
export type ArchivedTable = (typeof ARCHIVED_TABLES)[number];

/** The R2 key of one table's object for one day. Hive-style `day=` partitions, so
 *  DuckDB reads a date range with one glob (`ANALYTICS.md` §11c). */
export function archiveObjectKey(table: ArchivedTable, day: string): string {
  return `${table}/day=${day}/${table}.ndjson.gz`;
}

/**
 * Resolve the archive age: the `@aeci/shared` default unless a valid override is set.
 *
 * The override must be a whole number of at least 1 and below the `page_views`
 * window. Below 1 would archive today, which is not complete. At or above the window
 * would let the prune reach a day before it is archived, so the prune would refuse
 * every night. An invalid override is ignored and reported through `onInvalid`, like
 * `resolveRetentionDays`.
 *
 * The default is held below the window too. A `PAGE_VIEWS_RETENTION_DAYS` override
 * shorter than 372 would otherwise put the prune ahead of the archive. Archiving
 * earlier never deletes anything, so this clamp moves in the safe direction.
 */
export function resolveArchiveAgeDays(
  raw: string | undefined,
  pageViewsWindowDays: number,
  onInvalid?: (reason: string) => void,
): number {
  const fallback = Math.min(PAGE_VIEWS_ARCHIVE_AGE_DAYS, pageViewsWindowDays - 1);
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    onInvalid?.(`"${raw}" is not a whole number of days`);
    return fallback;
  }
  if (parsed < 1) {
    onInvalid?.(`${parsed} is below 1 day, so it would archive a day that is not complete`);
    return fallback;
  }
  if (parsed >= pageViewsWindowDays) {
    onInvalid?.(
      `${parsed} is not below the ${pageViewsWindowDays}-day page_views window, so the prune would reach a day before it is archived`,
    );
    return fallback;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// The bucket seam
// ---------------------------------------------------------------------------

/** The R2 calls this module makes. `R2Bucket` satisfies it, and a spec passes an
 *  in-memory fake. */
export interface ArchiveBucket {
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

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type ArchiveDayOutcome =
  | {
      day: string;
      status: 'archived';
      pageViewsRows: number;
      classificationRows: number;
      bytes: number;
    }
  | { day: string; status: 'failed'; reason: string };

/**
 * One run of the archive step, as `job_runs.detail.archive` records it.
 *
 * - `archived`: every attempted day was confirmed.
 * - `failed`: at least one day was not. `failedDays` names them.
 * - `nothing_due`: no day was due.
 * - `skipped`: no bucket bound off production. The prune gate is off too.
 * - `archive_unbound`: no bucket bound in production. The prune gate stays on, so
 *   the prune refuses any `page_views` day and the alert fires.
 */
export interface ArchiveRunSummary {
  status: 'archived' | 'failed' | 'nothing_due' | 'skipped' | 'archive_unbound';
  daysArchived: number;
  failedDays: string[];
  /** Per-day results, oldest first. Empty unless a day was attempted. */
  days: ArchiveDayOutcome[];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `[from, to)` for one UTC day, as ISO instants. */
function dayBounds(day: string): { from: string; to: string } {
  return { from: `${day}T00:00:00.000Z`, to: `${shiftDay(day, 1)}T00:00:00.000Z` };
}

/** Every `page_views` row of the day, `SELECT *`, in `id` order. */
async function readDayViews(db: Db, day: string): Promise<Record<string, unknown>[]> {
  const { from, to } = dayBounds(day);
  const out: Record<string, unknown>[] = [];
  let cursor = 0;
  for (;;) {
    const page = await db.all<Record<string, unknown>>(
      sql`SELECT * FROM ${pageViews} WHERE ${pageViews.createdAt} >= ${from} AND ${pageViews.createdAt} < ${to} AND ${pageViews.id} > ${cursor} ORDER BY ${pageViews.id} LIMIT ${ARCHIVE_PAGE_ROWS}`,
    );
    out.push(...page);
    if (page.length < ARCHIVE_PAGE_ROWS) return out;
    cursor = Number(page[page.length - 1]?.id);
  }
}

/** Every `page_view_classifications` row whose view falls in the day, `SELECT *`,
 *  in `id` order. The view set is the same predicate the prune deletes by. */
async function readDayClassifications(db: Db, day: string): Promise<Record<string, unknown>[]> {
  const { from, to } = dayBounds(day);
  const out: Record<string, unknown>[] = [];
  let cursor = 0;
  for (;;) {
    const page = await db.all<Record<string, unknown>>(
      sql`SELECT * FROM ${pageViewClassifications} WHERE ${pageViewClassifications.pageViewId} IN (SELECT ${pageViews.id} FROM ${pageViews} WHERE ${pageViews.createdAt} >= ${from} AND ${pageViews.createdAt} < ${to}) AND ${pageViewClassifications.id} > ${cursor} ORDER BY ${pageViewClassifications.id} LIMIT ${ARCHIVE_PAGE_ROWS}`,
    );
    out.push(...page);
    if (page.length < ARCHIVE_PAGE_ROWS) return out;
    cursor = Number(page[page.length - 1]?.id);
  }
}

/** The day's counts in D1 now. Step 4's recount. */
async function countDay(db: Db, day: string): Promise<{ views: number; classifications: number }> {
  const { from, to } = dayBounds(day);
  const inDay = and(gte(pageViews.createdAt, from), lt(pageViews.createdAt, to));
  const [views] = await db.select({ n: count() }).from(pageViews).where(inDay);
  const [classifications] = await db
    .select({ n: count() })
    .from(pageViewClassifications)
    .where(
      inArray(
        pageViewClassifications.pageViewId,
        db.select({ id: pageViews.id }).from(pageViews).where(inDay),
      ),
    );
  return { views: views?.n ?? 0, classifications: classifications?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** One JSON object per line, each line ending in `\n`. Empty input is empty text. */
export function toNdjson(rows: Record<string, unknown>[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

/** Gzip text into a buffer. `CompressionStream` is native in workerd and Node. */
export async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Lowercase hex SHA-256. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// One day
// ---------------------------------------------------------------------------

/** Thrown inside {@link archiveDay} to name the step that refused. */
class ArchiveStepError extends Error {}

interface WrittenObject {
  key: string;
  rows: number;
  bytes: number;
  sha256: string;
}

/** Steps 2 to 4 for one table: encode, put, then head and compare. */
async function writeObject(
  bucket: ArchiveBucket,
  key: string,
  rows: Record<string, unknown>[],
): Promise<WrittenObject> {
  const body = await gzip(toNdjson(rows));
  const sha256 = await sha256Hex(body);
  const customMetadata = { rows: String(rows.length), sha256 };
  const put = await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata,
    sha256,
  });
  if (!put) throw new ArchiveStepError(`put_refused key=${key}`);
  const head = await bucket.head(key);
  if (
    !head ||
    head.size !== body.byteLength ||
    head.customMetadata?.rows !== customMetadata.rows ||
    head.customMetadata?.sha256 !== sha256
  ) {
    throw new ArchiveStepError(`head_mismatch key=${key}`);
  }
  return { key, rows: rows.length, bytes: body.byteLength, sha256 };
}

/**
 * Archive one UTC day, or report why not. Never throws: a thrown D1 or R2 call is
 * returned as `failed` with its message, so one bad day never stops the others.
 */
export async function archiveDay(
  db: Db,
  bucket: ArchiveBucket,
  day: string,
  now: Date,
): Promise<ArchiveDayOutcome> {
  try {
    const views = await readDayViews(db, day);
    const classifications = await readDayClassifications(db, day);

    const viewsObject = await writeObject(bucket, archiveObjectKey('page_views', day), views);
    await writeObject(bucket, archiveObjectKey('page_view_classifications', day), classifications);

    // The AC's "row count check matches D1 at copy time". A row written or deleted
    // between the read and here means the objects do not match D1, so no ledger row.
    const recount = await countDay(db, day);
    if (recount.views !== views.length || recount.classifications !== classifications.length) {
      throw new ArchiveStepError(
        `count_changed views=${views.length}->${recount.views} classifications=${classifications.length}->${recount.classifications}`,
      );
    }

    const row = {
      day,
      pageViewsRows: views.length,
      classificationRows: classifications.length,
      objectKey: viewsObject.key,
      bytes: viewsObject.bytes,
      sha256: viewsObject.sha256,
      archivedAt: now.toISOString(),
    };
    // Upsert, because two overlapping runs (a cron double-fire) may both confirm
    // the same day. The later confirmation is as good as the earlier one.
    await db
      .insert(pageViewsArchiveDays)
      .values(row)
      .onConflictDoUpdate({
        target: pageViewsArchiveDays.day,
        set: {
          pageViewsRows: row.pageViewsRows,
          classificationRows: row.classificationRows,
          objectKey: row.objectKey,
          bytes: row.bytes,
          sha256: row.sha256,
          archivedAt: row.archivedAt,
        },
      });

    return {
      day,
      status: 'archived',
      pageViewsRows: views.length,
      classificationRows: classifications.length,
      bytes: viewsObject.bytes,
    };
  } catch (error) {
    return {
      day,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * The days due for archiving, oldest first: every day from the oldest `page_views`
 * row through the day that is `ageDays` old, minus the days already in the ledger.
 * One index read and one ledger range read.
 */
export async function dueArchiveDays(db: Db, now: Date, ageDays: number): Promise<string[]> {
  const [oldest] = await db.select({ at: min(pageViews.createdAt) }).from(pageViews);
  if (!oldest?.at) return [];
  const fromDay = oldest.at.slice(0, 10);
  const dueThrough = shiftDay(now.toISOString().slice(0, 10), -ageDays);
  if (fromDay > dueThrough) return [];
  const done = await db
    .select({ day: pageViewsArchiveDays.day })
    .from(pageViewsArchiveDays)
    .where(and(gte(pageViewsArchiveDays.day, fromDay), lte(pageViewsArchiveDays.day, dueThrough)))
    .orderBy(asc(pageViewsArchiveDays.day));
  const archived = new Set(done.map((r) => r.day));
  return daysBetween(fromDay, dueThrough).filter((day) => !archived.has(day));
}

/**
 * Archive up to {@link MAX_ARCHIVE_DAYS_PER_RUN} due days, oldest first. Each day
 * is independent: a failed day is reported and the next one still runs. A D1 failure
 * on the due-day read propagates, and the caller records it as a failed step.
 */
export async function archiveDueDays(
  db: Db,
  bucket: ArchiveBucket,
  now: Date,
  ageDays: number,
): Promise<ArchiveRunSummary> {
  const due = (await dueArchiveDays(db, now, ageDays)).slice(0, MAX_ARCHIVE_DAYS_PER_RUN);
  if (due.length === 0) {
    return { status: 'nothing_due', daysArchived: 0, failedDays: [], days: [] };
  }
  const days: ArchiveDayOutcome[] = [];
  for (const day of due) days.push(await archiveDay(db, bucket, day, now));
  const failedDays = days.filter((d) => d.status === 'failed').map((d) => d.day);
  return {
    status: failedDays.length > 0 ? 'failed' : 'archived',
    daysArchived: days.length - failedDays.length,
    failedDays,
    days,
  };
}

// ---------------------------------------------------------------------------
// Observability (docs/OBSERVABILITY.md)
// ---------------------------------------------------------------------------

export const ARCHIVE_RUN_METRIC = 'aeci.pageviews.archive';

/** Telemetry transport, the same injected seam as `RetentionMetricSink`. */
export type ArchiveMetricSink = {
  count(metric: string, value: number, tags: string[]): void;
};

/**
 * Emit `aeci.pageviews.archive` for one run. At least one point every run.
 *
 * - `outcome:archived`, value = days confirmed, when any were.
 * - `outcome:failed`, value = days that failed, when any did.
 * - `outcome:nothing_due`, `outcome:skipped` or `outcome:archive_unbound`, value 1.
 *
 * The alert `pageviews-archive-failed` fires on `failed` or `archive_unbound`.
 */
export function emitArchiveMetrics(sink: ArchiveMetricSink, summary: ArchiveRunSummary): void {
  const base = ['trigger:cron'];
  if (summary.status === 'archived' || summary.status === 'failed') {
    if (summary.daysArchived > 0) {
      sink.count(ARCHIVE_RUN_METRIC, summary.daysArchived, [...base, 'outcome:archived']);
    }
    // A crashed step reports no days, so it still counts one failure.
    const failed = Math.max(summary.failedDays.length, summary.status === 'failed' ? 1 : 0);
    if (failed > 0) sink.count(ARCHIVE_RUN_METRIC, failed, [...base, 'outcome:failed']);
    return;
  }
  sink.count(ARCHIVE_RUN_METRIC, 1, [...base, `outcome:${summary.status}`]);
}
