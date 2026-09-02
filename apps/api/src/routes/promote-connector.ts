/**
 * The connector-catalogue page ingest and its post-commit tail (AECI-714 / ADR 0021 /
 * `STAGE_1_5_SPEC.md` §13).
 *
 * The second arm of the promote family. It reuses ADR 0021 wholesale — one non-retried
 * `step.do`, one `db.batch` with the `promote_jobs` ledger row first, the same job-id
 * idempotency, the same KV spill and result mirror, the same poll endpoint — and
 * differs from the product arm in exactly two respects, both deliberate:
 *
 *   1. **There is no ID map.** These tables are keyed on the review app's own record
 *      ids, so the caller already knows every id it sent. The AECI-561 stranded-response
 *      failure mode does not exist on this path.
 *   2. **Almost no post-commit hooks.** §13.5: *"Reachable never counts — not in the
 *      heading, not in `integration_count`, not in a facet, not in the home stats."*
 *      See {@link dispatchConnectorHooks}.
 *
 * ── PAGES ARE ATOMIC; SEQUENCES OF PAGES ARE NOT ────────────────────────────
 * One `promote_jobs` row protects one commit. A catalogue is many pages, so the
 * cross-page property is idempotence rather than atomicity — every statement the
 * planner emits is an upsert on the review record id. A half-finished catalogue sync
 * is therefore always safe to simply re-run from the start.
 */

import type {
  AuditLogEntry,
  PromoteConnectorPagePayload,
  PromoteConnectorPageResponse,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/client';
import type { DbContext } from '../db/client';
import { promoteJobs } from '../db/schema';
import { ApiError } from '../errors';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { logBatchToPosthog } from '../posthog';
import { planConnectorCatalogPage } from '../lib/promote-connector-catalog';
import {
  AUDIT_META,
  auditLogEvent,
  isPromoteJobDuplicate,
  logPromoteSkips,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';

/**
 * Merge the shared `source` facet into an entry's own metadata rather than replacing it.
 *
 * The product arm can assign `AUDIT_META` outright because its rows carry no metadata of
 * their own. Here the planner's counts and page cursor ARE the row's content — a summary
 * row that lost them would satisfy §26.1's letter and none of its purpose, and
 * `STAGE_1_SPEC.md` §26.1 promises them by name.
 *
 * `AuditLogEntry.metadata` is `unknown`, so the object check is required rather than
 * decorative: a non-object metadata would spread to nothing and silently drop `source`.
 */
function withAuditMeta(entry: AuditLogEntry): AuditLogEntry {
  const own = entry.metadata;
  const merged =
    own && typeof own === 'object' && !Array.isArray(own)
      ? { ...AUDIT_META, ...(own as Record<string, unknown>) }
      : AUDIT_META;
  return { ...entry, metadata: merged };
}

/** What the committed page hands back to the Workflow. */
export type ConnectorIngestResult = {
  response: PromoteConnectorPageResponse;
  /** False for a page that changed nothing — the audit row is suppressed with it. */
  wrote: boolean;
  bookmark: string | null;
  auditEntries: AuditLogEntry[];
};

/**
 * What a committed connector page leaves in `promote_jobs.result`.
 *
 * `kind: 'connector'` is the discriminant, and it is what keeps the two envelopes from
 * being confused: the product parser rejects anything carrying a `kind`, and this one
 * requires it. A mis-parse would be worse than a failure — it would hand a connector
 * result back typed as a product ID map.
 *
 * Deliberately absent versus the product ledger: `removedTradeSlugs`,
 * `staleSupabaseIds` and `affectedProducts`. None has a connector analogue, and the
 * last one matters — carrying it would let a replay call `recomputeProductCounts` and
 * quietly violate §13.5. The shape enforces the rule so no call site has to remember it.
 */
export type ConnectorJobLedger = {
  v: 1;
  kind: 'connector';
  response: PromoteConnectorPageResponse;
  wrote: boolean;
  /** Stored WITH the planner's counts; only the shared `source` facet is re-applied on
   *  replay, so a replayed page forwards the same summary the original committed. */
  auditEntries: AuditLogEntry[];
};

function parseConnectorLedger(stored: unknown): ConnectorJobLedger | null {
  if (!stored || typeof stored !== 'object') return null;
  const c = stored as Partial<ConnectorJobLedger>;
  if (c.v !== 1 || c.kind !== 'connector' || !c.response) return null;
  return {
    v: 1,
    kind: 'connector',
    response: c.response,
    wrote: c.wrote ?? false,
    auditEntries: c.auditEntries ?? [],
  };
}

function replayConnectorJob(
  dbCtx: DbContext,
  jobId: string,
  stored: unknown,
): ConnectorIngestResult {
  const ledger = parseConnectorLedger(stored);
  if (!ledger) {
    // The commit HAPPENED; we simply cannot describe it. Re-planning would be safe here
    // in a way it is not for the product arm (every statement is an upsert), but
    // returning a wrong-shaped result would not — so fail loudly and let the operator
    // simply re-send the page under a fresh job id.
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      `Connector page job "${jobId}" has already committed, but its stored result is ` +
        `unreadable. The rows ARE live. Re-sending the page under a NEW job id is safe — ` +
        `every statement is an idempotent upsert.`,
    );
  }
  return {
    response: ledger.response,
    wrote: ledger.wrote,
    bookmark: dbCtx.getBookmark(),
    auditEntries: ledger.auditEntries.map(withAuditMeta),
  };
}

/**
 * Commit one page of one catalogue.
 *
 * Mirrors `runPromoteIngest`'s structure exactly, minus everything a connector page has
 * no analogue for: plan (no writes) → ledger row FIRST → audit rows LAST → one
 * `db.batch`. The ledger insert leads for the AECI-571 reason, unchanged: a replayed
 * step trips the primary key, the whole batch rolls back, and the recorded result is
 * returned instead of committing twice.
 */
export async function runConnectorCatalogIngest(
  rc: PromoteRunCtx,
  page: PromoteConnectorPagePayload,
  deps: PromoteIngestDeps = {},
  opts: { jobId?: string } = {},
): Promise<ConnectorIngestResult> {
  const dbFor = deps.dbFor ?? getDb;
  // `'first-primary'`, for the same reason the product ingest anchors there: the plan's
  // change detection reads before it writes, and a lagging replica would report a
  // changed row as unchanged — silently dropping the write.
  const dbCtx = dbFor(rc.env, { bookmark: null, constraint: 'first-primary' });
  const { db } = dbCtx;

  if (opts.jobId) {
    const prior = await db.query.promoteJobs.findFirst({
      where: eq(promoteJobs.jobId, opts.jobId),
    });
    if (prior) return replayConnectorJob(dbCtx, opts.jobId, prior.result);
  }

  const plan = await planConnectorCatalogPage(db, page);
  const auditEntries = plan.audits.map(withAuditMeta);

  const response: PromoteConnectorPageResponse = {
    kind: 'connector',
    catalogId: page.catalog.id,
    page: page.page,
    counts: plan.counts,
    skipped: plan.skipped,
  };

  const stmts: BatchStmt[] = [...plan.statements];
  // §26.1: the audit row rides the SAME batch as the mutation it describes.
  for (const entry of auditEntries) stmts.push(auditInsert(db, entry));

  if (opts.jobId) {
    const ledger: ConnectorJobLedger = {
      v: 1,
      kind: 'connector',
      response,
      wrote: plan.wrote,
      auditEntries: plan.audits,
    };
    // FIRST in the batch, and never with `ON CONFLICT DO NOTHING` — the primary-key
    // violation IS the replay guard (AECI-571). `promote_jobs` has no foreign keys, so
    // leading with it does not disturb the ordering the rest of the batch depends on.
    stmts.unshift(db.insert(promoteJobs).values({ jobId: opts.jobId, result: ledger }));
  }

  if (stmts.length) {
    try {
      await db.batch(stmts as BatchTuple);
    } catch (err) {
      if (opts.jobId && isPromoteJobDuplicate(err)) {
        const prior = await db.query.promoteJobs.findFirst({
          where: eq(promoteJobs.jobId, opts.jobId),
        });
        // An unreadable-but-present ledger means the page already committed; falling
        // through to a re-plan would be safe but would report the wrong counts.
        if (!prior) throw err;
        return replayConnectorJob(dbCtx, opts.jobId, prior.result);
      }
      throw err;
    }
  }

  return { response, wrote: plan.wrote, bookmark: dbCtx.getBookmark(), auditEntries };
}

/**
 * The post-commit tail. **Two hooks, against the product arm's seven** — and the
 * absences are the point, so each is argued rather than simply omitted:
 *
 *   - **No Algolia sync.** `syncPromoteTargets` iterates vendors/product/integrations,
 *     of which a connector page has none. The only signal it could move is
 *     `integration_count`, which §13.5 schedules into AECI-721 so the numbers move once.
 *   - **No IndexNow ping.** No public URL's content changes — AECI-715
 *     and AECI-716 are unbuilt. Pinging a search engine about 3,573 stubs' worth of
 *     no-change is crawl-budget vandalism.
 *   - **No home-stats refresh.** Refuted by spec rather than by inference (§13.5), and
 *     it would repaint an unchanged home page on every page of a 30-page sync.
 *   - **No cache purge, today.** A positive statement, not an omission: no cacheable
 *     route's output depends on these rows yet. When §13.7's summary line ships, the
 *     tag set is `product:{connectorSlug}` plus `product:{slug}` for each endpoint whose
 *     reachable count moved — and never `pair:*`, which §13.7 forbids enumerating, nor
 *     `sitemap`, since reachable pairs create no URLs. That obligation belongs to
 *     AECI-715/716 and is named here so it is inherited rather than rediscovered.
 *
 * What does apply: the §26.5 audit forward, and the skip report — which on a
 * full-mirror sync is the only thing that distinguishes "synced cleanly" from "synced
 * with 200 mappings dropped", since both return `status: 'complete'`.
 */
export function dispatchConnectorHooks(rc: PromoteRunCtx, result: ConnectorIngestResult): void {
  // One batched request for N entries, per the AECI-666 connection-budget rule.
  logBatchToPosthog(rc, rc.env, rc.request, result.auditEntries.map(auditLogEvent));
  logPromoteSkips(rc, result.response.skipped);
}
