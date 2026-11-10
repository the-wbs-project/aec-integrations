/**
 * The single-value hide, "under review" (AECI-1238 section B, ADR 0052 amendment,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.7). The ONE place its read and clear rules live.
 *
 * A `field_hides` row with `cleared_at` NULL hides one field on one vendor-held record:
 * the public read masks the value to `null` and lists the field in `under_review`. Three
 * things end it, each in its own write's batch:
 *
 *   1. an admin restore (`POST /api/admin/field-hides/:id/restore`, `clear_kind
 *      'restored'`);
 *   2. an AECi correction of the field (`POST /api/admin/field-overrides`, `clear_kind
 *      'corrected'`), through `correctionHideClear` in `routes/admin-field-overrides.ts`,
 *      and the AECi contest accept on a claimed row (`routes/admin-contests.ts`), through
 *      {@link vendorEditHideClears} with `kind: 'corrected'`;
 *   3. the vendor's own edit that CHANGES the field (`clear_kind 'vendor_edit'`), through
 *      {@link vendorEditHideClears}. Every vendor writer of a hideable field calls it:
 *      the writers named in the header of `lib/field-overrides.ts`, which are the same
 *      writers the lock guards.
 *
 * A clear is a guarded `UPDATE … WHERE cleared_at IS NULL`. Its audit row is an
 * `INSERT … SELECT` on the same guard, placed BEFORE the UPDATE, so a hide another write
 * cleared a moment earlier gets no second row and the batch still commits.
 *
 * The public read is one statement per entity table, for the page's existing batch, as
 * `lib/field-corrections.ts` does. It selects the entity id and the field name, nothing
 * else: the reason, note and source can never reach a public mapper.
 */

import type { FieldHideEntityType, HiddenField } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, fieldHides, integrations, products, vendors } from '../db/schema';

import { auditInsertWhere, type BatchStmt } from './audit';
import { NO_VENDOR_STAMP, type VendorAuditStamp } from './audit-vendor';
import { chunked } from './promote-claims';

/** The audit action prefix: `integration.*` covers both anchor tables. */
export function fieldHideActionPrefix(
  entityType: FieldHideEntityType,
): 'vendor' | 'product' | 'integration' {
  return entityType === 'connector_evidenced_pair' ? 'integration' : entityType;
}

// ─── Vendor reads ────────────────────────────────────────────────────────────

/**
 * Active hides for many entities of one type, keyed by entity id, newest first: the
 * portal's `hidden_fields`. Chunked for D1's 100-parameter cap, as
 * `lockedFieldsByEntity`. Never the internal note.
 *
 * `viewerVendorId` is the vendor reading (§11d.7). The reason and the source go only to
 * the hide's `vendor_id`, the holder AECi told. Any other viewer gets the field and
 * `set_at` with `reason` and `source_url` null. A hide with no `vendor_id` shows its
 * reason to no vendor.
 */
export async function hiddenFieldsByEntity(
  db: Db,
  entityType: FieldHideEntityType,
  entityIds: readonly string[],
  viewerVendorId: string,
): Promise<Map<string, HiddenField[]>> {
  const out = new Map<string, HiddenField[]>();
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return out;
  const rows = (
    await Promise.all(
      chunked(ids).map((slice) =>
        db
          .select({
            entityId: fieldHides.entityId,
            field: fieldHides.field,
            reason: fieldHides.reason,
            setAt: fieldHides.setAt,
            sourceUrl: fieldHides.sourceUrl,
            vendorId: fieldHides.vendorId,
          })
          .from(fieldHides)
          .where(
            and(
              eq(fieldHides.entityType, entityType),
              inArray(fieldHides.entityId, slice),
              isNull(fieldHides.clearedAt),
            ),
          )
          .orderBy(desc(fieldHides.setAt)),
      ),
    )
  ).flat();
  for (const row of rows) {
    const list = out.get(row.entityId) ?? [];
    const holder = row.vendorId !== null && row.vendorId === viewerVendorId;
    list.push({
      field: row.field,
      reason: holder ? row.reason : null,
      set_at: row.setAt,
      source_url: holder ? row.sourceUrl : null,
    });
    out.set(row.entityId, list);
  }
  return out;
}

/** Every active hide on one entity, as `viewerVendorId` sees it. */
export async function activeHidesOn(
  db: Db,
  entityType: FieldHideEntityType,
  entityId: string,
  viewerVendorId: string,
): Promise<HiddenField[]> {
  return (
    (await hiddenFieldsByEntity(db, entityType, [entityId], viewerVendorId)).get(entityId) ?? []
  );
}

// ─── Clears ──────────────────────────────────────────────────────────────────

/** One active hide, as a clear needs it. */
export interface ActiveHideRow {
  id: string;
  field: string;
  vendorId: string | null;
}

/** The active hides among `fields` on one entity. Empty for an empty field list. */
export async function activeHidesAmong(
  db: Db,
  entityType: FieldHideEntityType,
  entityId: string,
  fields: readonly string[],
): Promise<ActiveHideRow[]> {
  if (fields.length === 0) return [];
  return db
    .select({ id: fieldHides.id, field: fieldHides.field, vendorId: fieldHides.vendorId })
    .from(fieldHides)
    .where(
      and(
        eq(fieldHides.entityType, entityType),
        eq(fieldHides.entityId, entityId),
        isNull(fieldHides.clearedAt),
        inArray(fieldHides.field, [...fields]),
      ),
    );
}

/** The guard every clear shares: this hide, still active. */
function stillActive(hideId: string): SQL {
  return and(eq(fieldHides.id, hideId), isNull(fieldHides.clearedAt))!;
}

/**
 * The statements that clear one hide: the guarded audit row, then the guarded UPDATE.
 * The audit row lands only while the hide is still active, so it must come first.
 */
export function hideClearStatements(
  db: Db,
  hideId: string,
  audit: AuditLogEntry,
  clear: {
    actorId: string | null;
    at: string;
    kind: 'restored' | 'corrected' | 'vendor_edit';
    reason: string | null;
  },
): BatchStmt[] {
  return [
    auditInsertWhere(db, audit, { from: fieldHides, where: stillActive(hideId) }),
    db
      .update(fieldHides)
      .set({
        clearedAt: clear.at,
        clearedBy: clear.actorId,
        clearKind: clear.kind,
        clearReason: clear.reason,
      })
      .where(stillActive(hideId)),
  ];
}

/**
 * A row (a `notification.sent`) that lands only while the hide is still active. Put it
 * BEFORE that hide's {@link hideClearStatements}, which clear the hide, so a hide
 * another write already cleared tells nobody a second time.
 */
export function guardedHideAuditStatement(db: Db, hideId: string, entry: AuditLogEntry): BatchStmt {
  return auditInsertWhere(db, entry, { from: fieldHides, where: stillActive(hideId) });
}

/**
 * Writer 3: the vendor's own edit ended a hide. Call it with the wire fields the write
 * actually CHANGES (a resend of the stored value changes nothing and ends nothing). One
 * handler read, then for each active hide among them the guarded audit row and UPDATE,
 * for the writer's own batch. The `<entity>.field_hide_cleared` row carries `clearKind:
 * 'vendor_edit'` and the writer's vendor stamp. No notice: the vendor made the change.
 *
 * After commit, forward `landedAuditEntries(db, audits)`, not `audits`: a hide an admin
 * cleared in the same instant wrote no row here.
 *
 * A hide set between this read and the batch survives on the new value. The admin set
 * it after the vendor began the save, so AECi still holds it, and the admin list shows it.
 */
export async function vendorEditHideClears(
  db: Db,
  input: {
    entityType: FieldHideEntityType;
    entityId: string;
    changedFields: readonly string[];
    actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] };
    /** The vendor and plan columns of the audit row. A vendor writer passes
     *  `stampEntry` instead, so the row carries the session's stamp. */
    stamp?: VendorAuditStamp;
    /** Applied to each audit entry before its statement is built (a vendor writer's
     *  `vendorAuditEntry`), because the `INSERT … SELECT` binds the values at once. */
    stampEntry?: (entry: AuditLogEntry) => AuditLogEntry;
    at: string;
    /** `metadata.source` the writer stamps on its own audit rows. */
    source: string;
    /** `vendor_edit` (default) for the vendor's own write. `corrected` for an AECi write
     *  that replaced the value in a vendor writer's path: the AECi contest accept. */
    kind?: 'vendor_edit' | 'corrected';
    /** `clear_reason` on a `corrected` clear: the vendor-visible reason. */
    reason?: string | null;
  },
): Promise<{ stmts: BatchStmt[]; audits: AuditLogEntry[]; hides: ActiveHideRow[] }> {
  const hides = await activeHidesAmong(db, input.entityType, input.entityId, input.changedFields);
  const kind = input.kind ?? 'vendor_edit';
  // A writer with `stampEntry` stamps each entry itself; `NO_VENDOR_STAMP` is the base.
  const stamp: VendorAuditStamp = input.stamp ?? NO_VENDOR_STAMP;
  const stmts: BatchStmt[] = [];
  const audits: AuditLogEntry[] = [];
  for (const hide of hides) {
    let audit: AuditLogEntry = {
      ...input.actor,
      action: `${fieldHideActionPrefix(input.entityType)}.field_hide_cleared`,
      entityType: input.entityType,
      entityId: input.entityId,
      ...stamp,
      ...(input.entityType === 'product' ? { productId: input.entityId } : {}),
      beforeState: { cleared_at: null },
      afterState: { cleared_at: input.at, clear_kind: kind },
      metadata: {
        source: input.source,
        field: hide.field,
        fieldHideId: hide.id,
        clearKind: kind,
      },
    };
    if (input.stampEntry) audit = input.stampEntry(audit);
    audits.push(audit);
    stmts.push(
      ...hideClearStatements(db, hide.id, audit, {
        actorId: input.actor.actorId,
        at: input.at,
        kind,
        reason: kind === 'corrected' ? (input.reason ?? null) : null,
      }),
    );
  }
  return { stmts, audits, hides };
}

/**
 * The wire fields among `fields` whose value differs between `before` and `after`, both
 * keyed by column through `columns` (wire field → row key). A field with no column is
 * skipped. `undefined` and `null` agree, so a resend of the stored value changes nothing.
 */
export function changedHideableFields(
  fields: readonly string[],
  columns: Readonly<Record<string, string>>,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  return fields.filter((field) => {
    const column = columns[field];
    if (column === undefined || !(column in after)) return false;
    return (before[column] ?? null) !== (after[column] ?? null);
  });
}

// ─── Public reads ────────────────────────────────────────────────────────────

/** One active hide as the public read selects it: the field name, nothing else. */
export interface PublicHideRow {
  entityId: string;
  field: string;
}

function hidesQuery(
  db: Db,
  entityType: FieldHideEntityType,
  table: SQLiteTable,
  id: SQLiteColumn,
  scope: SQL | undefined,
) {
  return db
    .select({ entityId: fieldHides.entityId, field: fieldHides.field })
    .from(fieldHides)
    .innerJoin(table, eq(id, fieldHides.entityId))
    .where(and(eq(fieldHides.entityType, entityType), isNull(fieldHides.clearedAt), scope));
}

/** Active hides on the vendors `scope` selects. */
export function vendorHidesQuery(db: Db, scope: SQL | undefined) {
  return hidesQuery(db, 'vendor', vendors, vendors.id, scope);
}

/** Active hides on the products `scope` selects. */
export function productHidesQuery(db: Db, scope: SQL | undefined) {
  return hidesQuery(db, 'product', products, products.id, scope);
}

/** Active hides on the `integrations` rows `scope` selects. */
export function integrationHidesQuery(db: Db, scope: SQL | undefined) {
  return hidesQuery(db, 'integration', integrations, integrations.id, scope);
}

/** Active hides on the `connector_evidenced_pairs` rows `scope` selects. */
export function evidencedPairHidesQuery(db: Db, scope: SQL | undefined) {
  return hidesQuery(
    db,
    'connector_evidenced_pair',
    connectorEvidencedPairs,
    connectorEvidencedPairs.id,
    scope,
  );
}

/** Rows from any of the reads above, keyed by entity id, each list sorted. Ids are
 *  UUIDs across all four tables, so one map serves a page. */
export function groupHides(
  ...reads: ReadonlyArray<readonly PublicHideRow[]>
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const rows of reads) {
    for (const row of rows) {
      const set = out.get(row.entityId) ?? new Set<string>();
      set.add(row.field);
      out.set(row.entityId, set);
    }
  }
  return new Map(
    [...out].map(([id, set]) => [id, [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))]),
  );
}

/** The hidden fields of one entity, sorted. `[]` when none (or no map was passed). */
export function hiddenOf(hides: ReadonlyMap<string, readonly string[]> | undefined, id: string) {
  return hides?.get(id) ?? [];
}

/**
 * `payload` with every field in `hidden` set to `null`, where the payload carries it
 * under the same key. The public shapes use the wire names (`website`, `docs_url`,
 * `description`), so the key IS the field. `rename` maps a field the payload carries
 * under another key.
 */
export function maskHiddenFields<T extends object>(
  payload: T,
  hidden: readonly string[],
  rename: Readonly<Record<string, string>> = {},
): T {
  if (hidden.length === 0) return payload;
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of hidden) {
    const key = rename[field] ?? field;
    if (key in next) next[key] = null;
  }
  return next as T;
}

/** A raw `sql` predicate: the entity has no active hide on `field`. For SQL-side masks
 *  (search transforms that select a column directly). */
export function noActiveHideSql(
  entityType: FieldHideEntityType,
  entityId: SQLiteColumn | SQL,
  field: string,
): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM "field_hides" fh WHERE fh."entity_type" = ${entityType}
    AND fh."entity_id" = ${entityId} AND fh."field" = ${field} AND fh."cleared_at" IS NULL)`;
}
