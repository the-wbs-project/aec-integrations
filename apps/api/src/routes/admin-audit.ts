/**
 * `GET /api/admin/audit` (AECI-653): the global admin audit-log viewer. Source of
 * truth: `docs/API_CONTRACTS.md` §6.10, `docs/STAGE_1_SPEC.md` §26.7.
 *
 * `audit_log` is written by every domain-state write and kept forever. Until now
 * it had three scoped read surfaces (the vendor, claim and connector-catalogue
 * trails) and no global one. An operator asking "who changed this, and what was
 * it before" had to write D1 SQL by hand. This is the unscoped, filterable read.
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row
 * (ADR 0022 scopes the audit rule to domain-state writes), no `rateLimit()`
 * (reads are never rate-limited), no caching (`json()` sets `private, no-store`).
 *
 * The division of labour matches the claim and connector trails. This handler
 * parses the query, builds `where` and the cursor `paging`. `readAdminAuditPage`
 * runs the page and count `db.batch`, the actor lookup, the GoTrue email seam and
 * the row mapping.
 *
 * ─── Paging (ADR 0046) ────────────────────────────────────────────────────────
 *
 * Keyset cursors, not `page`. The claim and connector trails stay on offset
 * paging; this is the only caller of the reader's cursor branch.
 *
 * - **Cursor rule.** `after` is the page that follows that row in `order`,
 *   `before` the page that precedes it. One or neither, never both (400). The
 *   wire form is `"<created_at>|<id>"` and the reader binds its two halves as
 *   values in a row-value comparison on `(created_at, id)`.
 * - **Order rule.** `order=desc` (default) or `asc` sorts `created_at` and then
 *   `id` in the SAME direction, so the pair is one total order and a cursor
 *   names exactly one position in it.
 * - **Count flag.** `count=1` (default) adds the `count()` of the filtered set,
 *   ignoring the cursor, to the batch. `count=0` skips it and returns
 *   `total: null`, so a client paging through a known set does not pay for a
 *   re-count on every page.
 *
 * ─── Index discipline ─────────────────────────────────────────────────────────
 *
 * Every allowed filter shape starts from an index. The two shapes that cannot
 * (`entity_id` without `entity_type`, and `actor_type` on its own) are refused
 * by `AdminAuditLogQuerySchema` as 400 `VALIDATION_FAILED`. The table of filter
 * to index lives on that schema. `admin-audit.spec.ts` runs `EXPLAIN QUERY PLAN`
 * on every allowed shape, in both orders and with each cursor. A filtered page
 * must plan as an index `SEARCH`, and so must a page with only a cursor. Only
 * an unfiltered `count()` may `SCAN`, and only along `audit_log_created_at_idx`.
 *
 * `created_at` is a JS ISO string (`2026-10-23T12:34:56.789Z`), so the inclusive
 * day range compares lexically: `created_at >= 'from'` and
 * `created_at < 'the day after to'`. Both bounds are bare `YYYY-MM-DD` strings,
 * which sort before any timestamp on the same day.
 */

import {
  AdminAuditLogQuerySchema,
  AdminAuditLogResponseSchema,
  type AdminAuditLogQuery,
} from '@aeci/shared';
import { and, eq, gte, lt, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { auditLog } from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import {
  readAdminAuditPage,
  type AdminAuditCursorPaging,
  type FetchAuthEmails,
} from '../lib/admin-audit-page';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { fetchAuthUserEmailsResult } from '../lib/supabase-admin';

type AdminContext = Context<{ Bindings: Env }>;

/** The UTC day after `day` (`YYYY-MM-DD`). `day` is a real calendar day, the
 *  schema checks that, so the arithmetic cannot roll over silently. */
function nextUtcDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The `where` for a parsed query, or `undefined` when no filter is set. Exported
 * so the spec can EXPLAIN the same predicate the handler sends.
 */
export function adminAuditLogWhere(query: {
  entity_type?: string;
  entity_id?: string;
  action?: string;
  actor_id?: string;
  actor_type?: string;
  from?: string;
  to?: string;
}): SQL | undefined {
  const conditions: SQL[] = [];
  if (query.entity_type !== undefined) conditions.push(eq(auditLog.entityType, query.entity_type));
  if (query.entity_id !== undefined) conditions.push(eq(auditLog.entityId, query.entity_id));
  if (query.action !== undefined) conditions.push(eq(auditLog.action, query.action));
  if (query.actor_id !== undefined) conditions.push(eq(auditLog.actorId, query.actor_id));
  if (query.actor_type !== undefined) conditions.push(eq(auditLog.actorType, query.actor_type));
  if (query.from !== undefined) conditions.push(gte(auditLog.createdAt, query.from));
  if (query.to !== undefined) conditions.push(lt(auditLog.createdAt, nextUtcDay(query.to)));
  return conditions.length === 0 ? undefined : and(...conditions);
}

/** The reader's cursor `paging` for a parsed query. Exported for the spec. */
export function adminAuditLogPaging(query: AdminAuditLogQuery): AdminAuditCursorPaging {
  return {
    kind: 'cursor',
    perPage: query.perPage,
    order: query.order,
    after: query.after,
    before: query.before,
    count: query.count === 1,
  };
}

export function createAdminAuditLogHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthEmails = fetchAuthUserEmailsResult,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = AdminAuditLogQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const body = await readAdminAuditPage(
      db,
      c.env,
      adminAuditLogWhere(query),
      adminAuditLogPaging(query),
      fetchEmails,
    );

    validateResponseInDev(c.env, () => {
      AdminAuditLogResponseSchema.parse(body);
    });
    return json(body);
  };
}
