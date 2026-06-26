// Drizzle/D1 client factory (ADR 0016 / AECI-252, AECI-253) — one Drizzle client
// per request, bound to the Worker's `env.DB` D1 binding (no external proxy, no
// `nodejs_compat`). Replaces the former Prisma Accelerate per-request factory.
//
// Sessions API (AECI-250): D1 read replication + read-your-writes is now wired
// through `env.DB.withSession(anchor)`. Reads default to the `'first-unconstrained'`
// anchor so the first query can be served by the nearest replica (the edge
// read-latency win — ADR 0016's headline driver); write paths anchor at
// `'first-primary'` (and pass any inbound `x-d1-bookmark`) so a pre-write read
// sees the latest version and intra-request read-your-writes holds. `getBookmark()`
// returns `session.getBookmark()`, which the API Worker emits as the outbound
// `x-d1-bookmark` header (see `bookmark-middleware.ts`).
//
// Drizzle doesn't (yet) accept a `D1DatabaseSession` in its public types
// (drizzle-team/drizzle-orm #2226/#4522 are open), but its relational query
// builder and `db.batch([...])` only ever call `.prepare()` / `.batch()` on the
// client — both present on `D1DatabaseSession` — so `drizzle(session as unknown as
// D1Database, …)` is a runtime-shape contract that holds. `client.spec.ts` guards
// the cast structurally (Drizzle still builds a usable client over a
// session-shaped binding); the real query/batch path runs against D1 in prod.
//
// Fallback guard: `withSession` is prod-D1-only. Local `wrangler dev` runs a
// single un-replicated SQLite (read-your-writes is automatic) and the in-memory
// test harness mocks `env.DB` without `withSession`; in both, the factory uses the
// plain binding and `getBookmark()` returns `null`. So the perf win is prod-only
// by design (ADR 0016), and read replication must additionally be enabled
// per-database (dashboard/REST `read_replication:{mode:"auto"}`) before it appears.

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { schema } from './schema';

export type Db = DrizzleD1Database<typeof schema>;

/** D1 Sessions API session anchor (Cloudflare `D1SessionConstraint`). */
export type D1SessionAnchor = 'first-primary' | 'first-unconstrained';

export interface GetDbOptions {
  /**
   * Inbound `x-d1-bookmark` to resume a prior logical session for read-your-writes.
   * Takes precedence over `constraint` when present.
   */
  bookmark?: string | null;
  /**
   * Session anchor when no bookmark is supplied. Reads use `'first-unconstrained'`
   * (default — nearest replica, the latency win); writes pass `'first-primary'`
   * (latest version) via the `writeDb()` helper.
   */
  constraint?: D1SessionAnchor;
}

export interface DbContext {
  /** Request-scoped Drizzle client over the D1 binding (or a session over it). */
  db: Db;
  /**
   * Bookmark to persist (e.g. into the `x-d1-bookmark` response header) so a
   * subsequent request can resume this logical session for read-your-writes.
   * Returns `session.getBookmark()` on the Sessions-API path, or `null` on the
   * plain-binding fallback (local dev + the in-memory test harness).
   */
  getBookmark(): string | null;
}

/**
 * Build a request-scoped Drizzle client. Pass `{ bookmark }` (the inbound
 * `x-d1-bookmark`) and/or `{ constraint }` to anchor a D1 session; omit both for
 * the read default (`'first-unconstrained'`).
 */
export function getDb(env: Env, opts?: GetDbOptions): DbContext {
  if (!env.DB) {
    // Fail loud: a request-path call without the binding is a misconfiguration,
    // not a graceful-degradation case (unlike the optional KV cache).
    throw new Error('D1 binding `DB` is not configured (ADR 0016 / AECI-252)');
  }

  // Fallback: no Sessions API (local single SQLite / in-memory test harness).
  // Read-your-writes is automatic on a single DB, so this is correct — only the
  // replica-latency win is absent (prod-only by design).
  if (typeof env.DB.withSession !== 'function') {
    return {
      db: drizzle(env.DB, { schema }),
      getBookmark: () => null,
    };
  }

  const anchor: string = opts?.bookmark ?? opts?.constraint ?? 'first-unconstrained';
  const session = env.DB.withSession(anchor);
  return {
    // See the header comment: Drizzle reaches only `.prepare()` / `.batch()`,
    // both present on `D1DatabaseSession`, so the cast is runtime-safe.
    db: drizzle(session as unknown as D1Database, { schema }),
    getBookmark: () => session.getBookmark(),
  };
}
