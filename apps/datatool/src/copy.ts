/**
 * Full-clone copy engine — makes the destination D1 a mirror of the source
 * (replace/mirror semantics): clear every user table on the destination, then
 * reload it from the source. Table-agnostic (driven by runtime introspection), so
 * the whole database is copied, including auth-coupled tables. reviews.product_id
 * etc. are copied verbatim, so denormalized aggregates need no recompute.
 *
 * One deliberate exception (AECI-1273): the log-class tables in `LOG_CLASS_TABLES`
 * are CLEARED on the destination but not RELOADED, unless the caller opts in with
 * `includeLogTables`. Production `page_views` alone is large enough to exhaust the
 * Worker, and its rows carry FKs to products/vendors with no ON DELETE rule, so an
 * orphan in the source fails the insert. Clearing them is still required: their
 * FKs would otherwise block deleting the parents they reference.
 *
 * Ordering, not deferred FKs, is the contract: deletes run child-first, inserts
 * parent-first (topological order from introspect.ts), and the single self-FK
 * (`vendor_requests.duplicate_of_request_id`) is nulled then back-filled. The
 * destination clear is one atomic batch; the reload streams one read page at a
 * time and writes it in chunked batches, so memory stays bounded by the page
 * size. A mid-reload failure leaves the destination partially replaced and throws
 * `CopyFailedError` naming the stage, table, and D1 message — re-run to finish
 * (replace is idempotent).
 */

import {
  compareSchemas,
  introspect,
  referencesInto,
  type Schema,
  type TableInfo,
} from './introspect';

/** Inserts/updates per D1 batch. One statement per row (≤ ~40 cols ≪ 100 bound
 * params/statement), so a batch of this many statements stays well within limits. */
const BATCH_STATEMENTS = 50;
/** Keyset read page size: the most source rows held in Worker memory at once. */
const READ_PAGE = 2000;

/**
 * Log-class tables: cleared on the destination, NOT reloaded by default. Each is
 * either env-local operational state (copying it would make the destination lie
 * about its own crons and queues) or an append-only log nobody needs to rehearse
 * against. Tables a seated vendor, admin, or catalog page reads stay included even
 * when CLAUDE.md lists them as audit-exempt: `stats_cache` (home page),
 * `metrics_daily` (admin analytics), `notification_sends` (admin email screen, and
 * the dedupe ledger that stops the destination's crons re-sending a notification),
 * `notification_delivery_events` (admin email screen), and `recrawl_submissions` +
 * `recrawl_submission_causes` (the vendor re-crawl submissions screen). Lead data
 * (`mailing_list`, `feedback`) stays included too.
 */
export const LOG_CLASS_TABLES = [
  // Request log, mostly bot traffic. The table that exhausted the Worker (AECI-1273),
  // and its product/vendor FKs have no ON DELETE rule, so source orphans fail.
  'page_views',
  // Domain-write log; the second-largest table. The destination's vendor History
  // screen shows only events written there after the clone. Opt in to keep it.
  'audit_log',
  // Cron liveness ledger. The admin System screen reads it, but copied rows would
  // report the SOURCE's cron runs as the destination's.
  'job_runs',
  // Liveness probe scratch table; nothing reads it.
  'health_check',
  // Pending recrawl work. Copying it would make the destination's drains submit
  // the source's queued URLs; an empty queue is the true state of a fresh clone.
  'gsc_recrawl_queue',
  'indexnow_queue',
  // Causes of the pending queue rows above, keyed by audit_log id. Both of its
  // join partners are excluded, so a copied row could never resolve.
  'recrawl_queue_causes',
  // Per-user activity log; only the vendor-snapshot cron reads it.
  'user_activity_daily',
  // Derived nightly rollup written by the vendor-snapshot cron; no screen reads it.
  'vendor_activity_daily',
] as const;

type Row = Record<string, unknown>;

export interface CopyOptions {
  /** Reload the `LOG_CLASS_TABLES` too (default false: cleared, not reloaded). */
  includeLogTables?: boolean;
  /** Source rows per keyset read page. Tests lower it to span several pages. */
  readPage?: number;
}

export interface TableCount {
  table: string;
  sourceRows: number;
  destRows: number;
}

export interface ExcludedReference {
  table: string;
  references: string[];
}

export type CopyDryRun =
  | { ok: false; code: 'SCHEMA_MISMATCH'; messages: string[] }
  | {
      ok: false;
      code: 'EXCLUDED_TABLE_REFERENCED';
      messages: string[];
      references: ExcludedReference[];
    }
  | {
      ok: true;
      schema: Schema;
      /** Tables the execute path reloads, in insert order. */
      tables: TableCount[];
      /** Tables the execute path clears but does not reload. */
      excludedTables: TableCount[];
      /** Rows the execute path will write (reloaded tables only). */
      totalSourceRows: number;
      /** Rows the execute path will delete (every table, excluded ones included). */
      totalDestRows: number;
    };

export interface CopyResult {
  inserted: number;
  perTable: Record<string, number>;
  /** Tables cleared on the destination but not reloaded. */
  excludedTables: string[];
}

export type CopyStage = 'clear' | 'reload' | 'selfref';

/** A failed batch mid-copy. The destination is partially replaced when this is
 * thrown; the fields say how far the copy got so the operator can judge a re-run. */
export class CopyFailedError extends Error {
  constructor(
    readonly stage: CopyStage,
    /** The table being written, or null for the clear (one batch over all tables). */
    readonly table: string | null,
    /** Rows committed to `table` before the failing batch. */
    readonly rowsWritten: number,
    /** Tables fully reloaded before the failure, in insert order. */
    readonly completedTables: string[],
    /** The D1 error message. */
    readonly d1Message: string,
  ) {
    super(`copy failed at ${stage}${table ? ` of "${table}"` : ''}: ${d1Message}`);
    this.name = 'CopyFailedError';
  }
}

/** The D1 message, plus its cause when D1 wraps one (the cause carries the SQLite
 * constraint text, e.g. "FOREIGN KEY constraint failed"). */
function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : null;
  return cause && !e.message.includes(cause) ? `${e.message} (cause: ${cause})` : e.message;
}

/** The tables this run reloads and the ones it only clears. Exclusions that don't
 * exist in the schema are ignored, so the list can name a table a future migration
 * drops without breaking the copy. */
export function partitionTables(
  schema: Schema,
  includeLogTables: boolean,
): { reload: string[]; excluded: string[] } {
  if (includeLogTables) return { reload: [...schema.insertOrder], excluded: [] };
  const skip = new Set<string>(LOG_CLASS_TABLES);
  return {
    reload: schema.insertOrder.filter((n) => !skip.has(n)),
    excluded: schema.insertOrder.filter((n) => skip.has(n)),
  };
}

async function countRows(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM "${table}"`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Read a table one page at a time, yielding each page. Rowid keyset pagination
 * (index-free, stable under concurrent inserts on a live source). A WITHOUT ROWID
 * table (none today) pages by OFFSET over its primary key instead. Table names
 * come from `sqlite_master`, so the interpolation is over trusted identifiers. */
async function* readPages(
  db: D1Database,
  table: TableInfo,
  pageSize: number,
): AsyncGenerator<Row[]> {
  if (table.withoutRowid) {
    const order = table.pkColumns.map((c) => `"${c}"`).join(',') || '1';
    for (let offset = 0; ; offset += pageSize) {
      const { results } = await db
        .prepare(`SELECT * FROM "${table.name}" ORDER BY ${order} LIMIT ${pageSize} OFFSET ?`)
        .bind(offset)
        .all<Row>();
      if (results.length) yield results;
      if (results.length < pageSize) return;
    }
  }
  let after = 0;
  for (;;) {
    const { results } = await db
      .prepare(
        `SELECT rowid AS __rid, * FROM "${table.name}" WHERE rowid > ? ORDER BY rowid LIMIT ${pageSize}`,
      )
      .bind(after)
      .all<Row & { __rid: number }>();
    if (results.length === 0) return;
    after = results[results.length - 1].__rid;
    for (const r of results) delete (r as Row).__rid;
    yield results;
    if (results.length < pageSize) return;
  }
}

/** Preflight + per-table count diff. Default path of `POST /api/copy` (no writes). */
export async function copyDryRun(
  source: D1Database,
  dest: D1Database,
  options: CopyOptions = {},
): Promise<CopyDryRun> {
  const [sourceSchema, destSchema] = [await introspect(source), await introspect(dest)];
  const messages = compareSchemas(sourceSchema, destSchema);
  if (messages.length) return { ok: false, code: 'SCHEMA_MISMATCH', messages };

  const { reload, excluded } = partitionTables(sourceSchema, options.includeLogTables === true);
  // An included table pointing at an excluded one would fail every insert that sets
  // the FK (its parent row is never reloaded). Refuse before clearing anything.
  const references = referencesInto(sourceSchema, reload, excluded);
  if (references.length) {
    return {
      ok: false,
      code: 'EXCLUDED_TABLE_REFERENCED',
      messages: references.map(
        (r) =>
          `table "${r.table}" references excluded table(s) ${r.references.map((t) => `"${t}"`).join(', ')}`,
      ),
      references,
    };
  }

  const tables: TableCount[] = [];
  const excludedTables: TableCount[] = [];
  let totalSourceRows = 0;
  let totalDestRows = 0;
  const skip = new Set(excluded);
  for (const table of sourceSchema.insertOrder) {
    const sourceRows = await countRows(source, table);
    const destRows = await countRows(dest, table);
    totalDestRows += destRows;
    if (skip.has(table)) {
      excludedTables.push({ table, sourceRows, destRows });
      continue;
    }
    tables.push({ table, sourceRows, destRows });
    totalSourceRows += sourceRows;
  }
  return {
    ok: true,
    schema: sourceSchema,
    tables,
    excludedTables,
    totalSourceRows,
    totalDestRows,
  };
}

/** Build the INSERT statement (self-ref columns are nulled on the first pass). */
function insertStatement(dest: D1Database, table: TableInfo, row: Row): D1PreparedStatement {
  const columnList = table.columns.map((c) => `"${c}"`).join(',');
  const placeholders = table.columns.map(() => '?').join(',');
  const values = table.columns.map((c) =>
    table.selfRefColumns.includes(c) ? null : (row[c] ?? null),
  );
  return dest
    .prepare(`INSERT INTO "${table.name}" (${columnList}) VALUES (${placeholders})`)
    .bind(...values);
}

/** Second-pass UPDATEs that restore the self-ref values once all rows of the table
 * exist (the parents of a self-FK are sibling rows). Built per page, so only the
 * restore statements are kept, never the rows. Empty unless the table has a
 * self-FK and a usable primary key. */
function selfRefUpdates(dest: D1Database, table: TableInfo, rows: Row[]): D1PreparedStatement[] {
  if (table.selfRefColumns.length === 0 || table.pkColumns.length === 0) return [];
  const where = table.pkColumns.map((pk) => `"${pk}" = ?`).join(' AND ');
  const updates: D1PreparedStatement[] = [];
  for (const row of rows) {
    for (const col of table.selfRefColumns) {
      const value = row[col];
      if (value == null) continue;
      updates.push(
        dest
          .prepare(`UPDATE "${table.name}" SET "${col}" = ? WHERE ${where}`)
          .bind(value, ...table.pkColumns.map((pk) => row[pk] ?? null)),
      );
    }
  }
  return updates;
}

/** Run statements in chunked batches. `onBatch` reports each committed chunk's
 * size, so a failure can say how many rows landed before it. */
async function runInBatches(
  dest: D1Database,
  statements: D1PreparedStatement[],
  onBatch: (n: number) => void = () => {},
): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_STATEMENTS) {
    const chunk = statements.slice(i, i + BATCH_STATEMENTS);
    await dest.batch(chunk);
    onBatch(chunk.length);
  }
}

/** Replace the destination's data with the source's, table by table. Caller has
 * already preflighted (schema match, no reference into an excluded table,
 * confirmation) — this just executes. Throws `CopyFailedError` on any failed
 * batch. */
export async function copyExecute(
  source: D1Database,
  dest: D1Database,
  schema: Schema,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const pageSize = options.readPage ?? READ_PAGE;
  const { reload, excluded } = partitionTables(schema, options.includeLogTables === true);

  // 1. Clear the destination atomically, excluded tables included: null self-refs
  //    first (so a self-FK row's DELETE can't trip RESTRICT), then DELETE child-first.
  const clear: D1PreparedStatement[] = [];
  for (const name of schema.deleteOrder) {
    const table = schema.tablesByName.get(name)!;
    for (const col of table.selfRefColumns) {
      clear.push(dest.prepare(`UPDATE "${name}" SET "${col}" = NULL`));
    }
  }
  for (const name of schema.deleteOrder) {
    clear.push(dest.prepare(`DELETE FROM "${name}"`));
  }
  try {
    await dest.batch(clear);
  } catch (e) {
    throw new CopyFailedError('clear', null, 0, [], errorMessage(e));
  }

  // 2. Reload parent-first, one source page at a time. Inserts null self-refs; the
  //    restore statements are collected (only for non-null values) for step 3.
  const perTable: Record<string, number> = {};
  const completedTables: string[] = [];
  const deferredSelfRefUpdates: D1PreparedStatement[] = [];
  let inserted = 0;

  for (const name of reload) {
    const table = schema.tablesByName.get(name)!;
    let written = 0;
    try {
      for await (const rows of readPages(source, table, pageSize)) {
        await runInBatches(
          dest,
          rows.map((row) => insertStatement(dest, table, row)),
          (n) => {
            written += n;
          },
        );
        deferredSelfRefUpdates.push(...selfRefUpdates(dest, table, rows));
      }
    } catch (e) {
      throw new CopyFailedError('reload', name, written, completedTables, errorMessage(e));
    }
    perTable[name] = written;
    inserted += written;
    completedTables.push(name);
  }

  // 3. Restore self-references now that every row exists.
  let restored = 0;
  try {
    await runInBatches(dest, deferredSelfRefUpdates, (n) => {
      restored += n;
    });
  } catch (e) {
    // The self-FK lives on a single table today; name it when there is exactly one.
    const selfRefTables = reload.filter((n) => schema.tablesByName.get(n)!.selfRefColumns.length);
    throw new CopyFailedError(
      'selfref',
      selfRefTables.length === 1 ? selfRefTables[0] : null,
      restored,
      completedTables,
      errorMessage(e),
    );
  }

  return { inserted, perTable, excludedTables: excluded };
}
