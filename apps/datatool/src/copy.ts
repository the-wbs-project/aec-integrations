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
 * (replace is idempotent). All current data fits this comfortably.
 */

import { compareSchemas, introspect, type Schema, type TableInfo } from './introspect';

/** Inserts/updates per D1 batch. One statement per row (≤ ~40 cols ≪ 100 bound
 * params/statement), so a batch of this many statements stays well within limits. */
const BATCH_STATEMENTS = 50;
/** Keyset read page size. */
const READ_PAGE = 2000;

type Row = Record<string, unknown>;

export interface TableCount {
  table: string;
  sourceRows: number;
  destRows: number;
}

export type CopyDryRun =
  | { ok: false; code: 'SCHEMA_MISMATCH'; messages: string[] }
  | {
      ok: true;
      schema: Schema;
      tables: TableCount[];
      totalSourceRows: number;
      totalDestRows: number;
    };

export interface CopyResult {
  inserted: number;
  perTable: Record<string, number>;
}

async function countRows(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM "${table}"`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Read every row of a table via rowid keyset pagination (index-free, stable).
 * Falls back to a single read for WITHOUT ROWID tables (none today). Table names
 * come from `sqlite_master`, so the interpolation is over trusted identifiers. */
async function readAllRows(db: D1Database, table: string): Promise<Row[]> {
  try {
    const out: Row[] = [];
    let after = 0;
    for (;;) {
      const { results } = await db
        .prepare(
          `SELECT rowid AS __rid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${READ_PAGE}`,
        )
        .bind(after)
        .all<Row & { __rid: number }>();
      if (results.length === 0) break;
      for (const r of results) {
        after = r.__rid;
        delete (r as Row).__rid;
        out.push(r);
      }
      if (results.length < READ_PAGE) break;
    }
    return out;
  } catch {
    const { results } = await db.prepare(`SELECT * FROM "${table}"`).all<Row>();
    return results;
  }
}

/** Preflight + per-table count diff. Default path of `POST /api/copy` (no writes). */
export async function copyDryRun(source: D1Database, dest: D1Database): Promise<CopyDryRun> {
  const [sourceSchema, destSchema] = [await introspect(source), await introspect(dest)];
  const messages = compareSchemas(sourceSchema, destSchema);
  if (messages.length) return { ok: false, code: 'SCHEMA_MISMATCH', messages };

  const tables: TableCount[] = [];
  let totalSourceRows = 0;
  let totalDestRows = 0;
  for (const table of sourceSchema.insertOrder) {
    const sourceRows = await countRows(source, table);
    const destRows = await countRows(dest, table);
    tables.push({ table, sourceRows, destRows });
    totalSourceRows += sourceRows;
    totalDestRows += destRows;
  }
  return { ok: true, schema: sourceSchema, tables, totalSourceRows, totalDestRows };
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

async function runInBatches(dest: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_STATEMENTS) {
    await dest.batch(statements.slice(i, i + BATCH_STATEMENTS));
  }
}

/** Replace the destination's data with the source's, table by table. Caller has
 * already preflighted (schema match, confirmation) — this just executes. */
export async function copyExecute(
  source: D1Database,
  dest: D1Database,
  schema: Schema,
): Promise<CopyResult> {
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

  // 2. Reload parent-first. Inserts null self-refs; a final pass restores them.
  const perTable: Record<string, number> = {};
  const deferredSelfRefUpdates: D1PreparedStatement[] = [];
  let inserted = 0;

  for (const name of schema.insertOrder) {
    const table = schema.tablesByName.get(name)!;
    const rows = await readAllRows(source, name);
    perTable[name] = rows.length;
    inserted += rows.length;
    if (rows.length === 0) continue;

    await runInBatches(
      dest,
      rows.map((row) => insertStatement(dest, table, row)),
    );
    deferredSelfRefUpdates.push(...selfRefUpdates(dest, table, rows));
  }

  // 3. Restore self-references now that every row exists.
  await runInBatches(dest, deferredSelfRefUpdates);

  return { inserted, perTable };
}
