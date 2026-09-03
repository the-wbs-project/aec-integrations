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
 * invariant the write paths rely on. WRITE handlers must still NOT depend on batch
 * return values (generate ids up front) — that is the cleaner production pattern
 * regardless.
 *
 * The shim does return one result **per statement**, positionally, because
 * `db.batch()` is not only a write construct: `GET /api/vendor/updates` (AECI-627)
 * batches six SELECTs to buy one D1 round trip instead of six, and a shim that
 * answered `[]` would make every cursor read `undefined` — the endpoint would
 * "pass" its specs while reporting that nothing ever changes. better-sqlite3 needs
 * the read/write split made explicit (`.run()` on a SELECT returns no rows;
 * `.all()` on an INSERT without RETURNING throws), so it is taken from the
 * statement's own compiled SQL rather than guessed from the builder type.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { Db, DbContext, GetDbOptions } from '../db/client';
import { schema } from '../db/schema';
import type { DbFactory } from '../lib/handler-utils';

// Every committed migration, in order, split into individual statements on
// Drizzle's `--> statement-breakpoint` marker. cwd is the `apps/api` package
// when vitest runs.
const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/** Committed migration filenames, in apply order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** One migration's statements, split on Drizzle's marker. Exported so a spec can
 *  apply a single migration to an ALREADY-SEEDED database — the only way to test a
 *  destructive migration honestly, since one that applies cleanly to an empty table
 *  proves nothing (`docs/migrations.md` §3.3a rule 3). */
export function statementsForMigration(file: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
}

function migrationStatements(upToExclusive?: string): string[] {
  const out: string[] = [];
  for (const file of migrationFiles()) {
    if (upToExclusive && file >= upToExclusive) break;
    out.push(...statementsForMigration(file));
  }
  return out;
}

type Stmt = {
  run: () => unknown;
  all?: () => unknown;
  toSQL?: () => { sql: string };
};

/** Does this statement return rows? Read off the compiled SQL, so a builder shape
 *  that cannot be introspected simply falls back to the write path. */
function returnsRows(stmt: Stmt): boolean {
  if (typeof stmt.all !== 'function' || typeof stmt.toSQL !== 'function') return false;
  return /^\s*(select|with)\b/i.test(stmt.toSQL().sql);
}

export interface TestDb {
  /** Drizzle client over the in-memory DB, typed as the production `Db`. */
  db: Db;
  /** `{ db, getBookmark }` — the shape route handlers consume. */
  dbCtx: DbContext;
  /** Inject into a handler factory: `createXHandler(testDb.factory)`. */
  factory: DbFactory;
  /** Underlying better-sqlite3 handle (for raw seeding / teardown). */
  raw: Database.Database;
  /** Apply one migration file by name, against whatever is already in the DB. */
  applyMigration(file: string): void;
  dispose(): void;
}

/**
 * Build a fresh, migrated, empty in-memory D1. Call per test (cheap, sync init).
 *
 * `opts.upToExclusive` stops BEFORE the named migration file, so a spec can seed
 * the pre-migration shape and then apply that one migration itself. Used to test
 * destructive migrations against non-empty data.
 */
export async function makeTestDb(opts: { upToExclusive?: string } = {}): Promise<TestDb> {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const stmt of migrationStatements(opts.upToExclusive)) raw.prepare(stmt).run();

  const sqlDb = drizzle(raw, { schema });

  // Shim the D1-only `batch()` onto the sync better-sqlite3 client (see header).
  (sqlDb as unknown as { batch: (stmts: ReadonlyArray<Stmt>) => Promise<unknown[]> }).batch =
    async (stmts) => {
      const runAll = raw.transaction(() => {
        const results: unknown[] = [];
        for (const stmt of stmts) {
          results.push(returnsRows(stmt) ? stmt.all?.() : stmt.run());
        }
        return results;
      });
      return runAll(); // throws → transaction rolls back → returned promise rejects
    };

  const db = sqlDb as unknown as Db;
  const dbCtx: DbContext = { db, getBookmark: () => null };
  return {
    db,
    dbCtx,
    factory: () => dbCtx,
    raw,
    applyMigration: (file: string) => {
      // `defer_foreign_keys` is the pragma D1 supports and the migration sets, but
      // better-sqlite3 resets it at each transaction boundary, so set it here too —
      // the harness runs statements outside an explicit transaction.
      raw.pragma('defer_foreign_keys = true');
      for (const stmt of statementsForMigration(file)) raw.prepare(stmt).run();
    },
    dispose: () => raw.close(),
  };
}

/**
 * A `DbFactory` over an existing `Db` that records the `opts` each call received
 * and lets a test set the bookmark `getBookmark()` reports. The in-memory harness
 * has no real D1 session, so this is how route specs assert the Sessions-API
 * threading (AECI-250): inbound `x-d1-bookmark` → `opts.bookmark`, the
 * `first-primary` write anchor, and the outbound `x-d1-bookmark` header.
 */
export interface RecordingFactory {
  /** Pass to a handler factory in place of `t.factory`. */
  factory: DbFactory;
  /** Every `opts` the factory was called with, in order (`{}` when omitted). */
  calls: GetDbOptions[];
  /** Set the bookmark the returned `DbContext.getBookmark()` reports. */
  setBookmark(bookmark: string | null): void;
}

export function recordingFactory(db: Db): RecordingFactory {
  const calls: GetDbOptions[] = [];
  let bookmark: string | null = null;
  const factory: DbFactory = (_env, opts) => {
    calls.push(opts ?? {});
    return { db, getBookmark: () => bookmark };
  };
  return {
    factory,
    calls,
    setBookmark: (b) => {
      bookmark = b;
    },
  };
}
