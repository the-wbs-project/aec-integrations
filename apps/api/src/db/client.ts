// Drizzle/D1 client factory (ADR 0016 / AECI-252, AECI-253) — one Drizzle client
// per request, bound to the Worker's `env.DB` D1 binding (no external proxy, no
// `nodejs_compat`). Replaces the former Prisma Accelerate per-request factory.
//
// Sessions API (AECI-250): D1 read replication + read-your-writes is threaded via
// a session bookmark. The factory returns a `DbContext` whose shape already
// carries the `getBookmark()` seam, so adopting the Sessions API later does NOT
// touch the ~195 call sites — only this file changes. Until that hardening lands
// (and because local `wrangler dev` runs a single un-replicated SQLite where
// read-your-writes is automatic), the factory uses the plain binding and
// `getBookmark()` returns null. See ADR 0016 "Risks / open questions" #1.

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { schema } from './schema';

export type Db = DrizzleD1Database<typeof schema>;

export interface DbContext {
  /** Request-scoped Drizzle client over the D1 binding. */
  db: Db;
  /**
   * Bookmark to persist (e.g. into a response header) so a subsequent request can
   * resume this logical session for read-your-writes. Null while the plain
   * binding is in use (local dev + pre-AECI-250); wired to
   * `session.getBookmark()` when the Sessions API is adopted.
   */
  getBookmark(): string | null;
}

/**
 * Build a request-scoped Drizzle client. `bookmark` is accepted now (forward
 * seam) but unused until the Sessions API hardening; pass the inbound
 * `x-d1-bookmark` header value through it then.
 */
export function getDb(env: Env, _bookmark?: string | null): DbContext {
  if (!env.DB) {
    // Fail loud: a request-path call without the binding is a misconfiguration,
    // not a graceful-degradation case (unlike the optional KV cache).
    throw new Error('D1 binding `DB` is not configured (ADR 0016 / AECI-252)');
  }
  const db = drizzle(env.DB, { schema });
  return {
    db,
    getBookmark: () => null,
  };
}
