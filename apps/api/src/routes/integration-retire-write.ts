/**
 * The retire and restore write, shared by the owner routes (AECI-1010,
 * `vendor-integration-retire.ts`) and the admin routes (AECI-1046,
 * `admin-integration-retire.ts`). `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6.
 *
 * Each route keeps its own gate and its own refusal ladder. What they share is
 * everything after "this caller may do this":
 *
 * - {@link buildRetireBatch}: the one `db.batch`. The guarded UPDATE of `retired_at`,
 *   `retired_by` and `updated_at`, `retireRaceSentinel` right after it, then on a
 *   retire every open contest closed as `withdrawn` (guarded UPDATE, sentinel,
 *   workflow closure, audit row, a `closed_by_retire` notice to the submitter), then
 *   `noOpenContestsSentinel`, then the `integration.retired` / `integration.restored`
 *   audit row and one `notification.sent` row per recipient, then both endpoints'
 *   `integration_count` recomputed over the row as the batch leaves it.
 * - {@link afterRetireCommit}: the post-commit tail. A by-id Algolia sync of the
 *   integration, both products and the owner vendor behind promote's `dispatchHook`
 *   watchdog, the queue purge, the recrawl buffer and the PostHog audit forward.
 *
 * The caller supplies the extra UPDATE guard, because that is where the two routes
 * differ: the owner route requires `built_by_vendor_id = caller` and a claim, the
 * admin route requires the row to be vendor-held, and each restore requires the
 * retire to be its own kind.
 */

import type {
  CachePurgeSource,
  IntegrationContestField,
  IntegrationRetireEvent,
  IntegrationRetiredBy,
} from '@aeci/shared';
import type { AlgoliaEnv } from '@aeci/shared/algolia';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrationFieldChallenges, integrations } from '../db/schema';
import { syncIndexTargets, type IndexTargetIds } from '../lib/algolia-sync';
import { emitAlgoliaSyncMetrics } from '../lib/algolia-sync-metrics';
import { auditInsert, type BatchStmt } from '../lib/audit';
import {
  CONTEST_ENTITY_TYPE,
  contestNotificationAudit,
  contestStillOpenSentinel,
} from '../lib/integration-contests';
import {
  INTEGRATION_RESTORED_ACTION,
  INTEGRATION_RETIRED_ACTION,
  noOpenContestsSentinel,
  RETIRE_CLOSED_CONTEST_REASON,
  retireNotificationAudit,
  retireRaceSentinel,
  type openContestsOn,
} from '../lib/integration-retire';
import { publicSiteBase } from '../lib/public-urls';
import { integrationCountRecomputeStmt } from '../lib/recompute-counts';
import { logToPosthog, submitCount, submitDistribution } from '../posthog';
import { dispatchHook, type PromoteRunCtx } from './promote';
import { pairCacheTag } from './promote-pair';
import { closeWorkflow } from './vendor-contests';
import { attestationEditRecrawl } from './vendor-recrawl';
import { afterVendorWrite, recrawlEnabled, type VendorContext } from './vendor-shared';

export type RetireMode = 'retire' | 'restore';
type IntegrationRow = typeof integrations.$inferSelect;
type OpenContest = Awaited<ReturnType<typeof openContestsOn>>[number];

export interface RetireBatchInput {
  mode: RetireMode;
  row: IntegrationRow;
  now: string;
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] };
  /** Who is acting. Written to `retired_by` on a retire; restore clears it. */
  retiredBy: IntegrationRetiredBy;
  /** `metadata.source` on every audit row the batch writes. */
  source: string;
  /** Extra `metadata` on the integration audit row. Each contest audit row gets the
   *  same keys except `reason`, which stays on the integration's row. */
  metadata: Record<string, unknown>;
  /** The route's own UPDATE guard, beside the retired-state guard this builds. */
  guard: SQL;
  /** The open contests to close (a retire). Empty on a restore. */
  contests: readonly OpenContest[];
  /** The acting vendor (the owner), or `null` for an admin. A contest it filed
   *  itself gets no closed-by-retire notice. */
  actingVendorId: string | null;
  /** Vendor ids that get a `notification.sent` row, already de-duplicated. */
  recipients: readonly string[];
  owner: { id: string | null; name: string | null };
  pairSlugs: readonly [string, string] | null;
}

export interface RetireBatch {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  retiredAt: string | null;
  retiredBy: IntegrationRetiredBy | null;
  withdrawnContestIds: string[];
  productIds: string[];
}

export function buildRetireBatch(db: Db, input: RetireBatchInput): RetireBatch {
  const { mode, row, now, actor, contests, pairSlugs } = input;
  const integrationId = row.id;
  const retiredAt = mode === 'retire' ? now : null;
  const retiredBy = mode === 'retire' ? input.retiredBy : null;
  const event: IntegrationRetireEvent = mode === 'retire' ? 'retired' : 'restored';
  const withdrawnContestIds = contests.map((contest) => contest.id);

  const integrationAudit: AuditLogEntry = {
    ...actor,
    action: mode === 'retire' ? INTEGRATION_RETIRED_ACTION : INTEGRATION_RESTORED_ACTION,
    entityType: 'integration',
    entityId: integrationId,
    beforeState: { retired_at: row.retiredAt, retired_by: row.retiredBy },
    afterState: { retired_at: retiredAt, retired_by: retiredBy },
    metadata: {
      source: input.source,
      ...input.metadata,
      retiredBy: input.retiredBy,
      ...(mode === 'retire' ? { withdrawnContestIds } : {}),
    },
  };
  const notices = input.recipients.map((recipient) =>
    retireNotificationAudit(actor, {
      event,
      retiredBy: input.retiredBy,
      vendorId: recipient,
      integrationId,
      integrationName: row.name,
      ownerVendorId: input.owner.id,
      ownerName: input.owner.name,
      pairSlugs,
    }),
  );

  const stmts: BatchStmt[] = [
    db
      .update(integrations)
      .set({ retiredAt, retiredBy, updatedAt: now })
      .where(
        and(
          eq(integrations.id, integrationId),
          mode === 'retire' ? isNull(integrations.retiredAt) : isNotNull(integrations.retiredAt),
          input.guard,
        ),
      ),
    // Immediately after the guarded UPDATE: a lost race aborts the batch here.
    retireRaceSentinel(db),
  ];
  const audits: AuditLogEntry[] = [];

  // The admin's reason (AECI-1046) belongs on the integration's audit row only. The
  // contest rows and their workflow transitions carry the fixed retire reason.
  const { reason: _adminReason, ...contestExtra } = input.metadata;

  // Retire closes every open contest on the row as withdrawn (ruled 2026-09-22).
  for (const contest of contests) {
    const metadata = {
      source: input.source,
      ...contestExtra,
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
    // The submitter learns why its contest closed: a `contest` row with the
    // `closed_by_retire` event, addressed to the submitter vendor, in the same batch.
    const submitterNotice =
      contest.submitterVendorId !== input.actingVendorId
        ? contestNotificationAudit(actor, {
            vendorId: contest.submitterVendorId,
            contestId: contest.id,
            integrationId,
            integrationName: row.name,
            field: contest.field as IntegrationContestField,
            event: 'closed_by_retire',
            // AECI-1046: the submitter is told who retired it. No reason travels here.
            retiredBy: input.retiredBy,
            pairSlugs,
          })
        : null;
    audits.push(contestAudit, ...(submitterNotice ? [submitterNotice] : []));
    const workflow = closeWorkflow(
      db,
      contest,
      'withdrawn',
      { actorId: actor.actorId, reason: RETIRE_CLOSED_CONTEST_REASON, metadata },
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

  audits.unshift(integrationAudit, ...notices);
  stmts.push(auditInsert(db, integrationAudit), ...notices.map((n) => auditInsert(db, n)));

  // Last: both endpoints' counts, recomputed over the row as this batch leaves it.
  // Committed with the retire, so the purge after commit can never race a stale count.
  const productIds = [...new Set([row.sourceProductId, row.targetProductId])];
  for (const productId of productIds) stmts.push(integrationCountRecomputeStmt(db, productId));

  return { stmts, audits, retiredAt, retiredBy, withdrawnContestIds, productIds };
}

export interface RetireCommitInput {
  mode: RetireMode;
  integrationId: string;
  productIds: readonly string[];
  owner: { id: string; slug: string } | null;
  pairSlugs: readonly [string, string] | null;
  audits: readonly AuditLogEntry[];
  /** Hook name prefix and the Algolia failure log message, per route. */
  hookPrefix: string;
  syncFailureMessage: string;
  origin?: { auditSource: string; purgeSource: CachePurgeSource };
}

/** The post-commit tail. All best-effort; see the module header. */
export function afterRetireCommit(c: VendorContext, db: Db, input: RetireCommitInput): void {
  dispatchOwnerWriteSearch(
    c,
    `${input.hookPrefix}-${input.mode}-algolia`,
    syncOwnerWriteSearch(
      c,
      db,
      {
        integrations: [input.integrationId],
        products: [...input.productIds],
        vendors: input.owner ? [input.owner.id] : [],
      },
      input.syncFailureMessage,
    ),
  );

  const { pairSlugs } = input;
  const tags = [
    ...(pairSlugs
      ? [
          pairCacheTag(pairSlugs[0], pairSlugs[1]),
          `product:${pairSlugs[0]}`,
          `product:${pairSlugs[1]}`,
        ]
      : []),
    ...(input.owner ? [`vendor:${input.owner.slug}`] : []),
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
  afterVendorWrite(c, tags, input.audits, recrawl, db, input.origin);
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
