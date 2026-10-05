/**
 * The vendor change history (AECI-1194): one query, one projection, shared by
 * `GET /api/vendor/history` and `GET /api/vendor/history.csv`.
 *
 * ── SCOPING ─────────────────────────────────────────────────────────────────
 * The predicate is `audit_log.vendor_id = <session vendor>` and nothing else
 * about ownership. It never joins through `entity_id` to whoever owns the entity
 * now. Two things follow by construction:
 *  - a co-owned product: each owner sees only rows stamped with its own id;
 *  - ownership moved after the row: the row stays with the vendor it named.
 * `vendor_id` is stamped at write time (AECI-1192). Rows written before it are
 * NULL and never match. There is no backfill.
 *
 * ── ALLOW-LISTS ─────────────────────────────────────────────────────────────
 * Two of them. The action allow-list is the `receipt: true` entries of
 * `@aeci/shared/audit-vendor-actions`, so `notification.sent` and a seat's mute
 * setting never show. The field allow-list is {@link projectVendorHistoryRow}: it
 * builds each wire row from named columns. `actor_id`, emails, raw before/after
 * values and `metadata.internalNote` are never copied, whatever the row holds.
 *
 * ── THE `kind` FILTER ───────────────────────────────────────────────────────
 * `kind` selects by WHO acted, not by the action's registry kind: an AECi admin
 * overwriting a logo writes `product.updated`, and it belongs under `aeci`.
 * `vendor` keeps `actor_kind: 'your_team'`, `aeci` keeps `actor_kind: 'aeci'`,
 * `all` keeps everything, system rows included. Both come from one table.
 */

import { AUDIT_VENDOR_RECEIPT_ACTIONS } from '@aeci/shared/audit-vendor-actions';
import { WORKER_CONNECTION_LIMIT, mapWithConcurrency } from '@aeci/shared/concurrency';
import type {
  VendorHistoryActorKind,
  VendorHistoryFilter,
  VendorHistoryItem,
  VendorHistoryKind,
} from '@aeci/shared';
import { and, count, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  auditLog,
  connectorCatalogs,
  connectorEvidencedPairs,
  integrations,
  productVersions,
  products,
  vendors,
} from '../db/schema';

/** The receipt actions. The outer filter, whatever `kind` asks for. */
export function historyActions(): string[] {
  return [...AUDIT_VENDOR_RECEIPT_ACTIONS];
}

/**
 * Who made the change: the ONE table both `actor_kind` and the `kind` filter
 * read, so the label on a row and the filter that keeps it cannot disagree.
 *
 * `vendor_admin` writes record `actor_type = 'user'` (`auditActorType`), and
 * `requireVendor()` admits only seats, so a `user` row stamped with this
 * vendor's id is one of its own seats. A site admin acting on the vendor records
 * `admin`. Every other actor type (crons, sweeps and ops scripts record
 * `system`, promote records `workflow`) is `system`.
 */
const ACTOR_KIND_BY_TYPE: Readonly<Record<string, VendorHistoryActorKind>> = {
  user: 'your_team',
  admin: 'aeci',
};

export function actorKindFor(actorType: string): VendorHistoryActorKind {
  return Object.hasOwn(ACTOR_KIND_BY_TYPE, actorType) ? ACTOR_KIND_BY_TYPE[actorType]! : 'system';
}

/** The `actor_kind` each `kind` filter keeps. `all` keeps every row. */
const KIND_FILTER: Record<Exclude<VendorHistoryKind, 'all'>, VendorHistoryActorKind> = {
  vendor: 'your_team',
  aeci: 'aeci',
};

/**
 * The `actor_type` values one `kind` filter keeps, or `null` for `all`. Derived
 * from {@link ACTOR_KIND_BY_TYPE}, so `kind=vendor` returns exactly the rows
 * labelled `your_team` and `kind=aeci` exactly the rows labelled `aeci`.
 */
export function historyActorTypes(kind: VendorHistoryKind): string[] | null {
  if (kind === 'all') return null;
  const want = KIND_FILTER[kind];
  return Object.keys(ACTOR_KIND_BY_TYPE).filter((t) => ACTOR_KIND_BY_TYPE[t] === want);
}

/** The day after a `YYYY-MM-DD`, as an ISO instant: the exclusive end of `to`. */
function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** The one WHERE clause both routes use. */
export function vendorHistoryWhere(vendorId: string, filter: VendorHistoryFilter): SQL {
  const clauses: SQL[] = [
    eq(auditLog.vendorId, vendorId),
    inArray(auditLog.action, historyActions()),
  ];
  const actorTypes = historyActorTypes(filter.kind);
  if (actorTypes) clauses.push(inArray(auditLog.actorType, actorTypes));
  if (filter.from) clauses.push(gte(auditLog.createdAt, `${filter.from}T00:00:00.000Z`));
  if (filter.to) clauses.push(lt(auditLog.createdAt, dayAfter(filter.to)));
  return and(...clauses) as SQL;
}

/** The columns the projection reads. Nothing else leaves the database. */
export interface VendorHistoryRawRow {
  id: string;
  createdAt: string;
  actorType: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  afterState: unknown;
  metadata: unknown;
  vendorTier: string | null;
  vendorEntitlementStatus: string | null;
}

/** A field NAME, not a value. Rejects anything that looks like data used as a key. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The key names of `after_state`. Historical rows vary: some hold an object,
 * some an array, some a scalar or nothing, and a writer may have stored JSON
 * as a string. Only an object's keys count, and only keys shaped like a field
 * name, so a map keyed by an email or an id can never surface one.
 */
export function afterStateFields(afterState: unknown): string[] {
  let value = afterState;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => FIELD_NAME.test(key));
}

/** AECi's vendor-facing reason, only behind the AECI-1159 marker. */
function vendorReason(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  const { reasonVisibility, reason } = metadata as Record<string, unknown>;
  if (reasonVisibility !== 'vendor') return undefined;
  return typeof reason === 'string' && reason.trim() !== '' ? reason : undefined;
}

/** One wire row, built field by field from the allow-list. */
export function projectVendorHistoryRow(
  row: VendorHistoryRawRow,
  entityName: string | null,
): VendorHistoryItem {
  const reason = vendorReason(row.metadata);
  return {
    id: row.id,
    at: row.createdAt,
    actor_kind: actorKindFor(row.actorType),
    action: row.action,
    entity_type: row.entityType,
    entity_id: row.entityId,
    entity_name: entityName,
    fields: afterStateFields(row.afterState),
    plan: row.vendorTier
      ? { tier: row.vendorTier, status: row.vendorEntitlementStatus ?? null }
      : null,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Ids per name lookup. D1 caps bound parameters per query. */
const NAME_LOOKUP_CHUNK = 50;

type NameLookup = (db: Db, ids: string[]) => Promise<{ id: string; name: string | null }[]>;

/** Entity types whose current name is public catalog data. Every other type
 *  (a profile, a seat invite, a review reply) resolves to `null`: its "name"
 *  would be a person's name or email. */
const NAME_LOOKUPS: Record<string, NameLookup> = {
  vendor: (db, ids) =>
    db
      .select({ id: vendors.id, name: vendors.companyName })
      .from(vendors)
      .where(inArray(vendors.id, ids)),
  vendor_entitlement: (db, ids) => NAME_LOOKUPS.vendor!(db, ids),
  product: (db, ids) =>
    db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(inArray(products.id, ids)),
  integration: (db, ids) =>
    db
      .select({ id: integrations.id, name: integrations.name })
      .from(integrations)
      .where(inArray(integrations.id, ids)),
  product_version: (db, ids) =>
    db
      .select({ id: productVersions.id, name: productVersions.label })
      .from(productVersions)
      .where(inArray(productVersions.id, ids)),
  connector_evidenced_pair: (db, ids) =>
    db
      .select({ id: connectorEvidencedPairs.id, name: connectorEvidencedPairs.name })
      .from(connectorEvidencedPairs)
      .where(inArray(connectorEvidencedPairs.id, ids)),
  connector_catalog: (db, ids) =>
    db
      .select({ id: connectorCatalogs.id, name: products.name })
      .from(connectorCatalogs)
      .innerJoin(products, eq(products.id, connectorCatalogs.connectorProductId))
      .where(inArray(connectorCatalogs.id, ids)),
};

/** Map key for one entity. */
const nameKey = (type: string, id: string) => `${type}\u0000${id}`;

/**
 * The current name of every entity on a page, in one IN query per entity type
 * (chunked under D1's parameter cap). A failed lookup degrades to `null` names
 * rather than failing the read.
 */
export async function resolveEntityNames(
  db: Db,
  rows: readonly Pick<VendorHistoryRawRow, 'entityType' | 'entityId'>[],
): Promise<Map<string, string | null>> {
  const idsByType = new Map<string, Set<string>>();
  for (const { entityType, entityId } of rows) {
    if (!entityType || !entityId || !NAME_LOOKUPS[entityType]) continue;
    let set = idsByType.get(entityType);
    if (!set) idsByType.set(entityType, (set = new Set()));
    set.add(entityId);
  }
  const jobs: { type: string; ids: string[] }[] = [];
  for (const [type, set] of idsByType) {
    const ids = [...set];
    for (let i = 0; i < ids.length; i += NAME_LOOKUP_CHUNK) {
      jobs.push({ type, ids: ids.slice(i, i + NAME_LOOKUP_CHUNK) });
    }
  }
  const settled = await mapWithConcurrency(jobs, WORKER_CONNECTION_LIMIT, ({ type, ids }) =>
    NAME_LOOKUPS[type]!(db, ids).then((found) => ({ type, found })),
  );
  const names = new Map<string, string | null>();
  for (const [i, result] of settled.entries()) {
    if (result.status !== 'fulfilled') {
      // Degrade to null names, but say so: a silent miss looks like a deleted entity.
      console.warn('[vendor-history] entity name lookup failed', {
        entityType: jobs[i]?.type,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      continue;
    }
    for (const { id, name } of result.value.found) names.set(nameKey(result.value.type, id), name);
  }
  return names;
}

/** The page of raw rows, newest first, `id DESC` as the tiebreaker. */
async function selectRows(
  db: Db,
  where: SQL,
  limit: number,
  offset: number,
): Promise<VendorHistoryRawRow[]> {
  return db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorType: auditLog.actorType,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      afterState: auditLog.afterState,
      metadata: auditLog.metadata,
      vendorTier: auditLog.vendorTier,
      vendorEntitlementStatus: auditLog.vendorEntitlementStatus,
    })
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit)
    .offset(offset);
}

/**
 * The shared read. Returns the projected rows for one window plus the total
 * match count. JSON asks for one page. CSV asks for up to its cap.
 */
export async function listVendorHistory(
  db: Db,
  vendorId: string,
  filter: VendorHistoryFilter,
  window: { limit: number; offset: number },
): Promise<{ items: VendorHistoryItem[]; total: number }> {
  const where = vendorHistoryWhere(vendorId, filter);
  const [rows, [totalRow]] = await Promise.all([
    selectRows(db, where, window.limit, window.offset),
    db.select({ n: count() }).from(auditLog).where(where),
  ]);
  const names = await resolveEntityNames(db, rows);
  const items = rows.map((row) =>
    projectVendorHistoryRow(
      row,
      row.entityType && row.entityId
        ? (names.get(nameKey(row.entityType, row.entityId)) ?? null)
        : null,
    ),
  );
  return { items, total: totalRow?.n ?? 0 };
}
