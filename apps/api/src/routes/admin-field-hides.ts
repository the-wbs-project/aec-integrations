/**
 * The single-value hide, "under review" (AECI-1238 section B, ADR 0052 amendment,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.7, `ADMIN_PANEL_SPEC.md` §5.7).
 *
 *   POST /api/admin/field-hides                  — hide one value (201).
 *   POST /api/admin/field-hides/:id/restore      — the value stands; show it again (200).
 *   POST /api/admin/field-hides/:id/status-reply — record the status reply (200).
 *   GET  /api/admin/vendors/:id/field-hides      — the vendor's active hides (200).
 *
 * AECi receives a public source saying one value on a vendor-held record is wrong. The
 * policy hides that value within two business days of the request and decides within
 * five. Hiding is an interim step while AECi verifies, not a finding that the value is
 * false. The public read masks the field to `null` (`lib/field-hides.ts`).
 *
 * Rules:
 *
 * 1. **Admin only, rate-limited after the guard.** `requireAdmin()` then
 *    `rateLimit('write')` on the three writes. The GET is a read: no limiter, no audit.
 * 2. **Vendor-held records only.** The §11d.5 held test (`loadTarget`). Anything else is
 *    `409 FIELD_HIDE_NOT_VENDOR_HELD`: promote writes it, so the review app fixes it.
 * 3. **One active hide per field.** A second is `409 FIELD_HIDE_ACTIVE`. The partial
 *    unique index `field_hides_active_key` backs the pre-read, and the hide row goes FIRST
 *    in its batch so a racing second hide rolls back whole.
 * 4. **One batch.** The hide row, the `<entity>.field_hidden` audit row (source, received
 *    date and both dues, `reasonVisibility: 'vendor'`) and the holder's `field_hidden`
 *    notice. A restore is the guarded clear (`hideClearStatements`), a `changes() = 0`
 *    sentinel that answers `409 FIELD_HIDE_CLEARED`, the `<entity>.field_hide_cleared` row
 *    (`clearKind: 'restored'`) and the notice. A status reply is one guarded audit row,
 *    `<entity>.field_hide_status_reply`: internal, never a vendor receipt.
 * 5. **After commit.** A hide and a restore change what the public page shows, so both
 *    purge the record's cache tags and re-sync its Algolia record by id behind promote's
 *    watchdog, exactly as a correction does (`afterCommitTargets`). A status reply
 *    changes nothing public: it forwards its row and nothing else.
 *
 * The other two clears live with their writers: an AECi correction
 * (`correctionHideClear` in `admin-field-overrides.ts`) and the vendor's own edit
 * (`vendorEditHideClears` in `lib/field-hides.ts`).
 */

import {
  AdminFieldHideResponseSchema,
  AdminFieldHidesResponseSchema,
  AdminFieldHideStatusReplySchema,
  AdminRestoreFieldHideSchema,
  AdminSetFieldHideSchema,
  ApiErrorCode,
  vendorVisibleReasonMetadata,
  type AdminFieldHide,
  type AdminFieldHideResponse,
  type AdminFieldHidesResponse,
  type AdminFieldHideStatusReplyEntry,
  type FieldHideClearKind,
  type FieldHideEntityType,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  auditLog,
  connectorEvidencedPairs,
  fieldHides,
  integrations,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { aeciOverrideNotificationAudit } from '../lib/aeci-override-notifications';
import { auditInsert, auditInsertWhere, type BatchStmt, type BatchTuple } from '../lib/audit';
import { vendorAuditStamp } from '../lib/audit-vendor';
import { auditActorType } from '../lib/authz';
import { fieldHideDues } from '../lib/field-hide-dues';
import { fieldHideActionPrefix, hideClearStatements } from '../lib/field-hides';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import { retireSlugs } from '../lib/retire-target';
import {
  ADMIN_ORIGIN,
  FIELD_OVERRIDE_AUDIT_SOURCE,
  afterCommitTargets,
  fieldNoticeSubject,
  loadTarget,
  type OverrideTarget,
} from './admin-field-overrides';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { afterVendorWrite, parseJsonBody, type VendorContext } from './vendor-shared';

/** The token the restore and status-reply sentinels raise on a lost race. */
const FIELD_HIDE_CLEARED_TOKEN = 'field-hide-cleared';

const STATUS_REPLY_ACTION_SUFFIX = '.field_hide_status_reply';

/** Every status-reply action, by exact name so the read uses `audit_log_action_idx`. */
const STATUS_REPLY_ACTIONS = (['vendor', 'product', 'integration'] as const).map(
  (prefix) => `${prefix}${STATUS_REPLY_ACTION_SUFFIX}`,
);

function toAdminHide(
  row: typeof fieldHides.$inferSelect,
  entityName: string | null,
  lastStatusReply: AdminFieldHideStatusReplyEntry | null,
): AdminFieldHide {
  const dues = fieldHideDues(row.receivedAt);
  return {
    id: row.id,
    entity_type: row.entityType as FieldHideEntityType,
    entity_id: row.entityId,
    entity_name: entityName,
    field: row.field,
    reason: row.reason,
    internal_note: row.internalNote,
    source_url: row.sourceUrl,
    received_at: row.receivedAt,
    vendor_id: row.vendorId,
    set_by: row.setBy,
    set_at: row.setAt,
    cleared_by: row.clearedBy,
    cleared_at: row.clearedAt,
    clear_kind: (row.clearKind ?? null) as FieldHideClearKind | null,
    clear_reason: row.clearReason,
    hide_due: dues.hideDue,
    decide_due: dues.decideDue,
    last_status_reply: lastStatusReply,
  };
}

/** The latest status reply per hide id, from the audit log. */
async function lastStatusReplies(
  db: Db,
  hideIds: readonly string[],
): Promise<Map<string, AdminFieldHideStatusReplyEntry>> {
  const out = new Map<string, AdminFieldHideStatusReplyEntry>();
  if (hideIds.length === 0) return out;
  const hideIdOf = sql<string>`json_extract(${auditLog.metadata}, '$.fieldHideId')`;
  const rows = await db
    .select({
      hideId: hideIdOf,
      note: sql<string>`json_extract(${auditLog.metadata}, '$.note')`,
      at: auditLog.createdAt,
      by: auditLog.actorId,
    })
    .from(auditLog)
    .where(and(inArray(auditLog.action, STATUS_REPLY_ACTIONS), inArray(hideIdOf, [...hideIds])))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id));
  for (const row of rows) {
    if (!out.has(row.hideId)) out.set(row.hideId, { note: row.note, at: row.at, by: row.by });
  }
  return out;
}

async function readHide(db: Db, id: string, entityName: string | null): Promise<AdminFieldHide> {
  const row = await db.query.fieldHides.findFirst({ where: eq(fieldHides.id, id) });
  const replies = await lastStatusReplies(db, [id]);
  return toAdminHide(row!, entityName, replies.get(id) ?? null);
}

function hideActiveError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.FIELD_HIDE_ACTIVE,
    'This value is already hidden while AEC Integrations checks it.',
    { field: 'field' },
  );
}

function hideClearedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.FIELD_HIDE_CLEARED,
    'This hide has already ended. The value is back on the public page, or it was corrected.',
  );
}

function errorText(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let text = '';
  while (current && !seen.has(current)) {
    seen.add(current);
    text += ` ${String((current as { message?: unknown }).message ?? current)}`;
    current = (current as { cause?: unknown }).cause;
  }
  return text;
}

const isActiveHideConflict = (error: unknown) =>
  /field_hides_active_key|UNIQUE constraint failed: field_hides/.test(errorText(error));
const isClearedSentinel = (error: unknown) =>
  new RegExp(`malformed JSON|${FIELD_HIDE_CLEARED_TOKEN}`, 'i').test(errorText(error));

/** The pair slugs of an integration or pair target, for its notice. */
async function targetPairSlugs(
  db: Db,
  target: OverrideTarget | null,
): Promise<readonly [string, string] | null> {
  return target?.located ? (await retireSlugs(db, target.located)).pairSlugs : null;
}

/** Purge the record's tags and re-sync its search record, as a correction does. */
async function afterPublicChange(
  c: VendorContext,
  db: Db,
  target: OverrideTarget | null,
  audits: AuditLogEntry[],
  hookName: string,
): Promise<void> {
  if (!target) {
    afterVendorWrite(c, [], audits, undefined, db, ADMIN_ORIGIN);
    return;
  }
  const after = await afterCommitTargets(db, target, null);
  dispatchOwnerWriteSearch(
    c,
    hookName,
    syncOwnerWriteSearch(c, db, after.search, 'aeci.api.admin.field_hide_algolia_sync_failed'),
  );
  afterVendorWrite(c, after.tags, audits, undefined, db, ADMIN_ORIGIN);
}

// ─── POST /api/admin/field-hides ─────────────────────────────────────────────

export function createSetFieldHideHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const body = await parseJsonBody(c, AdminSetFieldHideSchema);
    const { db } = writeDb(c, dbFor);

    const target = await loadTarget(db, body.entityType, body.entityId);
    if (!target) {
      throw notFoundError(
        body.entityType === 'connector_evidenced_pair' ? 'integration' : body.entityType,
        { id: body.entityId },
      );
    }
    if (!target.vendorHeld) {
      throw new ApiError(
        409,
        ApiErrorCode.FIELD_HIDE_NOT_VENDOR_HELD,
        'No vendor holds this record, so promote and the review app write it. Correct it there instead.',
      );
    }

    const [existing, stamp, pairSlugs] = await Promise.all([
      db.query.fieldHides.findFirst({
        columns: { id: true },
        where: and(
          eq(fieldHides.entityType, body.entityType),
          eq(fieldHides.entityId, body.entityId),
          eq(fieldHides.field, body.field),
          isNull(fieldHides.clearedAt),
        ),
      }),
      vendorAuditStamp(db, target.holderVendorId),
      targetPairSlugs(db, target),
    ]);
    if (existing) throw hideActiveError();

    const now = new Date().toISOString();
    const hideId = crypto.randomUUID();
    const dues = fieldHideDues(body.receivedAt);
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: `${fieldHideActionPrefix(body.entityType)}.field_hidden`,
        entityType: body.entityType,
        entityId: body.entityId,
        ...stamp,
        ...(body.entityType === 'product' ? { productId: body.entityId } : {}),
        beforeState: { hidden: false },
        afterState: { hidden: true },
        metadata: {
          source: FIELD_OVERRIDE_AUDIT_SOURCE,
          field: body.field,
          fieldHideId: hideId,
          sourceUrl: body.sourceUrl,
          receivedAt: body.receivedAt,
          hideDue: dues.hideDue,
          decideDue: dues.decideDue,
          ...vendorVisibleReasonMetadata(body),
        },
      },
    ];
    if (target.holderVendorId) {
      audits.push(
        aeciOverrideNotificationAudit('portal-field-hidden-by-aeci', actor, {
          event: 'field_hidden',
          vendorId: target.holderVendorId,
          reason: body.reason,
          fieldHideId: hideId,
          field: body.field,
          ...fieldNoticeSubject(target, body.entityType, body.entityId, pairSlugs),
        }),
      );
    }

    const stmts: BatchStmt[] = [
      // The hide row FIRST: a racing second hide trips `field_hides_active_key` here
      // and the whole batch rolls back.
      db.insert(fieldHides).values({
        id: hideId,
        entityType: body.entityType,
        entityId: body.entityId,
        field: body.field,
        reason: body.reason,
        internalNote: body.internalNote ?? null,
        sourceUrl: body.sourceUrl,
        receivedAt: body.receivedAt,
        vendorId: target.holderVendorId,
        setBy: session.userId,
        setAt: now,
      }),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isActiveHideConflict(error)) throw hideActiveError();
      throw error;
    }

    await afterPublicChange(c, db, target, audits, 'admin-field-hide-algolia');

    const response: AdminFieldHideResponse = { hide: await readHide(db, hideId, target.name) };
    validateResponseInDev(c.env, () => AdminFieldHideResponseSchema.parse(response));
    return json(response, { status: 201 });
  };
}

// ─── POST /api/admin/field-hides/:id/restore ─────────────────────────────────

export function createRestoreFieldHideHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const body = await parseJsonBody(c, AdminRestoreFieldHideSchema);
    const { db } = writeDb(c, dbFor);

    const hide = await db.query.fieldHides.findFirst({ where: eq(fieldHides.id, id) });
    if (!hide) throw notFoundError('field_hide', { id });
    if (hide.clearedAt) throw hideClearedError();
    const entityType = hide.entityType as FieldHideEntityType;

    const [target, stamp] = await Promise.all([
      loadTarget(db, entityType, hide.entityId),
      vendorAuditStamp(db, hide.vendorId),
    ]);
    const pairSlugs = await targetPairSlugs(db, target);
    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const audit: AuditLogEntry = {
      ...actor,
      action: `${fieldHideActionPrefix(entityType)}.field_hide_cleared`,
      entityType,
      entityId: hide.entityId,
      ...stamp,
      ...(entityType === 'product' ? { productId: hide.entityId } : {}),
      beforeState: { cleared_at: null },
      afterState: { cleared_at: now, clear_kind: 'restored' },
      metadata: {
        source: FIELD_OVERRIDE_AUDIT_SOURCE,
        field: hide.field,
        fieldHideId: hide.id,
        clearKind: 'restored',
        ...vendorVisibleReasonMetadata(body),
      },
    };
    const audits: AuditLogEntry[] = [audit];
    // The vendor named on the hide is the one told: it was told when it was set.
    if (hide.vendorId) {
      audits.push(
        aeciOverrideNotificationAudit('portal-field-hide-cleared-by-aeci', actor, {
          event: 'field_hide_cleared',
          vendorId: hide.vendorId,
          reason: body.reason,
          fieldHideId: hide.id,
          field: hide.field,
          clearKind: 'restored',
          ...fieldNoticeSubject(target, entityType, hide.entityId, pairSlugs),
        }),
      );
    }

    try {
      await db.batch([
        ...hideClearStatements(db, hide.id, audit, {
          actorId: session.userId,
          at: now,
          kind: 'restored',
          reason: body.reason,
        }),
        // A double-click or a racing clear: the loser writes nothing.
        db
          .select({
            guard: sql`CASE WHEN changes() = 0 THEN json(${FIELD_HIDE_CLEARED_TOKEN}) END`,
          })
          .from(ONE_ROW),
        ...audits.slice(1).map((entry) => auditInsert(db, entry)),
      ] as BatchTuple);
    } catch (error) {
      if (isClearedSentinel(error)) throw hideClearedError();
      throw error;
    }

    await afterPublicChange(c, db, target, audits, 'admin-field-hide-restore-algolia');

    const response: AdminFieldHideResponse = {
      hide: await readHide(db, hide.id, target?.name ?? null),
    };
    validateResponseInDev(c.env, () => AdminFieldHideResponseSchema.parse(response));
    return json(response);
  };
}

// ─── POST /api/admin/field-hides/:id/status-reply ────────────────────────────

export function createFieldHideStatusReplyHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const body = await parseJsonBody(c, AdminFieldHideStatusReplySchema);
    const { db } = writeDb(c, dbFor);

    const hide = await db.query.fieldHides.findFirst({ where: eq(fieldHides.id, id) });
    if (!hide) throw notFoundError('field_hide', { id });
    if (hide.clearedAt) throw hideClearedError();
    const entityType = hide.entityType as FieldHideEntityType;
    const [target, stamp] = await Promise.all([
      loadTarget(db, entityType, hide.entityId),
      vendorAuditStamp(db, hide.vendorId),
    ]);

    // Internal: what AECi told the requester. No vendor-visible reason, no receipt.
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: `${fieldHideActionPrefix(entityType)}${STATUS_REPLY_ACTION_SUFFIX}`,
      entityType,
      entityId: hide.entityId,
      ...stamp,
      ...(entityType === 'product' ? { productId: hide.entityId } : {}),
      metadata: {
        source: FIELD_OVERRIDE_AUDIT_SOURCE,
        field: hide.field,
        fieldHideId: hide.id,
        note: body.note,
      },
    };
    try {
      await db.batch([
        auditInsertWhere(db, audit, {
          from: fieldHides,
          where: and(eq(fieldHides.id, hide.id), isNull(fieldHides.clearedAt)),
        }),
        db
          .select({
            guard: sql`CASE WHEN changes() = 0 THEN json(${FIELD_HIDE_CLEARED_TOKEN}) END`,
          })
          .from(ONE_ROW),
      ] as BatchTuple);
    } catch (error) {
      if (isClearedSentinel(error)) throw hideClearedError();
      throw error;
    }

    // Nothing public changed: forward the row, purge and sync nothing.
    afterVendorWrite(c, [], [audit], undefined, db, ADMIN_ORIGIN);

    const response: AdminFieldHideResponse = {
      hide: await readHide(db, hide.id, target?.name ?? null),
    };
    validateResponseInDev(c.env, () => AdminFieldHideResponseSchema.parse(response));
    return json(response);
  };
}

// ─── GET /api/admin/vendors/:id/field-hides ──────────────────────────────────

/**
 * Every active hide on the vendor, on its products, and on the integrations and pairs
 * it owns, newest first, with both dues and the latest status reply. Read-only, no audit
 * row (§9.3). The same record scope as the field-override list.
 */
export function createAdminVendorFieldHidesHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = c.req.param('id');
    if (!vendorId) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const { db } = dbFor(c.env);
    const vendor = await db.query.vendors.findFirst({
      columns: { id: true, companyName: true },
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    const [productRows, integrationRows, pairRows] = await Promise.all([
      db
        .select({ id: products.id, name: products.name })
        .from(products)
        .innerJoin(productVendors, eq(productVendors.productId, products.id))
        .where(eq(productVendors.vendorId, vendorId)),
      db
        .select({ id: integrations.id, name: integrations.name })
        .from(integrations)
        .where(eq(integrations.builtByVendorId, vendorId)),
      db
        .select({ id: connectorEvidencedPairs.id, name: connectorEvidencedPairs.name })
        .from(connectorEvidencedPairs)
        .where(eq(connectorEvidencedPairs.builtByVendorId, vendorId)),
    ]);
    const names = new Map<string, string | null>([
      [vendorId, vendor.companyName],
      ...productRows.map((r) => [r.id, r.name] as const),
      ...integrationRows.map((r) => [r.id, r.name] as const),
      ...pairRows.map((r) => [r.id, r.name] as const),
    ]);
    // Subqueries rather than id lists: a vendor's integration list is unbounded, and D1
    // caps a statement at 100 bound parameters.
    const rows = await db
      .select()
      .from(fieldHides)
      .where(
        and(
          isNull(fieldHides.clearedAt),
          or(
            and(eq(fieldHides.entityType, 'vendor'), eq(fieldHides.entityId, vendorId)),
            and(
              eq(fieldHides.entityType, 'product'),
              inArray(
                fieldHides.entityId,
                db
                  .select({ id: productVendors.productId })
                  .from(productVendors)
                  .where(eq(productVendors.vendorId, vendorId)),
              ),
            ),
            and(
              eq(fieldHides.entityType, 'integration'),
              inArray(
                fieldHides.entityId,
                db
                  .select({ id: integrations.id })
                  .from(integrations)
                  .where(eq(integrations.builtByVendorId, vendorId)),
              ),
            ),
            and(
              eq(fieldHides.entityType, 'connector_evidenced_pair'),
              inArray(
                fieldHides.entityId,
                db
                  .select({ id: connectorEvidencedPairs.id })
                  .from(connectorEvidencedPairs)
                  .where(eq(connectorEvidencedPairs.builtByVendorId, vendorId)),
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(fieldHides.setAt), asc(fieldHides.id));
    const replies = new Map<string, AdminFieldHideStatusReplyEntry>();
    // Chunked: one bound parameter per hide id.
    for (let i = 0; i < rows.length; i += 90) {
      const slice = await lastStatusReplies(
        db,
        rows.slice(i, i + 90).map((r) => r.id),
      );
      for (const [key, value] of slice) replies.set(key, value);
    }

    const response: AdminFieldHidesResponse = {
      hides: rows.map((row) =>
        toAdminHide(row, names.get(row.entityId) ?? null, replies.get(row.id) ?? null),
      ),
    };
    validateResponseInDev(c.env, () => AdminFieldHidesResponseSchema.parse(response));
    return json(response);
  };
}
