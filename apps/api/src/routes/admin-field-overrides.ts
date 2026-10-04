/**
 * AECi field corrections with a lock (AECI-1237, ADR 0039,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5, `ADMIN_PANEL_SPEC.md` §5.7).
 *
 *   POST /api/admin/field-overrides           — correct one field and lock it (201).
 *   POST /api/admin/field-overrides/:id/lift  — lift a lock (200).
 *   GET  /api/admin/vendors/:id/field-overrides — the vendor's active locks (200).
 *
 * Why it exists: on a vendor-held record promote no longer writes, and the vendor
 * edits without moderation (ADR 0035 decision 8). Before this, AECi could correct a
 * wrong fact there only by asking the owner, or by unaudited SQL. This is the audited
 * path, and the lock stops the next vendor save from quietly undoing it.
 *
 * Six rules of its own:
 *
 * 1. **Admin only, rate-limited after the guard.** `requireAdmin()` then
 *    `rateLimit('write')` at registration, on the two writes. The GET is a read: no
 *    limiter, no audit row (§9.3).
 * 2. **Vendor-held records only.** A company with an active seat (the promote fence's
 *    `loadClaimedVendorIds`), a product with such an owner (the same fence's
 *    `productBlocked`), or an integration or pair that is claimed or vendor-created
 *    (`isVendorHeld`). Anything else answers `409 FIELD_OVERRIDE_NOT_VENDOR_HELD`:
 *    promote writes it, so the correction belongs upstream in the review app.
 * 3. **Factual fields, the vendor's own value rule.** `AdminSetFieldOverrideSchema`
 *    names the allow-list; `parseFieldOverrideValue` applies the vendor PATCH rule. A
 *    connector-powered row's `mechanism_kind` is frozen here as for the owner.
 * 4. **One lock per field.** A second correction while a lock stands is
 *    `409 FIELD_OVERRIDE_ACTIVE`: lift it first. The partial unique index
 *    `field_overrides_active_key` backs the pre-read against a race.
 * 5. **One batch.** The column write, the lock row, the `<entity>.field_overridden`
 *    audit row (before and after, the holder's `vendor_id` and plan,
 *    `reasonVisibility: 'vendor'`) and the holder's `aeci_override` notice commit
 *    together. A lift is the guarded `UPDATE … WHERE lifted_at IS NULL`, its sentinel,
 *    the `<entity>.override_lifted` row and the notice. A lift leaves the column as
 *    AECi set it. No maintenance transfer: this is an AECi write.
 * 6. **After commit, as every catalog write.** Purge the record's cache tags through
 *    the queue, sync its Algolia record by id behind promote's watchdog, and forward
 *    the audit rows. A lift changes no public value, so it purges and syncs nothing.
 */

import {
  AdminFieldOverrideResponseSchema,
  AdminFieldOverridesResponseSchema,
  AdminLiftFieldOverrideSchema,
  AdminSetFieldOverrideSchema,
  ApiErrorCode,
  isFieldOverrideField,
  parseFieldOverrideValue,
  vendorVisibleReasonMetadata,
  type AdminFieldOverride,
  type AdminFieldOverrideResponse,
  type AdminFieldOverridesResponse,
  type AeciOverrideRecordSubject,
  type FieldOverrideEntityType,
  type FieldOverrideField,
  type FieldOverrideValue,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  connectorEvidencedPairs,
  fieldOverrides,
  integrations,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { aeciOverrideNotificationAudit } from '../lib/aeci-override-notifications';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { vendorAuditStamp } from '../lib/audit-vendor';
import { auditActorType } from '../lib/authz';
import { loadClaimedVendorIds } from '../lib/claimed-vendors';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { overrideColumn, overrideTable } from '../lib/field-overrides';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isVendorHeld, ONE_ROW } from '../lib/integration-claims';
import { retireSlugs, type LocatedRetireRow } from '../lib/retire-target';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { pairCacheTag } from './promote-pair';
import { afterVendorWrite, parseJsonBody, type VendorContext } from './vendor-shared';

/** `metadata.source` on the audit rows and the forward, as every admin moderation write. */
export const FIELD_OVERRIDE_AUDIT_SOURCE = 'admin-moderation';

const ADMIN_ORIGIN = {
  auditSource: FIELD_OVERRIDE_AUDIT_SOURCE,
  purgeSource: 'moderation',
} as const;

/** The audit action prefix: `integration.*` covers both anchor tables. */
function actionPrefix(entityType: FieldOverrideEntityType): 'vendor' | 'product' | 'integration' {
  return entityType === 'connector_evidenced_pair' ? 'integration' : entityType;
}

/** What the handlers need to know about the record a lock is on. */
interface OverrideTarget {
  entityType: FieldOverrideEntityType;
  id: string;
  name: string | null;
  /** The vendor told about the lock: the company itself, the product's first claimed
   *  owner, or the integration's owner. `null` when nobody holds the record. */
  holderVendorId: string | null;
  vendorHeld: boolean;
  connectorPowered: boolean;
  /** The record's stored row, for the before value. */
  row: Record<string, unknown>;
  recordSubject: AeciOverrideRecordSubject | null;
  /** For an integration or pair: the anchor row the cache and slug helpers read. */
  located: LocatedRetireRow | null;
}

async function loadTarget(
  db: Db,
  entityType: FieldOverrideEntityType,
  id: string,
): Promise<OverrideTarget | null> {
  switch (entityType) {
    case 'vendor': {
      const row = await db.query.vendors.findFirst({ where: eq(vendors.id, id) });
      if (!row) return null;
      const held = (await loadClaimedVendorIds(db, [id])).has(id);
      return {
        entityType,
        id,
        name: row.companyName,
        holderVendorId: held ? id : null,
        vendorHeld: held,
        connectorPowered: false,
        row,
        recordSubject: { type: 'vendor', slug: row.slug, name: row.companyName },
        located: null,
      };
    }
    case 'product': {
      const [row, owners] = await Promise.all([
        db.query.products.findFirst({ where: eq(products.id, id) }),
        db
          .select({ vendorId: productVendors.vendorId })
          .from(productVendors)
          .where(eq(productVendors.productId, id))
          .orderBy(desc(productVendors.isPrimary), asc(productVendors.vendorId)),
      ]);
      if (!row) return null;
      // The promote fence's own test (`productBlocked`, routes/promote.ts): a product is
      // vendor-held when any vendor that owns it has an active seat.
      const claimed = await loadClaimedVendorIds(
        db,
        owners.map((o) => o.vendorId),
      );
      const holder = owners.find((o) => claimed.has(o.vendorId))?.vendorId ?? null;
      return {
        entityType,
        id,
        name: row.name,
        holderVendorId: holder,
        vendorHeld: holder !== null,
        connectorPowered: false,
        row,
        recordSubject: { type: 'product', slug: row.slug, name: row.name },
        located: null,
      };
    }
    case 'integration': {
      const row = await db.query.integrations.findFirst({ where: eq(integrations.id, id) });
      if (!row) return null;
      return {
        entityType,
        id,
        name: row.name,
        holderVendorId: isVendorHeld(row) ? row.builtByVendorId : null,
        vendorHeld: isVendorHeld(row),
        connectorPowered: isConnectorPoweredEdge(row),
        row,
        recordSubject: null,
        located: { anchor: 'integration', row },
      };
    }
    case 'connector_evidenced_pair': {
      const pair = await db.query.connectorEvidencedPairs.findFirst({
        where: eq(connectorEvidencedPairs.id, id),
      });
      if (!pair) return null;
      return {
        entityType,
        id,
        name: pair.name,
        holderVendorId: isVendorHeld(pair) ? pair.builtByVendorId : null,
        vendorHeld: isVendorHeld(pair),
        connectorPowered: true,
        row: pair,
        recordSubject: null,
        located: { anchor: 'evidenced_pair', pair },
      };
    }
  }
}

function toAdminOverride(
  row: typeof fieldOverrides.$inferSelect,
  entityName: string | null,
): AdminFieldOverride {
  return {
    id: row.id,
    entity_type: row.entityType as FieldOverrideEntityType,
    entity_id: row.entityId,
    entity_name: entityName,
    field: row.field,
    value: (row.value ?? null) as FieldOverrideValue,
    reason: row.reason,
    internal_note: row.internalNote,
    vendor_id: row.vendorId,
    set_by: row.setBy,
    set_at: row.setAt,
    lifted_by: row.liftedBy,
    lifted_at: row.liftedAt,
    lift_reason: row.liftReason,
  };
}

function isActiveLockConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/field_overrides_active_key|UNIQUE constraint failed: field_overrides/.test(text)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function overrideActiveError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.FIELD_OVERRIDE_ACTIVE,
    'This field already carries an AEC Integrations lock. Lift it before correcting the field again.',
    { field: 'field' },
  );
}

/** The cache tags a corrected record's pages carry, and its Algolia ids. */
async function afterCommitTargets(
  db: Db,
  target: OverrideTarget,
): Promise<{
  tags: string[];
  search: { products: string[]; vendors: string[]; integrations: string[] };
}> {
  const row = target.row as { slug?: string };
  switch (target.entityType) {
    case 'vendor':
      // A product page embeds its vendor and carries this tag (CACHE_STRATEGY.md §3).
      return {
        tags: [`vendor:${row.slug}`],
        search: { products: [], vendors: [target.id], integrations: [] },
      };
    case 'product':
      return {
        tags: [`product:${row.slug}`, 'index:products'],
        search: { products: [target.id], vendors: [], integrations: [] },
      };
    case 'integration':
    case 'connector_evidenced_pair': {
      const slugs = await retireSlugs(db, target.located!);
      const tags = slugs.pairSlugs
        ? [
            pairCacheTag(slugs.pairSlugs[0], slugs.pairSlugs[1]),
            `product:${slugs.pairSlugs[0]}`,
            `product:${slugs.pairSlugs[1]}`,
          ]
        : [];
      if (slugs.connectorSlug) tags.push(`product:${slugs.connectorSlug}`);
      return { tags, search: { products: [], vendors: [], integrations: [target.id] } };
    }
  }
}

// ─── POST /api/admin/field-overrides ─────────────────────────────────────────

export function createSetFieldOverrideHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const body = await parseJsonBody(c, AdminSetFieldOverrideSchema);
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
        ApiErrorCode.FIELD_OVERRIDE_NOT_VENDOR_HELD,
        'No vendor holds this record, so promote and the review app write it. Correct it there instead.',
      );
    }
    // Rule 3: a connector-powered row's type is frozen, for AECi here as for the owner.
    if (
      !isFieldOverrideField(body.entityType, body.field, {
        connectorPowered: target.connectorPowered,
      })
    ) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'AEC Integrations cannot correct this field on this record',
        { field: 'field' },
      );
    }
    const field = body.field as FieldOverrideField;
    const parsed = parseFieldOverrideValue(body.entityType, field, body.value);
    if (!parsed.ok) {
      throw new ApiError(400, 'VALIDATION_FAILED', parsed.problem, { field: 'value' });
    }

    const [existing, stamp, pairSlugs] = await Promise.all([
      db.query.fieldOverrides.findFirst({
        columns: { id: true },
        where: and(
          eq(fieldOverrides.entityType, body.entityType),
          eq(fieldOverrides.entityId, body.entityId),
          eq(fieldOverrides.field, field),
          isNull(fieldOverrides.liftedAt),
        ),
      }),
      vendorAuditStamp(db, target.holderVendorId),
      target.located
        ? retireSlugs(db, target.located).then((s) => s.pairSlugs)
        : Promise.resolve(null),
    ]);
    if (existing) throw overrideActiveError();

    const column = overrideColumn(body.entityType, field);
    const before = (target.row[column] ?? null) as FieldOverrideValue;
    const value = parsed.value;
    const now = new Date().toISOString();
    const overrideId = crypto.randomUUID();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const prefix = actionPrefix(body.entityType);

    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: `${prefix}.field_overridden`,
        entityType: body.entityType,
        entityId: body.entityId,
        ...stamp,
        ...(body.entityType === 'product' ? { productId: body.entityId } : {}),
        beforeState: { [field]: before },
        afterState: { [field]: value },
        metadata: {
          source: FIELD_OVERRIDE_AUDIT_SOURCE,
          field,
          overrideId,
          locked: true,
          ...vendorVisibleReasonMetadata(body),
          ...(body.entityType === 'connector_evidenced_pair'
            ? { connectorPowered: true, anchor: 'evidenced_pair' }
            : {}),
        },
      },
    ];
    if (target.holderVendorId) {
      audits.push(
        aeciOverrideNotificationAudit('portal-field-corrected-by-aeci', actor, {
          event: 'field_corrected',
          vendorId: target.holderVendorId,
          reason: body.reason,
          overrideId,
          field,
          value: value === null ? null : String(value),
          ...(target.recordSubject
            ? {
                entityType: body.entityType as 'vendor' | 'product',
                entityId: body.entityId,
                recordSubject: target.recordSubject,
              }
            : {
                entityType: body.entityType as 'integration' | 'connector_evidenced_pair',
                entityId: body.entityId,
                integrationName: target.name,
                pairSlugs,
              }),
        }),
      );
    }

    const table = overrideTable(body.entityType);
    const stmts: BatchStmt[] = [
      // The lock row FIRST: a racing second correction trips the partial unique
      // index here and the whole batch, column write included, rolls back.
      db.insert(fieldOverrides).values({
        id: overrideId,
        entityType: body.entityType,
        entityId: body.entityId,
        field,
        value,
        reason: body.reason,
        internalNote: body.internalNote ?? null,
        vendorId: target.holderVendorId,
        setBy: session.userId,
        setAt: now,
      }),
      db
        .update(table)
        .set({ [column]: value, updatedAt: now } as never)
        .where(eq(table.id, body.entityId)),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isActiveLockConflict(error)) throw overrideActiveError();
      throw error;
    }

    const after = await afterCommitTargets(db, target);
    dispatchOwnerWriteSearch(
      c,
      'admin-field-override-algolia',
      syncOwnerWriteSearch(
        c,
        db,
        after.search,
        'aeci.api.admin.field_override_algolia_sync_failed',
      ),
    );
    afterVendorWrite(c, after.tags, audits, undefined, db, ADMIN_ORIGIN);

    const lock = await db.query.fieldOverrides.findFirst({
      where: eq(fieldOverrides.id, overrideId),
    });
    const response: AdminFieldOverrideResponse = { override: toAdminOverride(lock!, target.name) };
    validateResponseInDev(c.env, () => AdminFieldOverrideResponseSchema.parse(response));
    return json(response, { status: 201 });
  };
}

// ─── POST /api/admin/field-overrides/:id/lift ────────────────────────────────

export function createLiftFieldOverrideHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const body = await parseJsonBody(c, AdminLiftFieldOverrideSchema);
    const { db } = writeDb(c, dbFor);

    const lock = await db.query.fieldOverrides.findFirst({ where: eq(fieldOverrides.id, id) });
    if (!lock) throw notFoundError('field_override', { id });
    if (lock.liftedAt) throw liftedError();
    const entityType = lock.entityType as FieldOverrideEntityType;

    const [target, stamp] = await Promise.all([
      loadTarget(db, entityType, lock.entityId),
      vendorAuditStamp(db, lock.vendorId),
    ]);
    const pairSlugs = target?.located ? (await retireSlugs(db, target.located)).pairSlugs : null;
    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: `${actionPrefix(entityType)}.override_lifted`,
        entityType,
        entityId: lock.entityId,
        ...stamp,
        ...(entityType === 'product' ? { productId: lock.entityId } : {}),
        beforeState: { lifted_at: null },
        afterState: { lifted_at: now },
        metadata: {
          source: FIELD_OVERRIDE_AUDIT_SOURCE,
          field: lock.field,
          overrideId: lock.id,
          ...vendorVisibleReasonMetadata(body),
        },
      },
    ];
    // The vendor named on the lock is the one told: it was told when it was set.
    if (lock.vendorId) {
      audits.push(
        aeciOverrideNotificationAudit('portal-field-lock-lifted-by-aeci', actor, {
          event: 'field_lock_lifted',
          vendorId: lock.vendorId,
          reason: body.reason,
          overrideId: lock.id,
          field: lock.field,
          ...(entityType === 'vendor' || entityType === 'product'
            ? {
                entityType,
                entityId: lock.entityId,
                recordSubject: target?.recordSubject ?? {
                  type: entityType,
                  slug: '',
                  name: '',
                },
              }
            : {
                entityType,
                entityId: lock.entityId,
                integrationName: target?.name ?? null,
                pairSlugs,
              }),
        }),
      );
    }

    try {
      await db.batch([
        db
          .update(fieldOverrides)
          .set({ liftedAt: now, liftedBy: session.userId, liftReason: body.reason })
          .where(and(eq(fieldOverrides.id, id), isNull(fieldOverrides.liftedAt))),
        // A double-click or a second admin lifting at once: the loser writes nothing.
        db
          .select({ guard: sql`CASE WHEN changes() = 0 THEN json('field-override-lifted') END` })
          .from(ONE_ROW),
        ...audits.map((entry) => auditInsert(db, entry)),
      ] as BatchTuple);
    } catch (error) {
      if (
        /malformed JSON|field-override-lifted/i.test(
          String(error) + String((error as { cause?: unknown })?.cause ?? ''),
        )
      ) {
        throw liftedError();
      }
      throw error;
    }

    // A lift changes no public value: nothing to purge or re-index. Forward the rows.
    afterVendorWrite(c, [], audits, undefined, db, ADMIN_ORIGIN);

    const after = await db.query.fieldOverrides.findFirst({ where: eq(fieldOverrides.id, id) });
    const response: AdminFieldOverrideResponse = {
      override: toAdminOverride(after!, target?.name ?? null),
    };
    validateResponseInDev(c.env, () => AdminFieldOverrideResponseSchema.parse(response));
    return json(response);
  };
}

function liftedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.FIELD_OVERRIDE_LIFTED,
    'This lock has already been lifted.',
  );
}

// ─── GET /api/admin/vendors/:id/field-overrides ──────────────────────────────

/**
 * Every active lock on the vendor, on the products it owns, and on the integrations
 * and pairs it owns, newest first. Read-only, no audit row (§9.3). Two waves: the
 * vendor's record ids, then one lock read and the names.
 */
export function createAdminVendorFieldOverridesHandler(
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
    const scoped = (type: FieldOverrideEntityType, ids: string[]) =>
      ids.length
        ? and(eq(fieldOverrides.entityType, type), inArray(fieldOverrides.entityId, ids))
        : undefined;
    const clauses = [
      scoped('vendor', [vendorId]),
      scoped(
        'product',
        productRows.map((r) => r.id),
      ),
      scoped(
        'integration',
        integrationRows.map((r) => r.id),
      ),
      scoped(
        'connector_evidenced_pair',
        pairRows.map((r) => r.id),
      ),
    ].filter((clause) => clause !== undefined);
    const rows = await db
      .select()
      .from(fieldOverrides)
      .where(and(isNull(fieldOverrides.liftedAt), or(...clauses)))
      .orderBy(desc(fieldOverrides.setAt), asc(fieldOverrides.id));

    const response: AdminFieldOverridesResponse = {
      overrides: rows.map((row) => toAdminOverride(row, names.get(row.entityId) ?? null)),
    };
    validateResponseInDev(c.env, () => AdminFieldOverridesResponseSchema.parse(response));
    return json(response);
  };
}
