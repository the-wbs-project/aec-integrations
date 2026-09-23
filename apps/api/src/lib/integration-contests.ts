/**
 * Integration field contests: the rules both the vendor and the admin handlers
 * share (AECI-1008 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b).
 *
 * Four things live here so no handler re-derives them:
 *
 *   1. **Routing** — who decides a contest. {@link routeContest} is the one
 *      implementation, and {@link isIntegrationClaimed} (AECI-1005) its claim test.
 *   2. **The field ↔ column map**, and the two translations between the storage
 *      form of a value and the caller-relative wire form (`direction` only).
 *   3. **The vendor scoping predicate** ({@link vendorContestsWhere}), which
 *      `GET /api/vendor/contests` and the `contests` freshness cursor in
 *      `routes/vendor-updates.ts` both import. The cursor invariant
 *      (`STAGE_2_REALTIME_SPEC.md` §2.2) is that the two can never differ.
 *   4. **The notification row** ({@link contestNotificationAudit}): a
 *      `notification.sent` audit row addressed to the other side of a contest,
 *      which is how the event reaches the vendor feed with no new store.
 */

import {
  claimDirectionForContext,
  claimDirectionFromContext,
  orderedPairSlugs,
  type ClaimDirection,
  type ContestAnchorKind,
  type ContestNotificationEvent,
  type ContestRoute,
  type ContextDirection,
  type IntegrationContestField,
  type IntegrationRetiredBy,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { PAID_TIERS, tierFor } from '@aeci/shared/entitlements';
import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  products,
  vendorEntitlements,
  vendors,
} from '../db/schema';
import { workflowTransitionInsert, type BatchStmt } from './audit';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { isConnectorPoweredEdge } from './connector-powered';
import { isClaimed, ONE_ROW } from './integration-claims';
import { integrationLiveSentinel } from './live-integration';
import { chunked } from './promote-claims';

type IntegrationRow = typeof integrations.$inferSelect;

/** `audit_log.entity_type` for every row about a contest. `entity_type` is
 *  unconstrained, so this needs no migration. */
export const CONTEST_ENTITY_TYPE = 'integration_field_challenge';

/**
 * Is this integration CLAIMED, i.e. has its owner taken the row, so that it decides
 * contests on it?
 *
 * AECI-1005 replaced the stub that stood here (always `false`) with the real test:
 * `claimed_at IS NOT NULL`, via {@link isClaimed} in `lib/integration-claims.ts`,
 * which is the single definition. A claim is an act (the owner's own claim, or an
 * admin approval of an owner-unknown claim), and it is the same column that fences
 * promote, so an owner accept can no longer be reverted by the next promote of the
 * edge.
 *
 * It still takes the row rather than an id, and the submit handler still takes it
 * as an injectable predicate, so a spec can pin either route without seeding a claim.
 */
export function isIntegrationClaimed(
  integration: Pick<IntegrationRow, 'id' | 'builtByVendorId' | 'claimedAt'>,
): boolean {
  return isClaimed(integration);
}

export type IntegrationClaimedPredicate = typeof isIntegrationClaimed;

/**
 * Who decides a contest, fixed at submit (§11b.4, with the AECI-1040 exceptions of
 * §11b.13).
 *
 * `owner` iff the row is claimed, the field is not `owner`, and an owner is on file.
 * An `owner` contest ALWAYS routes to AECi: the owner cannot be the judge of whether
 * it is the owner. On a CONNECTOR-POWERED row (either table) two more rules send a
 * contest to AECi even when the row is claimed:
 *
 *   - **Ruling A.** A `mechanism_kind` contest. The owner may neither edit that
 *     column (it decides routing, ruling 5) nor accept a contest that writes it.
 *     Only an `integrations` row has the column, so this bites there alone.
 *   - **Ruling E.** The owner holds no active entitlement. Deciding is an owner write,
 *     and an owner write on these rows needs an active entitlement (ruling 2), so a
 *     contest routed to an owner without one would sit where nobody can decide it.
 *
 * `ownerVendorId` is the `built_by_vendor_id` snapshot either way. On an
 * AECi-routed row it is informational (the admin screen shows who is on file).
 */
export function routeContest(
  integration: Pick<IntegrationRow, 'id' | 'builtByVendorId' | 'claimedAt'>,
  field: IntegrationContestField,
  claimed: IntegrationClaimedPredicate = isIntegrationClaimed,
  carveOut: { connectorPowered: boolean; ownerEntitled: boolean } = {
    connectorPowered: false,
    ownerEntitled: true,
  },
): { routedTo: ContestRoute; ownerVendorId: string | null } {
  const ownerVendorId = integration.builtByVendorId ?? null;
  const ownerMayDecide = claimed(integration) && field !== 'owner' && ownerVendorId !== null;
  const carvedOut =
    carveOut.connectorPowered && (field === 'mechanism_kind' || !carveOut.ownerEntitled);
  const routedTo: ContestRoute = ownerMayDecide && !carvedOut ? 'owner' : 'aeci';
  return { routedTo, ownerVendorId };
}

// ─── The two anchors (AECI-1092) ─────────────────────────────────────────────

/** The row a contest sits on: exactly one of the two anchor columns is set
 *  (`integration_field_challenges_anchor_check`). */
export interface ContestAnchor {
  kind: ContestAnchorKind;
  id: string;
}

/** The anchor a stored contest row names. The CHECK guarantees one is set. */
export function contestAnchorOf(
  row: Pick<ContestRow, 'integrationId' | 'evidencedPairId'>,
): ContestAnchor {
  if (row.evidencedPairId) return { kind: 'evidenced_pair', id: row.evidencedPairId };
  return { kind: 'integration', id: row.integrationId ?? '' };
}

/**
 * Which table an id on `/api/vendor/integrations/:id/contests` names (AECI-1092): the
 * `integrations` row when there is one, else the `connector_evidenced_pairs` row, the
 * order promote's `locateEdge` and the AECI-1089 claim use. At most one matches (the
 * single-table invariant). An id in neither table answers the integrations kind, so
 * the caller's authority check returns its ordinary flat 404.
 */
export async function locateContestAnchor(db: Db, id: string): Promise<ContestAnchor> {
  const row = await db.query.integrations.findFirst({
    columns: { id: true },
    where: eq(integrations.id, id),
  });
  if (row) return { kind: 'integration', id };
  const pair = await db.query.connectorEvidencedPairs.findFirst({
    columns: { id: true },
    where: eq(connectorEvidencedPairs.id, id),
  });
  return { kind: pair ? 'evidenced_pair' : 'integration', id };
}

/** Accept an anchor, or a bare id meaning an `integrations` row (the pre-AECI-1092
 *  call form, which the specs still use). */
export function toContestAnchor(anchor: ContestAnchor | string): ContestAnchor {
  return typeof anchor === 'string' ? { kind: 'integration', id: anchor } : anchor;
}

/** The two anchor columns, for an insert. */
export function anchorColumns(anchor: ContestAnchor): {
  integrationId: string | null;
  evidencedPairId: string | null;
} {
  return anchor.kind === 'evidenced_pair'
    ? { integrationId: null, evidencedPairId: anchor.id }
    : { integrationId: anchor.id, evidencedPairId: null };
}

/** Contests on this anchor. */
export function contestAnchorWhere(anchor: ContestAnchor): SQL {
  return anchor.kind === 'evidenced_pair'
    ? eq(integrationFieldChallenges.evidencedPairId, anchor.id)
    : eq(integrationFieldChallenges.integrationId, anchor.id);
}

/**
 * An UPDATE of the anchor row, in whichever table it lives. `set` uses the Drizzle
 * property names both tables share (`name`, `direction`, `builtByVendorId`,
 * `claimedAt`, `maintainedBy`, `lastReviewedAt`, …). Only an `integrations` anchor
 * may set `mechanismKind`; the callers never pass it for a pair.
 */
export function anchorUpdate(db: Db, anchor: ContestAnchor, set: Record<string, unknown>) {
  return anchor.kind === 'evidenced_pair'
    ? db
        .update(connectorEvidencedPairs)
        .set(set as Partial<typeof connectorEvidencedPairs.$inferInsert>)
        .where(eq(connectorEvidencedPairs.id, anchor.id))
    : db
        .update(integrations)
        .set(set as Partial<typeof integrations.$inferInsert>)
        .where(eq(integrations.id, anchor.id));
}

/** The anchor column's name, for the raw-SQL sentinels. A constant, never input. */
export function anchorColumnSql(kind: ContestAnchorKind): SQL {
  return sql.raw(kind === 'evidenced_pair' ? '"evidenced_pair_id"' : '"integration_id"');
}

/** The anchor table's name, for the raw-SQL sentinels. A constant, never input. */
function anchorTableSql(kind: ContestAnchorKind): SQL {
  return sql.raw(kind === 'evidenced_pair' ? '"connector_evidenced_pairs"' : '"integrations"');
}

/** `audit_log.entity_type` for a catalog write on the anchor row. An evidenced pair
 *  uses the entity type promote already writes for it. */
export function anchorEntityType(kind: ContestAnchorKind): string {
  return kind === 'evidenced_pair' ? 'connector_evidenced_pair' : 'integration';
}

/** `audit_log.action` for a content write on the anchor row: `integration.updated` on
 *  either table, the action the AECI-1090 owner edit writes. The table is told apart by
 *  the entity type and {@link anchorWriteMarkers}. */
export function anchorUpdatedAction(_kind: ContestAnchorKind): string {
  return 'integration.updated';
}

/**
 * The carve-out markers a vendor-held write on a connector-powered row carries in its
 * audit metadata, exactly as the AECI-1089 claim and the AECI-1090 owner edit write
 * them: `{ connectorPowered: true, anchor }`. Empty on any other row.
 */
export function anchorWriteMarkers(target: Pick<ContestTarget, 'anchor' | 'connectorPowered'>): {
  connectorPowered?: true;
  anchor?: ContestAnchorKind;
} {
  return target.connectorPowered ? { connectorPowered: true, anchor: target.anchor.kind } : {};
}

/** Audit metadata naming the anchor: `integrationId` or `evidencedPairId`. */
export function anchorMetadata(anchor: ContestAnchor): Record<string, string> {
  return anchor.kind === 'evidenced_pair'
    ? { evidencedPairId: anchor.id }
    : { integrationId: anchor.id };
}

/**
 * The row a contest sits on, normalized across both tables. On an evidenced pair
 * `sourceProductId` is endpoint A and `targetProductId` endpoint B of the canonical
 * order, which is the frame its `direction` is stored in, so every direction
 * translation reads the same on both. `mechanismKind` is `null` there.
 */
export interface ContestTarget {
  anchor: ContestAnchor;
  id: string;
  name: string | null;
  mechanismKind: string | null;
  mechanismName: string | null;
  direction: string | null;
  description: string | null;
  listingUrl: string | null;
  docsUrl: string | null;
  website: string | null;
  mechanismUrl: string | null;
  pricingModel: string | null;
  maturity: string | null;
  builtByVendorId: string | null;
  claimedAt: string | null;
  retiredAt: string | null;
  maintainedBy: string;
  lastReviewedAt: string | null;
  sourceProductId: string;
  targetProductId: string;
  /** The delivering connector product, on an evidenced pair only. */
  connectorProductId: string | null;
  /** `integrations.powered_by_product_id`; the connector product on a pair. */
  poweredByProductId: string | null;
  /** Decision 9's predicate: `isConnectorPoweredEdge`, or any evidenced pair. */
  connectorPowered: boolean;
}

/** Load the row a contest sits on, in either table, or `null` when it is gone. */
export async function loadContestTarget(
  db: Db,
  anchorOrId: ContestAnchor | string,
): Promise<ContestTarget | null> {
  const anchor = toContestAnchor(anchorOrId);
  if (anchor.kind === 'evidenced_pair') {
    const pair = await db.query.connectorEvidencedPairs.findFirst({
      where: eq(connectorEvidencedPairs.id, anchor.id),
    });
    if (!pair) return null;
    return {
      anchor,
      id: pair.id,
      name: pair.name,
      mechanismKind: null,
      mechanismName: pair.mechanismName,
      direction: pair.direction,
      description: pair.description,
      listingUrl: pair.listingUrl,
      docsUrl: pair.docsUrl,
      website: pair.website,
      mechanismUrl: pair.mechanismUrl,
      pricingModel: pair.pricingModel,
      maturity: pair.maturity,
      builtByVendorId: pair.builtByVendorId,
      claimedAt: pair.claimedAt,
      retiredAt: pair.retiredAt,
      maintainedBy: pair.maintainedBy,
      lastReviewedAt: pair.lastReviewedAt,
      sourceProductId: pair.productAId,
      targetProductId: pair.productBId,
      connectorProductId: pair.connectorProductId,
      poweredByProductId: pair.connectorProductId,
      connectorPowered: true,
    };
  }
  const row = await db.query.integrations.findFirst({ where: eq(integrations.id, anchor.id) });
  if (!row) return null;
  return {
    anchor,
    id: row.id,
    name: row.name,
    mechanismKind: row.mechanismKind,
    mechanismName: row.mechanismName,
    direction: row.direction,
    description: row.description,
    listingUrl: row.listingUrl,
    docsUrl: row.docsUrl,
    website: row.website,
    mechanismUrl: row.mechanismUrl,
    pricingModel: row.pricingModel,
    maturity: row.maturity,
    builtByVendorId: row.builtByVendorId,
    claimedAt: row.claimedAt,
    retiredAt: row.retiredAt,
    maintainedBy: row.maintainedBy,
    lastReviewedAt: row.lastReviewedAt,
    sourceProductId: row.sourceProductId,
    targetProductId: row.targetProductId,
    connectorProductId: null,
    poweredByProductId: row.poweredByProductId,
    connectorPowered: isConnectorPoweredEdge(row),
  };
}

/** Cache-Tags a catalog write on the anchor row must purge: the pair page, both
 *  endpoint product pages, and on an evidenced pair the connector's page too, which
 *  lists the pair (`retract-product.ts` purges the same set for a deleted pair). */
export async function anchorPurgeTags(
  db: Db,
  target: Pick<ContestTarget, 'sourceProductId' | 'targetProductId' | 'connectorProductId'>,
  pairTag: (a: string, b: string) => string,
): Promise<{ tags: string[]; pairSlugs: readonly [string, string] | null }> {
  const ids = [target.sourceProductId, target.targetProductId];
  if (target.connectorProductId) ids.push(target.connectorProductId);
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(inArray(products.id, ids));
  const slug = new Map(rows.map((r) => [r.id, r.slug]));
  const a = slug.get(target.sourceProductId);
  const b = slug.get(target.targetProductId);
  if (!a || !b) return { tags: [], pairSlugs: null };
  const tags = [pairTag(a, b), `product:${a}`, `product:${b}`];
  const connector = target.connectorProductId ? slug.get(target.connectorProductId) : undefined;
  if (connector) tags.push(`product:${connector}`);
  return { tags, pairSlugs: [a, b] };
}

// ─── The owner's entitlement (AECI-1040 rulings 2, B and E) ─────────────────

/**
 * Does this vendor hold an active entitlement? The same test the vendor guard runs
 * on its own session (`tierFor`: a `vendor_entitlements` row with `status =
 * 'active'` at a tier this build knows), read for ANOTHER vendor: the submit route
 * routes on the OWNER's entitlement, and the caller is the submitter.
 */
export async function vendorHoldsActiveEntitlement(db: Db, vendorId: string): Promise<boolean> {
  const row = await db.query.vendorEntitlements.findFirst({
    columns: { tier: true, status: true },
    where: eq(vendorEntitlements.vendorId, vendorId),
  });
  return tierFor(row ?? null) !== 'unclaimed';
}

/**
 * A batch statement that ABORTS a contest submit routed to an owner on a
 * connector-powered row when the owner's entitlement is no longer active at commit.
 * The other half of ruling B: an admin clear that commits between the submit's read
 * and its batch would otherwise leave a new contest with an owner who cannot decide
 * it, after the clear's own re-route had already run. The handler re-routes and
 * retries. Same `json()` abort as the other contest sentinels.
 */
export function ownerEntitlementActiveSentinel(db: Db, ownerVendorId: string) {
  const tiers = sql.join(
    PAID_TIERS.map((tier) => sql`${tier}`),
    sql`, `,
  );
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM "vendor_entitlements"
          WHERE "vendor_id" = ${ownerVendorId} AND "status" = 'active' AND "tier" IN (${tiers}))
        THEN json('contest-owner-unentitled') END`,
    })
    .from(ONE_ROW);
}

/**
 * A batch statement that ABORTS a write when the anchor row is retired at commit
 * (AECI-1010), on either table. The `integrations` arm is the shared
 * `integrationLiveSentinel`; the evidenced arm is its twin over
 * `connector_evidenced_pairs.retired_at` (migration 0049). Both raise through
 * `isIntegrationRetiredRaceError`'s match.
 */
export function contestAnchorLiveSentinel(db: Db, anchor: ContestAnchor) {
  if (anchor.kind === 'integration') return integrationLiveSentinel(db, anchor.id);
  return db
    .select({
      guard: sql`CASE WHEN ${connectorEvidencedPairs.retiredAt} IS NOT NULL THEN json('integration-retired') END`,
    })
    .from(connectorEvidencedPairs)
    .where(eq(connectorEvidencedPairs.id, anchor.id));
}

// ─── Ruling B: an entitlement clear re-routes the owner's contests ──────────

/**
 * What an admin entitlement `clear` adds to its batch (AECI-1040 follow-up ruling 2,
 * "ruling B"; `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13): every OPEN owner-routed
 * contest this vendor decides on a CONNECTOR-POWERED row (either table) moves to the
 * AECi queue, because deciding it is an owner write that now needs an entitlement
 * the vendor no longer holds. Contests on rows that are not connector-powered keep
 * their owner route: those rows keep the seat as their whole gate (decision 15).
 *
 * A re-route IN the clear's batch, not a read-time check, so every reader agrees
 * from the commit on: `routed_to` is what `pending_contests`, the owner's Received
 * list, the admin queue's filters, the admin PATCH, the protest eligibility rule and
 * the `contests` cursor predicate all read. See §11b.13 for the comparison.
 *
 * `guard` goes FIRST among these statements. It aborts the batch unless the set of
 * open owner-routed contests for the vendor still has the count and newest
 * `updated_at` read here, so a
 * contest submitted (or re-routed) between this read and the commit cannot be left
 * with an owner who can no longer decide it. The handler re-plans and retries.
 */
export async function planEntitlementClearReroute(
  db: Db,
  vendorId: string,
  actor: { actorId: string; actorType: AuditLogEntry['actorType'] },
  now: string,
): Promise<{ stmts: BatchStmt[]; audits: AuditLogEntry[]; rerouted: number }> {
  const open = await db
    .select()
    .from(integrationFieldChallenges)
    .where(
      and(
        eq(integrationFieldChallenges.routedTo, 'owner'),
        eq(integrationFieldChallenges.ownerVendorId, vendorId),
        eq(integrationFieldChallenges.status, 'open'),
      ),
    );
  // AECI-1092 reconciliation with AECI-989: contests a seat lapse already moved to
  // AECi for this owner, stamped so a seat event would send them back. On a
  // connector-powered row the owner can no longer decide them, so the clear makes
  // them AECi's for good by clearing the stamp.
  const stamped = await db
    .select()
    .from(integrationFieldChallenges)
    .where(
      and(
        eq(integrationFieldChallenges.routedTo, 'aeci'),
        eq(integrationFieldChallenges.ownerVendorId, vendorId),
        eq(integrationFieldChallenges.status, 'open'),
        isNotNull(integrationFieldChallenges.ownerSeatLapsedAt),
      ),
    );
  const integrationIds = [
    ...new Set(
      [...open, ...stamped]
        .map((row) => row.integrationId)
        .filter((id): id is string => id !== null),
    ),
  ];
  // Chunked: D1 caps bound parameters per statement, and a vendor may have more open
  // owner-routed contests than that (review finding, AECI-1092).
  const powered = (
    await Promise.all(
      chunked(integrationIds).map((chunk) =>
        db
          .select({
            id: integrations.id,
            poweredByProductId: integrations.poweredByProductId,
            mechanismKind: integrations.mechanismKind,
          })
          .from(integrations)
          .where(inArray(integrations.id, chunk)),
      ),
    )
  ).flat();
  const poweredIds = new Set(powered.filter(isConnectorPoweredEdge).map((row) => row.id));
  const onPoweredRow = (row: ContestRow): boolean =>
    row.evidencedPairId !== null ||
    (row.integrationId !== null && poweredIds.has(row.integrationId));
  const moving = open.filter(onPoweredRow);
  const unstamping = stamped.filter(onPoweredRow);
  const reroute = rerouteToAeciStatements(
    db,
    moving,
    actor,
    now,
    'owner entitlement cleared: re-routed to AECi',
    { reason: 'entitlement-cleared', ownerVendorId: vendorId },
  );
  // A fingerprint of the set, in two bound values rather than one per id, so a
  // vendor with many open contests cannot run past D1's bound-parameter cap: the
  // count, and the newest `updated_at`. A contest that joins the set is newer than
  // everything read (it is inserted after the read), and one that leaves it changes
  // the count unless another joins, which moves the maximum.
  const newestOf = (rows: readonly ContestRow[]) =>
    rows.reduce<string | null>(
      (max, row) => (max === null || row.updatedAt > max ? row.updatedAt : max),
      null,
    );
  const newest = newestOf(open);
  const scope = sql`"routed_to" = 'owner' AND "owner_vendor_id" = ${vendorId} AND "status" = 'open'`;
  // The same fingerprint over the stamped set (AECI-1092 reconciliation): a seat
  // lapse or return committing in between changes one of the two, and the clear
  // re-plans.
  const newestStamped = newestOf(stamped);
  const stampedScope = sql`"routed_to" = 'aeci' AND "owner_vendor_id" = ${vendorId} AND "status" = 'open' AND "owner_seat_lapsed_at" IS NOT NULL`;
  const guard = db
    .select({
      guard: sql`CASE WHEN (SELECT count(*) FROM "integration_field_challenges" WHERE ${scope}) <> ${open.length}
          OR ifnull((SELECT max("updated_at") FROM "integration_field_challenges" WHERE ${scope}), '') <> ${newest ?? ''}
          OR (SELECT count(*) FROM "integration_field_challenges" WHERE ${stampedScope}) <> ${stamped.length}
          OR ifnull((SELECT max("updated_at") FROM "integration_field_challenges" WHERE ${stampedScope}), '') <> ${newestStamped ?? ''}
        THEN json('contest-reroute-changed') END`,
    })
    .from(ONE_ROW);
  const unstamp = clearSeatStamp(db, unstamping, actor, now, {
    reason: 'entitlement-cleared',
    ownerVendorId: vendorId,
  });
  return {
    stmts: [guard, ...reroute.stmts, ...unstamp.stmts],
    audits: [...reroute.audits, ...unstamp.audits],
    rerouted: moving.length,
  };
}

// ─── The seat-lapse stamp (AECI-989, reconciled by AECI-1092) ───────────────

/**
 * A batch statement that ABORTS the batch when the statement just before it changed
 * no row. Put it DIRECTLY after a guarded contest UPDATE whose audit row and
 * transition ride the same batch: a concurrent writer that got there first (a second
 * seat grant, a decision, a clear) leaves the guard matching nothing, and without
 * this the batch would still commit an audit row and a transition for a write it
 * never made (review MINOR 4). `json('contest-row-changed')` is malformed JSON, so the
 * whole batch rolls back. The seat writers answer it as `409 VENDOR_SEATS_CHANGED`
 * (`isSeatsChangedError`), the clear re-plans (`isContestRaceError`), and the admin
 * accept answers `409 CONTEST_INTEGRATION_CHANGED` through `runGuardedContestBatch`.
 * Same mechanism as `seatRaceSentinels`, and FROM a one-row constant for the same
 * reason.
 */
export function contestRowChangedSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('contest-row-changed') END` })
    .from(ONE_ROW);
}

/** The audit action for clearing `owner_seat_lapsed_at` without a re-route: the
 *  contest stays with AECi, and stops being one a seat event can send back. */
export const SEAT_STAMP_CLEARED_ACTION = 'integration.contest.seat_stamp_cleared';

/**
 * Clear `owner_seat_lapsed_at` on stamped OPEN AECi contests, so no seat event can
 * route them back: each is AECi's for good (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13,
 * "Reconciled with AECI-989"). A guarded UPDATE per contest (still open, still with
 * AECi, still stamped) and an audit row naming why. `updated_at` moves, so the
 * submitter's `contests` cursor sees it. No workflow transition: the state and the
 * decider both hold.
 *
 * Three callers: the seat return, for a contest its owner may not decide
 * (`lib/vendor-handback.ts`); the entitlement clear (ruling B, below); and the accept
 * that makes a row connector-powered (`routes/admin-contests.ts`).
 */
export function clearSeatStamp(
  db: Db,
  contests: readonly ContestRow[],
  actor: { actorId: string; actorType: AuditLogEntry['actorType'] },
  now: string,
  extra: { reason: string; source?: string } & Record<string, unknown>,
): { stmts: BatchStmt[]; audits: AuditLogEntry[] } {
  const stmts: BatchStmt[] = [];
  const audits: AuditLogEntry[] = [];
  for (const contest of contests) {
    stmts.push(
      db
        .update(integrationFieldChallenges)
        .set({ ownerSeatLapsedAt: null, updatedAt: now })
        .where(
          and(
            eq(integrationFieldChallenges.id, contest.id),
            eq(integrationFieldChallenges.status, 'open'),
            eq(integrationFieldChallenges.routedTo, 'aeci'),
            isNotNull(integrationFieldChallenges.ownerSeatLapsedAt),
          ),
        ),
      // Directly after the UPDATE: a lost race writes no phantom audit row.
      contestRowChangedSentinel(db),
    );
    audits.push({
      ...actor,
      action: SEAT_STAMP_CLEARED_ACTION,
      entityType: CONTEST_ENTITY_TYPE,
      entityId: contest.id,
      beforeState: { routed_to: 'aeci', owner_seat_lapsed_at: contest.ownerSeatLapsedAt },
      afterState: { routed_to: 'aeci', owner_seat_lapsed_at: null },
      metadata: {
        source: 'admin-moderation',
        contestId: contest.id,
        ...anchorMetadata(contestAnchorOf(contest)),
        ...extra,
      },
    });
  }
  return { stmts, audits };
}

// ─── Re-routing open owner contests to AECi ─────────────────────────────────

/**
 * Move OPEN owner-routed contests to the AECi queue: a guarded UPDATE per contest,
 * an `open → open` workflow transition (the state holds, the decider changes) and an
 * `integration.contest.rerouted` audit row. Pushed into the caller's batch.
 *
 * Two callers. An AECi accept that takes a claimed row away from its owner
 * (AECI-1005, `routes/admin-contests.ts`), and an admin clearing a vendor's
 * entitlement, which sends that vendor's open contests on connector-powered rows
 * back to AECi (ruling B, `routes/admin-entitlements.ts`). The UPDATE is guarded on
 * `routed_to = 'owner'` as well as `status = 'open'`. `updated_at` moves, so the
 * submitter's `contests` cursor sees it.
 */
export function rerouteToAeciStatements(
  db: Db,
  contests: readonly ContestRow[],
  actor: { actorId: string; actorType: AuditLogEntry['actorType'] },
  now: string,
  reason: string,
  extra: Record<string, unknown>,
): { stmts: BatchStmt[]; audits: AuditLogEntry[] } {
  const stmts: BatchStmt[] = [];
  const audits: AuditLogEntry[] = [];
  for (const contest of contests) {
    const metadata = {
      source: 'admin-moderation',
      contestId: contest.id,
      ...anchorMetadata(contestAnchorOf(contest)),
      ...extra,
    };
    stmts.push(
      db
        .update(integrationFieldChallenges)
        // `owner_seat_lapsed_at` is cleared explicitly (AECI-1092 reconciliation): a
        // contest this moves is AECi's for good, never one a seat event returns.
        .set({ routedTo: 'aeci', ownerSeatLapsedAt: null, updatedAt: now })
        .where(
          and(
            eq(integrationFieldChallenges.id, contest.id),
            eq(integrationFieldChallenges.status, 'open'),
            eq(integrationFieldChallenges.routedTo, 'owner'),
          ),
        ),
    );
    if (contest.workflowId) {
      stmts.push(
        workflowTransitionInsert(db, {
          workflowId: contest.workflowId,
          fromState: 'open',
          toState: 'open',
          actorId: actor.actorId,
          reason,
          metadata,
        }),
      );
    }
    audits.push({
      ...actor,
      action: 'integration.contest.rerouted',
      entityType: CONTEST_ENTITY_TYPE,
      entityId: contest.id,
      beforeState: { routed_to: 'owner', owner_vendor_id: contest.ownerVendorId },
      afterState: { routed_to: 'aeci', owner_vendor_id: contest.ownerVendorId },
      metadata,
    });
  }
  return { stmts, audits };
}
// ─── Field ↔ column ──────────────────────────────────────────────────────────

/** The `integrations` column each content field names. `owner` is absent on
 *  purpose: it maps to `built_by_vendor_id`, and no accept path ever writes it. */
export const CONTEST_FIELD_COLUMNS = {
  name: 'name',
  mechanism_kind: 'mechanismKind',
  mechanism_name: 'mechanismName',
  direction: 'direction',
  description: 'description',
  listing_url: 'listingUrl',
  docs_url: 'docsUrl',
  website: 'website',
  mechanism_url: 'mechanismUrl',
  pricing_model: 'pricingModel',
  maturity: 'maturity',
} as const satisfies Record<Exclude<IntegrationContestField, 'owner'>, keyof IntegrationRow>;

export type ContentContestField = keyof typeof CONTEST_FIELD_COLUMNS;

/** The field's value on the row, in STORAGE form. */
export function storedFieldValue(
  row: Pick<IntegrationRow, ContestColumn | 'builtByVendorId'>,
  field: IntegrationContestField,
): string | null {
  if (field === 'owner') return row.builtByVendorId ?? null;
  return row[CONTEST_FIELD_COLUMNS[field]] ?? null;
}

type ContestColumn = (typeof CONTEST_FIELD_COLUMNS)[ContentContestField];

/** Storage form → wire form. Only `direction` differs: it is re-framed against the
 *  caller's context product. An unknown stored direction passes through as-is
 *  rather than throwing, so one bad row cannot 500 a list. */
export function toWireValue(
  field: IntegrationContestField,
  stored: string | null,
  contextIsSource: boolean,
): string | null {
  if (field !== 'direction' || stored === null) return stored;
  if (stored !== 'a_to_b' && stored !== 'b_to_a' && stored !== 'both') return stored;
  return claimDirectionForContext(stored as ClaimDirection, contextIsSource);
}

/** Wire form → storage form. The caller has already passed
 *  `contestValueProblem`, so a `direction` here is a valid `ContextDirection`. */
export function toStorageValue(
  field: IntegrationContestField,
  wire: string | null,
  contextIsSource: boolean,
): string | null {
  if (field !== 'direction' || wire === null) return wire;
  return claimDirectionFromContext(wire as ContextDirection, contextIsSource);
}

// ─── Scoping ─────────────────────────────────────────────────────────────────

/** Contests the caller's vendor filed. */
export function submittedContestsWhere(vendorId: string): SQL {
  return eq(integrationFieldChallenges.submitterVendorId, vendorId);
}

/** Contests the caller's vendor decides: owner-routed, with it as the snapshot
 *  owner. An AECi-routed row naming the vendor as owner is NOT received — the
 *  vendor is not its decider, and an owner contest about it must not be shown to
 *  the party it disputes. */
export function receivedContestsWhere(vendorId: string): SQL {
  return and(
    eq(integrationFieldChallenges.routedTo, 'owner'),
    eq(integrationFieldChallenges.ownerVendorId, vendorId),
  ) as SQL;
}

/**
 * The whole vendor contest scope: submitted ∪ received.
 *
 * The scoping predicate of `GET /api/vendor/contests` AND of the `contests`
 * cursor on `GET /api/vendor/updates`. Import it; never restate it. A cursor that
 * scopes wider moves on a row the list will never show (and leaks that it
 * exists); one that scopes narrower never moves for a change the list would show.
 */
export function vendorContestsWhere(vendorId: string): SQL {
  return or(submittedContestsWhere(vendorId), receivedContestsWhere(vendorId)) as SQL;
}

// ─── The notification row ────────────────────────────────────────────────────

/** What a contest `notification.sent` row records. Read back by
 *  `routes/vendor-notifications.ts`. `vendorId` is the RECIPIENT, which is what
 *  the feed's `json_extract(metadata, '$.vendorId')` filter matches. */
export interface ContestNotificationMetadata {
  kind: 'contest';
  vendorId: string;
  contestId: string;
  /** The anchor row's id, in whichever table `anchor` names. */
  integrationId: string;
  /** AECI-1092: present, as `'evidenced_pair'`, only on a contest over an evidenced
   *  pair. Absent means an `integrations` row, which is every row written before. */
  anchor?: 'evidenced_pair';
  integrationName: string | null;
  field: IntegrationContestField;
  event: ContestNotificationEvent;
  /** On `closed_by_retire` only (AECI-1046): who retired the integration. Absent on
   *  rows written before it, which were owner retires. Never the admin's reason. */
  retiredBy?: IntegrationRetiredBy;
  pairSlugs: readonly [string, string] | null;
  /** AECI-1009: which side a protest decision addresses (both sides get one). */
  recipientRole?: 'submitter' | 'owner';
  /** AECI-1009: on an owner `declined`, the last instant a protest may be filed. */
  protestClosesAt?: string;
  /** AECI-1009: on `protested`, the basis and the owner's reply deadline. */
  basis?: 'declined' | 'silence';
  replyDueAt?: string;
  /** AECI-1009: on `protest_rejected` to the submitter, the cooldown end. */
  cooldownUntil?: string;
}

/**
 * The `notification.sent` row for one contest event, addressed to one vendor.
 *
 * Pushed into the SAME batch as the transition it announces, so a rolled-back
 * transition cannot leave a notification about something that never happened.
 * `actorId` is the person who caused the event (the row is not the sweep's), and
 * `entity_type` distinguishes it from the §7 detector rows, whose entity is a claim.
 */
export function contestNotificationAudit(
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<ContestNotificationMetadata, 'kind' | 'pairSlugs'> & {
    pairSlugs: readonly [string, string] | null;
  },
): AuditLogEntry {
  const full: ContestNotificationMetadata = {
    kind: 'contest',
    ...metadata,
    pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: CONTEST_ENTITY_TYPE,
    entityId: metadata.contestId,
    metadata: full,
  };
}

/** The canonical pair page for two slugs, or `null` when either is missing. */
export function pairPathFor(pairSlugs: readonly [string, string] | null): string | null {
  if (!pairSlugs) return null;
  const [a, b] = orderedPairSlugs(pairSlugs[0], pairSlugs[1]);
  return `/products/${a}/integrations/${b}`;
}

// ─── Hydration (shared by the vendor and admin reads) ────────────────────────

export type ContestRow = typeof integrationFieldChallenges.$inferSelect;

interface HydratedProduct {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

/**
 * The row a contest sits on, as the lists render it. On an evidenced pair
 * (`anchor = 'evidenced_pair'`, AECI-1092) `sourceProduct` is endpoint A and
 * `targetProduct` endpoint B of the canonical order, `mechanismKind` is `null`, and
 * `connectorProduct` names the product that delivers the pair.
 */
export interface ContestIntegrationContext extends Pick<
  IntegrationRow,
  ContestColumn | 'builtByVendorId' | 'claimedAt'
> {
  id: string;
  name: string | null;
  anchor: ContestAnchorKind;
  sourceProduct: HydratedProduct;
  targetProduct: HydratedProduct;
  connectorProduct: HydratedProduct | null;
}

export interface ContestHydration {
  integrations: Map<string, ContestIntegrationContext>;
  /** AECI-1092: the evidenced pairs, kept apart so an id can never resolve against
   *  the wrong table. Read through {@link hydratedTarget}. */
  evidencedPairs: Map<string, ContestIntegrationContext>;
  vendorNames: Map<string, string>;
}

/** The hydrated row a contest sits on, from the map for its anchor's table. */
export function hydratedTarget(
  hydration: ContestHydration,
  row: Pick<ContestRow, 'integrationId' | 'evidencedPairId'>,
): ContestIntegrationContext | undefined {
  const anchor = contestAnchorOf(row);
  return anchor.kind === 'evidenced_pair'
    ? hydration.evidencedPairs?.get(anchor.id)
    : hydration.integrations.get(anchor.id);
}

const PRODUCT_COLUMNS = { columns: { id: true, name: true, slug: true, logoUrl: true } } as const;

/**
 * Everything a list of contest rows needs to render, in at most three reads: the
 * integrations and the evidenced pairs (each with its endpoint products), and the
 * vendor names — submitter, owner, and the vendor ids an `owner` contest carries
 * as its values.
 */
export async function hydrateContests(
  db: Db,
  rows: readonly ContestRow[],
): Promise<ContestHydration> {
  const anchors = rows.map(contestAnchorOf);
  const integrationIds = [
    ...new Set(anchors.filter((a) => a.kind === 'integration').map((a) => a.id)),
  ];
  const pairIds = [...new Set(anchors.filter((a) => a.kind === 'evidenced_pair').map((a) => a.id))];
  const vendorIds = [
    ...new Set(
      rows.flatMap((r) =>
        [
          r.submitterVendorId,
          r.ownerVendorId,
          ...(r.field === 'owner' ? [r.currentValue, r.proposedValue] : []),
        ].filter((v): v is string => typeof v === 'string'),
      ),
    ),
  ];
  // Every contestable column and the claim state too (AECI-1006): the admin
  // queue shows the LIVE value beside the one recorded at submit, so an operator
  // can see why an accept would be refused as stale.
  const [integrationRows, pairRows] = await Promise.all([
    integrationIds.length === 0
      ? []
      : db.query.integrations.findMany({
          columns: {
            id: true,
            name: true,
            mechanismKind: true,
            mechanismName: true,
            direction: true,
            description: true,
            listingUrl: true,
            docsUrl: true,
            website: true,
            mechanismUrl: true,
            pricingModel: true,
            maturity: true,
            builtByVendorId: true,
            claimedAt: true,
          },
          with: { sourceProduct: PRODUCT_COLUMNS, targetProduct: PRODUCT_COLUMNS },
          where: inArray(integrations.id, integrationIds),
        }),
    pairIds.length === 0
      ? []
      : db.query.connectorEvidencedPairs.findMany({
          columns: {
            id: true,
            name: true,
            mechanismName: true,
            direction: true,
            description: true,
            listingUrl: true,
            docsUrl: true,
            website: true,
            mechanismUrl: true,
            pricingModel: true,
            maturity: true,
            builtByVendorId: true,
            claimedAt: true,
          },
          with: {
            productA: PRODUCT_COLUMNS,
            productB: PRODUCT_COLUMNS,
            connectorProduct: PRODUCT_COLUMNS,
          },
          where: inArray(connectorEvidencedPairs.id, pairIds),
        }),
  ]);
  const integrationMap = new Map<string, ContestIntegrationContext>(
    integrationRows.map((row) => [
      row.id,
      { ...row, anchor: 'integration' as const, connectorProduct: null },
    ]),
  );
  const pairMap = new Map<string, ContestIntegrationContext>(
    pairRows.map(({ productA, productB, connectorProduct, ...row }) => [
      row.id,
      {
        ...row,
        mechanismKind: null,
        anchor: 'evidenced_pair' as const,
        sourceProduct: productA,
        targetProduct: productB,
        connectorProduct,
      },
    ]),
  );
  const hydration = { integrations: integrationMap, evidencedPairs: pairMap };
  // The live owner of an `owner` contest's row needs a name as well.
  for (const r of rows) {
    if (r.field !== 'owner') continue;
    const live = hydratedTarget({ ...hydration, vendorNames: new Map() }, r)?.builtByVendorId;
    if (live && !vendorIds.includes(live)) vendorIds.push(live);
  }
  const vendorRows =
    vendorIds.length === 0
      ? []
      : await db
          .select({ id: vendors.id, name: vendors.companyName })
          .from(vendors)
          .where(inArray(vendors.id, vendorIds));
  return {
    ...hydration,
    vendorNames: new Map(vendorRows.map((row) => [row.id, row.name])),
  };
}

/** The display label for a value: a vendor name for `owner`, `null` otherwise. */
export function contestValueLabel(
  field: string,
  value: string | null,
  vendorNames: ReadonlyMap<string, string>,
): string | null {
  if (field !== 'owner' || value === null) return null;
  return vendorNames.get(value) ?? null;
}

// ─── The decision-race sentinel ──────────────────────────────────────────────

/**
 * A batch statement that ABORTS the batch when the statement before it changed
 * zero rows. Push it immediately after a contest's guarded
 * `UPDATE … WHERE status = 'open'`, and push every other statement after it.
 *
 * Why it exists: D1 has no interactive transactions, so a batch cannot branch on
 * whether its guarded UPDATE matched. Without this, the loser of a decision race
 * (two deciders, or a decision against a withdraw) still committed its audit row,
 * its workflow transition, the owner-accept catalog write, and — the real harm — a
 * `notification.sent` row telling the other side "declined" about a contest that
 * was in fact accepted.
 *
 * How: `changes()` is SQLite's row count for the most recent INSERT/UPDATE/DELETE
 * on the connection, which inside a batch is the guarded UPDATE. When it is 0 the
 * `CASE` evaluates `json('contest-not-open')`, which is malformed JSON and raises,
 * rolling the whole batch back. SQLite has no `RAISE()` outside triggers, so a
 * deliberate function error is the only in-statement abort available. It is a
 * Drizzle SELECT builder (not `db.run(sql…)`) so the D1 batch and the test
 * harness's shim both accept it. It selects FROM the contest's own row, which
 * always exists at this point, so the expression is evaluated exactly once.
 *
 * {@link isContestRaceError} recognises the resulting error; nothing else in a
 * contest batch calls `json()`, so the match is unambiguous.
 */
export function contestStillOpenSentinel(db: Db, _contestId: string) {
  // FROM a one-row constant, NOT from the contest's own row (AECI-1005 review). If
  // the row is gone (its integration was deleted and the FK cascaded), a
  // `FROM integration_field_challenges WHERE id = ?` returns zero rows, the CASE is
  // never evaluated, and the batch sails on writing audit rows about a contest that
  // no longer exists. A constant row always evaluates the guard exactly once.
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('contest-not-open') END` })
    .from(ONE_ROW);
}

/**
 * A batch statement that ABORTS an admin accept when the integration's ownership
 * state moved after the handler read it (AECI-1005). What an AECi accept writes
 * depends on that state (`claimed_at` decides whether the value is applied here,
 * `built_by_vendor_id` whether an owner accept is a reassignment), so a claim or an
 * owner change landing between the read and the batch must not be decided on stale
 * facts. Same `json()` abort as {@link contestStillOpenSentinel}; the handler tells
 * the two apart by re-reading the contest, which is still `open` only in this case.
 */
export function contestIntegrationStateSentinel(
  db: Db,
  anchorOrId: ContestAnchor | string,
  expected: { claimed: boolean; ownerVendorId: string | null },
) {
  // AECI-1092: either anchor table. Both carry `claimed_at` and `built_by_vendor_id`
  // with the same meaning (migration 0049).
  const anchor = toContestAnchor(anchorOrId);
  const table = anchorTableSql(anchor.kind);
  // Raises when the row is GONE as well as when it moved (AECI-1005 review): a
  // promote cross-table move deletes an unclaimed row, and a guard that reads
  // `FROM integrations WHERE id = ?` would return zero rows and pass silently.
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${table} WHERE "id" = ${anchor.id})
        OR EXISTS (SELECT 1 FROM ${table} WHERE "id" = ${anchor.id}
          AND (("claimed_at" IS NOT NULL) <> ${expected.claimed ? 1 : 0}
            OR ifnull("built_by_vendor_id", '') <> ${expected.ownerVendorId ?? ''}))
        THEN json('contest-integration-changed') END`,
    })
    .from(ONE_ROW);
}

/**
 * Is an AECi accept of this contest STALE (AECI-1006)? True for a content contest
 * on a CLAIMED row whose live column no longer holds the value recorded at submit.
 *
 * Such an accept would write the contest's proposal over whatever changed the
 * column since, which on a claimed row is almost always the owner's own edit
 * (`PATCH /api/vendor/integrations/:id`). So it is refused with
 * `409 CONTEST_VALUE_STALE`: the admin declines, or the submitter withdraws and
 * re-files against the current value. An unclaimed row writes nothing here on
 * accept, so it is never stale, and an `owner` contest is decided on ownership,
 * not on a column value.
 */
export function isContestValueStale(
  row: Pick<ContestRow, 'field' | 'currentValue'>,
  integration: Pick<IntegrationRow, ContestColumn | 'builtByVendorId' | 'claimedAt'>,
): boolean {
  if (row.field === 'owner' || !isClaimed(integration)) return false;
  return storedFieldValue(integration, row.field as IntegrationContestField) !== row.currentValue;
}

/**
 * A batch statement that ABORTS an AECi accept when the contested column no longer
 * holds the value recorded at submit (AECI-1006). The in-batch half of
 * {@link isContestValueStale}: the handler's pre-read refuses the common case, and
 * this catches an owner edit that lands between that read and the batch. `IS NOT`
 * compares NULLs as equal, which is what a recorded `null` means. A missing row is
 * {@link contestIntegrationStateSentinel}'s to catch, so this passes on one.
 */
export function contestValueUnchangedSentinel(
  db: Db,
  anchorOrId: ContestAnchor | string,
  field: ContentContestField,
  expected: string | null,
) {
  // AECI-1092: either anchor table. The column name is the same on both, and only an
  // `integrations` contest can name `mechanism_kind` (§11b.13).
  const anchor = toContestAnchor(anchorOrId);
  if (anchor.kind === 'evidenced_pair' && field === 'mechanism_kind') {
    throw new Error('connector_evidenced_pairs has no mechanism_kind column');
  }
  const column = sql.identifier(integrations[CONTEST_FIELD_COLUMNS[field]].name);
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM ${anchorTableSql(anchor.kind)} WHERE "id" = ${anchor.id}
          AND ${column} IS NOT ${expected})
        THEN json('contest-value-stale') END`,
    })
    .from(ONE_ROW);
}

/** True for the error {@link contestStillOpenSentinel} raises, in D1 or SQLite. */
export function isContestRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (/malformed JSON/i.test(String((current as { message?: unknown }).message ?? current))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
