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
 * ── 2. A SEAT IS THE WHOLE GATE, AND THE ROW MUST BE CLAIMED ────────────────
 * `requireVendor()` then `rateLimit('write')` at registration, no capability
 * (AECI-1003 decision 15). Inside: the same row → ownership → connector-powered order
 * the claim route uses, then two state checks. The owner of an unclaimed row gets
 * `409 INTEGRATION_NOT_CLAIMED`: ownership is taken by the claim, and a row promote
 * can still write must not be hidden by a vendor.
 *
 * ── 3. IDEMPOTENT BY REFUSAL ────────────────────────────────────────────────
 * Retiring a retired row is `409 INTEGRATION_RETIRED`; restoring a live row is
 * `409 INTEGRATION_NOT_RETIRED`. Neither writes an audit row.
 *
 * ── 4. ONE BATCH ────────────────────────────────────────────────────────────
 * The guarded UPDATE (retired state, claimed, owner), `retireRaceSentinel`
 * immediately after it, then on a retire every open contest closed as `withdrawn`
 * (each with its own guarded UPDATE and sentinel, its workflow closure and its audit
 * row), then `noOpenContestsSentinel`, then the `integration.retired` /
 * `integration.restored` audit row and one `notification.sent` per other endpoint
 * vendor. A lost race writes nothing and re-derives the refusal. Restore reopens no
 * contest (ruled 2026-09-22): a contest was about the row as it stood, and the
 * submitter can file again.
 *
 * ── 5. `updated_at` MOVES, THROUGH DRIZZLE ──────────────────────────────────
 * Set explicitly and through `db.update`, so the row enters the 08:00 Algolia sync
 * window and the `integrations` freshness cursor moves for both endpoint vendors. A
 * raw-SQL write without the bump would break restore permanently: the orphan sweep
 * only deletes, so an un-bumped restore is never re-indexed.
 *
 * ── 6. POST-COMMIT: COUNTS, THEN SEARCH, THEN THE EDGE ──────────────────────
 * `recomputeProductCounts` for both endpoints first, because the product search
 * record reads the stored `integration_count`. Then a by-id Algolia sync of the
 * integration (a retire deletes its record, a restore re-adds it), both products and
 * the owner vendor, whose count has no other refresh path. Then the purge queue and
 * the recrawl through `afterVendorWrite`. All best-effort, all after commit. The home
 * stats (`index:home`) are left to their daily cron, as for every vendor write.
 *
 * Retire does not touch `maintained_by` or `last_reviewed_at` (§13.9): it changes
 * whether the row is shown, not what it says, and a claimed row is already
 * vendor-maintained.
 */

import {
  ApiErrorCode,
  RetireIntegrationResponseSchema,
  type IntegrationRetireEvent,
  type RetireIntegrationResponse,
} from '@aeci/shared';
import type { AlgoliaEnv } from '@aeci/shared/algolia';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { integrationFieldChallenges, integrations, productVendors, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { syncIndexTargets } from '../lib/algolia-sync';
import { emitAlgoliaSyncMetrics } from '../lib/algolia-sync-metrics';
import { vendorsForIntegrationSlots } from '../lib/attestation-authority';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isClaimed } from '../lib/integration-claims';
import { CONTEST_ENTITY_TYPE, contestStillOpenSentinel } from '../lib/integration-contests';
import {
  INTEGRATION_RESTORED_ACTION,
  INTEGRATION_RETIRED_ACTION,
  isRetireRaceError,
  noOpenContestsSentinel,
  openContestsOn,
  RETIRE_CLOSED_CONTEST_REASON,
  retireNotificationAudit,
  retireRaceSentinel,
} from '../lib/integration-retire';
import { integrationRetiredError, isLiveIntegration } from '../lib/live-integration';
import { publicSiteBase } from '../lib/public-urls';
import { recomputeProductCounts } from '../lib/recompute-counts';
import { logToPosthog, submitCount, submitDistribution } from '../posthog';
import { pairCacheTag } from './promote-pair';
import { closeWorkflow, endpointSlugs } from './vendor-contests';
import { attestationEditRecrawl } from './vendor-recrawl';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  recrawlEnabled,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

type IntegrationRow = typeof integrations.$inferSelect;
type Mode = 'retire' | 'restore';

/** Does the caller's vendor own either endpoint product? The visibility half of the
 *  404 rule, as in the claim route. */
async function ownsAnEndpoint(
  db: Db,
  vendorId: string,
  row: Pick<IntegrationRow, 'sourceProductId' | 'targetProductId'>,
): Promise<boolean> {
  const hit = await db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(
      and(
        eq(productVendors.vendorId, vendorId),
        inArray(productVendors.productId, [row.sourceProductId, row.targetProductId]),
      ),
    )
    .limit(1);
  return hit.length > 0;
}

/**
 * Why this caller cannot retire or restore this row, or `null` when it can. Shared
 * by the pre-check and the lost-race re-read, so a race answers exactly what the
 * pre-check would have answered a moment later.
 */
async function refusalFor(
  db: Db,
  vendorId: string,
  row: IntegrationRow,
  mode: Mode,
): Promise<ApiError | null> {
  if (row.builtByVendorId !== vendorId) {
    if (!(await ownsAnEndpoint(db, vendorId, row))) {
      return notFoundError('integration', { id: row.id });
    }
    if (row.builtByVendorId === null) {
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
  // Decision 9, v1: no vendor write on a connector-powered row. After ownership, so a
  // non-owner still gets the ownership answer.
  if (isConnectorPoweredEdge(row)) {
    return new ApiError(
      403,
      ApiErrorCode.INTEGRATION_CONNECTOR_POWERED,
      'This integration is delivered through a connector product, and connector-delivered integrations cannot be retired yet.',
    );
  }
  if (!isClaimed(row)) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_NOT_CLAIMED,
      'Claim this integration before retiring it.',
    );
  }
  const live = isLiveIntegration(row);
  if (mode === 'retire' && !live) return integrationRetiredError();
  if (mode === 'restore' && live) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_NOT_RETIRED,
      'This integration is not retired, so there is nothing to restore.',
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

    // 1. The row, alone in its wave. An unknown id and an invisible one are both 404.
    const row = await db.query.integrations.findFirst({
      where: eq(integrations.id, integrationId),
    });
    if (!row) throw notFoundError('integration', { id: integrationId });

    // 2. Ownership, then connector-powered, then state.
    const refusal = await refusalFor(db, vendorId, row, mode);
    if (refusal) throw refusal;

    const [owner, slotVendors, pairSlugs, contests] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, slug: true, companyName: true },
        where: eq(vendors.id, vendorId),
      }),
      vendorsForIntegrationSlots(db, [integrationId]),
      endpointSlugs(db, row.sourceProductId, row.targetProductId),
      mode === 'retire' ? openContestsOn(db, integrationId) : Promise.resolve([]),
    ]);
    if (!owner) throw notFoundError('vendor', { id: vendorId });

    // Every vendor of either endpoint except the owner, as for the claim.
    const slots = slotVendors.get(integrationId)?.slots;
    const recipients = [...new Set([...(slots?.vendor_a ?? []), ...(slots?.vendor_b ?? [])])]
      .filter((id) => id !== vendorId)
      .sort();

    const now = new Date().toISOString();
    const retiredAt = mode === 'retire' ? now : null;
    const event: IntegrationRetireEvent = mode === 'retire' ? 'retired' : 'restored';
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const withdrawnContestIds = contests.map((contest) => contest.id);

    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: mode === 'retire' ? INTEGRATION_RETIRED_ACTION : INTEGRATION_RESTORED_ACTION,
        entityType: 'integration',
        entityId: integrationId,
        beforeState: { retired_at: row.retiredAt },
        afterState: { retired_at: retiredAt },
        metadata: {
          source: AUDIT_SOURCE,
          vendorId,
          ...(mode === 'retire' ? { withdrawnContestIds } : {}),
        },
      },
      ...recipients.map((recipient) =>
        retireNotificationAudit(actor, {
          event,
          vendorId: recipient,
          integrationId,
          integrationName: row.name,
          ownerVendorId: vendorId,
          ownerName: owner.companyName,
          pairSlugs,
        }),
      ),
    ];

    const stmts: BatchStmt[] = [
      db
        .update(integrations)
        .set({ retiredAt, updatedAt: now })
        .where(
          and(
            eq(integrations.id, integrationId),
            mode === 'retire' ? isNull(integrations.retiredAt) : isNotNull(integrations.retiredAt),
            isNotNull(integrations.claimedAt),
            eq(integrations.builtByVendorId, vendorId),
          ),
        ),
      // Immediately after the guarded UPDATE: a lost race aborts the batch here.
      retireRaceSentinel(db),
    ];

    // Retire closes every open contest on the row as withdrawn (ruled 2026-09-22).
    for (const contest of contests) {
      const metadata = {
        source: AUDIT_SOURCE,
        vendorId,
        contestId: contest.id,
        integrationId,
        field: contest.field,
        reason: RETIRE_CLOSED_CONTEST_REASON,
      };
      const contestAudit: AuditLogEntry = {
        ...actor,
        action: 'integration.contest.withdrawn',
        entityType: CONTEST_ENTITY_TYPE,
        entityId: contest.id,
        beforeState: { status: 'open' },
        afterState: { status: 'withdrawn' },
        metadata,
      };
      audits.push(contestAudit);
      const workflow = closeWorkflow(
        db,
        contest,
        'withdrawn',
        { actorId: session.userId, reason: RETIRE_CLOSED_CONTEST_REASON, metadata },
        now,
      );
      stmts.push(
        db
          .update(integrationFieldChallenges)
          .set({ status: 'withdrawn', updatedAt: now })
          .where(
            and(
              eq(integrationFieldChallenges.id, contest.id),
              eq(integrationFieldChallenges.status, 'open'),
            ),
          ),
        contestStillOpenSentinel(db, contest.id),
        ...workflow.stmts,
        auditInsert(db, contestAudit),
      );
    }
    if (mode === 'retire') stmts.push(noOpenContestsSentinel(db, integrationId));
    // The integration audit row and the notifications. The contest audits were
    // pushed with their own statements above, so skip them here.
    for (const entry of audits) {
      if (entry.entityType !== CONTEST_ENTITY_TYPE) stmts.push(auditInsert(db, entry));
    }

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isRetireRaceError(error)) throw error;
      const current = await db.query.integrations.findFirst({
        where: eq(integrations.id, integrationId),
      });
      if (!current) throw notFoundError('integration', { id: integrationId });
      throw (
        (await refusalFor(db, vendorId, current, mode)) ??
        new ApiError(
          409,
          ApiErrorCode.INTEGRATION_RETIRED,
          'This integration changed while you were saving. Reload and try again.',
        )
      );
    }

    const productIds = [row.sourceProductId, row.targetProductId];
    c.executionCtx.waitUntil(refreshCountsAndSearch(c, db, productIds, integrationId, vendorId));

    const tags = [
      ...(pairSlugs
        ? [
            pairCacheTag(pairSlugs[0], pairSlugs[1]),
            `product:${pairSlugs[0]}`,
            `product:${pairSlugs[1]}`,
          ]
        : []),
      `vendor:${owner.slug}`,
      'index:products',
      'taxonomy',
      'sitemap',
    ];
    const base = publicSiteBase(c.env);
    // A retire is announced too: a re-crawl is how a crawler learns the pair page
    // went `noindex`.
    const recrawl =
      pairSlugs && recrawlEnabled(c.env) && base
        ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
        : undefined;
    afterVendorWrite(c, tags, audits, recrawl, db);

    const body: RetireIntegrationResponse = {
      integration: { id: integrationId, retired_at: retiredAt, updated_at: now },
      withdrawn_contest_ids: withdrawnContestIds,
    };
    validateResponseInDev(c.env, () => RetireIntegrationResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * The post-commit tail: recompute both endpoints' stored counts, THEN re-index by id.
 * Order matters, because the product search record reads `products.integration_count`.
 * Never throws. Sequential by construction, so it holds at most one outbound
 * connection at a time.
 */
async function refreshCountsAndSearch(
  c: VendorContext,
  db: Db,
  productIds: readonly string[],
  integrationId: string,
  ownerVendorId: string,
): Promise<void> {
  try {
    await recomputeProductCounts(db, productIds);
  } catch (error) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: 'aeci.api.vendor.retire_recompute_failed',
      outcome: error instanceof Error ? error.message : String(error),
    });
    // The counts are the reconcile cron's to repair. Still re-index the integration.
  }

  const creds = { appId: c.env.ALGOLIA_APP_ID, apiKey: c.env.ALGOLIA_ADMIN_KEY };
  if (!creds.appId || !creds.apiKey) return;
  const env: AlgoliaEnv = c.env.ENV ?? 'development';
  const started = Date.now();
  try {
    const results = await syncIndexTargets(db, fetch, creds, env, {
      integrations: [integrationId],
      products: productIds,
      vendors: [ownerVendorId],
    });
    emitAlgoliaSyncMetrics(
      {
        count: (metric, value, tags) =>
          submitCount(c.executionCtx, c.env, c.req.raw, metric, value, tags),
        distribution: (metric, value, tags) =>
          submitDistribution(c.executionCtx, c.env, c.req.raw, metric, value, tags),
      },
      'vendor',
      results,
      Date.now() - started,
    );
  } catch (error) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: 'aeci.api.vendor.retire_algolia_sync_failed',
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}
