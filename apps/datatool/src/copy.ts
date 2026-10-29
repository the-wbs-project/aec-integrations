/**
 * Full-clone copy engine — makes the destination D1 an exact mirror of the source
 * (replace/mirror semantics): clear every user table on the destination, then
 * reload it from the source. Table-agnostic (driven by runtime introspection), so
 * the WHOLE database is copied, including auth-coupled and analytics tables — the
 * operator accepted that a clone across the dev↔prod Supabase boundary leaves
 * those rows logically orphaned (see the README / plan). reviews.product_id etc.
 * are copied verbatim, so denormalized aggregates need no recompute.
 *
 * Ordering, not deferred FKs, is the contract: deletes run child-first, inserts
 * parent-first (topological order from introspect.ts), and the single self-FK
 * (`vendor_requests.duplicate_of_request_id`) is nulled then back-filled. The
 * destination clear is one atomic batch; the reload is many chunked batches, so a
 * mid-reload failure leaves the destination partially replaced — re-run to finish
 * (replace is idempotent).
 *
 * Two Worker limits shape the reload, and both bit production → demo in 2026-10
 * once the analytics tables passed ~300k rows:
 *   - Memory (128 MB). Rows are streamed: read one page, write it, drop it. Page
 *     and batch sizes come from each table's measured average row size, so a wide
 *     table (`promote_jobs`) gets small pages and a narrow one gets big ones.
 *   - D1's 1,000 queries per invocation. A `db.batch()` counts as ONE query, so
 *     each INSERT carries as many rows as the 100-bound-parameter cap allows and
 *     each batch carries many INSERTs. The dry run estimates the total, and
 *     execute refuses BEFORE the destination clear when it would not fit.
 */

import { compareSchemas, introspect, type Schema, type TableInfo } from './introspect';

/** D1 caps bound parameters per statement at 100; a multi-row INSERT spends one per
 * column per row. */
const MAX_BOUND_PARAMS = 100;
/** D1 queries per Worker invocation (Workers Paid). A `db.batch()` counts once. */
export const QUERY_BUDGET = 1000;
/** Held back for the post-copy reindex + purge, which runs in the same invocation. */
const REFRESH_RESERVE = 100;
/** Source bytes held in memory per read page (JS objects cost a few times this). */
const READ_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_READ_PAGE = 10_000;
/** Row bytes per INSERT statement and per `db.batch()`. Each batch must also finish
 * inside D1's 30 s per-call limit, which these keep well clear of. */
const STATEMENT_BYTES = 64 * 1024;
const BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_STATEMENTS = 1000;
/** Fixed queries outside the per-table reload: introspect (2 per database), the
 * row/byte counts (1 per database) and the destination clear (1). */
const FIXED_QUERIES = 7;

type Row = Record<string, unknown>;

export interface TableCount {
  table: string;
  sourceRows: number;
  destRows: number;
}

/** How one table is streamed. `readPage` is a multiple of `rowsPerBatch`, so every
 * page splits into whole batches. */
export interface TablePlan extends TableCount {
  avgRowBytes: number;
  readPage: number;
  rowsPerStatement: number;
  statementsPerBatch: number;
  /** Reads + insert batches + self-ref update batches this table will cost. */
  queries: number;
}

export type CopyDryRun =
  | { ok: false; code: 'SCHEMA_MISMATCH'; messages: string[] }
  | {
      ok: true;
      schema: Schema;
      tables: TablePlan[];
      totalSourceRows: number;
      totalDestRows: number;
      /** Every D1 query the execute path makes, including this preflight. */
      estimatedQueries: number;
      /** Queries the copy may spend: QUERY_BUDGET less the refresh reserve. */
      queryBudget: number;
    };

export type CopyPlan = Extract<CopyDryRun, { ok: true }>;

export interface CopyResult {
  inserted: number;
  perTable: Record<string, number>;
}

function sizeTable(info: TableInfo, count: TableCount, sourceBytes: number): TablePlan {
  const n = count.sourceRows;
  const avgRowBytes = n > 0 ? Math.max(1, Math.ceil(sourceBytes / n)) : 1;
  const byParams = Math.max(1, Math.floor(MAX_BOUND_PARAMS / Math.max(1, info.columns.length)));
  const rowsPerStatement = Math.max(
    1,
    Math.min(byParams, Math.floor(STATEMENT_BYTES / avgRowBytes)),
  );
  const statementsPerBatch = Math.max(
    1,
    Math.min(
      MAX_BATCH_STATEMENTS,
      Math.floor(BATCH_BYTES / (avgRowBytes * rowsPerStatement)),
      Math.floor(MAX_READ_PAGE / rowsPerStatement),
    ),
  );
  const rowsPerBatch = rowsPerStatement * statementsPerBatch;
  const pageRows = Math.min(MAX_READ_PAGE, Math.floor(READ_PAGE_BYTES / avgRowBytes));
  const readPage = Math.max(rowsPerBatch, Math.floor(pageRows / rowsPerBatch) * rowsPerBatch);

  // The read loop stops on a short page, so an exact multiple costs one empty read.
  const reads = Math.floor(n / readPage) + 1;
  const inserts = Math.ceil(n / rowsPerBatch);
  const selfRefs =
    info.selfRefColumns.length > 0 && info.pkColumns.length > 0
      ? Math.ceil((n * info.selfRefColumns.length) / MAX_BATCH_STATEMENTS)
      : 0;
  return {
    ...count,
    avgRowBytes,
    readPage,
    rowsPerStatement,
    statementsPerBatch,
    queries: reads + inserts + selfRefs,
  };
}

/** `count(*)` plus the summed byte length of every column, for each table, in one
 * batch (one query against the invocation budget). */
async function measure(
  db: D1Database,
  schema: Schema,
  withBytes: boolean,
): Promise<Map<string, { rows: number; bytes: number }>> {
  const names = schema.insertOrder;
  const statements = names.map((name) => {
    const cols = schema.tablesByName.get(name)!.columns;
    const bytes =
      withBytes && cols.length
        ? `coalesce(sum(${cols.map((c) => `coalesce(length("${c}"),0)`).join('+')}),0)`
        : '0';
    return db.prepare(`SELECT count(*) AS n, ${bytes} AS bytes FROM "${name}"`);
  });
  const results = statements.length ? await db.batch<{ n: number; bytes: number }>(statements) : [];
  const out = new Map<string, { rows: number; bytes: number }>();
  names.forEach((name, i) => {
    const row = results[i]?.results[0];
    out.set(name, { rows: row?.n ?? 0, bytes: row?.bytes ?? 0 });
  });
  return out;
}

/** Stream a table one page at a time via rowid keyset pagination (index-free,
 * stable). Falls back to a single read for WITHOUT ROWID tables (none today).
 * Table names come from `sqlite_master`, so the interpolation is over trusted
 * identifiers. */
async function* readPages(db: D1Database, table: string, pageSize: number): AsyncGenerator<Row[]> {
  let after = 0;
  let first = true;
  for (;;) {
    let results: (Row & { __rid: number })[];
    try {
      ({ results } = await db
        .prepare(
          `SELECT rowid AS __rid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${pageSize}`,
        )
        .bind(after)
        .all<Row & { __rid: number }>());
    } catch (err) {
      if (!first) throw err;
      yield (await db.prepare(`SELECT * FROM "${table}"`).all<Row>()).results;
      return;
    }
    first = false;
    if (results.length === 0) return;
    after = results[results.length - 1]!.__rid;
    for (const r of results) delete (r as Row).__rid;
    yield results;
    if (results.length < pageSize) return;
  }
}

/** Preflight + per-table count diff + query estimate. Default path of
 * `POST /api/copy` (no writes). */
export async function copyDryRun(source: D1Database, dest: D1Database): Promise<CopyDryRun> {
  const [sourceSchema, destSchema] = [await introspect(source), await introspect(dest)];
  const messages = compareSchemas(sourceSchema, destSchema);
  if (messages.length) return { ok: false, code: 'SCHEMA_MISMATCH', messages };

  const sourceSizes = await measure(source, sourceSchema, true);
  const destSizes = await measure(dest, sourceSchema, false);
  const tables: TablePlan[] = [];
  let totalSourceRows = 0;
  let totalDestRows = 0;
  let estimatedQueries = FIXED_QUERIES;
  for (const table of sourceSchema.insertOrder) {
    const src = sourceSizes.get(table)!;
    const count = { table, sourceRows: src.rows, destRows: destSizes.get(table)!.rows };
    const plan = sizeTable(sourceSchema.tablesByName.get(table)!, count, src.bytes);
    tables.push(plan);
    totalSourceRows += plan.sourceRows;
    totalDestRows += plan.destRows;
    estimatedQueries += plan.queries;
  }
  return {
    ok: true,
    schema: sourceSchema,
    tables,
    totalSourceRows,
    totalDestRows,
    estimatedQueries,
    queryBudget: QUERY_BUDGET - REFRESH_RESERVE,
  };
}

/** One multi-row INSERT (self-ref columns are nulled on the first pass). */
function insertStatement(dest: D1Database, table: TableInfo, rows: Row[]): D1PreparedStatement {
  const columnList = table.columns.map((c) => `"${c}"`).join(',');
  const tuple = `(${table.columns.map(() => '?').join(',')})`;
  const values = rows.flatMap((row) =>
    table.columns.map((c) => (table.selfRefColumns.includes(c) ? null : (row[c] ?? null))),
  );
  return dest
    .prepare(
      `INSERT INTO "${table.name}" (${columnList}) VALUES ${rows.map(() => tuple).join(',')}`,
    )
    .bind(...values);
}

/** Second-pass UPDATEs that restore the self-ref values once all rows of the table
 * exist (the parents of a self-FK are sibling rows). Empty unless the table has a
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

async function runInBatches(
  dest: D1Database,
  statements: D1PreparedStatement[],
  perBatch: number,
): Promise<void> {
  for (let i = 0; i < statements.length; i += perBatch) {
    await dest.batch(statements.slice(i, i + perBatch));
  }
}

/** Replace the destination's data with the source's, table by table. Caller has
 * already preflighted (schema match, query budget, confirmation) — this just
 * executes. */
export async function copyExecute(
  source: D1Database,
  dest: D1Database,
  plan: CopyPlan,
): Promise<CopyResult> {
  const { schema } = plan;
  // 1. Clear the destination atomically: null self-refs first (so a self-FK row's
  //    DELETE can't trip RESTRICT), then DELETE child-first.
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
  await dest.batch(clear);

  // 2. Reload parent-first, one page in memory at a time. Inserts null self-refs;
  //    a final pass restores them (only `vendor_requests` has one, and it is small).
  const perTable: Record<string, number> = {};
  const deferredSelfRefUpdates: D1PreparedStatement[] = [];
  let inserted = 0;

  for (const sizing of plan.tables) {
    const table = schema.tablesByName.get(sizing.table)!;
    let copied = 0;
    for await (const page of readPages(source, table.name, sizing.readPage)) {
      const statements: D1PreparedStatement[] = [];
      for (let i = 0; i < page.length; i += sizing.rowsPerStatement) {
        statements.push(insertStatement(dest, table, page.slice(i, i + sizing.rowsPerStatement)));
      }
      await runInBatches(dest, statements, sizing.statementsPerBatch);
      deferredSelfRefUpdates.push(...selfRefUpdates(dest, table, page));
      copied += page.length;
    }
    perTable[table.name] = copied;
    inserted += copied;
  }

  // 3. Restore self-references now that every row exists.
  await runInBatches(dest, deferredSelfRefUpdates, MAX_BATCH_STATEMENTS);

  return { inserted, perTable };
}
