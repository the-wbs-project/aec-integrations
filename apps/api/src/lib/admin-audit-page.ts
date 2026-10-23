/**
 * One page of an entity's audit trail, shaped for `<aec-audit-trail>`.
 *
 * Shared by the single-disjunct admin audit reads: the connector catalogue's
 * (`GET /api/admin/connector-catalogs/:id/audit`), the claim's
 * (`GET /api/admin/claims/:id/audit`, AECI-1276), and the global viewer
 * (`GET /api/admin/audit`, AECI-653). Each scoped caller owns its own 404 gate,
 * and every caller owns its own `where`. The global viewer has no gate and may
 * pass `undefined`. This reader owns everything after the gate: the page
 * and count `db.batch`, the actor-name lookup, the email seam, and the row
 * mapping. The vendor trail (`admin-vendors.ts`) keeps its own code because it
 * ORs four disjuncts and carries a scope filter.
 *
 * Two paging modes, chosen by a discriminated `paging` argument:
 *
 * - **offset** (`{ page, perPage }`, no `kind`): the claim and connector trails.
 *   Ordered `created_at DESC, id DESC`, `LIMIT perPage OFFSET (page - 1) * perPage`,
 *   always counted. Those callers pass their parsed `PageQuerySchema` object
 *   unchanged, so the missing `kind` is what selects this branch.
 * - **cursor** (`{ kind: 'cursor', … }`): the global viewer only (ADR 0046). A
 *   keyset walk over `(created_at, id)`, see `cursorPageQuery`.
 *
 * The tiebreaker matters in both: `created_at` is a JS-stamped ISO string and
 * two rows from one `db.batch` routinely share a millisecond.
 */

import { encodeAuditCursor, type AdminAuditRow, type AuditCursor } from '@aeci/shared';
import { and, asc, count, desc, inArray, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { auditLog, profiles } from '../db/schema';
import type { Env } from '../env';
import type { AuthEmailLookup } from './supabase-admin';

/** The email seam in its availability-reporting form. */
export type FetchAuthEmails = (env: Env, ids: readonly string[]) => Promise<AuthEmailLookup>;

/** Offset paging, as the scoped trails parse it. `kind` is absent there. */
export interface AdminAuditOffsetPaging {
  kind?: 'offset';
  page: number;
  perPage: number;
}

/** Keyset paging for the global viewer. At most one of `after` / `before`. */
export interface AdminAuditCursorPaging {
  kind: 'cursor';
  perPage: number;
  order: 'asc' | 'desc';
  after?: AuditCursor;
  before?: AuditCursor;
  /** `false` skips the `count()`; the page then reports `total: null`. */
  count: boolean;
}

export type AdminAuditPaging = AdminAuditOffsetPaging | AdminAuditCursorPaging;

interface AdminAuditPageBase {
  data: AdminAuditRow[];
  perPage: number;
  actor_emails_available: boolean;
}

/** An offset page: the claim and connector trails' envelope. */
export interface AdminAuditPage extends AdminAuditPageBase {
  page: number;
  total: number;
}

/** A keyset page: the global viewer's envelope (`AdminAuditLogResponseSchema`). */
export interface AdminAuditCursorPage extends AdminAuditPageBase {
  total: number | null;
  has_next: boolean;
  has_prev: boolean;
  next_cursor: string | null;
  prev_cursor: string | null;
}

const PAGE_COLUMNS = {
  id: auditLog.id,
  action: auditLog.action,
  actorId: auditLog.actorId,
  actorType: auditLog.actorType,
  entityType: auditLog.entityType,
  entityId: auditLog.entityId,
  createdAt: auditLog.createdAt,
  beforeState: auditLog.beforeState,
  afterState: auditLog.afterState,
};

/**
 * The keyset page query.
 *
 * ORDER BY `created_at` and `id`, both in one direction. This differs from
 * `resolveAdminUserOrderBy` (`lib/sort.ts`), whose `id` tiebreak stays put when
 * the primary flips: a keyset comparison needs one total order, so the tiebreak
 * flips with the primary.
 *
 * The cursor predicate is the row-value comparison
 * `(created_at, id) < (?, ?)` (or `>`). SQLite turns its leading term into a
 * `created_at` range on whichever index the filters chose, so every shape stays
 * an index SEARCH. The expanded `created_at < ? OR (created_at = ? AND id < ?)`
 * plans as a MULTI-INDEX OR and drops the range on the composite indexes, so it
 * is not used (ADR 0046).
 *
 * `before` walks the other way from `order` and the caller reverses the rows.
 * `LIMIT perPage + 1`: the extra row only says whether more rows exist.
 */
function cursorPageQuery(db: Db, where: SQL | undefined, paging: AdminAuditCursorPaging) {
  const cursor = paging.before ?? paging.after;
  // The scan runs in `order` for a forward page and against it for a `before` page.
  const scanDesc = (paging.order === 'desc') === (paging.before === undefined);
  const cursorWhere = cursor
    ? sql`(${auditLog.createdAt}, ${auditLog.id}) ${sql.raw(scanDesc ? '<' : '>')} (${cursor.createdAt}, ${cursor.id})`
    : undefined;
  const dir = scanDesc ? desc : asc;
  return db
    .select(PAGE_COLUMNS)
    .from(auditLog)
    .where(and(where, cursorWhere))
    .orderBy(dir(auditLog.createdAt), dir(auditLog.id))
    .limit(paging.perPage + 1);
}

/**
 * The page and count queries, unexecuted. Exported so `routes/admin-audit.spec.ts`
 * can run `EXPLAIN QUERY PLAN` on the exact SQL this reader sends. `total` is
 * `null` when a cursor caller asked for no count. The count never carries the
 * cursor: it is the size of the filtered set.
 */
export function adminAuditPageQueries(
  db: Db,
  where: SQL | undefined,
  paging: AdminAuditOffsetPaging,
): { page: ReturnType<typeof offsetPageQuery>; total: ReturnType<typeof countQuery> };
export function adminAuditPageQueries(
  db: Db,
  where: SQL | undefined,
  paging: AdminAuditCursorPaging,
): { page: ReturnType<typeof cursorPageQuery>; total: ReturnType<typeof countQuery> | null };
export function adminAuditPageQueries(db: Db, where: SQL | undefined, paging: AdminAuditPaging) {
  if (paging.kind === 'cursor') {
    return {
      page: cursorPageQuery(db, where, paging),
      total: paging.count ? countQuery(db, where) : null,
    };
  }
  return { page: offsetPageQuery(db, where, paging), total: countQuery(db, where) };
}

function countQuery(db: Db, where: SQL | undefined) {
  return db.select({ value: count() }).from(auditLog).where(where);
}

function offsetPageQuery(db: Db, where: SQL | undefined, paging: AdminAuditOffsetPaging) {
  return db
    .select(PAGE_COLUMNS)
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(paging.perPage)
    .offset((paging.page - 1) * paging.perPage);
}

type PageRow = Awaited<ReturnType<typeof cursorPageQuery>>[number];

export function readAdminAuditPage(
  db: Db,
  env: Env,
  where: SQL | undefined,
  paging: AdminAuditOffsetPaging,
  fetchEmails: FetchAuthEmails,
): Promise<AdminAuditPage>;
export function readAdminAuditPage(
  db: Db,
  env: Env,
  where: SQL | undefined,
  paging: AdminAuditCursorPaging,
  fetchEmails: FetchAuthEmails,
): Promise<AdminAuditCursorPage>;
export async function readAdminAuditPage(
  db: Db,
  env: Env,
  where: SQL | undefined,
  paging: AdminAuditPaging,
  fetchEmails: FetchAuthEmails,
): Promise<AdminAuditPage | AdminAuditCursorPage> {
  if (paging.kind !== 'cursor') {
    const queries = adminAuditPageQueries(db, where, paging);
    const [rows, totals] = await db.batch([queries.page, queries.total]);
    return {
      ...(await mapRows(db, env, rows, fetchEmails)),
      page: paging.page,
      perPage: paging.perPage,
      total: totals[0]?.value ?? 0,
    };
  }

  const queries = adminAuditPageQueries(db, where, paging);
  let fetched: PageRow[];
  let total: number | null = null;
  if (queries.total) {
    const [rows, totals] = await db.batch([queries.page, queries.total]);
    fetched = rows;
    total = totals[0]?.value ?? 0;
  } else {
    [fetched] = await db.batch([queries.page]);
  }

  const backward = paging.before !== undefined;
  const more = fetched.length > paging.perPage;
  const rows = fetched.slice(0, paging.perPage);
  if (backward) rows.reverse();

  // A forward page has rows behind it exactly when it came from a cursor. A
  // `before` page has rows ahead of it by construction: the cursor row itself.
  const hasNext = backward ? true : more;
  const hasPrev = backward ? more : paging.after !== undefined;
  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    ...(await mapRows(db, env, rows, fetchEmails)),
    perPage: paging.perPage,
    total,
    has_next: hasNext,
    has_prev: hasPrev,
    next_cursor: hasNext && last ? encodeAuditCursor(last) : null,
    prev_cursor: hasPrev && first ? encodeAuditCursor(first) : null,
  };
}

/** The actor-name lookup, the email seam and the row mapping, for one page. */
async function mapRows(
  db: Db,
  env: Env,
  rows: PageRow[],
  fetchEmails: FetchAuthEmails,
): Promise<{ data: AdminAuditRow[]; actor_emails_available: boolean }> {
  // Bounded by `perPage`, not by how much history the entity has.
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => !!v))];
  const [actorRows, lookup] = await Promise.all([
    actorIds.length === 0
      ? Promise.resolve([] as { id: string; displayName: string | null }[])
      : db
          .select({ id: profiles.id, displayName: profiles.displayName })
          .from(profiles)
          .where(inArray(profiles.id, actorIds)),
    fetchEmails(env, actorIds),
  ]);
  const namesById = new Map(actorRows.map((r) => [r.id, r.displayName]));

  return {
    data: rows.map(
      (row): AdminAuditRow => ({
        id: row.id,
        action: row.action,
        // A row with no actor id (a sync run, a workflow step, an anonymous
        // submission) is `null`. `null` means "not a known person", never
        // "person unknown".
        actor: row.actorId
          ? {
              id: row.actorId,
              display_name: namesById.get(row.actorId) ?? null,
              email: lookup.emails.get(row.actorId) ?? null,
            }
          : null,
        actor_type: row.actorType,
        entity_type: row.entityType,
        entity_id: row.entityId,
        created_at: row.createdAt,
        before_state: row.beforeState ?? null,
        after_state: row.afterState ?? null,
      }),
    ),
    actor_emails_available: lookup.available,
  };
}
