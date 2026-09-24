/**
 * Integration retire and restore, vendor side (AECI-1010 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6) — Drizzle/D1.
 *
 *   POST /api/vendor/integrations/:id/retire  — the owner withdraws the row (200).
 *   POST /api/vendor/integrations/:id/restore — the owner brings it back (200).
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Six rules of
 * this module's own:
 *
 * ── 1. RETIRE IS NOT RETRACT ────────────────────────────────────────────────
 * Nothing is deleted (ADR 0030 is about deletes, and this is not one). The row, its
 * claims and its attestations all stay, so a restore is lossless. What changes is
 * `retired_at`, and every count, id set and public read filters on it through
 * `lib/live-integration.ts`. That predicate is the hard part of this feature; this
 * handler is the easy part.
 *
 * ── 2. A SEAT IS THE GATE, AND THE ROW MUST BE CLAIMED ──────────────────────
 * `requireVendor()` then `rateLimit('write')` at registration, no capability
 * (AECI-1003 decision 15). Inside: the row → ownership → entitlement on a
 * connector-powered row → claimed order the claim and the edit use, then two state
 * checks. The owner of an unclaimed row gets `409 INTEGRATION_NOT_CLAIMED`: ownership
 * is taken by the claim, and a row promote can still write must not be hidden by a
 * vendor.
 *
 * ── 2a. CONNECTOR-POWERED ROWS, IN EITHER TABLE (AECI-1091) ─────────────────
 * The AECI-1040 carve-out: the owner retires and restores its claimed
 * connector-powered rows too, but only with an active entitlement (ruling 2,
 * `403 INTEGRATION_ENTITLEMENT_REQUIRED`, `lib/integration-entitlement.ts`). Until
 * AECI-1091 such a row answered `403 INTEGRATION_CONNECTOR_POWERED`. The `:id` is
 * looked up in `integrations` first and then in `connector_evidenced_pairs`
 * (`lib/retire-target.ts`). A pair takes `buildPairRetireBatch`: a soft retire of
 * `retired_at` / `retired_by` on the pair, never a delete (the table cascades into
 * `claims` and on into `attestations`), audited as entity type
 * `connector_evidenced_pair`, with THREE count recomputes (both endpoints and the
 * connector) and the connector's `product:` tag in the purge.
 *
 * ── 3. IDEMPOTENT BY REFUSAL ────────────────────────────────────────────────
 * Retiring a retired row is `409 INTEGRATION_RETIRED`; restoring a live row is
 * `409 INTEGRATION_NOT_RETIRED`. Neither writes an audit row.
 *
 * ── 4. ONE BATCH ────────────────────────────────────────────────────────────
 * The guarded UPDATE (retired state, claimed, owner), `retireRaceSentinel`
 * immediately after it, then on a retire every open contest closed as `withdrawn`
 * (each with its own guarded UPDATE and sentinel, its workflow closure, its audit
 * row and a `closed_by_retire` contest notification to the submitter vendor), then `noOpenContestsSentinel`, then the `integration.retired` /
 * `integration.restored` audit row and one `notification.sent` per other endpoint
 * vendor, then the two endpoints' `integration_count` recomputes
 * (`integrationCountRecomputeStmt`, derived writes with no audit row). A lost race
 * writes nothing and re-derives the refusal. When the re-read finds nothing to
 * refuse (a contest was filed in between, say), the answer is
 * `409 INTEGRATION_CHANGED_WHILE_SAVING`: reload and try again. Restore reopens no
 * contest (ruled 2026-09-22): a contest was about the row as it stood, and the
 * submitter can file again.
 *
 * ── 5. `updated_at` MOVES, THROUGH DRIZZLE ──────────────────────────────────
 * Set explicitly and through `db.update`, so the row enters the 08:00 Algolia sync
 * window and the `integrations` freshness cursor moves for both endpoint vendors. A
 * raw-SQL write without the bump would break restore permanently: the orphan sweep
 * only deletes, so an un-bumped restore is never re-indexed.
 *
 * ── 6. COUNTS IN THE BATCH; SEARCH AND THE EDGE AFTER COMMIT ────────────────
 * The two endpoints' stored `integration_count` is recomputed INSIDE the batch, so
 * it is committed before any purge is enqueued and no re-render can cache the old
 * count. After commit: a by-id Algolia sync of the integration (a retire deletes its
 * record, a restore re-adds it), both products (whose record reads the stored count)
 * and the owner vendor, whose count has no other refresh path. It runs behind
 * promote's `dispatchHook` watchdog because it holds outbound Algolia connections,
 * and each entity that fails is logged. Then the purge queue and the recrawl through
 * `afterVendorWrite`. All best-effort. The home stats (`index:home`) are left to
 * their daily cron, as for every vendor write.
 *
 * Retire does not touch `maintained_by` or `last_reviewed_at` (§13.9): it changes
 * whether the row is shown, not what it says, and a claimed row is already
 * vendor-maintained.
 */

import {
  ApiErrorCode,
  RetireIntegrationResponseSchema,
  type RetireIntegrationResponse,
} from '@aeci/shared';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { connectorEvidencedPairs, integrations, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  hasActiveEntitlement,
  integrationEntitlementRequired,
  type EntitlementSession,
} from '../lib/integration-entitlement';
import { isRetireRaceError, openContestsOn } from '../lib/integration-retire';
import { integrationRetiredError, isLiveIntegration } from '../lib/live-integration';
import {
  endpointVendorIds,
  locateRetireTarget,
  ownsAnEndpoint,
  relocateRetireTarget,
  retireSlugs,
  retireTargetOf,
  type LocatedRetireRow,
  type RetireTarget,
} from '../lib/retire-target';
import {
  afterRetireCommit,
  buildPairRetireBatch,
  buildRetireBatch,
  type RetireBatch,
  type RetireMode,
} from './integration-retire-write';
import { AUDIT_SOURCE, sessionVendorId, type VendorContext } from './vendor-shared';

type Mode = RetireMode;

/**
 * Why this caller cannot retire or restore this row, or `null` when it can. Shared
 * by the pre-check and the lost-race re-read, so a race answers exactly what the
 * pre-check would have answered a moment later. One ladder for both anchor tables
 * (AECI-1091): {@link RetireTarget} is the part of either row it reads.
 */
async function refusalFor(
  db: Db,
  vendorId: string,
  target: RetireTarget,
  mode: Mode,
  session: EntitlementSession,
): Promise<ApiError | null> {
  if (target.builtByVendorId !== vendorId) {
    if (!(await ownsAnEndpoint(db, vendorId, target.endpointIds))) {
      return notFoundError('integration', { id: target.id });
    }
    if (target.builtByVendorId === null) {
      return new ApiError(
        409,
        ApiErrorCode.INTEGRATION_OWNER_UNKNOWN,
        'No owner is on file for this integration, so nobody can retire it yet.',
      );
    }
    return new ApiError(
      403,
      ApiErrorCode.INTEGRATION_NOT_OWNER,
      'Only the company that owns this integration can retire or restore it.',
    );
  }
  // AECI-1091, the AECI-1040 carve-out (ruling 2): the owner of a connector-powered
  // row retires and restores it only with an active entitlement. Every evidenced
  // pair is connector-powered. After ownership, so a non-owner still gets the
  // ownership answer, and before the claim, as the claim and the edit ask it.
  if (target.connectorPowered && !hasActiveEntitlement(session)) {
    return integrationEntitlementRequired(session);
  }
  if (target.claimedAt === null) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_NOT_CLAIMED,
      'Claim this integration before retiring it.',
    );
  }
  const live = isLiveIntegration(target);
  if (mode === 'retire' && !live) return integrationRetiredError();
  if (mode === 'restore' && live) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_NOT_RETIRED,
      'This integration is not retired, so there is nothing to restore.',
    );
  }
  // AECI-1046: only an AECi admin restores an AECi retire.
  if (mode === 'restore' && target.retiredBy === 'aeci') {
    return new ApiError(
      403,
      ApiErrorCode.INTEGRATION_RETIRED_BY_AECI,
      'AEC Integrations retired this integration, so only AEC Integrations can restore it.',
    );
  }
  return null;
}

export function createRetireIntegrationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return handlerFor('retire', dbFor);
}

export function createRestoreIntegrationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return handlerFor('restore', dbFor);
}

function handlerFor(mode: Mode, dbFor: DbFactory): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const integrationId = c.req.param('id');
    if (!integrationId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    }
    const { db } = writeDb(c, dbFor);

    // 1. The row, in either table (AECI-1091). An unknown id and an invisible one
    //    are both 404.
    const located = await locateRetireTarget(db, integrationId);
    if (!located) throw notFoundError('integration', { id: integrationId });

    // 2. Ownership, then the entitlement on a connector-powered row, then state.
    const refusal = await refusalFor(db, vendorId, retireTargetOf(located), mode, session);
    if (refusal) throw refusal;

    const [owner, endpointVendors, slugs, contests] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, slug: true, companyName: true },
        where: eq(vendors.id, vendorId),
      }),
      endpointVendorIds(db, located),
      retireSlugs(db, located),
      // Either anchor: a pair's contests sit on `evidenced_pair_id` (AECI-1092).
      mode === 'retire'
        ? openContestsOn(db, { kind: located.anchor, id: integrationId })
        : Promise.resolve([]),
    ]);
    if (!owner) throw notFoundError('vendor', { id: vendorId });

    // Every vendor of either endpoint except the owner, as for the claim.
    const recipients = endpointVendors.filter((id) => id !== vendorId);

    const now = new Date().toISOString();
    const common = {
      mode,
      now,
      actor: { actorId: session.userId, actorType: auditActorType(session) },
      retiredBy: 'owner' as const,
      source: AUDIT_SOURCE,
      metadata: { vendorId },
      actingVendorId: vendorId,
      recipients,
      owner: { id: vendorId, name: owner.companyName },
      pairSlugs: slugs.pairSlugs,
    };
    const batch: RetireBatch =
      located.anchor === 'integration'
        ? buildRetireBatch(db, {
            ...common,
            row: located.row,
            guard: and(
              isNotNull(integrations.claimedAt),
              eq(integrations.builtByVendorId, vendorId),
              // AECI-1046: the owner restores only its own retire. NULL predates
              // 0046 and is an owner retire.
              mode === 'restore'
                ? or(isNull(integrations.retiredBy), eq(integrations.retiredBy, 'owner'))
                : undefined,
            )!,
            contests,
          })
        : buildPairRetireBatch(db, {
            ...common,
            pair: located.pair,
            contests,
            // The same guard on the pair's own columns. Only these routes write
            // `retired_by` there, always with `retired_at`, so NULL cannot occur; it
            // is read as `'owner'` anyway, as `effectiveRetiredBy` reads it.
            guard: and(
              isNotNull(connectorEvidencedPairs.claimedAt),
              eq(connectorEvidencedPairs.builtByVendorId, vendorId),
              mode === 'restore'
                ? or(
                    isNull(connectorEvidencedPairs.retiredBy),
                    eq(connectorEvidencedPairs.retiredBy, 'owner'),
                  )
                : undefined,
            )!,
          });

    try {
      await db.batch(batch.stmts as BatchTuple);
    } catch (error) {
      if (!isRetireRaceError(error)) throw error;
      throw await raceAnswer(db, vendorId, located, mode, session);
    }

    afterRetireCommit(c, db, {
      mode,
      integrationId,
      productIds: batch.productIds,
      owner: { id: vendorId, slug: owner.slug },
      pairSlugs: slugs.pairSlugs,
      connectorSlug: slugs.connectorSlug,
      audits: batch.audits,
      hookPrefix: 'vendor',
      syncFailureMessage: 'aeci.api.vendor.retire_algolia_sync_failed',
    });

    const body: RetireIntegrationResponse = {
      integration: {
        id: integrationId,
        retired_at: batch.retiredAt,
        retired_by: batch.retiredBy,
        updated_at: now,
      },
      withdrawn_contest_ids: batch.withdrawnContestIds,
    };
    validateResponseInDev(c.env, () => RetireIntegrationResponseSchema.parse(body));
    return json(body);
  };
}

/** A lost race re-reads the row and answers what the pre-check would now answer, or
 *  `409 INTEGRATION_CHANGED_WHILE_SAVING` when nothing refuses any more. */
async function raceAnswer(
  db: Db,
  vendorId: string,
  located: LocatedRetireRow,
  mode: Mode,
  session: EntitlementSession,
): Promise<ApiError> {
  const current = await relocateRetireTarget(db, located);
  if (!current) return notFoundError('integration', { id: retireTargetOf(located).id });
  return (
    (await refusalFor(db, vendorId, retireTargetOf(current), mode, session)) ??
    new ApiError(
      409,
      ApiErrorCode.INTEGRATION_CHANGED_WHILE_SAVING,
      'This integration changed while you were saving. Reload and try again.',
    )
  );
}
