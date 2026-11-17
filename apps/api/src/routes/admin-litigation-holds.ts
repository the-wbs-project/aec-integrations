/**
 * Litigation holds on `/admin/legal` (AECI-1638, counsel Q23a, ADR 0058). Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.22b, `docs/API_CONTRACTS.md` §6.10 "Litigation holds",
 * `docs/DATABASE_SCHEMA.md` §8.15.
 *
 *   GET  /api/admin/litigation-holds               every open hold, and the latest released
 *   POST /api/admin/litigation-holds               place one hold
 *   POST /api/admin/litigation-holds/:id/release   release one hold
 *
 * All behind `requireAdmin()` in `index.ts`. The two POSTs also carry `rateLimit('write')`
 * after the guard (`waf-rate-limits.md` §6.2). The GET is a read: no audit row, no limiter.
 * A hold is never public, so no write purges a cache.
 *
 * An open hold stops the legal retention prune (`lib/legal-retention-prune.ts`). Any open
 * hold pauses the four-year `audit_log` part. A vendor hold keeps that vendor's acceptance
 * and grant rows. A global hold keeps everything.
 *
 * ─── Place ────────────────────────────────────────────────────────────────────
 *
 *   1. The body (400). A vendor hold names a vendor row that exists (404 `NOT_FOUND`).
 *   2. An open hold of that scope already exists: 409 `LITIGATION_HOLD_EXISTS`. The early
 *      read answers most cases; the partial unique index answers a race, and its error maps
 *      to the same 409.
 *   3. ONE `db.batch`: the insert and its `litigation_hold.placed` audit row. Then the
 *      forward.
 *
 * ─── Release ──────────────────────────────────────────────────────────────────
 *
 *   1. The body (400). Then the row (404 `NOT_FOUND`), and a row already released (409
 *      `LITIGATION_HOLD_RELEASED`).
 *   2. ONE `db.batch`: a sentinel that aborts when the row was released after the read, the
 *      guarded UPDATE and its `litigation_hold.released` audit row. An abort is the same 409.
 *
 * The four-year audit prune never deletes `litigation_hold.*` audit rows on its own. Four
 * years after a release, the legal prune deletes the hold row and its audit rows together
 * (`lib/legal-retention-prune.ts`), because the reason can name a person.
 */

import {
  ApiErrorCode,
  CreateLitigationHoldRequestSchema,
  LITIGATION_HOLDS_RELEASED_LIMIT,
  LitigationHoldsResponseSchema,
  LitigationHoldWriteResponseSchema,
  ReleaseLitigationHoldRequestSchema,
  type LitigationHold,
  type LitigationHoldScope,
  type LitigationHoldsResponse,
  type LitigationHoldWriteResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import { litigationHolds, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';

type HoldContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;
type HoldRow = typeof litigationHolds.$inferSelect;

const AUDIT_SOURCE = 'admin-litigation-holds';
export const LITIGATION_HOLD_ENTITY_TYPE = 'litigation_hold';
export const LITIGATION_HOLD_PLACED_ACTION = 'litigation_hold.placed';
export const LITIGATION_HOLD_RELEASED_ACTION = 'litigation_hold.released';
/** The release sentinel's abort token, the `lib/notifications/switches.ts` shape. */
const RACE_TOKEN = 'litigation-hold-released';

export interface AdminLitigationHoldsDeps {
  now?: () => Date;
}

function toHold(row: HoldRow, vendorName: string | null): LitigationHold {
  return {
    id: row.id,
    scope: row.scope as LitigationHoldScope,
    vendor_id: row.vendorId,
    vendor_name: vendorName,
    reason: row.reason,
    matter_reference: row.matterReference,
    placed_by: row.placedBy,
    placed_at: row.placedAt,
    released_at: row.releasedAt,
    released_by: row.releasedBy,
    release_reason: row.releaseReason,
  };
}

function selectJoined(db: Db, where: SQL | undefined) {
  return db
    .select({ row: litigationHolds, vendorName: vendors.companyName })
    .from(litigationHolds)
    .leftJoin(vendors, eq(vendors.id, litigationHolds.vendorId))
    .where(where);
}

async function loadHold(db: Db, id: string): Promise<LitigationHold | null> {
  const [found] = await selectJoined(db, eq(litigationHolds.id, id));
  return found ? toHold(found.row, found.vendorName) : null;
}

async function parseBody<T>(c: HoldContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

function causeChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    parts.push(String((current as { message?: unknown }).message ?? current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** The partial unique indexes' error. D1 names the columns, SQLite may name the index. */
export function isOpenHoldConflict(error: unknown): boolean {
  return /UNIQUE constraint failed: litigation_holds\.|litigation_holds_open_(global|vendor)_idx/i.test(
    causeChain(error),
  );
}

const holdExists = (scope: LitigationHoldScope) =>
  new ApiError(
    409,
    ApiErrorCode.LITIGATION_HOLD_EXISTS,
    scope === 'global' ? 'A global hold is already open.' : 'This vendor already has an open hold.',
  );

const holdReleased = () =>
  new ApiError(409, ApiErrorCode.LITIGATION_HOLD_RELEASED, 'This hold was already released.');

/** `GET /api/admin/litigation-holds`. */
export function createAdminLitigationHoldsHandler(
  dbFor: DbFactory = getDb,
  deps: AdminLitigationHoldsDeps = {},
): (c: HoldContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const { db } = dbFor(c.env);
    const [open, released] = await db.batch([
      selectJoined(db, isNull(litigationHolds.releasedAt)).orderBy(
        desc(litigationHolds.placedAt),
        desc(litigationHolds.id),
      ),
      selectJoined(db, isNotNull(litigationHolds.releasedAt))
        .orderBy(desc(litigationHolds.releasedAt), desc(litigationHolds.id))
        .limit(LITIGATION_HOLDS_RELEASED_LIMIT),
    ]);
    const body: LitigationHoldsResponse = {
      generated_at: clock().toISOString(),
      open: open.map((r) => toHold(r.row, r.vendorName)),
      released: released.map((r) => toHold(r.row, r.vendorName)),
    };
    validateResponseInDev(c.env, () => {
      LitigationHoldsResponseSchema.parse(body);
    });
    return json(body);
  };
}

/** `POST /api/admin/litigation-holds`. */
export function createPlaceLitigationHoldHandler(
  dbFor: DbFactory = getDb,
  deps: AdminLitigationHoldsDeps = {},
): (c: HoldContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const session = c.get('auth');
    const payload = await parseBody(c, CreateLitigationHoldRequestSchema);
    const { db } = writeDb(c, dbFor);
    const vendorId = payload.scope === 'vendor' ? (payload.vendor_id ?? null) : null;

    let vendorName: string | null = null;
    if (vendorId) {
      const [vendor] = await db
        .select({ name: vendors.companyName })
        .from(vendors)
        .where(eq(vendors.id, vendorId));
      if (!vendor) throw notFoundError('vendor', { id: vendorId });
      vendorName = vendor.name;
    }
    const [existing] = await db
      .select({ id: litigationHolds.id })
      .from(litigationHolds)
      .where(
        and(
          isNull(litigationHolds.releasedAt),
          vendorId ? eq(litigationHolds.vendorId, vendorId) : eq(litigationHolds.scope, 'global'),
        ),
      );
    if (existing) throw holdExists(payload.scope);

    const nowIso = clock().toISOString();
    const row: HoldRow = {
      id: crypto.randomUUID(),
      scope: payload.scope,
      vendorId,
      reason: payload.reason,
      matterReference: payload.matter_reference,
      placedBy: session.userId,
      placedAt: nowIso,
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
      createdAt: nowIso,
    };
    const entry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: LITIGATION_HOLD_PLACED_ACTION,
      entityType: LITIGATION_HOLD_ENTITY_TYPE,
      entityId: row.id,
      vendorId,
      beforeState: null,
      afterState: {
        scope: row.scope,
        vendor_id: row.vendorId,
        matter_reference: row.matterReference,
        placed_at: row.placedAt,
      },
      metadata: { source: AUDIT_SOURCE, reason: row.reason },
    };
    try {
      await db.batch([db.insert(litigationHolds).values(row), auditInsert(db, entry)]);
    } catch (error) {
      if (isOpenHoldConflict(error)) throw holdExists(payload.scope);
      throw error;
    }
    forwardAuditBatch(c, [entry], [], AUDIT_SOURCE);

    const body: LitigationHoldWriteResponse = { hold: toHold(row, vendorName) };
    validateResponseInDev(c.env, () => {
      LitigationHoldWriteResponseSchema.parse(body);
    });
    return json(body, { status: 201 });
  };
}

/** True when the release batch failed because its sentinel fired. */
function isReleaseRace(error: unknown): boolean {
  return /malformed JSON/i.test(causeChain(error));
}

/** `POST /api/admin/litigation-holds/:id/release`. */
export function createReleaseLitigationHoldHandler(
  dbFor: DbFactory = getDb,
  deps: AdminLitigationHoldsDeps = {},
): (c: HoldContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id') ?? '';
    const payload = await parseBody(c, ReleaseLitigationHoldRequestSchema);
    const { db } = writeDb(c, dbFor);

    const current = await loadHold(db, id);
    if (!current) throw notFoundError('litigation_hold', { id });
    if (current.released_at !== null) throw holdReleased();

    const nowIso = clock().toISOString();
    const entry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: LITIGATION_HOLD_RELEASED_ACTION,
      entityType: LITIGATION_HOLD_ENTITY_TYPE,
      entityId: id,
      vendorId: current.vendor_id,
      beforeState: { released_at: null },
      afterState: { scope: current.scope, vendor_id: current.vendor_id, released_at: nowIso },
      metadata: { source: AUDIT_SOURCE, reason: payload.reason },
    };
    const sentinel = db
      .select({
        guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${litigationHolds}
          WHERE ${litigationHolds.id} = ${id} AND ${litigationHolds.releasedAt} IS NULL)
          THEN json(${RACE_TOKEN}) END`,
      })
      .from(sql`(SELECT 1)`);
    const stmts = [
      sentinel,
      db
        .update(litigationHolds)
        .set({ releasedAt: nowIso, releasedBy: session.userId, releaseReason: payload.reason })
        .where(and(eq(litigationHolds.id, id), isNull(litigationHolds.releasedAt))),
      auditInsert(db, entry),
    ];
    try {
      await db.batch(stmts as unknown as BatchTuple);
    } catch (error) {
      if (isReleaseRace(error)) throw holdReleased();
      throw error;
    }
    forwardAuditBatch(c, [entry], [], AUDIT_SOURCE);

    const body: LitigationHoldWriteResponse = {
      hold: {
        ...current,
        released_at: nowIso,
        released_by: session.userId,
        release_reason: payload.reason,
      },
    };
    validateResponseInDev(c.env, () => {
      LitigationHoldWriteResponseSchema.parse(body);
    });
    return json(body);
  };
}
