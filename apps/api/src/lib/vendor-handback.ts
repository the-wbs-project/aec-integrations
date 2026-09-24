/**
 * What a vendor's rows do when its seats go away (AECI-989 /
 * `docs/STAGE_2_ATTESTATIONS_SPEC.md` §13.9 "The seat hand-back").
 *
 * Three builders, one per seat event. Each READS what it needs, then RETURNS the
 * statements, audit rows, workflow transitions and purge tags for the caller to put
 * in its own `db.batch([...])` (§26.1). None of them executes a write.
 *
 * ── 1. THE HAND-BACK: `planVendorHandback` ──────────────────────────────────
 * Runs when a vendor is left with NO `vendor_admin` profile at all, banned or not.
 * Today the one caller is the admin seat revoke (`routes/admin-vendors.ts`).
 * AECI-1106 wires the account-erasure batch onto the same function, which is why
 * it is exported and takes no Hono context.
 *
 * - `vendors.maintained_by` and every owned `products.maintained_by` go back to
 *   `'aeci'`. A product co-owned with a vendor that still holds a seat keeps its
 *   marker: AECI-520 still blocks promote on it, so AECi is not curating it again.
 * - Every LIVE integration the vendor owns and has claimed loses `claimed_at`, so
 *   the promote fence (`REVIEW_APP_PROMOTE_API.md` §4b) lifts and promote writes it
 *   again. This is the un-claim the owner-reassignment accept already makes
 *   (`routes/admin-contests.ts`), for the same reason: nobody who has acted owns it.
 *   `built_by_vendor_id` and `origin` are untouched. A vendor-created row
 *   (`origin = 'vendor'`) therefore stays fenced, which is correct: the review app
 *   has no record to write it from (ruled 2026-09-23).
 * - The same holds for every live `connector_evidenced_pairs` row it owns and has
 *   claimed (AECI-1089 made pairs claimable). Same un-claim, same retired-row rule,
 *   same marker rule over the attestations anchored on the pair. Its audit rows use
 *   entity type `connector_evidenced_pair` with `metadata.anchor = 'evidenced_pair'`,
 *   as the claim's do, and a marker flip also purges the connector's `product:` tag,
 *   because the connector's page lists the pair.
 * - A RETIRED owned row keeps its claim. It is off the public record already, and
 *   a claimed retired row is what lets a re-seated vendor restore its own
 *   withdrawal. Clearing it would also break "retired implies vendor-held" on an
 *   `origin = 'aeci'` row (the `retired_integration_unclaimed` check).
 * - An un-claimed integration's `maintained_by` goes back to `'aeci'` only when no
 *   live vendor attestation survives on it, which is §13.4's retraction rule. An
 *   attestation is not ownership (ADR 0035 decision 13).
 * - Every open contest routed to this owner goes to AECi, as the reassignment
 *   accept's `rerouteOwnerContests` does. A contest a ban had already moved keeps
 *   its `owner_seat_lapsed_at` stamp, and it still cannot come back: the return
 *   needs the row claimed by this owner since before the stamp, and this
 *   hand-back ends that claim. A later re-claim is newer than the stamp.
 * - Claims, attestations, links and contests are kept. Nothing is deleted.
 * - `last_reviewed_at` is never touched in either direction (§13.4).
 * - `vendors.verified` and `vendor_entitlements` are untouched. Seat and
 *   entitlement stay orthogonal (`STAGE_2_PAID_TIERS_SPEC.md` §5.2).
 *
 * A write that would change nothing is omitted with its audit row, the way
 * `aeciMaintainedFlip` returns `null` in `routes/vendor-attestations.ts`.
 *
 * ── 2. THE SEAT LAPSE: `planOwnerSeatLapse` ─────────────────────────────────
 * Runs when a vendor still has a `vendor_admin` profile but none of them is
 * unbanned: a ban of its last active seat, or a revoke that leaves only banned
 * seats. A ban hands nothing back (ruled 2026-09-23): it is reversible, and a
 * hand-back would make an unban lose data. But nobody at the vendor can answer a
 * contest, so every open owner-routed contest moves to AECi's queue, stamped with
 * `owner_seat_lapsed_at`. `claimed_at` is untouched.
 *
 * ── 3. THE SEAT RETURN: `planOwnerSeatReturn` ───────────────────────────────
 * Runs whenever the vendor has an unbanned seat again: on an unban, and on any new
 * seat grant (`planSeatGrantReturn`, ruled 2026-09-23). Every open, stamped contest whose integration is still live
 * and has been claimed by this vendor since before the stamp goes back to the
 * owner, and the stamp clears. "Since before the stamp" is what keeps a contest a
 * hand-back took for good from returning after the vendor re-claims the row.
 * A contest submitted during the lapse is stamped at submit
 * (`routes/vendor-contests.ts`), so it returns the same way.
 */

import { ApiErrorCode } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import { ApiError } from '../errors';
import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  products,
  productVendors,
  profiles,
  vendors,
} from '../db/schema';
import { pairCacheTag } from '../routes/promote-pair';
import { ATTESTATION_SLOTS } from './attestation-authority';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from './audit';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import { liveAttestationsWhere } from './drizzle-helpers';
import { ONE_ROW } from './integration-claims';
import { isConnectorPoweredEdge } from './connector-powered';
import { CONTEST_ENTITY_TYPE } from './integration-contests';

/** Who is acting. The admin on the revoke and the ban. */
export interface HandbackActor {
  actorId: string;
  actorType: AuditLogEntry['actorType'];
}

export interface HandbackParams extends HandbackActor {
  vendorId: string;
  now: string;
  /** `metadata.source` on every row. The admin routes pass `admin-moderation`. */
  source: string;
}

/** What a builder hands the caller: put `stmts` in the batch, forward the rest
 *  post-commit, and enqueue `purgeTags` inside `ctx.waitUntil`. */
export interface HandbackBatch {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  transitions: WorkflowTransitionEntry[];
  purgeTags: string[];
}

/** `metadata.reason` on the un-claim row. The marker flips keep
 *  `maintenance-marker` so one grep still finds every maintenance flip (§13.9). */
export const HANDBACK_REASON = 'owner-seat-revoked';

/** `metadata.reason` on a contest the lapse moves to AECi. */
export const SEAT_LAPSE_REASON = 'owner-seat-lapsed';

/** `metadata.reason` on a contest the unban moves back to its owner. */
export const SEAT_RETURN_REASON = 'owner-seat-restored';

const MAINTENANCE_REASON = 'maintenance-marker';

function emptyBatch(): HandbackBatch {
  return { stmts: [], audits: [], transitions: [], purgeTags: [] };
}

/** Add the audit rows' inserts to the statements, in order, once. */
function sealed(batch: HandbackBatch, db: Db): HandbackBatch {
  return { ...batch, stmts: [...batch.stmts, ...batch.audits.map((a) => auditInsert(db, a))] };
}

// ─── Which seat event is this? ───────────────────────────────────────────────

/** What losing a seat means for the vendor, given the seats that REMAIN after it. */
export type SeatLossOutcome = 'handback' | 'lapse' | 'none';

/**
 * `handback` when no `vendor_admin` profile remains, `lapse` when some remain and
 * all are banned, `none` while any unbanned seat remains. `excludeUserId` is the
 * seat being removed or banned, read as already gone because the pre-batch read
 * cannot see the batch.
 */
export async function seatLossOutcome(
  db: Db,
  vendorId: string,
  excludeUserId: string,
): Promise<SeatLossOutcome> {
  const remaining = await db
    .select({ bannedAt: profiles.bannedAt })
    .from(profiles)
    .where(
      and(
        eq(profiles.vendorId, vendorId),
        eq(profiles.role, VENDOR_ADMIN_ROLE),
        ne(profiles.id, excludeUserId),
      ),
    );
  if (remaining.length === 0) return 'handback';
  return remaining.some((r) => r.bannedAt === null) ? 'none' : 'lapse';
}

// ─── Race guards ─────────────────────────────────────────────────────────────

const SEATS_CHANGED_TOKEN = 'vendor-seats-changed';

/**
 * Two batch statements that ABORT a seat revoke or ban whose plan no longer holds.
 * Put them directly after the guarded profile UPDATE.
 *
 * The first raises when that UPDATE matched no row: a double-click, where the first
 * request already revoked or banned the seat. Without it the loser would commit
 * every hand-back audit row for writes its guarded UPDATEs did not make.
 *
 * The second raises when the seats left after the UPDATE are not the ones the plan
 * read. Two seats revoked at once would each see the other still there, plan
 * `none`, and leave a seatless vendor with nothing handed back.
 *
 * `planned = null` keeps the first guard only, for an unban, which plans nothing
 * that depends on the other seats.
 *
 * Both use `json('vendor-seats-changed')`, which is malformed JSON, so the whole
 * batch rolls back. {@link isSeatsChangedError} recognises it. Same mechanism as
 * `claimRaceSentinel`, and FROM a one-row constant for the same reason.
 */
export function seatRaceSentinels(
  db: Db,
  vendorId: string,
  planned: SeatLossOutcome | null,
): BatchStmt[] {
  const any = sql`EXISTS (SELECT 1 FROM ${profiles} WHERE ${profiles.vendorId} = ${vendorId} AND ${profiles.role} = ${VENDOR_ADMIN_ROLE})`;
  const active = sql`EXISTS (SELECT 1 FROM ${profiles} WHERE ${profiles.vendorId} = ${vendorId} AND ${profiles.role} = ${VENDOR_ADMIN_ROLE} AND ${profiles.bannedAt} IS NULL)`;
  const mismatch =
    planned === 'handback'
      ? any
      : planned === 'lapse'
        ? sql`(NOT ${any} OR ${active})`
        : sql`NOT ${active}`;
  const matched = db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${SEATS_CHANGED_TOKEN}) END` })
    .from(ONE_ROW);
  if (planned === null) return [matched];
  return [
    matched,
    db
      .select({ guard: sql`CASE WHEN ${mismatch} THEN json(${SEATS_CHANGED_TOKEN}) END` })
      .from(ONE_ROW),
  ];
}

/** `409 VENDOR_SEATS_CHANGED`: the seat write lost a race and wrote nothing. */
export function seatsChangedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.VENDOR_SEATS_CHANGED,
    "This vendor's seats changed while the request ran, so nothing was saved. Reload and try again.",
  );
}

/** True for the error {@link seatRaceSentinels} raises, in D1 or SQLite. */
export function isSeatsChangedError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(SEATS_CHANGED_TOKEN)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Does this vendor hold no unbanned `vendor_admin` seat? The contest submit asks
 *  this of the owner before routing a contest to it. */
export async function ownerSeatLapsed(db: Db, vendorId: string): Promise<boolean> {
  const active = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.vendorId, vendorId),
        eq(profiles.role, VENDOR_ADMIN_ROLE),
        isNull(profiles.bannedAt),
      ),
    )
    .limit(1);
  return active.length === 0;
}

// ─── 1. The hand-back ────────────────────────────────────────────────────────

export async function planVendorHandback(db: Db, p: HandbackParams): Promise<HandbackBatch> {
  const batch = emptyBatch();
  const actor = { actorId: p.actorId, actorType: p.actorType };
  const base = { source: p.source, vendor_id: p.vendorId };

  const vendor = await db.query.vendors.findFirst({
    columns: { id: true, slug: true, maintainedBy: true },
    where: eq(vendors.id, p.vendorId),
  });
  if (!vendor) return batch;

  // The vendor row.
  if (vendor.maintainedBy === 'vendor') {
    batch.stmts.push(
      db
        .update(vendors)
        .set({ maintainedBy: 'aeci' })
        .where(and(eq(vendors.id, vendor.id), eq(vendors.maintainedBy, 'vendor'))),
    );
    batch.audits.push({
      ...actor,
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: vendor.id,
      beforeState: { maintained_by: 'vendor' },
      afterState: { maintained_by: 'aeci' },
      metadata: { ...base, reason: MAINTENANCE_REASON, cause: HANDBACK_REASON },
    });
    batch.purgeTags.push(`vendor:${vendor.slug}`);
  }

  // Every owned product, the same `product_vendors` set AECI-520 blocks on.
  const owned = await db
    .select({ id: products.id, slug: products.slug, maintainedBy: products.maintainedBy })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(eq(productVendors.vendorId, p.vendorId));
  const vendorProducts = owned.filter((row) => row.maintainedBy === 'vendor');
  const seatedCoOwned = await productsWithSeatedCoOwner(
    db,
    p.vendorId,
    vendorProducts.map((row) => row.id),
  );
  for (const product of vendorProducts) {
    if (seatedCoOwned.has(product.id)) continue;
    batch.stmts.push(
      db
        .update(products)
        .set({ maintainedBy: 'aeci' })
        .where(and(eq(products.id, product.id), eq(products.maintainedBy, 'vendor'))),
    );
    batch.audits.push({
      ...actor,
      action: 'product.updated',
      entityType: 'product',
      entityId: product.id,
      beforeState: { maintained_by: 'vendor' },
      afterState: { maintained_by: 'aeci' },
      metadata: { ...base, reason: MAINTENANCE_REASON, cause: HANDBACK_REASON },
    });
    batch.purgeTags.push(`product:${product.slug}`);
  }
  if (batch.purgeTags.some((tag) => tag.startsWith('product:'))) {
    batch.purgeTags.push('index:products');
  }

  // Every live integration it owns and has claimed.
  const source = alias(products, 'handback_source');
  const target = alias(products, 'handback_target');
  const poweredBy = alias(products, 'handback_powered_by');
  const claimedRows = await db
    .select({
      id: integrations.id,
      claimedAt: integrations.claimedAt,
      maintainedBy: integrations.maintainedBy,
      poweredByProductId: integrations.poweredByProductId,
      mechanismKind: integrations.mechanismKind,
      sourceSlug: source.slug,
      targetSlug: target.slug,
      poweredBySlug: poweredBy.slug,
    })
    .from(integrations)
    .innerJoin(source, eq(source.id, integrations.sourceProductId))
    .innerJoin(target, eq(target.id, integrations.targetProductId))
    .leftJoin(poweredBy, eq(poweredBy.id, integrations.poweredByProductId))
    .where(
      and(
        eq(integrations.builtByVendorId, p.vendorId),
        isNotNull(integrations.claimedAt),
        isNull(integrations.retiredAt),
      ),
    );
  const attested = await integrationsWithLiveVendorAttestation(
    db,
    claimedRows.map((row) => row.id),
  );
  for (const row of claimedRows) {
    const guard = and(eq(integrations.id, row.id), eq(integrations.builtByVendorId, p.vendorId));
    // The carve-out markers the AECI-1089 claim and the AECI-1090 edit write on a
    // connector-powered row, so one filter finds every owner-side write on them.
    const markers = isConnectorPoweredEdge(row)
      ? { connectorPowered: true as const, anchor: 'integration' as const }
      : {};
    batch.stmts.push(
      db
        .update(integrations)
        .set({ claimedAt: null })
        .where(and(guard, isNotNull(integrations.claimedAt))),
    );
    batch.audits.push({
      ...actor,
      action: 'integration.updated',
      entityType: 'integration',
      entityId: row.id,
      beforeState: { claimed_at: row.claimedAt },
      afterState: { claimed_at: null },
      metadata: { ...base, integrationId: row.id, ...markers, reason: HANDBACK_REASON },
    });
    if (row.maintainedBy === 'vendor' && !attested.has(row.id)) {
      batch.stmts.push(
        db
          .update(integrations)
          .set({ maintainedBy: 'aeci' })
          .where(and(guard, eq(integrations.maintainedBy, 'vendor'))),
      );
      batch.audits.push({
        ...actor,
        action: 'integration.updated',
        entityType: 'integration',
        entityId: row.id,
        beforeState: { maintained_by: 'vendor' },
        afterState: { maintained_by: 'aeci' },
        metadata: {
          ...base,
          integrationId: row.id,
          ...markers,
          reason: MAINTENANCE_REASON,
          cause: HANDBACK_REASON,
        },
      });
      batch.purgeTags.push(
        pairCacheTag(row.sourceSlug, row.targetSlug),
        `product:${row.sourceSlug}`,
        `product:${row.targetSlug}`,
        // The `powered_by` product's page lists the row too.
        ...(row.poweredBySlug ? [`product:${row.poweredBySlug}`] : []),
      );
    }
  }

  // Every live evidenced pair it owns and has claimed (AECI-1089). The same rules as
  // the integration arm above; only the table, the anchor and the tags differ.
  const pairA = alias(products, 'handback_pair_a');
  const pairB = alias(products, 'handback_pair_b');
  const pairConnector = alias(products, 'handback_pair_connector');
  const claimedPairs = await db
    .select({
      id: connectorEvidencedPairs.id,
      claimedAt: connectorEvidencedPairs.claimedAt,
      maintainedBy: connectorEvidencedPairs.maintainedBy,
      aSlug: pairA.slug,
      bSlug: pairB.slug,
      connectorSlug: pairConnector.slug,
    })
    .from(connectorEvidencedPairs)
    .innerJoin(pairA, eq(pairA.id, connectorEvidencedPairs.productAId))
    .innerJoin(pairB, eq(pairB.id, connectorEvidencedPairs.productBId))
    .innerJoin(pairConnector, eq(pairConnector.id, connectorEvidencedPairs.connectorProductId))
    .where(
      and(
        eq(connectorEvidencedPairs.builtByVendorId, p.vendorId),
        isNotNull(connectorEvidencedPairs.claimedAt),
        isNull(connectorEvidencedPairs.retiredAt),
      ),
    );
  const attestedPairs = await pairsWithLiveVendorAttestation(
    db,
    claimedPairs.map((row) => row.id),
  );
  for (const row of claimedPairs) {
    const guard = and(
      eq(connectorEvidencedPairs.id, row.id),
      eq(connectorEvidencedPairs.builtByVendorId, p.vendorId),
    );
    const pairMeta = {
      ...base,
      integrationId: row.id,
      connectorPowered: true as const,
      anchor: 'evidenced_pair' as const,
    };
    batch.stmts.push(
      db
        .update(connectorEvidencedPairs)
        .set({ claimedAt: null })
        .where(and(guard, isNotNull(connectorEvidencedPairs.claimedAt))),
    );
    batch.audits.push({
      ...actor,
      action: 'integration.updated',
      entityType: 'connector_evidenced_pair',
      entityId: row.id,
      beforeState: { claimed_at: row.claimedAt },
      afterState: { claimed_at: null },
      metadata: { ...pairMeta, reason: HANDBACK_REASON },
    });
    if (row.maintainedBy === 'vendor' && !attestedPairs.has(row.id)) {
      batch.stmts.push(
        db
          .update(connectorEvidencedPairs)
          .set({ maintainedBy: 'aeci' })
          .where(and(guard, eq(connectorEvidencedPairs.maintainedBy, 'vendor'))),
      );
      batch.audits.push({
        ...actor,
        action: 'integration.updated',
        entityType: 'connector_evidenced_pair',
        entityId: row.id,
        beforeState: { maintained_by: 'vendor' },
        afterState: { maintained_by: 'aeci' },
        metadata: { ...pairMeta, reason: MAINTENANCE_REASON, cause: HANDBACK_REASON },
      });
      batch.purgeTags.push(
        pairCacheTag(row.aSlug, row.bSlug),
        `product:${row.aSlug}`,
        `product:${row.bSlug}`,
        `product:${row.connectorSlug}`,
      );
    }
  }

  // Every open contest this owner could decide goes to AECi, for good.
  const contests = await db
    .select()
    .from(integrationFieldChallenges)
    .where(
      and(
        eq(integrationFieldChallenges.ownerVendorId, p.vendorId),
        eq(integrationFieldChallenges.routedTo, 'owner'),
        eq(integrationFieldChallenges.status, 'open'),
      ),
    );
  for (const contest of contests) {
    rerouteContest(db, batch, actor, contest, p.now, {
      to: 'aeci',
      stamp: null,
      reason: HANDBACK_REASON,
      transitionReason: 'owner seat revoked: re-routed to AECi',
      source: p.source,
    });
  }

  batch.purgeTags = [...new Set(batch.purgeTags)];
  return sealed(batch, db);
}

/** Ids per `IN (...)` lookup. D1 caps bound parameters per query at 100, and a
 *  vendor's product or integration list is unbounded. */
const ID_CHUNK = 80;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Products in `productIds` that another vendor, holding any seat, also owns. */
async function productsWithSeatedCoOwner(
  db: Db,
  vendorId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const ids of chunk(productIds, ID_CHUNK)) {
    const rows = await db
      .selectDistinct({ productId: productVendors.productId })
      .from(productVendors)
      .innerJoin(profiles, eq(profiles.vendorId, productVendors.vendorId))
      .where(
        and(
          inArray(productVendors.productId, ids),
          ne(productVendors.vendorId, vendorId),
          eq(profiles.role, VENDOR_ADMIN_ROLE),
        ),
      );
    for (const row of rows) found.add(row.productId);
  }
  return found;
}

/** Integrations in `ids` that still carry a live vendor attestation (§13.4's
 *  integration-grain test, batched). */
async function integrationsWithLiveVendorAttestation(
  db: Db,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunk(ids, ID_CHUNK)) {
    const rows = await db
      .selectDistinct({ integrationId: claims.integrationId })
      .from(attestations)
      .innerJoin(claims, eq(claims.id, attestations.claimId))
      .where(
        and(
          inArray(claims.integrationId, part),
          inArray(attestations.source, [...ATTESTATION_SLOTS]),
          liveAttestationsWhere,
        ),
      );
    for (const row of rows) if (row.integrationId) found.add(row.integrationId);
  }
  return found;
}

/** Evidenced pairs in `ids` that still carry a live vendor attestation: the same
 *  test as {@link integrationsWithLiveVendorAttestation}, over the claims anchored
 *  on the pair. */
async function pairsWithLiveVendorAttestation(
  db: Db,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunk(ids, ID_CHUNK)) {
    const rows = await db
      .selectDistinct({ pairId: claims.connectorEvidencedPairId })
      .from(attestations)
      .innerJoin(claims, eq(claims.id, attestations.claimId))
      .where(
        and(
          inArray(claims.connectorEvidencedPairId, part),
          inArray(attestations.source, [...ATTESTATION_SLOTS]),
          liveAttestationsWhere,
        ),
      );
    for (const row of rows) if (row.pairId) found.add(row.pairId);
  }
  return found;
}

// ─── 2. The seat lapse ───────────────────────────────────────────────────────

export async function planOwnerSeatLapse(db: Db, p: HandbackParams): Promise<HandbackBatch> {
  const batch = emptyBatch();
  const actor = { actorId: p.actorId, actorType: p.actorType };
  const open = await db
    .select()
    .from(integrationFieldChallenges)
    .where(
      and(
        eq(integrationFieldChallenges.ownerVendorId, p.vendorId),
        eq(integrationFieldChallenges.routedTo, 'owner'),
        eq(integrationFieldChallenges.status, 'open'),
      ),
    );
  for (const contest of open) {
    rerouteContest(db, batch, actor, contest, p.now, {
      to: 'aeci',
      stamp: p.now,
      reason: SEAT_LAPSE_REASON,
      transitionReason: 'owner has no active seat: re-routed to AECi',
      source: p.source,
    });
  }
  return sealed(batch, db);
}

// ─── 3. The seat return ──────────────────────────────────────────────────────

export async function planOwnerSeatReturn(db: Db, p: HandbackParams): Promise<HandbackBatch> {
  const batch = emptyBatch();
  const actor = { actorId: p.actorId, actorType: p.actorType };
  const stamped = await db
    .select({ contest: integrationFieldChallenges })
    .from(integrationFieldChallenges)
    .innerJoin(integrations, eq(integrations.id, integrationFieldChallenges.integrationId))
    .where(
      and(
        eq(integrationFieldChallenges.ownerVendorId, p.vendorId),
        eq(integrationFieldChallenges.routedTo, 'aeci'),
        eq(integrationFieldChallenges.status, 'open'),
        isNotNull(integrationFieldChallenges.ownerSeatLapsedAt),
        eq(integrations.builtByVendorId, p.vendorId),
        isNotNull(integrations.claimedAt),
        isNull(integrations.retiredAt),
        sql`${integrationFieldChallenges.ownerSeatLapsedAt} >= ${integrations.claimedAt}`,
      ),
    );
  for (const { contest } of stamped) {
    rerouteContest(db, batch, actor, contest, p.now, {
      to: 'owner',
      stamp: null,
      reason: SEAT_RETURN_REASON,
      transitionReason: 'owner seat restored: routed back to the owner',
      source: p.source,
    });
  }
  return sealed(batch, db);
}

/**
 * The seat-GRANT half of the return (ruled 2026-09-23): a vendor that gets an
 * unbanned `vendor_admin` again by a NEW seat, not only by an unban, gets its
 * ban-moved contests back. Called by all three seat writers: the admin provision
 * (`POST /api/admin/vendors/:id/seats`), the claim grant
 * (`PATCH /api/admin/claims/:id`) and the invite redeem
 * (`POST /api/seat-invites/:token/accept`).
 *
 * `null` when the new seat's own profile is banned, because a banned seat is not
 * an active one, or when nothing is stamped. The pre-batch read cannot see the new
 * seat, so the caller's grant is what makes the vendor active again. A grant that
 * lands on no row (a lost race) still commits these guarded re-routes. That is
 * accepted: the grant's own batch is what decides whether the seat exists.
 */
export async function planSeatGrantReturn(
  db: Db,
  p: HandbackParams,
  seatUserId: string,
): Promise<HandbackBatch | null> {
  const seat = await db.query.profiles.findFirst({
    columns: { bannedAt: true },
    where: eq(profiles.id, seatUserId),
  });
  if (seat?.bannedAt) return null;
  const batch = await planOwnerSeatReturn(db, p);
  return batch.stmts.length > 0 ? batch : null;
}

// ─── Shared: one contest re-route ────────────────────────────────────────────

type ContestSelect = typeof integrationFieldChallenges.$inferSelect;

/**
 * One re-route, in `rerouteOwnerContests`' shape: a guarded UPDATE, an
 * `open → open` transition (the state holds, the decider changes) and an
 * `integration.contest.rerouted` audit row.
 */
function rerouteContest(
  db: Db,
  batch: HandbackBatch,
  actor: HandbackActor,
  contest: ContestSelect,
  now: string,
  move: {
    to: 'owner' | 'aeci';
    stamp: string | null;
    reason: string;
    transitionReason: string;
    source: string;
  },
): void {
  const from = move.to === 'aeci' ? 'owner' : 'aeci';
  const metadata = {
    source: move.source,
    contestId: contest.id,
    integrationId: contest.integrationId,
    reason: move.reason,
  };
  batch.stmts.push(
    db
      .update(integrationFieldChallenges)
      .set({ routedTo: move.to, ownerSeatLapsedAt: move.stamp, updatedAt: now })
      .where(
        and(
          eq(integrationFieldChallenges.id, contest.id),
          eq(integrationFieldChallenges.status, 'open'),
          eq(integrationFieldChallenges.routedTo, from),
        ),
      ),
  );
  if (contest.workflowId) {
    const transition: WorkflowTransitionEntry = {
      workflowId: contest.workflowId,
      fromState: 'open',
      toState: 'open',
      actorId: actor.actorId,
      reason: move.transitionReason,
      metadata,
    };
    batch.stmts.push(workflowTransitionInsert(db, transition));
    batch.transitions.push(transition);
  }
  batch.audits.push({
    ...actor,
    action: 'integration.contest.rerouted',
    entityType: CONTEST_ENTITY_TYPE,
    entityId: contest.id,
    beforeState: { routed_to: from, owner_vendor_id: contest.ownerVendorId },
    afterState: { routed_to: move.to, owner_vendor_id: contest.ownerVendorId },
    metadata,
  });
}
