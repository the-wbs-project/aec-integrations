/**
 * Runtime D1 schema introspection — the copy engine is table-agnostic so it stays
 * correct as the schema evolves. Reads the live database (not a hardcoded list):
 *   - user tables from `sqlite_master` (excluding SQLite + Cloudflare internals
 *     and `d1_migrations`, which each database owns separately),
 *   - column order from `pragma_table_info`,
 *   - foreign-key edges from `pragma_foreign_key_list`,
 * then topologically sorts so parents insert before children (and the reverse for
 * deletes). The only cycle in the schema is `vendor_requests`'s nullable self-FK,
 * which is handled by null-then-update in the copy engine — cross-table FKs form a
 * DAG, so ordering is the correctness contract (no reliance on deferred FKs).
 */

/** Table names that are never user data: SQLite internals (`sqlite_%`),
 * Cloudflare D1 internals (`_cf_%`), and the per-database migration ledger. */
const EXCLUDE_TABLES_SQL =
  "name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'";

export interface TableInfo {
  name: string;
  /** Column names in `cid` order — used verbatim for SELECT/INSERT alignment. */
  columns: string[];
  /** Primary-key columns in key order — targets the self-ref second-pass UPDATE. */
  pkColumns: string[];
  /** Distinct parent tables this table references (self excluded). */
  references: string[];
  /** FK columns that point back at THIS table (the self-ref to null-then-update). */
  selfRefColumns: string[];
}

export interface Schema {
  tablesByName: Map<string, TableInfo>;
  /** Parent-before-child order (inserts). */
  insertOrder: string[];
  /** Child-before-parent order (deletes) — reverse of insertOrder. */
  deleteOrder: string[];
}

function sqlStringLiteral(s: string): string {
  return s.replaceAll("'", "''");
}

/** User tables in name order (internals excluded). */
export async function listUserTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND ${EXCLUDE_TABLES_SQL} ORDER BY name`,
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function readTableInfo(db: D1Database, name: string): Promise<TableInfo> {
  const lit = sqlStringLiteral(name);
  const cols = await db
    .prepare(`SELECT name, pk FROM pragma_table_info('${lit}') ORDER BY cid`)
    .all<{ name: string; pk: number }>();
  const columns = cols.results.map((r) => r.name);
  const pkColumns = cols.results
    .filter((r) => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => r.name);

  const fks = await db
    .prepare(`SELECT "table" AS parent, "from" AS fromcol FROM pragma_foreign_key_list('${lit}')`)
    .all<{ parent: string; fromcol: string }>();
  const references = [
    ...new Set(fks.results.filter((r) => r.parent !== name).map((r) => r.parent)),
  ];
  const selfRefColumns = [
    ...new Set(fks.results.filter((r) => r.parent === name).map((r) => r.fromcol)),
  ];

  return { name, columns, pkColumns, references, selfRefColumns };
}

/** Kahn's algorithm over the parent→child edges; deterministic (name-sorted). A
 * leftover (a real cross-table cycle, which the schema doesn't have) is appended
 * in name order rather than dropped, so nothing is silently skipped. */
function topoSort(tables: Map<string, TableInfo>): string[] {
  const names = [...tables.keys()].sort();
  const indegree = new Map<string, number>(names.map((n) => [n, 0]));
  const children = new Map<string, string[]>(names.map((n) => [n, []]));

  for (const table of tables.values()) {
    for (const parent of table.references) {
      if (parent === table.name || !tables.has(parent)) continue;
      children.get(parent)!.push(table.name);
      indegree.set(table.name, (indegree.get(table.name) ?? 0) + 1);
    }
  }

  const queue = names.filter((n) => (indegree.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const child of children.get(n) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  for (const n of names) if (!order.includes(n)) order.push(n);
  return order;
}

export async function introspect(db: D1Database): Promise<Schema> {
  const names = await listUserTables(db);
  const tablesByName = new Map<string, TableInfo>();
  for (const name of names) tablesByName.set(name, await readTableInfo(db, name));
  const insertOrder = topoSort(tablesByName);
  return { tablesByName, insertOrder, deleteOrder: [...insertOrder].reverse() };
}

/** Human-readable schema differences (empty array = identical). Compares the table
 * set and each table's ordered column list — the things a row-level copy depends
 * on. A non-empty result aborts the copy (SCHEMA_MISMATCH) rather than producing a
 * half-broken clone (e.g. one env migrated ahead of the other). */
export function compareSchemas(source: Schema, dest: Schema): string[] {
  const messages: string[] = [];
  for (const name of source.tablesByName.keys()) {
    if (!dest.tablesByName.has(name)) messages.push(`table "${name}" missing in destination`);
  }
  for (const name of dest.tablesByName.keys()) {
    if (!source.tablesByName.has(name)) messages.push(`table "${name}" missing in source`);
  }
  for (const [name, src] of source.tablesByName) {
    const dst = dest.tablesByName.get(name);
    if (!dst) continue;
    const a = src.columns.join(',');
    const b = dst.columns.join(',');
    if (a !== b) messages.push(`table "${name}" columns differ (source: ${a} | dest: ${b})`);
  }
  return messages;
}
