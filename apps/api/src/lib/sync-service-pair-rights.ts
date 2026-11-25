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
 * `vetoed_at` on EVERY row on that key, in both tables, is denormalised from it by
 * {@link vetoedAtKeyRecompute}, which every veto, withdraw and lift batch runs after its
 * own write: the earliest open veto on the key's `filed_at`, or NULL when none is open.
 * A `SELECT` inside each UPDATE, so two vendors vetoing or withdrawing at once each leave
 * the column true to the table. The anchor (the row the veto was filed on) only names
 * the row for notices and lists; the key decides what is hidden. `vetoed_at` is part of
 * liveness (`lib/live-integration.ts`), so every count, id set and public read drops a
 * vetoed row the way it drops a retired one.
 *
 * The gate is read before the batch and asserted again inside it: the veto and the
 * report INSERTs carry {@link pairRightTargetSentinel}, so a promote, an owner change or
 * a lost seat that lands between the read and the batch aborts the write.
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

// ─── The rows on a pair key (the review blocker on AECI-2042) ────────────────
//
// A veto is keyed to the pair, not to the row it was filed on. The same connector and
// endpoint pair can sit in more than one row: one `connector_evidenced_pairs` row (its
// unique index allows only one) beside one or more connector-powered `integrations`
// rows. So the rule for `vetoed_at` is key-wide: EVERY row on the key carries the
// earliest open veto's `filed_at`, or NULL when none is open. The anchor id only names
// the row the vendor pressed the button on.
//
// The two frames differ. A pair is stored id-sorted (A < B). An `integrations` row is
// source → target, so it is on the key in either order.

/** `integrations` rows on the key: powered by its connector, its endpoints either way. */
export function integrationsOnPairKeyWhere(key: PairKey): SQL {
  return and(
    eq(integrations.poweredByProductId, key.connectorProductId),
    or(
      and(
        eq(integrations.sourceProductId, key.productAId),
        eq(integrations.targetProductId, key.productBId),
      ),
      and(
        eq(integrations.sourceProductId, key.productBId),
        eq(integrations.targetProductId, key.productAId),
      ),
    ),
  )!;
}

/** `connector_evidenced_pairs` rows on the key: at most one, by the unique index. */
export function evidencedPairsOnPairKeyWhere(key: PairKey): SQL {
  return and(
    eq(connectorEvidencedPairs.connectorProductId, key.connectorProductId),
    eq(connectorEvidencedPairs.productAId, key.productAId),
    eq(connectorEvidencedPairs.productBId, key.productBId),
  )!;
}

/** One row on a pair key, in either table. */
export interface PairKeyRow {
  readonly anchor: PairRightAnchor;
  readonly id: string;
  readonly builtByVendorId: string | null;
  readonly retiredAt: string | null;
}

/** Every row on the key, both tables, evidenced first, then by id (BINARY). Two reads. */
export async function rowsOnPairKey(db: Db, key: PairKey): Promise<PairKeyRow[]> {
  const [pairs, ints] = await Promise.all([
    db
      .select({
        id: connectorEvidencedPairs.id,
        builtByVendorId: connectorEvidencedPairs.builtByVendorId,
        retiredAt: connectorEvidencedPairs.retiredAt,
      })
      .from(connectorEvidencedPairs)
      .where(evidencedPairsOnPairKeyWhere(key))
      .orderBy(connectorEvidencedPairs.id),
    db
      .select({
        id: integrations.id,
        builtByVendorId: integrations.builtByVendorId,
        retiredAt: integrations.retiredAt,
      })
      .from(integrations)
      .where(integrationsOnPairKeyWhere(key))
      .orderBy(integrations.id),
  ]);
  return [
    ...pairs.map((r) => ({ anchor: 'evidenced_pair' as const, ...r })),
    ...ints.map((r) => ({ anchor: 'integration' as const, ...r })),
  ];
}

/** The key a veto row blocks. Never changes after filing. */
export function vetoKeyOf(row: {
  connectorProductId: string;
  productAId: string;
  productBId: string;
}): PairKey {
  return {
    connectorProductId: row.connectorProductId,
    productAId: row.productAId,
    productBId: row.productBId,
  };
}

/**
 * The denormalised `vetoed_at` and `updated_at` on EVERY row on the key, in both tables,
 * from the veto table as this batch leaves it. Place it AFTER the veto write. A
 * `SELECT` inside each `UPDATE`, so two vendors acting at once each leave every row true
 * to the table, and a row that reached the key between the route's reads and the batch
 * is covered too (the predicate runs at commit). `updated_at` moves so the owner's
 * freshness cursor and the incremental Algolia sync see the change.
 *
 * Every path that changes veto state runs it: the veto, the withdraw and the lift. It
 * is keyed on the veto row's own key, so it still runs after the anchor row is deleted
 * (the anchor FK is SET NULL and the veto survives on its key): the other rows on the
 * key stay hidden while it is in force, and return when it ends.
 */
export function vetoedAtKeyRecompute(db: Db, key: PairKey, now: string): BatchStmt[] {
  const earliest = sql<
    string | null
  >`(SELECT min(${syncServicePairVetoes.filedAt}) FROM ${syncServicePairVetoes} WHERE ${openVetoOnKeyWhere(key)})`;
  return [
    db
      .update(connectorEvidencedPairs)
      .set({ vetoedAt: earliest, updatedAt: now })
      .where(evidencedPairsOnPairKeyWhere(key)),
    db
      .update(integrations)
      .set({ vetoedAt: earliest, updatedAt: now })
      .where(integrationsOnPairKeyWhere(key)),
  ];
}

/** The three counts a veto moves: both endpoints and the connector (§12.5 option B).
 *  Every row on the key touches the same three products, so these cover them all. */
export function vetoCountRecomputes(db: Db, key: PairKey): BatchStmt[] {
  return [...new Set([key.productAId, key.productBId, key.connectorProductId])].map((productId) =>
    integrationCountRecomputeStmt(db, productId),
  );
}

// ─── The commit-time gate (the second review blocker on AECI-2042) ───────────

/** The token {@link pairRightTargetSentinel} raises. */
export const PAIR_RIGHT_CHANGED_TOKEN = 'pair-right-changed';

/**
 * The commit-time half of {@link resolvePairRightTarget}. Pushed AHEAD of the veto
 * INSERT or the report INSERT; ABORTS the batch, writing nothing, unless at commit:
 *
 *   (a) the anchor row still exists with the same connector and the same endpoints, in
 *       the same frame, that the write is about to record;
 *   (b) the connector product is still a Sync Service (role `connector` or `hybrid`,
 *       kind `sync_service`), the rule `isSyncService` applies;
 *   (c) the caller's vendor still holds at least one of the two endpoint products;
 *   (d) the caller's vendor is still not the row's owner and does not hold the
 *       connector product.
 *
 * `opts.ownerUnchanged` also requires the owner and the claimed state the route read
 * (a report routes on them). `opts.live` also requires the row to be neither retired nor
 * vetoed (a report asks about a pair on the site). Raises "malformed JSON", like every
 * sentinel here; selects FROM `ONE_ROW`, so it runs exactly once.
 */
export function pairRightTargetSentinel(
  db: Db,
  target: PairRightTarget,
  vendorId: string,
  opts: { ownerUnchanged?: boolean; live?: boolean } = {},
): BatchStmt {
  const key = pairKeyOf(target);
  const [sourceId, targetId] = target.sourceIsA
    ? [target.productAId, target.productBId]
    : [target.productBId, target.productAId];
  const row =
    target.anchor === 'integration'
      ? {
          table: integrations,
          where: and(
            eq(integrations.id, target.id),
            eq(integrations.poweredByProductId, target.connectorProductId),
            eq(integrations.sourceProductId, sourceId),
            eq(integrations.targetProductId, targetId),
          )!,
          builtBy: integrations.builtByVendorId,
          claimedAt: integrations.claimedAt,
          retiredAt: integrations.retiredAt,
          vetoedAt: integrations.vetoedAt,
        }
      : {
          table: connectorEvidencedPairs,
          where: and(eq(connectorEvidencedPairs.id, target.id), evidencedPairsOnPairKeyWhere(key))!,
          builtBy: connectorEvidencedPairs.builtByVendorId,
          claimedAt: connectorEvidencedPairs.claimedAt,
          retiredAt: connectorEvidencedPairs.retiredAt,
          vetoedAt: connectorEvidencedPairs.vetoedAt,
        };
  const extra: SQL[] = [];
  if (opts.ownerUnchanged) {
    extra.push(sql`ifnull(${row.builtBy}, '') = ${target.builtByVendorId ?? ''}`);
    extra.push(sql`(${row.claimedAt} IS NULL) = ${target.claimedAt === null ? 1 : 0}`);
  }
  if (opts.live) extra.push(sql`${row.retiredAt} IS NULL AND ${row.vetoedAt} IS NULL`);
  const extraSql = extra.length ? sql` AND ${sql.join(extra, sql` AND `)}` : sql``;
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${row.table} WHERE ${row.where} AND (${row.builtBy} IS NULL OR ${row.builtBy} <> ${vendorId})${extraSql})
        OR NOT EXISTS (SELECT 1 FROM ${products} WHERE ${products.id} = ${target.connectorProductId} AND ${products.productRole} IN ('connector', 'hybrid') AND ${products.connectorKind} = 'sync_service')
        OR NOT EXISTS (SELECT 1 FROM ${productVendors} WHERE ${productVendors.vendorId} = ${vendorId} AND ${productVendors.productId} IN (${target.productAId}, ${target.productBId}))
        OR EXISTS (SELECT 1 FROM ${productVendors} WHERE ${productVendors.vendorId} = ${vendorId} AND ${productVendors.productId} = ${target.connectorProductId})
        THEN json(${PAIR_RIGHT_CHANGED_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/** The `409` a veto answers when {@link pairRightTargetSentinel} aborted it. */
export function vetoPairChangedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.VETO_PAIR_CHANGED,
    'This integration, or your company’s link to it, changed while you were sending. Nothing was saved. Reload and try again.',
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
 *  vendors of the Sync Service product; the owner of every other row on the key, whose
 *  row the veto hid too (`keyOwners`); and every other endpoint vendor. The acting
 *  vendor is never told. Sorted by id (an id ordering stays BINARY). */
export async function vetoAudience(
  db: Db,
  target: PairRightTarget,
  actingVendorId: string | null,
  keyOwners: readonly (string | null)[] = [],
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
  for (const owner of keyOwners) if (owner) owners.add(owner);
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

/** Is any row on the key on the public site now? A veto's `pair_public`: the key is
 *  what a veto hides and what a withdraw or lift brings back. */
export async function pairKeyIsPublic(db: Db, key: PairKey): Promise<boolean> {
  const [pair] = await db
    .select({ id: connectorEvidencedPairs.id })
    .from(connectorEvidencedPairs)
    .where(and(evidencedPairsOnPairKeyWhere(key), liveEvidencedPairWhere))
    .limit(1);
  if (pair) return true;
  const [row] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(integrationsOnPairKeyWhere(key), liveIntegrationWhere))
    .limit(1);
  return row !== undefined;
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

/** The row a veto was filed on. `null` when it is gone (the anchor FK is SET NULL). */
export function vetoAnchorOf(row: VetoRow): { anchor: PairRightAnchor; id: string } | null {
  if (row.integrationId) return { anchor: 'integration', id: row.integrationId };
  if (row.evidencedPairId) return { anchor: 'evidenced_pair', id: row.evidencedPairId };
  return null;
}

/**
 * The row a withdraw or lift names in its notices: the veto's anchor, or, when that
 * row is gone, the first row still on the veto's key. `null` when no row is on the key:
 * there is nothing to recompute and nobody to tell.
 */
export async function vetoNoticeTarget(db: Db, row: VetoRow): Promise<PairRightTarget | null> {
  const anchor = vetoAnchorOf(row);
  const located = anchor ? await locatePairRightTarget(db, anchor.id) : null;
  if (located && located.connectorProductId !== null) return located as PairRightTarget;
  const [first] = await rowsOnPairKey(db, vetoKeyOf(row));
  if (!first) return null;
  const other = await locatePairRightTarget(db, first.id);
  return other && other.connectorProductId !== null ? (other as PairRightTarget) : null;
}

/**
 * Vetoes on a pair key where this vendor owns a row: the owner's side of the vendor
 * list. Key-wide, like the hiding: an owner whose row on the key was hidden sees the
 * veto, whichever row it was filed on, and after that row is deleted.
 */
export function vetoesOwnedByWhere(vendorId: string): SQL {
  const v = syncServicePairVetoes;
  return or(
    sql`EXISTS (SELECT 1 FROM ${connectorEvidencedPairs} WHERE ${connectorEvidencedPairs.builtByVendorId} = ${vendorId} AND ${connectorEvidencedPairs.connectorProductId} = ${v.connectorProductId} AND ${connectorEvidencedPairs.productAId} = ${v.productAId} AND ${connectorEvidencedPairs.productBId} = ${v.productBId})`,
    sql`EXISTS (SELECT 1 FROM ${integrations} WHERE ${integrations.builtByVendorId} = ${vendorId} AND ${integrations.poweredByProductId} = ${v.connectorProductId} AND ((${integrations.sourceProductId} = ${v.productAId} AND ${integrations.targetProductId} = ${v.productBId}) OR (${integrations.sourceProductId} = ${v.productBId} AND ${integrations.targetProductId} = ${v.productAId})))`,
  )!;
}
