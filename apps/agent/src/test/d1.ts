/**
 * In-memory D1 test shim (datatool). Backs a real SQLite database via
 * better-sqlite3, applies the actual apps/api Drizzle migrations (so the schema,
 * foreign keys, and CHECK constraints are real), and exposes the SUBSET of the
 * `D1Database` interface the copy/seed/reindex engines use: `prepare().bind()
 * .all()/.first()/.run()` and `batch()`.
 *
 * No Drizzle here — datatool talks to D1 over the raw binding API, so the shim
 * mirrors that, not the ORM. `batch()` runs inside one better-sqlite3 transaction
 * (atomic; rolls back on a thrown constraint error), matching D1 batch semantics.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

// vitest runs with cwd = apps/datatool; the migrations live in the sibling api app.
const MIGRATIONS_DIR = join(process.cwd(), '..', 'api', 'migrations');

function migrationStatements(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const out: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const part of sql.split('--> statement-breakpoint')) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function coerce(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

class ShimStatement {
  constructor(
    private readonly raw: Database.Database,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): ShimStatement {
    return new ShimStatement(this.raw, this.sql, args.map(coerce));
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: object }> {
    const stmt = this.raw.prepare(this.sql);
    if (stmt.reader) {
      return { results: stmt.all(...this.args) as T[], success: true, meta: {} };
    }
    const info = stmt.run(...this.args);
    return { results: [] as T[], success: true, meta: { changes: info.changes } };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.raw.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
    if (row == null) return null;
    return (column ? (row[column] as T) : (row as unknown as T)) ?? null;
  }

  async run(): Promise<{ results: never[]; success: true; meta: object }> {
    const info = this.raw.prepare(this.sql).run(...this.args);
    return { results: [], success: true, meta: { changes: info.changes } };
  }

  /** Synchronous runner used inside `batch()`'s better-sqlite3 transaction. */
  runSync(): unknown {
    const stmt = this.raw.prepare(this.sql);
    return stmt.reader ? stmt.all(...this.args) : stmt.run(...this.args);
  }
}

class ShimDb {
  constructor(readonly raw: Database.Database) {}

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.raw, sql);
  }

  async batch(stmts: ShimStatement[]): Promise<unknown[]> {
    const runAll = this.raw.transaction(() => stmts.map((s) => s.runSync()));
    return runAll();
  }
}

export interface ShimHandle {
  /** The shim, typed as `D1Database` for the engines under test. */
  db: D1Database;
  /** Underlying better-sqlite3 handle (raw seeding / assertions). */
  raw: Database.Database;
  dispose(): void;
}

/** A fresh, migrated, empty in-memory D1 shim. */
export function makeShimDb(): ShimHandle {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const stmt of migrationStatements()) raw.prepare(stmt).run();
  const db = new ShimDb(raw) as unknown as D1Database;
  return { db, raw, dispose: () => raw.close() };
}
