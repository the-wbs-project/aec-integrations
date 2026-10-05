/**
 * The daily Google re-crawl inspection run (AECI-1236 / §20.2, ADR 0031's
 * 2026-10-05 amendment).
 *
 * Asks the Search Console URL Inspection API about `gsc_recrawl_queue` rows and:
 *
 *   - **closes** a row when Google reports the page indexed AND crawled after the
 *     row's `last_changed_at` (`decideInspection` in `gsc-inspection.ts`). Google
 *     has already seen the change, so a manual Request Indexing would spend quota
 *     for nothing.
 *   - **tags** every other row with what Google said (`inspect_reason`,
 *     `last_crawl_at`, `coverage_state`, `inspected_at`), so `/admin/reindex`
 *     shows the operator why each remaining row needs them.
 *
 * It never requests indexing: no API accepts our content types (AECI-747).
 *
 * ─── Chunked, because a run outlives one consumer invocation ─────────────────
 *
 * Measured 2026-10-05: about 25 inspections a minute at four in flight. A run of
 * {@link GSC_INSPECT_RUN_BUDGET} therefore takes about an hour, and a Queue
 * consumer invocation is capped at 15 minutes of wall time. So one call here
 * handles ONE chunk of {@link GSC_INSPECT_CHUNK_SIZE} rows and returns how much
 * budget is left. `scheduled.ts` re-enqueues the next chunk with that number.
 *
 * The chunk read needs no cursor. Its predicate is "never inspected, or inspected
 * more than {@link GSC_INSPECT_RECHECK_DAYS} days ago", and every row this chunk
 * touches is either deleted or stamped `inspected_at = now`, so it leaves the
 * eligible set. A row that ERRORED is not stamped, so it stays eligible for the
 * next day's run. Inside one run it would sort straight back to the top of the
 * next chunk, so each chunk returns its errored ids (`failedIds`) and the chain
 * carries them forward as `skipIds`. Without that, 100 permanently failing rows
 * would fill every chunk and starve the rest of the worklist.
 *
 * ─── Audit: the scheduled-deletion rule, one row per batch ───────────────────
 *
 * The close is a scheduled DELETE, so §26.1's rule applies as written: one
 * summary `audit_log` row per committed batch, `actor_type 'system'`, in the same
 * `db.batch` as the deletes, and no row when nothing was closed. Ruling
 * 2026-10-05 (Chris): summary rather than per-row, with the summary's `metadata`
 * listing EVERY cleared row (id, url, reason, timestamps, Google's crawl time).
 * That keeps ADR 0031 §2's promise that the operator can audit what left the
 * list, without a per-row trail. The tag UPDATEs are derived from Google's answer
 * and are log-class under ADR 0022, like the appends.
 *
 * ─── The edit-during-run race ────────────────────────────────────────────────
 *
 * A page can be edited while its row is being inspected. `enqueueGscRecrawl`
 * then moves `last_changed_at` and clears the tags. So the commit re-reads the
 * candidates' change time immediately before the batch and drops any that moved,
 * and every DELETE and UPDATE is guarded on the change time it decided against.
 * The residual window is the milliseconds between that re-read and the batch.
 */

import { mapWithConcurrency } from '@aeci/shared/concurrency';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { gscRecrawlQueue } from '../db/schema';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import {
  decideInspection,
  getGoogleAccessToken,
  inspectUrl,
  parseServiceAccount,
  type GscInspectReason,
  type IndexStatus,
  type InspectResult,
} from './gsc-inspection';

/** Inspections per run. Google allows 2,000 a day per property; the rest is
 *  headroom for an operator inspecting by hand in the Search Console UI, whose
 *  share of the same quota is not documented. */
export const GSC_INSPECT_RUN_BUDGET = 1_500;
/** Rows per chunk (one consumer invocation): about four minutes of inspections,
 *  well inside the 15-minute wall-time cap, and 201 statements at most per batch. */
export const GSC_INSPECT_CHUNK_SIZE = 100;
/** A row tagged less than this long ago is not re-inspected. Google rarely
 *  re-crawls a page within days, so asking sooner mostly re-reads the same answer. */
export const GSC_INSPECT_RECHECK_DAYS = 3;
/** Calls in flight. Under the Worker's ~6 open connections and Google's 600 a
 *  minute. */
export const GSC_INSPECT_CONCURRENCY = 4;

export const GSC_INSPECT_RUN_METRIC = 'aeci.gsc_inspect.run';
export const GSC_INSPECT_ROWS_METRIC = 'aeci.gsc_inspect.rows';
/** `audit_log.action` for the batch summary. Needs a label in
 *  `apps/web/src/app/admin/audit/audit-action-labels.ts`. */
export const REINDEX_AUTO_CLEARED_ACTION = 'reindex.auto_cleared';

export type GscInspectOutcome =
  /** The chunk ran. Some rows may have errored; see `errors`. */
  | 'ok'
  /** Not configured here: no key, or not a public indexable env. */
  | 'skipped'
  /** Google answered 429: the day's quota is spent. The chain stops. */
  | 'halted_quota'
  /** The key was rejected or lost access to the property. The chain stops. */
  | 'halted_auth';

export interface GscInspectChunkResult {
  outcome: GscInspectOutcome;
  /** Why it was skipped or halted. */
  reason?: string;
  inspected: number;
  closed: number;
  tagged: number;
  errors: number;
  /** Budget left for the next chunk, or null when the run is over. */
  next: number | null;
  /** Ids whose inspection failed in this chunk. The caller adds them to the
   *  run's `skipIds`, so later chunks of the same run do not re-read them. */
  failedIds: number[];
  /** The summary row committed with the deletes, for the post-commit forward. */
  auditEntry?: AuditLogEntry;
}

export interface GscInspectDeps {
  db: Db;
  /** `GSC_SA_KEY_JSON`. */
  serviceAccountJson: string | undefined;
  /** `INDEXNOW_KEY` + `PUBLIC_SITE_URL`: the §20.2 "this env is public and
   *  indexable" signal. The queue only fills where both are set. */
  indexNowKey: string | undefined;
  publicSiteUrl: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface Candidate {
  id: number;
  url: string;
  priority: number;
  reason: string;
  queuedAt: string;
  lastChangedAt: string | null;
}

const changedAtOf = (row: Pick<Candidate, 'queuedAt' | 'lastChangedAt'>) =>
  row.lastChangedAt ?? row.queuedAt;

/** The change time a guard compares, matching {@link changedAtOf} in SQL. */
const changedAtSql = sql`coalesce(${gscRecrawlQueue.lastChangedAt}, ${gscRecrawlQueue.queuedAt})`;

function emptyResult(outcome: GscInspectOutcome, reason?: string): GscInspectChunkResult {
  return {
    outcome,
    reason,
    inspected: 0,
    closed: 0,
    tagged: 0,
    errors: 0,
    next: null,
    failedIds: [],
  };
}

/** Run one chunk of the inspection run. Never throws on a Google failure; a D1
 *  failure throws, so the consumer retries the message. `skipIds` are the rows
 *  that already failed earlier in this run. */
export async function runGscInspectChunk(
  deps: GscInspectDeps,
  remaining: number,
  skipIds: readonly number[] = [],
): Promise<GscInspectChunkResult> {
  const { db, fetchImpl = fetch, now = () => new Date(), sleep } = deps;
  const account = parseServiceAccount(deps.serviceAccountJson);
  if (!account) return emptyResult('skipped', 'no_creds');
  if (!deps.indexNowKey || !deps.publicSiteUrl) return emptyResult('skipped', 'not_public');
  if (remaining <= 0) return emptyResult('ok');

  const startedAt = now();
  const recheckBefore = new Date(
    startedAt.getTime() - GSC_INSPECT_RECHECK_DAYS * 86_400_000,
  ).toISOString();
  const limit = Math.min(GSC_INSPECT_CHUNK_SIZE, remaining);

  const rows: Candidate[] = await db
    .select({
      id: gscRecrawlQueue.id,
      url: gscRecrawlQueue.url,
      priority: gscRecrawlQueue.priority,
      reason: gscRecrawlQueue.reason,
      queuedAt: gscRecrawlQueue.queuedAt,
      lastChangedAt: gscRecrawlQueue.lastChangedAt,
    })
    .from(gscRecrawlQueue)
    .where(
      and(
        or(isNull(gscRecrawlQueue.inspectedAt), lt(gscRecrawlQueue.inspectedAt, recheckBefore)),
        // One bound parameter however long the list: D1 caps a query at 100.
        skipIds.length > 0
          ? sql`${gscRecrawlQueue.id} not in (select value from json_each(${JSON.stringify(skipIds)}))`
          : undefined,
      ),
    )
    // Never inspected first, then the oldest inspection; the tier breaks ties.
    .orderBy(
      sql`${gscRecrawlQueue.inspectedAt} is not null`,
      asc(gscRecrawlQueue.inspectedAt),
      asc(gscRecrawlQueue.priority),
      asc(gscRecrawlQueue.id),
    )
    .limit(limit);
  if (rows.length === 0) return emptyResult('ok');

  const token = await getGoogleAccessToken(fetchImpl, account);
  if (!token.ok) return emptyResult('halted_auth', token.message);

  const settled = await mapWithConcurrency(rows, GSC_INSPECT_CONCURRENCY, (row) =>
    inspectUrl(fetchImpl, token.token, row.url, sleep ? { sleep } : {}),
  );
  const answers: InspectResult[] = settled.map((s) =>
    s.status === 'fulfilled'
      ? s.value
      : { ok: false, kind: 'transient', message: String(s.reason) },
  );

  const closeRows: { row: Candidate; status: IndexStatus }[] = [];
  const tagRows: { row: Candidate; status: IndexStatus; reason: GscInspectReason }[] = [];
  const failedIds: number[] = [];
  let halt = null as 'halted_quota' | 'halted_auth' | null;
  for (const [i, row] of rows.entries()) {
    const answer = answers[i]!;
    if (!answer.ok) {
      failedIds.push(row.id);
      if (answer.kind === 'quota') halt = 'halted_quota';
      else if (answer.kind === 'auth' && halt === null) halt = 'halted_auth';
      continue;
    }
    const decision = decideInspection(answer.status, changedAtOf(row));
    if (decision.action === 'close') closeRows.push({ row, status: answer.status });
    else tagRows.push({ row, status: answer.status, reason: decision.reason });
  }

  // Drop any row whose page changed while it was being inspected (see header).
  const touched = [...closeRows, ...tagRows].map((x) => x.row.id);
  const current = touched.length
    ? await db
        .select({
          id: gscRecrawlQueue.id,
          queuedAt: gscRecrawlQueue.queuedAt,
          lastChangedAt: gscRecrawlQueue.lastChangedAt,
        })
        .from(gscRecrawlQueue)
        .where(inArray(gscRecrawlQueue.id, touched))
    : [];
  const stillAt = new Map(current.map((c) => [c.id, changedAtOf(c)]));
  const unchanged = (row: Candidate) => stillAt.get(row.id) === changedAtOf(row);
  const closing = closeRows.filter((x) => unchanged(x.row));
  const tagging = tagRows.filter((x) => unchanged(x.row));

  const inspectedAt = now().toISOString();
  const stmts: BatchStmt[] = [];
  for (const { row } of closing) {
    stmts.push(
      db
        .delete(gscRecrawlQueue)
        .where(and(eq(gscRecrawlQueue.id, row.id), eq(changedAtSql, changedAtOf(row)))),
    );
  }
  for (const { row, status, reason } of tagging) {
    stmts.push(
      db
        .update(gscRecrawlQueue)
        .set({
          inspectedAt,
          lastCrawlAt: status.lastCrawlTime ?? null,
          coverageState: status.coverageState ?? null,
          inspectReason: reason,
        })
        .where(and(eq(gscRecrawlQueue.id, row.id), eq(changedAtSql, changedAtOf(row)))),
    );
  }

  let auditEntry: AuditLogEntry | undefined;
  if (closing.length > 0) {
    auditEntry = {
      actorId: null,
      actorType: 'system',
      action: REINDEX_AUTO_CLEARED_ACTION,
      entityType: 'gsc_recrawl_queue',
      entityId: null,
      metadata: {
        source: 'gsc-inspect-cron',
        closed: closing.length,
        rows: closing.map(({ row, status }) => ({
          id: row.id,
          url: row.url,
          priority: row.priority,
          reason: row.reason,
          queued_at: row.queuedAt,
          last_changed_at: changedAtOf(row),
          google_last_crawl: status.lastCrawlTime ?? null,
        })),
      },
    };
    stmts.push(auditInsert(db, auditEntry));
  }
  if (stmts.length > 0) await db.batch(stmts as BatchTuple);

  const left = remaining - rows.length;
  const next = halt === null && rows.length === limit && left > 0 ? left : null;
  return {
    outcome: halt ?? 'ok',
    reason: halt ? 'google_refused' : undefined,
    inspected: rows.length,
    closed: closing.length,
    tagged: tagging.length,
    errors: failedIds.length,
    next,
    failedIds,
    auditEntry,
  };
}
