/**
 * An endpoint vendor's rights on a pair a Sync Service delivers (AECI-2042, rulings
 * 8, 9 and 10 on AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e).
 *
 * This module is what the veto routes (`routes/vendor-sync-service-vetoes.ts`,
 * `routes/admin-sync-service-vetoes.ts`) and the report routes
 * (`routes/vendor-pair-contests.ts`, `routes/admin-pair-contests.ts`) share:
 *
 * ── THE TARGET ──────────────────────────────────────────────────────────────
 * {@link resolvePairRightTarget} finds `:id` in `integrations` then in
 * `connector_evidenced_pairs`, and applies one gate in order:
 *
 *   1. unknown id, or the caller's vendor holds neither endpoint product → 404, the
 *      same answer, so a stranger learns nothing;
 *   2. the row has no connector, or its connector is not a Sync Service
 *      (`isSyncService`: an Integration platform, a blank kind, an application) →
 *      403 `SYNC_SERVICE_RIGHT_NOT_AVAILABLE`. Those rows keep the §11b field contests;
 *   3. the caller is the row's owner (`built_by_vendor_id`) or holds the connector
 *      product → 403 `SYNC_SERVICE_RIGHT_OWN_INTEGRATION`. The Sync Service has its own
 *      tools: retire, edit, flows.
 *
 * A seat is the whole remaining gate, on any plan. A right asks for a fact on a public
 * page to change, so gating it behind a paid plan would sell accuracy (§11b.2's named
 * exception to `API_CONTRACTS.md` §6.14, for the same reason).
 *
 * ── THE VETO ────────────────────────────────────────────────────────────────
 * A veto row lives in `sync_service_pair_vetoes` with the pair key (connector, A, B).
 * The anchor row's `vetoed_at` is denormalised from it by {@link vetoedAtRecompute},
 * which every veto, withdraw and lift batch runs after its own write: the earliest open
 * veto's `filed_at`, or NULL when none is open. A `SELECT` inside the UPDATE, so two
 * vendors vetoing or withdrawing at once each leave the column true to the table.
 * `vetoed_at` is part of liveness (`lib/live-integration.ts`), so every count, id set
 * and public read drops a vetoed row the way it drops a retired one.
 *
 * Veto and retire are separate. A vetoed row is not retired by its owner: the owner's
 * restore and the admin restore both refuse it with `409 INTEGRATION_VETOED`, and a
 * retire leaves the veto in force. Only a withdraw by the vetoing vendor or an AECi
 * lift ends a veto, and the pair returns only when no veto is in force and it is not
 * retired.
 */

import {
  ApiErrorCode,
  isSyncService,
  orderedPairSlugs,
  type PairRightNotificationEvent,
  type PairRightPair,
  type PairContestKind,
  type SyncServicePairVeto,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrations,
  productVendors,
  products,
  syncServicePairVetoes,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import type { BatchStmt } from './audit';
import { ONE_ROW } from './integration-claims';
import type { PortalNotificationId } from './notifications/registry';
import { liveEvidencedPairWhere, liveIntegrationWhere } from './live-integration';
import { integrationCountRecomputeStmt } from './recompute-counts';

/** `audit_log.entity_type` of a veto row. */
export const VETO_ENTITY_TYPE = 'sync_service_pair_veto';
/** `metadata.kind` of every veto and report `notification.sent` row. */
export const PAIR_RIGHT_NOTIFICATION_KIND = 'pair_right';

export type PairRightAnchor = 'integration' | 'evidenced_pair';

/** The row a right acts on, in either table, in the pair's canonical frame. */
export interface PairRightTarget {
  readonly anchor: PairRightAnchor;
  readonly id: string;
  readonly name: string | null;
  /** `powered_by_product_id`, or the pair's connector. Never null past the gate. */
  readonly connectorProductId: string;
  /** Canonical: `productAId < productBId`. */
  readonly productAId: string;
  readonly productBId: string;
  /** On `integrations`, whether `source_product_id` is A. Always true on a pair. */
  readonly sourceIsA: boolean;
  readonly builtByVendorId: string | null;
  readonly claimedAt: string | null;
  readonly origin: string;
  readonly retiredAt: string | null;
  readonly vetoedAt: string | null;
}

/** The pair key a veto blocks, the unique index's key on the evidenced table. */
export interface PairKey {
  readonly connectorProductId: string;
  readonly productAId: string;
  readonly productBId: string;
}

export function pairKeyOf(target: PairRightTarget): PairKey {
  return {
    connectorProductId: target.connectorProductId,
    productAId: target.productAId,
    productBId: target.productBId,
  };
}

function canonical(x: string, y: string): [string, string, boolean] {
  return x < y ? [x, y, true] : [y, x, false];
}

/** The row behind `id` in either table, without any gate. `null` when neither holds
 *  it, and for an `integrations` row no connector delivers. */
export async function locatePairRightTarget(
  db: Db,
  id: string,
): Promise<
  PairRightTarget | { anchor: 'integration'; id: string; connectorProductId: null } | null
> {
  const row = await db.query.integrations.findFirst({ where: eq(integrations.id, id) });
  if (row) {
    if (row.poweredByProductId === null) {
      return { anchor: 'integration', id: row.id, connectorProductId: null };
    }
    const [a, b, sourceIsA] = canonical(row.sourceProductId, row.targetProductId);
    return {
      anchor: 'integration',
      id: row.id,
      name: row.name,
      connectorProductId: row.poweredByProductId,
      productAId: a,
      productBId: b,
      sourceIsA,
      builtByVendorId: row.builtByVendorId,
      claimedAt: row.claimedAt,
      origin: row.origin,
      retiredAt: row.retiredAt,
      vetoedAt: row.vetoedAt,
    };
  }
  const pair = await db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  });
  if (!pair) return null;
  return {
    anchor: 'evidenced_pair',
    id: pair.id,
    name: pair.name,
    connectorProductId: pair.connectorProductId,
    productAId: pair.productAId,
    productBId: pair.productBId,
    sourceIsA: true,
    builtByVendorId: pair.builtByVendorId,
    claimedAt: pair.claimedAt,
    origin: pair.origin,
    retiredAt: pair.retiredAt,
    vetoedAt: pair.vetoedAt,
  };
}

/** The endpoint products of the pair the caller's vendor holds. */
async function heldProductIds(db: Db, vendorId: string, ids: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(and(eq(productVendors.vendorId, vendorId), inArray(productVendors.productId, [...ids])));
  return rows.map((r) => r.productId);
}

export function rightNotAvailableError(): ApiError {
  return new ApiError(
    403,
    ApiErrorCode.SYNC_SERVICE_RIGHT_NOT_AVAILABLE,
    'This right applies only to an integration a Sync Service delivers. Use Request a change for this one.',
  );
}

/** Is this product a Sync Service now? */
export async function productIsSyncService(db: Db, productId: string): Promise<boolean> {
  const product = await db.query.products.findFirst({
    columns: { productRole: true, connectorKind: true },
    where: eq(products.id, productId),
  });
  return isSyncService(product?.productRole, product?.connectorKind);
}

/**
 * The module's gate. See the header, "The target". Returns the row and the endpoint
 * products the caller holds.
 */
export async function resolvePairRightTarget(
  db: Db,
  vendorId: string,
  id: string,
): Promise<{ target: PairRightTarget; heldEndpointIds: string[] }> {
  const located = await locatePairRightTarget(db, id);
  if (!located) throw notFoundError('integration', { id });
  if (located.connectorProductId === null) {
    // A native row: the caller may still be an endpoint vendor. 404 for a stranger,
    // 403 for an endpoint vendor, as on a Sync Service row.
    const row = await db.query.integrations.findFirst({
      columns: { sourceProductId: true, targetProductId: true },
      where: eq(integrations.id, id),
    });
    const held = row
      ? await heldProductIds(db, vendorId, [row.sourceProductId, row.targetProductId])
      : [];
    if (held.length === 0) throw notFoundError('integration', { id });
    throw rightNotAvailableError();
  }
  const target = located as PairRightTarget;
  const heldEndpointIds = await heldProductIds(db, vendorId, [
    target.productAId,
    target.productBId,
  ]);
  if (heldEndpointIds.length === 0) throw notFoundError('integration', { id });
  if (!(await productIsSyncService(db, target.connectorProductId))) throw rightNotAvailableError();
  const holdsConnector =
    (await heldProductIds(db, vendorId, [target.connectorProductId])).length > 0;
  if (target.builtByVendorId === vendorId || holdsConnector) {
    throw new ApiError(
      403,
      ApiErrorCode.SYNC_SERVICE_RIGHT_OWN_INTEGRATION,
      'Your company offers this integration, so it is yours to retire or edit, not to report.',
    );
  }
  return { target, heldEndpointIds };
}

// ─── Statements ──────────────────────────────────────────────────────────────

/** The anchor column of a veto or report row for this target. */
export function vetoAnchorColumn(anchor: PairRightAnchor) {
  return anchor === 'integration'
    ? syncServicePairVetoes.integrationId
    : syncServicePairVetoes.evidencedPairId;
}

/**
 * The denormalised `vetoed_at` and `updated_at` on the anchor row, from the veto table
 * as this batch leaves it. Place it AFTER the veto write. `updated_at` moves so the
 * owner's freshness cursor and the incremental Algolia sync see the change.
 */
export function vetoedAtRecompute(
  db: Db,
  target: Pick<PairRightTarget, 'anchor' | 'id'>,
  now: string,
): BatchStmt {
  const column = vetoAnchorColumn(target.anchor);
  const earliest = sql<
    string | null
  >`(SELECT min(${syncServicePairVetoes.filedAt}) FROM ${syncServicePairVetoes} WHERE ${column} = ${target.id} AND ${syncServicePairVetoes.endedAt} IS NULL)`;
  return target.anchor === 'integration'
    ? db
        .update(integrations)
        .set({ vetoedAt: earliest, updatedAt: now })
        .where(eq(integrations.id, target.id))
    : db
        .update(connectorEvidencedPairs)
        .set({ vetoedAt: earliest, updatedAt: now })
        .where(eq(connectorEvidencedPairs.id, target.id));
}

/** The three counts a veto moves: both endpoints and the connector (§12.5 option B). */
export function vetoCountRecomputes(db: Db, target: PairRightTarget): BatchStmt[] {
  return [...new Set([target.productAId, target.productBId, target.connectorProductId])].map(
    (productId) => integrationCountRecomputeStmt(db, productId),
  );
}

/** The token {@link vetoRowChangedSentinel} raises. */
export const VETO_CHANGED_TOKEN = 'veto-changed';

/** Placed right after a guarded veto UPDATE: aborts the batch when it matched no row
 *  (the veto ended meanwhile). Reads SQLite's `changes()`. */
export function vetoRowChangedSentinel(db: Db): BatchStmt {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${VETO_CHANGED_TOKEN}) END` })
    .from(ONE_ROW);
}

/** True for a sentinel abort ("malformed JSON") or the open-veto unique index. */
export function isVetoRaceError(error: unknown): 'changed' | 'duplicate' | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/UNIQUE constraint failed: sync_service_pair_vetoes/i.test(text)) return 'duplicate';
    if (/malformed JSON/i.test(text) || text.includes(VETO_CHANGED_TOKEN)) return 'changed';
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Open vetoes on a pair key, by any vendor. The re-create guards read this. */
export function openVetoOnKeyWhere(key: PairKey): SQL {
  return and(
    eq(syncServicePairVetoes.connectorProductId, key.connectorProductId),
    eq(syncServicePairVetoes.productAId, key.productAId),
    eq(syncServicePairVetoes.productBId, key.productBId),
    isNull(syncServicePairVetoes.endedAt),
  )!;
}

/** The first open veto on the key, or `null`. */
export async function findOpenVetoOnKey(db: Db, key: PairKey): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: syncServicePairVetoes.id })
    .from(syncServicePairVetoes)
    .where(openVetoOnKeyWhere(key))
    .orderBy(syncServicePairVetoes.filedAt, syncServicePairVetoes.id)
    .limit(1);
  return row ?? null;
}

// ─── Notifications ───────────────────────────────────────────────────────────

/** The two registry entries a veto or report notice names. */
export type PairRightNotificationId = Extract<
  PortalNotificationId,
  'portal-sync-service-veto' | 'portal-sync-service-pair-report'
>;

export interface PairRightNotificationMetadata {
  kind: typeof PAIR_RIGHT_NOTIFICATION_KIND;
  notificationId: PairRightNotificationId;
  event: PairRightNotificationEvent;
  /** The RECIPIENT. */
  vendorId: string;
  integrationId: string;
  integrationName: string | null;
  reportKind: PairContestKind | null;
  byVendorName: string | null;
  reason: string | null;
  pairPublic: boolean | null;
  pairSlugs: readonly [string, string] | null;
}

export function pairRightNotificationAudit(
  notification: PairRightNotificationId,
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  anchor: PairRightAnchor,
  metadata: Omit<PairRightNotificationMetadata, 'kind' | 'notificationId'>,
): AuditLogEntry {
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: anchor === 'evidenced_pair' ? 'connector_evidenced_pair' : 'integration',
    entityId: metadata.integrationId,
    // AECI-1192: `notification.sent` carries the RECIPIENT in `vendor_id`.
    vendorId: metadata.vendorId,
    metadata: {
      kind: PAIR_RIGHT_NOTIFICATION_KIND,
      notificationId: notification,
      ...metadata,
      pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
    },
  };
}

/** Who hears about a veto on this row. The owner, or when no owner is on file the
 *  vendors of the Sync Service product; and every other endpoint vendor. The acting
 *  vendor is never told. Sorted by id (an id ordering stays BINARY). */
export async function vetoAudience(
  db: Db,
  target: PairRightTarget,
  actingVendorId: string | null,
): Promise<{ owners: string[]; endpoints: string[] }> {
  const rows = await db
    .select({ vendorId: productVendors.vendorId, productId: productVendors.productId })
    .from(productVendors)
    .where(
      inArray(productVendors.productId, [
        target.productAId,
        target.productBId,
        target.connectorProductId,
      ]),
    );
  const owners = new Set<string>();
  if (target.builtByVendorId) owners.add(target.builtByVendorId);
  else {
    for (const r of rows) if (r.productId === target.connectorProductId) owners.add(r.vendorId);
  }
  const endpoints = new Set<string>();
  for (const r of rows) {
    if (r.productId === target.connectorProductId) continue;
    if (!owners.has(r.vendorId)) endpoints.add(r.vendorId);
  }
  if (actingVendorId) {
    owners.delete(actingVendorId);
    endpoints.delete(actingVendorId);
  }
  return { owners: [...owners].sort(), endpoints: [...endpoints].sort() };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** The two endpoint slugs in canonical order, the connector slug, and every name. */
export async function pairProducts(
  db: Db,
  key: PairKey,
): Promise<Map<string, { id: string; slug: string; name: string }>> {
  const rows = await db
    .select({ id: products.id, slug: products.slug, name: products.name })
    .from(products)
    .where(inArray(products.id, [key.connectorProductId, key.productAId, key.productBId]));
  return new Map(rows.map((r) => [r.id, r]));
}

export function pairSlugsOf(
  key: PairKey,
  byId: Map<string, { slug: string }>,
): readonly [string, string] | null {
  const a = byId.get(key.productAId)?.slug;
  const b = byId.get(key.productBId)?.slug;
  return a && b ? [a, b] : null;
}

/** Is the anchor row on the public site now (live: not retired, not vetoed, no hidden
 *  endpoint)? `false` when it is gone. */
export async function anchorIsPublic(
  db: Db,
  anchor: PairRightAnchor | null,
  id: string | null,
): Promise<boolean> {
  if (!anchor || !id) return false;
  const rows =
    anchor === 'integration'
      ? await db
          .select({ id: integrations.id })
          .from(integrations)
          .where(and(eq(integrations.id, id), liveIntegrationWhere))
          .limit(1)
      : await db
          .select({ id: connectorEvidencedPairs.id })
          .from(connectorEvidencedPairs)
          .where(and(eq(connectorEvidencedPairs.id, id), liveEvidencedPairWhere))
          .limit(1);
  return rows.length > 0;
}

type VetoRow = typeof syncServicePairVetoes.$inferSelect;

/**
 * Wire rows for veto rows, with their pair named. Three reads for the whole list (the
 * products, the anchor names, the other vetoes in force), never one per row.
 */
export async function vetoWireRows(
  db: Db,
  rows: readonly VetoRow[],
): Promise<SyncServicePairVeto[]> {
  if (rows.length === 0) return [];
  const productIds = [
    ...new Set(rows.flatMap((r) => [r.connectorProductId, r.productAId, r.productBId])),
  ];
  const integrationIds = rows.map((r) => r.integrationId).filter((x): x is string => !!x);
  const pairIds = rows.map((r) => r.evidencedPairId).filter((x): x is string => !!x);
  const keyJson = JSON.stringify(
    rows.map((r) => [r.connectorProductId, r.productAId, r.productBId]),
  );
  const [productRows, intRows, pairRows, openRows] = await Promise.all([
    db
      .select({ id: products.id, slug: products.slug, name: products.name })
      .from(products)
      .where(sql`${products.id} IN (SELECT value FROM json_each(${JSON.stringify(productIds)}))`),
    integrationIds.length
      ? db
          .select({ id: integrations.id, name: integrations.name })
          .from(integrations)
          .where(
            sql`${integrations.id} IN (SELECT value FROM json_each(${JSON.stringify(integrationIds)}))`,
          )
      : Promise.resolve([]),
    pairIds.length
      ? db
          .select({ id: connectorEvidencedPairs.id, name: connectorEvidencedPairs.name })
          .from(connectorEvidencedPairs)
          .where(
            sql`${connectorEvidencedPairs.id} IN (SELECT value FROM json_each(${JSON.stringify(pairIds)}))`,
          )
      : Promise.resolve([]),
    db
      .select({
        id: syncServicePairVetoes.id,
        connectorProductId: syncServicePairVetoes.connectorProductId,
        productAId: syncServicePairVetoes.productAId,
        productBId: syncServicePairVetoes.productBId,
      })
      .from(syncServicePairVetoes)
      .where(
        and(
          isNull(syncServicePairVetoes.endedAt),
          sql`json_array(${syncServicePairVetoes.connectorProductId}, ${syncServicePairVetoes.productAId}, ${syncServicePairVetoes.productBId}) IN (SELECT value FROM json_each(${keyJson}))`,
        ),
      ),
  ]);
  const product = new Map(productRows.map((p) => [p.id, p]));
  const name = new Map([...intRows, ...pairRows].map((r) => [r.id, r.name]));
  const keyOf = (r: { connectorProductId: string; productAId: string; productBId: string }) =>
    `${r.connectorProductId}|${r.productAId}|${r.productBId}`;
  const openByKey = new Map<string, string[]>();
  for (const r of openRows) openByKey.set(keyOf(r), [...(openByKey.get(keyOf(r)) ?? []), r.id]);
  return rows.map((r) => {
    const anchorId = r.integrationId ?? r.evidencedPairId;
    const pair: PairRightPair = {
      integration_id: anchorId,
      anchor: r.integrationId ? 'integration' : r.evidencedPairId ? 'evidenced_pair' : null,
      name: anchorId ? (name.get(anchorId) ?? null) : null,
      connector: product.get(r.connectorProductId) ?? null,
      product_a: product.get(r.productAId) ?? null,
      product_b: product.get(r.productBId) ?? null,
    };
    const others = (openByKey.get(keyOf(r)) ?? []).filter((id) => id !== r.id).length;
    return {
      id: r.id,
      pair,
      vendor_id: r.vendorId,
      vendor_name: r.vendorName,
      reason: r.reason,
      filed_at: r.filedAt,
      in_force: r.endedAt === null,
      ended_at: r.endedAt,
      ended_how: (r.endedHow as 'withdrawn' | 'lifted' | null) ?? null,
      end_note: r.endNote,
      other_vetoes_in_force: others,
      updated_at: r.updatedAt,
    };
  });
}

/** The vendor's name, for a snapshot. */
export async function vendorName(db: Db, vendorId: string | null): Promise<string | null> {
  if (!vendorId) return null;
  const row = await db.query.vendors.findFirst({
    columns: { companyName: true },
    where: eq(vendors.id, vendorId),
  });
  return row?.companyName ?? null;
}

/** The anchor of a veto row as a target-shaped key, for the recompute after a withdraw
 *  or lift. `null` when the row it was filed on is gone. */
export function vetoAnchorOf(row: VetoRow): { anchor: PairRightAnchor; id: string } | null {
  if (row.integrationId) return { anchor: 'integration', id: row.integrationId };
  if (row.evidencedPairId) return { anchor: 'evidenced_pair', id: row.evidencedPairId };
  return null;
}

/** Vetoes this vendor filed, or vetoes on pairs it owns: the vendor list's two sides. */
export function vetoesOwnedByWhere(vendorId: string): SQL {
  return or(
    sql`${syncServicePairVetoes.integrationId} IN (SELECT ${integrations.id} FROM ${integrations} WHERE ${integrations.builtByVendorId} = ${vendorId})`,
    sql`${syncServicePairVetoes.evidencedPairId} IN (SELECT ${connectorEvidencedPairs.id} FROM ${connectorEvidencedPairs} WHERE ${connectorEvidencedPairs.builtByVendorId} = ${vendorId})`,
  )!;
}
