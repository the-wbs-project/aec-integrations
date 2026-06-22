/**
 * In-memory D1 test harness (ADR 0016 / AECI-253). Spins a real SQLite database
 * via better-sqlite3, applies the actual generated Drizzle migrations, and
 * returns a Drizzle client cast to the production `Db` type plus a `DbFactory` to
 * inject into route-handler factories. Specs seed real rows and assert real query
 * + mapper output — far more faithful than mocking the client, and the relational
 * query builder parses correctly here (sql.js does not).
 *
 * `db.batch()` is D1-only; better-sqlite3 is synchronous and has none, so we shim
 * it to run the statements inside one better-sqlite3 transaction (atomic, rolls
 * back on a thrown constraint error). That preserves the Spec §26.1 audit-in-tx
 * invariant the write paths rely on. Handlers must therefore NOT depend on batch
 * RETURN values (generate ids up front) — the shim returns `[]`; this is also the
 * cleaner production pattern.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { Db, DbContext } from '../db/client';
import { schema } from '../db/schema';
import type { DbFactory } from '../lib/handler-utils';

// Every committed migration, in order, split into individual statements on
// Drizzle's `--> statement-breakpoint` marker. cwd is the `apps/api` package
// when vitest runs.
const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
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

type Stmt = { run: () => unknown };

export interface TestDb {
  /** Drizzle client over the in-memory DB, typed as the production `Db`. */
  db: Db;
  /** `{ db, getBookmark }` — the shape route handlers consume. */
  dbCtx: DbContext;
  /** Inject into a handler factory: `createXHandler(testDb.factory)`. */
  factory: DbFactory;
  /** Underlying better-sqlite3 handle (for raw seeding / teardown). */
  raw: Database.Database;
  dispose(): void;
}

/** Build a fresh, migrated, empty in-memory D1. Call per test (cheap, sync init). */
export async function makeTestDb(): Promise<TestDb> {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const stmt of migrationStatements()) raw.prepare(stmt).run();

  const sqlDb = drizzle(raw, { schema });

  // Shim the D1-only `batch()` onto the sync better-sqlite3 client (see header).
  (sqlDb as unknown as { batch: (stmts: ReadonlyArray<Stmt>) => Promise<unknown[]> }).batch =
    async (stmts) => {
      const runAll = raw.transaction(() => {
        for (const stmt of stmts) stmt.run();
      });
      runAll(); // throws → transaction rolls back → returned promise rejects
      return [];
    };

  const db = sqlDb as unknown as Db;
  const dbCtx: DbContext = { db, getBookmark: () => null };
  return { db, dbCtx, factory: () => dbCtx, raw, dispose: () => raw.close() };
}
