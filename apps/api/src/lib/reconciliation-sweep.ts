/**
 * Request→Linear reconciliation sweep (AECI-214 / Phase 6.7) — the guaranteed
 * backstop behind `STAGE_1_PHASE_6_SPEC.md` §6.2/§6.4.
 *
 * On submit, `createLinearIssueForRequest()` (§6.4 / AECI-211) tries **once** to
 * create the Linear issue in `ctx.waitUntil()`. It never throws: on any failure
 * the `vendor_requests` row simply stays `open` / `linear_issue_id = null`. This
 * sweep is what makes that safe — a scheduled job (every 15 min, via the ADR-0013
 * cron→queue→consumer) that:
 *
 *   1. finds `open` requests with `linear_issue_id = null` older than
 *      `RECONCILE_STUCK_MINUTES`, and
 *   2. **retries §6.4 by re-invoking the same idempotent
 *      `createLinearIssueForRequest()`** (its read-guard + compare-and-set persist
 *      mean a re-fire never double-creates — §6.4's "Idempotent"), then
 *   3. for any request still failing AND older than `RECONCILE_PERSISTENT_MINUTES`,
 *      raises the §6.2 admin alert: a high-severity Datadog error log +
 *      `aeci.linear.reconcile.persistent_failure` count (the Datadog alert a
 *      monitor pages on) and the `sendAdminAlert()` email seam.
 *
 * Stateless + age-based — no attempt-counter column, no migration (consistent with
 * ADR 0013's "no DLQ; the cadence re-runs"). The two thresholds separate "retry
 * promptly" from "only alert once it's been failing a while," so a request that
 * merely missed its first on-submit attempt isn't alerted on.
 */

import type { RequestKind, RequestTargetType } from '@aeci/shared';

import {
  sendAdminAlert,
  type AdminAlert,
  type AlertContext,
  type StuckRequestSummary,
} from './admin-alert';
import { createLinearIssueForRequest, type LinearPersistClient } from './linear';
import { logToDatadog, submitCount, submitGauge } from '../datadog';

const MINUTE_MS = 60_000;

/** A row open/unlinked older than this is **retried**. Matches the every-15-min
 *  cron cadence: a request whose on-submit creation failed is retried within ~15m. */
export const RECONCILE_STUCK_MINUTES = 15;

/** A row still failing AND older than this is **alerted on** (§6.2 admin alert).
 *  Longer than the retry threshold so a few sweeps elapse before we page. */
export const RECONCILE_PERSISTENT_MINUTES = 60;

/** Most stuck rows reconciled per sweep. A backstop bound — at the 15-min cadence
 *  the next tick continues the backlog; the sweep logs a warn when it caps (no
 *  silent truncation). */
export const RECONCILE_BATCH_CAP = 50;

// ─── Structural Prisma surface ───────────────────────────────────────────────
// Same loose-structural approach as `routes/requests.ts` / `scheduled.ts`: we
// touch a known slice of the generated client and type it structurally. A real
// accelerated client and the test fake both satisfy this. The slice is a superset
// of `LinearPersistClient` (the retry casts to it), plus the read delegates the
// sweep needs to find stuck rows and rebuild the §6.4 input.

type StuckRow = {
  id: string;
  kind: RequestKind;
  targetType: RequestTargetType;
  targetId: string;
  submitterEmail: string;
  submitterName: string | null;
  submitterRole: string | null;
  body: string;
  sourceUrl: string | null;
  domainMatch: string;
  createdAt: Date;
};

type FindUniqueById = (args: {
  where: { id: string };
  select: Record<string, boolean>;
}) => Promise<Record<string, unknown> | null>;

export type ReconcilePrisma = {
  vendorRequest: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
      take?: number;
      select?: Record<string, boolean>;
    }): Promise<Array<Record<string, unknown>>>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
  product: { findUnique: FindUniqueById };
  vendor: { findUnique: FindUniqueById };
  workflowInstance: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }): Promise<{ id: string } | null>;
  };
};

// ─── Dependencies (injected for tests) ───────────────────────────────────────

export interface ReconcileDeps {
  /** The §6.4 retrier. Injected so the sweep's tests can drive cleared/failing
   *  outcomes without a real Linear transport. */
  createIssue?: typeof createLinearIssueForRequest;
  /** The §6.2 admin-alert email seam. Injected so tests can assert it fires on a
   *  persistent failure (the issue's "persistent failure emails" criterion). */
  sendAlert?: typeof sendAdminAlert;
  /** `now` for deterministic age math (mirrors `runDailySync(…, new Date())`). */
  now?: Date;
}

export interface ReconcileResult {
  /** True backlog size — all stuck rows past the threshold (the
   *  `aeci.linear.reconcile.stuck` gauge), which may exceed the per-sweep
   *  `RECONCILE_BATCH_CAP`. The retried/cleared/stillFailing counts below cover
   *  only the rows actually processed this sweep. */
  stuck: number;
  /** Rows we could rebuild + retried (resolved target + workflow). */
  retried: number;
  /** Rows linked after the retry. */
  cleared: number;
  /** Rows still `linear_issue_id = null` after the retry (includes un-rebuildable). */
  stillFailing: number;
  /** Still-failing rows older than `RECONCILE_PERSISTENT_MINUTES`. */
  persistent: number;
  /** Whether the admin-alert seam was invoked. */
  alerted: boolean;
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/**
 * Run one reconciliation pass. Unexpected throws (a Prisma/Accelerate read
 * failure on the initial query or the re-read) propagate to the queue consumer,
 * which `retry()`s — the whole sweep re-runs and `createLinearIssueForRequest`'s
 * idempotency makes that safe. Per-row errors are caught (logged + skipped) so one
 * bad row never aborts the batch.
 */
export async function runReconciliationSweep(
  c: AlertContext,
  prisma: ReconcilePrisma,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  const createIssue = deps.createIssue ?? createLinearIssueForRequest;
  const sendAlert = deps.sendAlert ?? sendAdminAlert;
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  const stuckCutoff = new Date(nowMs - RECONCILE_STUCK_MINUTES * MINUTE_MS);
  // One predicate, used by both the batched fetch and the unbounded backlog count,
  // so the two can't drift.
  const stuckWhere = { status: 'open', linearIssueId: null, createdAt: { lt: stuckCutoff } };

  const stuckRows = (await prisma.vendorRequest.findMany({
    where: stuckWhere,
    orderBy: { createdAt: 'asc' },
    take: RECONCILE_BATCH_CAP,
    select: {
      id: true,
      kind: true,
      targetType: true,
      targetId: true,
      submitterEmail: true,
      submitterName: true,
      submitterRole: true,
      body: true,
      sourceUrl: true,
      domainMatch: true,
      createdAt: true,
    },
  })) as unknown as StuckRow[];

  // The gauge is the TRUE backlog, not this sweep's batch. `findMany` caps at
  // RECONCILE_BATCH_CAP, so when the cap is hit the real backlog may be larger —
  // count it (unbounded) rather than reporting a clamped cap that would plateau an
  // operator's "backlog size" view mid-incident. Below the cap the fetched rows ARE
  // the whole backlog, so skip the extra query. Always emit it (0 on a clean run)
  // so a no-data monitor can tell "ran clean" from "didn't run" (mirrors index-drift).
  const backlog =
    stuckRows.length < RECONCILE_BATCH_CAP
      ? stuckRows.length
      : await prisma.vendorRequest.count({ where: stuckWhere });
  gauge(c, 'aeci.linear.reconcile.stuck', backlog);

  if (stuckRows.length === 0) {
    log(c, { level: 'info', message: 'aeci.linear.reconcile: no stuck requests' });
    return { stuck: 0, retried: 0, cleared: 0, stillFailing: 0, persistent: 0, alerted: false };
  }
  if (stuckRows.length === RECONCILE_BATCH_CAP) {
    log(c, {
      level: 'warn',
      message: `aeci.linear.reconcile: sweep hit the ${RECONCILE_BATCH_CAP}-row cap — ${backlog} stuck total; the next tick continues`,
    });
  }

  // Retry each, remembering the resolved target name for the alert digest.
  const targetNames = new Map<string, string | null>();
  let retried = 0;
  for (const row of stuckRows) {
    try {
      const target = await resolveTargetById(prisma, row.targetType, row.targetId);
      targetNames.set(row.id, target?.name ?? null);
      const workflow = await prisma.workflowInstance.findFirst({
        where: { entityId: row.id },
        select: { id: true },
      });
      if (!target || !workflow) {
        // Can't rebuild the §6.4 input (target row gone, or no workflow instance) —
        // skip; it stays counted as still-failing below.
        log(c, {
          level: 'warn',
          message: `aeci.linear.reconcile: cannot rebuild request ${row.id} (${
            !target ? 'target missing' : 'workflow missing'
          }) — skipping`,
        });
        continue;
      }
      retried++;
      // Idempotent retry of §6.4 — the same function the request handler runs.
      await createIssue(c, prisma as unknown as LinearPersistClient, {
        requestId: row.id,
        workflowId: workflow.id,
        kind: row.kind,
        targetType: row.targetType,
        targetName: target.name,
        slug: target.slug,
        submitterEmail: row.submitterEmail,
        submitterName: row.submitterName,
        submitterRole: row.submitterRole,
        body: row.body,
        sourceUrl: row.sourceUrl,
        domainMatch: row.domainMatch,
      });
    } catch (error) {
      // A per-row read error must not abort the rest of the batch.
      if (!targetNames.has(row.id)) targetNames.set(row.id, null);
      log(c, {
        level: 'warn',
        message: `aeci.linear.reconcile: retry for request ${row.id} errored: ${errMsg(error)}`,
      });
    }
  }

  // Re-read which swept rows are STILL unlinked — those are this round's failures
  // (createLinearIssueForRequest links by compare-and-set on success).
  const sweptIds = stuckRows.map((r) => r.id);
  const stillFailingIds = new Set(
    (
      (await prisma.vendorRequest.findMany({
        where: { id: { in: sweptIds }, linearIssueId: null },
        select: { id: true },
      })) as unknown as Array<{ id: string }>
    ).map((r) => r.id),
  );

  const cleared = sweptIds.length - stillFailingIds.size;
  const stillFailing = stillFailingIds.size;
  if (cleared > 0) count(c, 'aeci.linear.reconcile.attempt', cleared, ['outcome:cleared']);
  if (stillFailing > 0) {
    count(c, 'aeci.linear.reconcile.attempt', stillFailing, ['outcome:still_failing']);
  }

  // Persistent failures: still unlinked AND older than the persistent threshold.
  const persistentCutoffMs = nowMs - RECONCILE_PERSISTENT_MINUTES * MINUTE_MS;
  const persistentRows: StuckRequestSummary[] = stuckRows
    .filter((r) => stillFailingIds.has(r.id) && r.createdAt.getTime() < persistentCutoffMs)
    .map((r) => ({
      requestId: r.id,
      kind: r.kind,
      targetType: r.targetType,
      targetName: targetNames.get(r.id) ?? null,
      ageMinutes: Math.floor((nowMs - r.createdAt.getTime()) / MINUTE_MS),
    }));

  let alerted = false;
  if (persistentRows.length > 0) {
    // The Datadog alert: a count a monitor pages on + a high-severity log.
    count(c, 'aeci.linear.reconcile.persistent_failure', persistentRows.length, []);
    log(c, {
      level: 'error',
      message: `aeci.linear.reconcile.persistent_failure: ${persistentRows.length} request(s) stuck >${RECONCILE_PERSISTENT_MINUTES}m and still failing — Linear issue creation is not recovering`,
      request_ids: persistentRows.map((r) => r.requestId),
    });
    const alert: AdminAlert = { kind: 'stuck_requests', rows: persistentRows };
    await sendAlert(c, alert);
    alerted = true;
  }

  log(c, {
    level: stillFailing > 0 ? 'warn' : 'info',
    message: `aeci.linear.reconcile: stuck=${backlog} retried=${retried} cleared=${cleared} still_failing=${stillFailing} persistent=${persistentRows.length}`,
  });

  return {
    stuck: backlog,
    retried,
    cleared,
    stillFailing,
    persistent: persistentRows.length,
    alerted,
  };
}

/**
 * Resolve a `vendor_requests.target_id` back to its display name + slug — the
 * reverse of `routes/requests.ts`'s `resolveTarget` (which goes slug → id/name).
 * Products carry `name`, vendors `company_name`. `null` if the target row is gone.
 */
async function resolveTargetById(
  prisma: ReconcilePrisma,
  targetType: RequestTargetType,
  targetId: string,
): Promise<{ name: string; slug: string } | null> {
  if (targetType === 'product') {
    const row = (await prisma.product.findUnique({
      where: { id: targetId },
      select: { name: true, slug: true },
    })) as { name: string; slug: string } | null;
    return row ? { name: row.name, slug: row.slug } : null;
  }
  const row = (await prisma.vendor.findUnique({
    where: { id: targetId },
    select: { companyName: true, slug: true },
  })) as { companyName: string; slug: string } | null;
  return row ? { name: row.companyName, slug: row.slug } : null;
}

// ─── Telemetry (wrapped so it never breaks the sweep) ─────────────────────────

function gauge(c: AlertContext, metric: string, value: number): void {
  try {
    submitGauge(c.executionCtx, c.env, c.req.raw, metric, value, []);
  } catch {
    // Telemetry must never break the sweep.
  }
}

function count(c: AlertContext, metric: string, value: number, tags: string[]): void {
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, metric, value, tags);
  } catch {
    // Telemetry must never break the sweep.
  }
}

function log(
  c: AlertContext,
  entry: { level: 'info' | 'warn' | 'error'; message: string } & Record<string, unknown>,
): void {
  try {
    logToDatadog(c.executionCtx, c.env, c.req.raw, { source: 'reconcile', ...entry });
  } catch {
    console[entry.level === 'error' ? 'error' : 'warn'](`reconcile: ${entry.message}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
