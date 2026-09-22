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
  type IntegrationContestField,
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
import { syncIndexTargets, type IndexTargetIds } from '../lib/algolia-sync';
import { emitAlgoliaSyncMetrics } from '../lib/algolia-sync-metrics';
import { vendorsForIntegrationSlots } from '../lib/attestation-authority';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isClaimed } from '../lib/integration-claims';
import {
  CONTEST_ENTITY_TYPE,
  contestNotificationAudit,
  contestStillOpenSentinel,
} from '../lib/integration-contests';
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
import { integrationCountRecomputeStmt } from '../lib/recompute-counts';
import { logToPosthog, submitCount, submitDistribution } from '../posthog';
import { dispatchHook, type PromoteRunCtx } from './promote';
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
      // The submitter learns why its contest closed. A `contest` row with the
      // `closed_by_retire` event, addressed to the submitter vendor, in the same batch.
      const submitterNotice =
        contest.submitterVendorId !== vendorId
          ? contestNotificationAudit(actor, {
              vendorId: contest.submitterVendorId,
              contestId: contest.id,
              integrationId,
              integrationName: row.name,
              field: contest.field as IntegrationContestField,
              event: 'closed_by_retire',
              pairSlugs,
            })
          : null;
      audits.push(contestAudit, ...(submitterNotice ? [submitterNotice] : []));
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
        ...(submitterNotice ? [auditInsert(db, submitterNotice)] : []),
      );
    }
    if (mode === 'retire') stmts.push(noOpenContestsSentinel(db, integrationId));
    // The integration audit row and the notifications. The contest audits were
    // pushed with their own statements above, so skip them here.
    for (const entry of audits) {
      if (entry.entityType !== CONTEST_ENTITY_TYPE) stmts.push(auditInsert(db, entry));
    }
    // Last: both endpoints' counts, recomputed over the row as this batch leaves it.
    // Committed with the retire, so the purge below can never race a stale count.
    const productIds = [...new Set([row.sourceProductId, row.targetProductId])];
    for (const productId of productIds) stmts.push(integrationCountRecomputeStmt(db, productId));

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
          ApiErrorCode.INTEGRATION_CHANGED_WHILE_SAVING,
          'This integration changed while you were saving. Reload and try again.',
        )
      );
    }

    dispatchOwnerWriteSearch(
      c,
      `vendor-${mode}-algolia`,
      syncOwnerWriteSearch(
        c,
        db,
        { integrations: [integrationId], products: productIds, vendors: [vendorId] },
        'aeci.api.vendor.retire_algolia_sync_failed',
      ),
    );

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
 * The post-commit search tail of an owner write: a by-id Algolia sync of the
 * records the write changed. Retire passes the integration, both endpoint products
 * and the owner vendor (the counts were committed in the batch, so the product and
 * vendor records read the new stored value). The AECI-1006 edit passes the
 * integration alone, because an edit changes no count. The AECI-1011 create passes
 * the same four records as retire. Never throws. Sequential by
 * construction (`syncIndexTargets`), so it holds at most one outbound connection at
 * a time. Each entity whose sync failed is logged under `failureMessage`, as the
 * promote tail does.
 */
export async function syncOwnerWriteSearch(
  c: VendorContext,
  db: Db,
  targets: IndexTargetIds,
  failureMessage: string,
): Promise<void> {
  const creds = { appId: c.env.ALGOLIA_APP_ID, apiKey: c.env.ALGOLIA_ADMIN_KEY };
  if (!creds.appId || !creds.apiKey) return;
  const env: AlgoliaEnv = c.env.ENV ?? 'development';
  const started = Date.now();
  try {
    const results = await syncIndexTargets(db, fetch, creds, env, targets);
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
    for (const result of results) {
      if (!result.ok) logSyncFailure(c, failureMessage, result.entity, result.error ?? 'unknown');
    }
  } catch (error) {
    logSyncFailure(
      c,
      failureMessage,
      'all',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Run {@link syncOwnerWriteSearch} behind promote's `dispatchHook` watchdog, so a
 * wedged Algolia connection becomes a warning rather than a hung invocation.
 */
export function dispatchOwnerWriteSearch(
  c: VendorContext,
  hookName: string,
  work: Promise<void>,
): void {
  const rc: PromoteRunCtx = {
    env: c.env,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    request: c.req.raw,
    bookmark: () => null,
  };
  dispatchHook(rc, hookName, work);
}

function logSyncFailure(c: VendorContext, message: string, entity: string, reason: string): void {
  logToPosthog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message,
    entity,
    reason,
  });
}
