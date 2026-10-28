/**
 * What a vendor's rows do when its seats go away, and when AECi takes its records
 * back (AECI-989, reworked by AECI-1415 / ADR 0042; `docs/STAGE_2_ATTESTATIONS_SPEC.md`
 * §13.9).
 *
 * Builders, one per event. Each READS what it needs, then RETURNS the statements,
 * audit rows, workflow transitions and purge tags for the caller to put in its own
 * `db.batch([...])` (§26.1). None of them executes a write.
 *
 * ── 0. SEAT LOSS FREEZES, IT DOES NOT HAND BACK (ruled 2026-10-19, AECI-1341 Q1) ──
 * Ownership is stored (`vendors.owned_at`) and seat loss never moves it. When a
 * revoke or an account erasure leaves a vendor with no `vendor_admin` profile at all
 * (`seatLossOutcome` = `vacant`), the caller plans the SEAT LAPSE below, the same as
 * a ban: the edit right ends with the seats, the open owner contests move to AECi's
 * queue stamped, and nothing else changes. `maintained_by`, `claimed_at` and
 * `owned_at` stay, so promote keeps refusing the records (`REVIEW_APP_PROMOTE_API.md`
 * §4a). A later seat grant gets the stamped contests back, as after an unban.
 *
 * ── 1. THE RETURN TO AECi: `planVendorHandback` ─────────────────────────────
 * The one explicit admin action, "Return records to AECi"
 * (`POST /api/admin/vendors/:id/return-to-aeci`, `routes/admin-vendors.ts`), is its
 * only caller. It exists for a mistaken approval. The route refuses while the vendor
 * holds any `vendor_admin` seat, and clears `vendors.owned_at` in the same batch.
 *
 * - `vendors.maintained_by` and every owned `products.maintained_by` go back to
 *   `'aeci'`. A product co-owned with another OWNED vendor keeps its marker: promote
 *   still refuses it (Q3), so AECi is not curating it again.
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
 * - Every open contest still routed to this owner goes to AECi. A contest the seat
 *   loss had already moved keeps its `owner_seat_lapsed_at` stamp, and it still
 *   cannot come back: the return needs the row claimed by this owner since before
 *   the stamp, and this un-claim ends that claim. A later re-claim is newer.
 * - Claims, attestations, links and contests are kept. Nothing is deleted.
 * - `last_reviewed_at` is never touched in either direction (§13.4).
 * - `vendors.verified` and the vendor's licenses are untouched. Seat and plan stay
 *   orthogonal (`STAGE_2_PAID_TIERS_SPEC.md` §5.2).
 *
 * A write that would change nothing is omitted with its audit row, the way
 * `aeciMaintainedFlip` returns `null` in `routes/vendor-attestations.ts`.
 *
 * ── 2. THE SEAT LAPSE: `planOwnerSeatLapse` ─────────────────────────────────
 * Runs when a vendor is left with no unbanned seat: a ban of its last active seat,
 * a revoke that leaves only banned seats, and since AECI-1415 a revoke or erasure
 * that leaves no seat at all. Nothing is handed back (ruled 2026-09-23 for the ban,
 * 2026-10-19 for every seat loss). But nobody at the vendor can answer a contest,
 * so every open owner-routed contest moves to AECi's queue, stamped with
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
 * A seat grant also clears the vendor's `vendor-banned` license flags, as the unban
 * does (ruled 2026-10-15, `clearVendorBannedFlagsStatements` in `lib/license.ts`).
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
  billingAccounts,
  claims,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  licenses,
  products,
  productVendors,
  profiles,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import { pairCacheTag } from '../routes/promote-pair';
import { ATTESTATION_SLOTS } from './attestation-authority';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from './audit';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import { liveAttestationsWhere } from './drizzle-helpers';
import { ONE_ROW } from './integration-claims';
import { isConnectorPoweredEdge } from './connector-powered';
import {
  anchorMetadata,
  clearSeatStamp,
  CONTEST_ENTITY_TYPE,
  contestAnchorOf,
  contestRowChangedSentinel,
  routesAsConnectorPowered,
  ownerEntitlementActiveSentinel,
  vendorHoldsActiveEntitlement,
} from './integration-contests';
import { licensePlanSnapshot } from '@aeci/shared/entitlements';
import {
  clearVendorBannedFlagsStatements,
  loadVendorLicenses,
  VENDOR_BANNED_CANCEL_REASON,
} from './license';
import { liveInvitesFor } from './vendor-seat-invites';

/** Who is acting. The admin on the revoke and the ban. `null` on an account
 *  erasure (AECI-1106): the erased profile is deleted in the same batch, and
 *  `audit_log.actor_id` and `workflow_transitions.actor_id` are NO ACTION FKs. */
export interface HandbackActor {
  actorId: string | null;
  actorType: AuditLogEntry['actorType'];
}

export interface HandbackParams extends HandbackActor {
  vendorId: string;
  now: string;
  /** `metadata.source` on every row. The admin routes pass `admin-moderation`. */
  source: string;
  /**
   * The vendor's plan snapshot, when the caller already read the plan for its own
   * rows (the revoke, the ban, every seat grant). {@link sealed} stamps it as-is and
   * skips its own license read. Absent, `sealed` reads it.
   */
  vendorPlan?: NonNullable<AuditLogEntry['vendorPlan']>;
}

/** What a builder hands the caller: put `stmts` in the batch, forward the rest
 *  post-commit, and enqueue `purgeTags` inside `ctx.waitUntil`. */
export interface HandbackBatch {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  transitions: WorkflowTransitionEntry[];
  purgeTags: string[];
  /**
   * True when the batch returns a contest on a connector-powered row, and so carries
   * `ownerEntitlementActiveSentinel`. A clear that commits first aborts the batch
   * with the same malformed-JSON error the seat sentinels raise, which the seat
   * writers answer as `409 VENDOR_SEATS_CHANGED` (AECI-1092 reconciliation).
   */
  entitlementGuarded?: boolean;
  /**
   * True when the batch clears `vendor-banned` license flags ({@link planSeatGrantReturn}).
   * The seat writer then clears the ban's Stripe cancel after commit
   * (`scheduleStripeBanCancelClear` in `lib/stripe-licenses.ts`, AECI-1503).
   */
  vendorBannedFlagsCleared?: boolean;
}

/**
 * What the return to AECi handed back (AECI-1415): the records that are AECi's again,
 * so promote writes them on the next push. Every product joined to the vendor that no
 * other owned vendor holds, and every live integration and evidenced pair it had
 * claimed. The admin route answers with it, and it is the hook the ownership message
 * to the review app reads (AECI-1418).
 */
export interface ReturnedRecords {
  productIds: string[];
  integrationIds: string[];
  evidencedPairIds: string[];
  contestsRerouted: number;
}

/** {@link planVendorHandback}'s result: the batch plus what it hands back. */
export interface VendorReturnBatch extends HandbackBatch {
  returned: ReturnedRecords;
}

/** `metadata.reason` on the un-claim row of the admin return (AECI-1415), and
 *  `metadata.cause` on its marker flips. The flips keep `maintenance-marker` as their
 *  reason so one grep still finds every maintenance flip (§13.9). Rows written
 *  before AECI-1415 by the last-seat hand-back say `owner-seat-revoked`. */
export const HANDBACK_REASON = 'records-returned-to-aeci';

/** `metadata.reason` on a contest the lapse moves to AECi. */
export const SEAT_LAPSE_REASON = 'owner-seat-lapsed';

/** `metadata.reason` on a contest the unban moves back to its owner. */
export const SEAT_RETURN_REASON = 'owner-seat-restored';

/** `metadata.reason` on a stamped contest the return keeps at AECi for good,
 *  because its owner may not decide it on a connector-powered row (AECI-1092
 *  reconciliation with AECI-989). */
export const SEAT_RETURN_WITHHELD_REASON = 'owner-may-not-decide';

const MAINTENANCE_REASON = 'maintenance-marker';

function emptyBatch(): HandbackBatch {
  return { stmts: [], audits: [], transitions: [], purgeTags: [] };
}

/**
 * Add the audit rows' inserts to the statements, in order, once.
 *
 * Every row a handback, lapse or return writes is about something `p.vendorId`
 * HOLDS (its products, integrations, pairs and owner contests), so each is stamped
 * with that vendor and its plan (AECI-1192 / AECI-1193, `DATABASE_SCHEMA.md` §8.4).
 * A row that already names a vendor keeps it: a `notification.sent` row carries
 * its recipient. The plan is `p.vendorPlan` when the caller passed one, so a
 * caller that already read the plan does not read it twice. Otherwise it costs one
 * license read (`licensePlanSnapshot`, AECI-1355), and only when there is a row to
 * stamp.
 */
async function sealed(batch: HandbackBatch, db: Db, p: HandbackParams): Promise<HandbackBatch> {
  if (batch.audits.length === 0) return batch;
  const vendorPlan =
    p.vendorPlan ?? licensePlanSnapshot(await loadVendorLicenses(db, p.vendorId), p.now);
  const audits = batch.audits.map((a) =>
    a.vendorId ? a : { ...a, vendorId: p.vendorId, vendorPlan },
  );
  return {
    ...batch,
    audits,
    stmts: [...batch.stmts, ...audits.map((a) => auditInsert(db, a))],
  };
}

// ─── Which seat event is this? ───────────────────────────────────────────────

/** What losing a seat means for the vendor, given the seats that REMAIN after it. */
export type SeatLossOutcome = 'vacant' | 'lapse' | 'none';

/**
 * `vacant` when no `vendor_admin` profile remains, `lapse` when some remain and
 * all are banned, `none` while any unbanned seat remains. `vacant` and `lapse` both
 * plan the seat lapse since AECI-1415. They differ only in the race sentinel and in
 * whether a remaining seat can be told. `excludeUserId` is the
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
  if (remaining.length === 0) return 'vacant';
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
 * every re-route audit row for writes its guarded UPDATEs did not make.
 *
 * The second raises when the seats left after the UPDATE are not the ones the plan
 * read. Two seats revoked at once would each see the other still there, plan
 * `none`, and leave a seatless vendor with its owner contests unmoved.
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
    planned === 'vacant'
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

/**
 * Aborts the batch when the vendor still has a live seat invite after the last-seat
 * ban's revokes (AECI-1374, ruled 2026-10-16): one was created between the ban's read
 * and its batch, so the ban would leave a redeemable invite behind. Place it after the
 * invite revokes. Same token as {@link seatRaceSentinels}, so it answers `409`.
 */
export function pendingInviteRaceSentinel(db: Db, vendorId: string, now: string): BatchStmt {
  const left = sql`EXISTS (SELECT 1 FROM ${vendorSeatInvites} WHERE ${liveInvitesFor(vendorId, now)})`;
  return db
    .select({ guard: sql`CASE WHEN ${left} THEN json(${SEATS_CHANGED_TOKEN}) END` })
    .from(ONE_ROW);
}

/**
 * Aborts a seat grant whose new seat would sit beside `vendor-banned` license flags
 * the grant did not clear (AECI-1374 E4.5, ruled 2026-10-16). Used by the admin
 * provision (`POST /api/admin/vendors/:id/seats`) and the claim grant
 * (`PATCH /api/admin/claims/:id`). Put it LAST in the batch, after the grant's seat
 * write and after `planSeatGrantReturn`'s flag clears.
 *
 * The race: the grant plans its clears from a pre-batch read. A last-seat ban that
 * commits between that read and the batch flags every live license. The grant then
 * lands an unbanned seat, the flags stay, and an active vendor shows "vendor banned"
 * with licenses that will not renew. After the planned clears ran, the set test is
 * "any live `vendor-banned` license left", so there is no planned id list to compare.
 *
 * It fires only when the granted seat is, at batch time, an unbanned `vendor_admin`
 * of this vendor. A banned seat does not make the vendor active, so its flags rightly
 * stay and the grant commits. Same token as {@link seatRaceSentinels}, so it answers
 * `409`. The retry re-reads the flags and clears them.
 *
 * The invite redeem does not carry it: the ban revokes every pending invite in the
 * flagging batch (`pendingInviteRaceSentinel`), so `inviteSpentSentinel` already
 * aborts a redeem planned before the ban.
 */
export function vendorBannedFlagsRaceSentinel(
  db: Db,
  vendorId: string,
  seatUserId: string,
): BatchStmt {
  const seatActive = sql`EXISTS (SELECT 1 FROM ${profiles} WHERE ${profiles.id} = ${seatUserId} AND ${profiles.vendorId} = ${vendorId} AND ${profiles.role} = ${VENDOR_ADMIN_ROLE} AND ${profiles.bannedAt} IS NULL)`;
  const flagLeft = sql`EXISTS (SELECT 1 FROM ${licenses} INNER JOIN ${billingAccounts} ON ${billingAccounts.id} = ${licenses.billingAccountId} WHERE ${billingAccounts.vendorId} = ${vendorId} AND ${licenses.endedAt} IS NULL AND ${licenses.cancelReason} = ${VENDOR_BANNED_CANCEL_REASON})`;
  return db
    .select({
      guard: sql`CASE WHEN ${seatActive} AND ${flagLeft} THEN json(${SEATS_CHANGED_TOKEN}) END`,
    })
    .from(ONE_ROW);
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

// ─── 1. The return to AECi ───────────────────────────────────────────────────

export async function planVendorHandback(db: Db, p: HandbackParams): Promise<VendorReturnBatch> {
  const batch = emptyBatch();
  const returned: ReturnedRecords = {
    productIds: [],
    integrationIds: [],
    evidencedPairIds: [],
    contestsRerouted: 0,
  };
  const actor = { actorId: p.actorId, actorType: p.actorType };
  const base = { source: p.source, vendorId: p.vendorId };

  const vendor = await db.query.vendors.findFirst({
    columns: { id: true, slug: true, maintainedBy: true },
    where: eq(vendors.id, p.vendorId),
  });
  if (!vendor) return { ...batch, returned };

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

  // Every owned product, the same `product_vendors` set the promote fence blocks on.
  const owned = await db
    .select({ id: products.id, slug: products.slug, maintainedBy: products.maintainedBy })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(eq(productVendors.vendorId, p.vendorId));
  const ownedCoOwned = await productsWithOwnedCoOwner(
    db,
    p.vendorId,
    owned.map((row) => row.id),
  );
  returned.productIds = owned.filter((row) => !ownedCoOwned.has(row.id)).map((row) => row.id);
  const vendorProducts = owned.filter((row) => row.maintainedBy === 'vendor');
  for (const product of vendorProducts) {
    if (ownedCoOwned.has(product.id)) continue;
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
      productId: product.id,
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
    returned.integrationIds.push(row.id);
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
    returned.evidencedPairIds.push(row.id);
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
  returned.contestsRerouted = contests.length;
  for (const contest of contests) {
    rerouteContest(db, batch, actor, contest, p.now, {
      to: 'aeci',
      stamp: null,
      reason: HANDBACK_REASON,
      transitionReason: 'records returned to AECi: re-routed to AECi',
      source: p.source,
    });
  }

  batch.purgeTags = [...new Set(batch.purgeTags)];
  return { ...(await sealed(batch, db, p)), returned };
}

/** Ids per `IN (...)` lookup. D1 caps bound parameters per query at 100, and a
 *  vendor's product or integration list is unbounded. */
const ID_CHUNK = 80;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Products in `productIds` that another OWNED vendor (`owned_at` set) also holds.
 *  Promote still refuses those (Q3, AECI-1415), so their marker stays. */
async function productsWithOwnedCoOwner(
  db: Db,
  vendorId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const ids of chunk(productIds, ID_CHUNK)) {
    const rows = await db
      .selectDistinct({ productId: productVendors.productId })
      .from(productVendors)
      .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
      .where(
        and(
          inArray(productVendors.productId, ids),
          ne(productVendors.vendorId, vendorId),
          isNotNull(vendors.ownedAt),
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
        // `anchor_id` leads `claims_identity_key` (AECI-1484), as in
        // `ownership-sync.ts`. The NOT NULL keeps a pair's claim out, so this is
        // exactly `integration_id IN (…)`.
        and(
          inArray(claims.anchorId, part),
          isNotNull(claims.integrationId),
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
        // Same anchor probe; the NOT NULL keeps an integration's claim out.
        and(
          inArray(claims.anchorId, part),
          isNotNull(claims.connectorEvidencedPairId),
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
  return sealed(batch, db, p);
}

// ─── 3. The seat return ──────────────────────────────────────────────────────

export interface SeatReturnOptions {
  /**
   * The caller's own batch makes the vendor's entitlement active (the claim grant,
   * `PATCH /api/admin/claims/:id`, activates it beside the seat). The pre-batch read
   * cannot see that, so the caller says so.
   */
  entitledAfterBatch?: boolean;
}

/**
 * Route stamped contests back to the owner, under the AECI-1092 reconciliation
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13, "Reconciled with AECI-989"): a contest
 * returns to the owner only when the owner has an unbanned seat (the caller's event)
 * AND, on a connector-powered row, an active entitlement. A `mechanism_kind`
 * contest on a connector-powered row never returns (ruling A). A stamped contest
 * that fails those tests stays with AECi and loses its stamp, so no later seat
 * event can send it back.
 *
 * Both anchors: an `integrations` row, and since AECI-1092 a
 * `connector_evidenced_pairs` row, which is connector-powered by construction. The
 * "claimed by this vendor since before the stamp" rule is AECI-989's, on either table.
 */
export async function planOwnerSeatReturn(
  db: Db,
  p: HandbackParams,
  opts: SeatReturnOptions = {},
): Promise<HandbackBatch> {
  const batch = emptyBatch();
  const actor = { actorId: p.actorId, actorType: p.actorType };
  const stampedOpen = and(
    eq(integrationFieldChallenges.ownerVendorId, p.vendorId),
    eq(integrationFieldChallenges.routedTo, 'aeci'),
    eq(integrationFieldChallenges.status, 'open'),
    isNotNull(integrationFieldChallenges.ownerSeatLapsedAt),
  );
  const onIntegrations = await db
    .select({
      contest: integrationFieldChallenges,
      poweredByProductId: integrations.poweredByProductId,
      mechanismKind: integrations.mechanismKind,
    })
    .from(integrationFieldChallenges)
    .innerJoin(integrations, eq(integrations.id, integrationFieldChallenges.integrationId))
    .where(
      and(
        stampedOpen,
        eq(integrations.builtByVendorId, p.vendorId),
        isNotNull(integrations.claimedAt),
        isNull(integrations.retiredAt),
        sql`${integrationFieldChallenges.ownerSeatLapsedAt} >= ${integrations.claimedAt}`,
      ),
    );
  const onPairs = await db
    .select({ contest: integrationFieldChallenges })
    .from(integrationFieldChallenges)
    .innerJoin(
      connectorEvidencedPairs,
      eq(connectorEvidencedPairs.id, integrationFieldChallenges.evidencedPairId),
    )
    .where(
      and(
        stampedOpen,
        eq(connectorEvidencedPairs.builtByVendorId, p.vendorId),
        isNotNull(connectorEvidencedPairs.claimedAt),
        isNull(connectorEvidencedPairs.retiredAt),
        sql`${integrationFieldChallenges.ownerSeatLapsedAt} >= ${connectorEvidencedPairs.claimedAt}`,
      ),
    );
  const candidates = [
    // The submit's test, forward-looking half of ruling A included: a `mechanism_kind`
    // contest proposing a connector kind is never returned to the owner (review MINOR 5).
    ...onIntegrations.map((row) => ({
      contest: row.contest,
      connectorPowered: routesAsConnectorPowered(
        {
          connectorPowered: isConnectorPoweredEdge(row),
          poweredByProductId: row.poweredByProductId,
        },
        row.contest.field,
        row.contest.proposedValue,
      ),
    })),
    ...onPairs.map((row) => ({ contest: row.contest, connectorPowered: true })),
  ];
  const needsEntitlement = candidates.some(
    (row) => row.connectorPowered && row.contest.field !== 'mechanism_kind',
  );
  const entitled =
    opts.entitledAfterBatch === true ||
    (needsEntitlement && (await vendorHoldsActiveEntitlement(db, p.vendorId)));

  for (const { contest, connectorPowered } of candidates) {
    const ownerMayDecide = !connectorPowered || (contest.field !== 'mechanism_kind' && entitled);
    if (ownerMayDecide) {
      if (connectorPowered) batch.entitlementGuarded = true;
      rerouteContest(db, batch, actor, contest, p.now, {
        to: 'owner',
        stamp: null,
        reason: SEAT_RETURN_REASON,
        transitionReason: 'owner seat restored: routed back to the owner',
        source: p.source,
      });
    } else {
      const cleared = clearSeatStamp(db, [contest], actor, p.now, {
        reason: SEAT_RETURN_WITHHELD_REASON,
        source: p.source,
      });
      batch.stmts.push(...cleared.stmts);
      batch.audits.push(...cleared.audits);
    }
  }
  // Ruling B's guard on the return: a clear that commits between the read above and
  // this batch aborts it, and the retry keeps those contests with AECi.
  if (batch.entitlementGuarded) batch.stmts.push(ownerEntitlementActiveSentinel(db, p.vendorId));
  return sealed(batch, db, p);
}

/**
 * The seat-GRANT half of the return (ruled 2026-09-23): a vendor that gets an
 * unbanned `vendor_admin` again by a NEW seat, not only by an unban, gets its
 * ban-moved contests back. Called by all three seat writers: the admin provision
 * (`POST /api/admin/vendors/:id/seats`), the claim grant
 * (`PATCH /api/admin/claims/:id`) and the invite redeem
 * (`POST /api/seat-invites/:token/accept`).
 *
 * The same grant also clears the `vendor-banned` cancel-at-term-end flags on the
 * vendor's live licenses (ruled 2026-10-15, `STAGE_2_PAID_TIERS_SPEC.md` §5.2), as
 * the unban does, through the one helper `clearVendorBannedFlagsStatements`. Its
 * statements carry their own audit inserts and go after the sealed contest rows. Its
 * audit rows join `audits`, so the caller forwards them with the rest. The clears are
 * planned from this read, so the provision and the claim grant end their batch with
 * {@link vendorBannedFlagsRaceSentinel}: a ban that flags licenses after this read
 * aborts the grant (AECI-1374 E4.5). When it clears a flag it sets
 * `vendorBannedFlagsCleared`, and the seat writer clears the ban's Stripe cancel after
 * commit (AECI-1503).
 *
 * `null` when the new seat's own profile is banned, because a banned seat is not
 * an active one, or when nothing is stamped and nothing is flagged. The pre-batch
 * read cannot see the new seat, so the caller's grant is what makes the vendor
 * active again. A grant that lands on no row (a lost race) still commits these
 * guarded writes. That is accepted: the grant's own batch is what decides whether
 * the seat exists.
 */
export async function planSeatGrantReturn(
  db: Db,
  p: HandbackParams,
  seatUserId: string,
  opts: SeatReturnOptions = {},
): Promise<HandbackBatch | null> {
  const seat = await db.query.profiles.findFirst({
    columns: { bannedAt: true },
    where: eq(profiles.id, seatUserId),
  });
  if (seat?.bannedAt) return null;
  const batch = await planOwnerSeatReturn(db, p, opts);
  const flags = await clearVendorBannedFlagsStatements(db, {
    vendorId: p.vendorId,
    now: p.now,
    actorId: p.actorId,
    actorType: p.actorType,
    source: p.source,
    extraMetadata: { seat_user_id: seatUserId },
  });
  if (batch.stmts.length === 0 && flags.stmts.length === 0) return null;
  return {
    ...batch,
    stmts: [...batch.stmts, ...flags.stmts],
    audits: [...batch.audits, ...flags.auditEntries],
    vendorBannedFlagsCleared: flags.stmts.length > 0,
  };
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
    ...anchorMetadata(contestAnchorOf(contest)),
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
          // A return needs the stamp still set: a last-license revoke or a
          // connector-making accept that cleared it made the contest AECi's for good.
          ...(move.to === 'owner' ? [isNotNull(integrationFieldChallenges.ownerSeatLapsedAt)] : []),
        ),
      ),
  );
  // The return only (review MINOR 4): a concurrent grant or decision that moved this
  // contest first leaves the UPDATE matching nothing, and the batch must then abort
  // rather than commit a `rerouted` row and a transition for a move it did not make.
  if (move.to === 'owner') batch.stmts.push(contestRowChangedSentinel(db));
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
