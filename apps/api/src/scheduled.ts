/**
 * Scheduled-job entrypoints for the API Worker (AECI-139 / Phase 3.6 + AECI-140 /
 * Phase 3.7). Two handlers, deliberately split:
 *
 *   • `scheduled` — the cron trigger. It does NOT run the work; it only enqueues
 *     a `ScheduledJobMessage` onto the matching Cloudflare Queue (`enqueueOrRun`).
 *   • `queue` — the consumer. It receives the message and runs the actual job.
 *
 * This cron→queue→consumer split (ADR 0013) decouples scheduling from execution:
 * the queue gives native retries, and the same queue can be fed by a future
 * manual/REST producer to force a run on demand. Both queues are bound per-env in
 * `wrangler.jsonc` (staging + production only — NOT base config / preview, so PR
 * previews carry no queues and run no daily jobs). On an env without the binding
 * (local `wrangler dev`, preview), `enqueueOrRun` runs the job inline so a
 * `--test-scheduled` tick is never silently dropped.
 *
 * Cron triggers (`wrangler.jsonc`), staging + production:
 * 02:00 UTC **Mondays** — the weekly §7.6 `asn_registry` refresh
 * (`./lib/asn-registry`, AECI-624): one PeeringDB read (authenticated when
 * `PEERINGDB_API_KEY` is set — anonymous reads are throttled, AECI-661),
 * intersected with the ASNs `page_views` has actually seen, upserted for the
 * admin panel's read-time annotation. The only weekly trigger, and the only job
 * whose output is an annotation rather than a measurement — it never writes
 * `page_views.is_bot` and never deletes a row, so a failed week leaves the last
 * good registry in place (visibly stale via `fetched_at`).
 * 03:00 UTC — daily §7.4 retention prune (`./lib/retention-prune`, AECI-584 /
 * Phase 8.3 P3.2): delete `page_views` older than 400 days and `job_runs` older
 * than 90, in bounded chunks, committing every chunk together with ONE summary
 * `audit_log` row (the ADR 0022 exception — the only cron here that audits).
 * Runs after the 00:15 snapshot, and *verifies* rather than assumes it landed:
 * a day inside the cut window with no `metrics_daily` row aborts the whole run.
 * 04:00 UTC — daily §23.1 data-quality suite (`./lib/data-quality`, AECI-241 /
 * Phase 7.6): ten read-only integrity checks (orphan products/vendors, stale
 * `ready` products, broken integration refs, anonymized-review integrity, stale
 * `stats_cache`, duplicate candidates, a Brandfetch logo-404 sample, and the
 * reused AECI-140 Algolia drift) → an email digest to Chris + Bill via Resend
 * (`./lib/email`). Report-only — no auto-remediation; humans triage.
 * 07:00 UTC (= 02:00 EST) — daily home-stats compute (`./lib/home-stats`,
 * AECI-178 / Phase 4.3 / §10): recompute the seven `home.*` `stats_cache` keys
 * and upsert each. Runs before the Algolia sync so a fresh stats row is ready at
 * the start of the US morning. Per-key best-effort (one key failing doesn't abort
 * the rest); empty `page_views` → empty `trending_products`.
 * 08:00 UTC (= 03:00 EST) — incremental Algolia sync (`./lib/algolia-sync`,
 * AECI-139): push rows changed since the stored watermark to the env's three
 * indexes, removing `retracted`/`rejected` records. A full reindex is the same
 * `indexEntity` over all rows (the Node-Prisma bulk CLI was retired under D1 —
 * ADR 0016; a Worker-triggered full sweep is the follow-up).
 * 09:00 UTC (= 04:00 EST) — Algolia ↔ D1 index-drift reconciliation + orphan
 * sweep (`./lib/algolia-drift` + `./lib/algolia-orphans`, AECI-140 / AECI-266 /
 * §23.1): compare promoted-row counts to Algolia object counts per entity and emit
 * the `aeci.algolia.index_drift` gauge (the Datadog-monitored alert), THEN heal the
 * negative-drift case — sweep orphan objects (in the index, no promoted D1 row) the
 * incremental sync can't see to delete. The sweep is delete-only + safety-capped;
 * positive drift (records MISSING from the index) stays repaired by the 08:00 sync.
 * Every 15 minutes (the one sub-hourly trigger; see `RECONCILE_CRON`) —
 * request→Linear reconciliation sweep (`./lib/reconciliation-sweep`, AECI-214 /
 * Phase 6.7 / §6.2/§6.4): retry `vendor_requests` stuck
 * `open`/`linear_issue_id=null` (their §6.4 on-submit issue creation failed), and
 * on a persistent failure raise the §6.2 admin alert. A tight backstop, not a
 * daily batch.
 * Every hour at :00 (`WAF_CRON`) — WAF firewall-event poll (`./lib/waf-metrics` +
 * `@aeci/shared/cloudflare-analytics`, AECI-262 / §15.1): read the previous clock
 * hour of `firewallEventsAdaptiveGroups` from Cloudflare's GraphQL Analytics API
 * (the free Pro-plan alternative to Enterprise Logpush) and emit the
 * `aeci.waf.ratelimit.blocked` count. Queue-less like the moderation snapshot (a
 * cheap read-only poll), scoped to this env's own host so the shared zone isn't
 * counted under each `env:` tag.
 *
 * Best-effort + observable: the work is **awaited** in the consumer (so a failure
 * is logged and the run isn't torn down mid-batch), while metric/log emission
 * rides `ctx.waitUntil` via the shared Datadog client. The job has no incoming
 * `Request`, so a synthetic one is passed to the Datadog helpers (used only to
 * derive the `host` tag, which falls back to the worker slug).
 */

import { fetchWafFirewallEvents } from '@aeci/shared/cloudflare-analytics';
import { and, asc, count, eq, inArray } from 'drizzle-orm';

import { getDb } from './db/client';
import type { Db } from './db/client';
import { integrations, products, reviews, vendors } from './db/schema';
import { logToDatadog, submitCount, submitDistribution, submitGauge } from './datadog';
import { forwardAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import type { ScheduledJob, ScheduledJobMessage, ScheduledJobMessageInput, Env } from './env';
import {
  createAlgoliaCounter,
  reportAlgoliaDrift,
  type AlgoliaIndexDrift,
} from './lib/algolia-drift';
import { algoliaEnvFor, createDriftRunner, drizzleDriftCounter } from './lib/algolia-drift-deps';
import { runDailySync } from './lib/algolia-sync';
import {
  createAlgoliaDeleteClient,
  createAlgoliaObjectIdClient,
  DEFAULT_SAFETY_CAP,
  sweepAlgoliaOrphans,
  type EntityOrphanResult,
  type PromotedIdProvider,
} from './lib/algolia-orphans';
import {
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  dailyWindows,
  type DigestWindow,
} from './lib/analytics-digest';
import { refreshAsnRegistry } from './lib/asn-registry';
import { fetchPosthogTraffic, publicHostOf, type PosthogQueryOutcome } from './lib/posthog-query';
import { detectSwarms, NON_BROWSER_VERDICTS, swarmNote } from './lib/swarm-detection';
import {
  ADMIN_CRON_JOB,
  ALGOLIA_DRIFT_CRON,
  ALGOLIA_SYNC_CRON,
  ANALYTICS_CRON,
  ASN_REGISTRY_CRON,
  DATA_QUALITY_CRON,
  MODERATION_CRON,
  RECONCILE_CRON,
  RETENTION_CRON,
  SNAPSHOT_CRON,
  STATS_CRON,
  WAF_CRON,
} from './lib/cron-schedules';
import { hasErrors, runDataQualityChecks, type DataQualityCheckResult } from './lib/data-quality';
import { buildDataQualityDigest } from './lib/data-quality-email';
import { parseRecipients, sendEmail } from './lib/email';
import { emitAlgoliaSyncMetrics, type SyncMetricSink } from './lib/algolia-sync-metrics';
import { runHomeStats, type HomeStatsResult } from './lib/home-stats';
import { emitHomeStatsMetrics, jobOutcome } from './lib/home-stats-metrics';
import { shiftDay } from './lib/admin-analytics';
import {
  emitMetricsSnapshotMetrics,
  runMetricsSnapshot,
  type MetricsSnapshotResult,
  type SnapshotMetricSink,
} from './lib/metrics-snapshot';
import {
  toOrphanSweepEntity,
  withJobRun,
  type DriftReportDetail,
  type JobRunReport,
  type JobRunSink,
  type OrphanSweepDetail,
} from './lib/job-runs';
import {
  emitModerationQueueMetrics,
  oldestPendingAgeHours,
  type ModerationMetricSink,
} from './lib/moderation-metrics';
import { runReconciliationSweep } from './lib/reconciliation-sweep';
import {
  emitRetentionPruneMetrics,
  resolveRetentionWindows,
  runRetentionPrune,
  RETENTION_RUN_METRIC,
  type RetentionMetricSink,
} from './lib/retention-prune';
import { emitWafEventMetrics, previousHourWindow } from './lib/waf-metrics';

/**
 * D1 client for cron/queue jobs (AECI-250). Background jobs have no user latency
 * to optimize, so they anchor the D1 session at `'first-primary'` — preserving the
 * pre-Sessions-API strongly-consistent reads (the plain binding always hit the
 * primary) rather than the `'first-unconstrained'` replica default the request
 * read-paths use for the edge-latency win. Several of these jobs are
 * read-modify-write (home-stats, reconcile), where a stale first read would be
 * wrong; the rest lose nothing by reading the primary.
 */
function cronDb(env: Env) {
  return getDb(env, { constraint: 'first-primary' });
}

/**
 * D1 client for the §7.2 `job_runs` bookkeeping row (AECI-583).
 *
 * Unlike every other `cronDb` caller this one must NOT fail loud: `getDb` throws
 * when the `DB` binding is absent, and a bookkeeping row is not worth taking down
 * a job that needs no database at all (the WAF poll; both Algolia halves of the
 * drift job). A `null` here degrades to "no row" and the job runs uninstrumented.
 */
function jobRunDb(env: Env) {
  try {
    return cronDb(env).db;
  } catch {
    return null;
  }
}

/**
 * Datadog sink for the bookkeeping writes themselves. Emitted on success too:
 * without an always-on series, a silently-broken writer is indistinguishable from
 * "no crons ran", which is exactly the confusion §5.6 exists to remove. A failure
 * here means the admin panel's cron liveness under-reports — the JOB is
 * unaffected. See docs/OBSERVABILITY.md.
 */
function jobRunSink(ctx: ExecutionContext, env: Env): JobRunSink {
  const req = cronRequest('/cron/job-runs');
  return (event) => {
    submitCount(ctx, env, req, JOB_RUN_WRITE_METRIC, 1, [
      `phase:${event.phase}`,
      `job:${event.job}`,
      `outcome:${event.outcome}`,
    ]);
    if (event.outcome === 'failed') {
      logToDatadog(ctx, env, req, {
        level: 'error',
        message: 'aeci.job_runs.write_failed',
        source: 'job-runs',
        job: event.job,
        phase: event.phase,
        reason: event.reason,
      });
    }
  };
}

// The ten cron expressions now live in `./lib/cron-schedules` — hoisted there
// by AECI-580 (the snapshot cron joined them in AECI-581) so `GET /api/admin/system`'s
// liveness rows read the SAME literals this dispatcher `switch`es on rather than a
// second copy that could drift. Each one MUST still stay byte-equal to its
// `triggers.crons` entry in `wrangler.jsonc`, or `controller.cron` won't match the
// `switch` below; see that file for the per-job scheduling rationale (including why
// `SNAPSHOT_CRON` runs at 00:15, the first slot of the day).

/** The gauge a Datadog monitor alerts on (see docs/OBSERVABILITY.md). */
const DRIFT_METRIC = 'aeci.algolia.index_drift';

/** Orphan-sweep gauges (AECI-266): objects removed per entity (0 on a clean run)
 *  and — when the safety cap blocks an unexpectedly large purge — the count it
 *  refused (so a monitor can page an operator). See docs/OBSERVABILITY.md. */
const ORPHANS_REMOVED_METRIC = 'aeci.algolia.orphans_removed';
const ORPHANS_SKIPPED_CAP_METRIC = 'aeci.algolia.orphans_skipped_cap';

/** `promotion_status` value marking a row live (the value `POST /api/promote`
 *  writes). The orphan sweep's authoritative-membership filter. */
const PROMOTED = 'promoted';

/** Metric names for the daily data-quality job (AECI-241; see docs/OBSERVABILITY.md). */
const DQ_JOB_METRIC = 'aeci.data_quality.job';
const DQ_DURATION_METRIC = 'aeci.data_quality.job.duration_ms';
const DQ_CHECK_METRIC = 'aeci.data_quality.check';
const DQ_EMAIL_METRIC = 'aeci.data_quality.email';

/** Metric for the daily analytics digest (AECI-526). One count per run tagged
 *  `outcome:sent|skipped|failed`; the always-emitted count doubles as the cron
 *  liveness signal (see docs/OBSERVABILITY.md). */
const ANALYTICS_EMAIL_METRIC = 'aeci.analytics_digest.email';

/** Per-run heartbeat for the WAF firewall-event poll (AECI-262). One count per
 *  run with `outcome:ok|failed|skipped_no_creds` — the always-emitted `outcome:ok`
 *  series doubles as the cron-liveness signal (see docs/OBSERVABILITY.md). */
const WAF_POLL_METRIC = 'aeci.waf.poll';

/** Per-run heartbeat for the weekly `asn_registry` refresh (AECI-624), tagged
 *  `outcome:ok|partial|failed|skipped`, and the coverage gauge beside it: the
 *  fraction of seen ASNs the registry can classify. Coverage is what silently
 *  decays between runs as new ASNs arrive, so it gets its own series rather than
 *  living only in the `job_runs` payload (see docs/OBSERVABILITY.md). */
const ASN_REGISTRY_METRIC = 'aeci.asn_registry.refresh';
const ASN_REGISTRY_COVERAGE_METRIC = 'aeci.asn_registry.coverage';

/** Outcome of a §7.2 `job_runs` bookkeeping write (AECI-583), tagged
 *  `phase:start|finish`, `job:<AdminCronJob>`, `outcome:ok|failed`. This measures
 *  the RECORDER, not the job — see docs/OBSERVABILITY.md. */
const JOB_RUN_WRITE_METRIC = 'aeci.job_runs.write';

/** Synthetic request so the Datadog helpers can derive a `host` tag (the cron
 *  has no incoming Request; `hostnameFromRequest` uses the URL host or falls
 *  back to the worker slug). */
function cronRequest(path: string): Request {
  return new Request(`https://aeci-api${path}`);
}

/** A Drizzle-backed `PromotedIdProvider` (the orphan sweep's injected
 *  authoritative-membership id-sets). Returns the promoted product/vendor ids and
 *  the integration ids whose BOTH endpoints are promoted — the same membership
 *  `drizzleDriftCounter` counts and `algolia-sync` indexes on, but as id SETS (no
 *  transforms). algolia-orphans stays ORM-agnostic; only this adapter knows D1. */
function drizzlePromotedIds(env: Env): PromotedIdProvider {
  const { db } = cronDb(env);
  return {
    productIds: async () =>
      new Set(
        (
          await db
            .select({ id: products.id })
            .from(products)
            .where(eq(products.promotionStatus, PROMOTED))
        ).map((r) => r.id),
      ),
    vendorIds: async () =>
      new Set(
        (
          await db
            .select({ id: vendors.id })
            .from(vendors)
            .where(eq(vendors.promotionStatus, PROMOTED))
        ).map((r) => r.id),
      ),
    integrationIds: async () => {
      const promoted = db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.promotionStatus, PROMOTED));
      const rows = await db
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          and(
            inArray(integrations.sourceProductId, promoted),
            inArray(integrations.targetProductId, promoted),
          ),
        );
      return new Set(rows.map((r) => r.id));
    },
  };
}

/** Adapt the shared Datadog submitters into the pure metrics modules' sink, so
 *  `emitAlgoliaSyncMetrics` / `emitHomeStatsMetrics` / `emitModerationQueueMetrics`
 *  / `emitMetricsSnapshotMetrics` / `emitRetentionPruneMetrics` stay free of
 *  `ctx`/`env`/`Request` plumbing. The count + distribution + gauge shape
 *  satisfies `SyncMetricSink` / `StatsMetricSink` / `SnapshotMetricSink` /
 *  `RetentionMetricSink` (count + distribution) and `ModerationMetricSink`
 *  (gauge) alike. */
function metricSink(
  ctx: ExecutionContext,
  env: Env,
  req: Request,
): SyncMetricSink & ModerationMetricSink & SnapshotMetricSink & RetentionMetricSink {
  return {
    count: (metric, value, tags) => submitCount(ctx, env, req, metric, value, tags),
    distribution: (metric, value, tags) => submitDistribution(ctx, env, req, metric, value, tags),
    gauge: (metric, value, tags) => submitGauge(ctx, env, req, metric, value, tags),
  };
}

async function runAlgoliaSync(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/algolia-sync');
  const creds = { appId: env.ALGOLIA_APP_ID, apiKey: env.ALGOLIA_ADMIN_KEY };

  // Defensive no-op: production deploys are gated on these secrets
  // (verify-worker-secrets.sh), but local/preview may legitimately lack them.
  if (!creds.appId || !creds.apiKey) {
    submitCount(ctx, env, req, 'aeci.algolia.sync', 1, [
      'trigger:cron',
      'entity:all',
      'outcome:skipped_no_creds',
    ]);
    logToDatadog(ctx, env, req, {
      level: 'warn',
      message: 'aeci.algolia.sync.skipped_no_creds',
      source: 'algolia-sync-cron',
    });
    return { outcome: 'skipped', detail: { job: 'algolia-sync', reason: 'no_creds' } };
  }

  const { db } = cronDb(env);

  const started = Date.now();
  let result: Awaited<ReturnType<typeof runDailySync>>;
  try {
    result = await runDailySync(db, fetch, creds, algoliaEnvFor(env), new Date());
  } catch (error) {
    // runDailySync swallows per-entity push failures, but the watermark
    // read/write (D1) can still throw — log loudly, never rethrow
    // (a thrown cron just shows as a failed invocation with no detail). This is
    // a pre-push crash, not a completed run, so it stays inline rather than going
    // through emitAlgoliaSyncMetrics (which is per-entity, completed-run only).
    submitCount(ctx, env, req, 'aeci.algolia.sync', 1, [
      'trigger:cron',
      'entity:all',
      'outcome:failed',
    ]);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.algolia.sync.crashed',
      source: 'algolia-sync-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'failed',
      detail: {
        job: 'algolia-sync',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const durationMs = Date.now() - started;

  // Per-entity outcome + records counts and the run-level duration distribution
  // (AECI-141). Shared with the promote hook so the two writers can't drift.
  emitAlgoliaSyncMetrics(metricSink(ctx, env, req), 'cron', result.entities, durationMs);

  for (const entity of result.entities) {
    logToDatadog(ctx, env, req, {
      level: entity.ok ? 'info' : 'error',
      message: `aeci.algolia.sync ${entity.entity} saved=${entity.saved} deleted=${entity.deleted}`,
      source: 'algolia-sync-cron',
      entity: entity.entity,
      saved: entity.saved,
      deleted: entity.deleted,
      transform_errors: entity.transformErrors,
      ...(entity.ok ? {} : { reason: entity.error }),
    });
  }

  // `runDailySync` swallows per-entity push failures, so a run where an entity
  // errored still returns normally. Record it as `failed` — `emitAlgoliaSyncMetrics`
  // already tagged that entity `outcome:failed`, and the panel must never claim
  // more success than Datadog does for the same run.
  return {
    outcome: result.entities.every((e) => e.ok) ? 'ok' : 'failed',
    detail: {
      job: 'algolia-sync',
      durationMs,
      cutoff: result.cutoff,
      entities: result.entities,
    },
  };
}

async function runAlgoliaDrift(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/algolia-drift');

  // Defensive no-op: production deploys are gated on these secrets
  // (verify-worker-secrets.sh), but local/preview may legitimately lack them.
  if (!env.ALGOLIA_APP_ID || !env.ALGOLIA_ADMIN_KEY) {
    logToDatadog(ctx, env, req, {
      level: 'warn',
      message: 'aeci.algolia.index_drift.skipped_no_creds',
      source: 'algolia-drift-cron',
    });
    return { outcome: 'skipped', detail: { job: 'algolia-drift', reason: 'no_creds' } };
  }

  const driftCounter = drizzleDriftCounter(cronDb(env).db);
  const algolia = createAlgoliaCounter(env.ALGOLIA_APP_ID, env.ALGOLIA_ADMIN_KEY);
  const ddEnv = algoliaEnvFor(env);

  // The two halves are recorded independently so a `failed` headline can still
  // say WHICH half failed (§5.6 renders both).
  // Assigned on every path out of each try/catch below.
  let report: DriftReportDetail;
  let sweep: OrphanSweepDetail;

  try {
    const measured: AlgoliaIndexDrift[] = [];
    await reportAlgoliaDrift(
      {
        db: driftCounter,
        algolia,
        // Gauge per entity, always (0 when clean) so a no-data monitor can tell
        // "ran clean" from "didn't run". The same per-entity rows are collected
        // for the §7.2 `detail` payload — one measurement, two recording surfaces.
        emitGauge: (row: AlgoliaIndexDrift) => {
          measured.push(row);
          submitGauge(ctx, env, req, DRIFT_METRIC, row.drift, [
            `entity:${row.entity}`,
            `index:${row.indexName}`,
          ]);
        },
        onDrift: (drifted: AlgoliaIndexDrift[]) =>
          logToDatadog(ctx, env, req, {
            level: 'error',
            message: `aeci.algolia.index_drift on ${ddEnv}: ${drifted
              .map((d) => `${d.indexName} ${d.drift > 0 ? '+' : ''}${d.drift}`)
              .join(
                ', ',
              )} (negative drift = orphans, auto-healed by the sweep below; positive drift = records missing from the index, repaired by the incremental sync)`,
            source: 'algolia-drift-cron',
            drift: drifted,
          }),
      },
      { env: ddEnv },
    );
    report = { ran: true, drifted: measured };
  } catch (error) {
    // The Algolia count (fetch) or the D1 counts can throw; log loudly,
    // never rethrow (a thrown cron just shows as a failed invocation with no
    // detail).
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.algolia.index_drift.crashed',
      source: 'algolia-drift-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    report = { ran: false, reason: error instanceof Error ? error.message : String(error) };
  }

  // Remediation half (AECI-266): the report above MEASURES; this sweep HEALS the
  // negative-drift case (orphan objects with no promoted D1 row — records the
  // incremental sync structurally can't see to delete). It runs AFTER the
  // measurement so the `index_drift` gauge captures the pre-heal state for the
  // monitor; the next day's drift run confirms 0 (we deliberately don't re-measure
  // in-run — that could mask a partial-failure heal or read a mid-propagation
  // replica). `apply:true` is safe because the safety cap (`override:false`)
  // refuses an unexpectedly large purge (e.g. an empty/misconfigured D1 read).
  // Independent try/catch so a drift-report failure doesn't block the heal.
  try {
    const swept = await sweepAlgoliaOrphans(
      {
        ids: drizzlePromotedIds(env),
        browse: createAlgoliaObjectIdClient(env.ALGOLIA_APP_ID, env.ALGOLIA_ADMIN_KEY),
        remove: createAlgoliaDeleteClient({
          appId: env.ALGOLIA_APP_ID,
          apiKey: env.ALGOLIA_ADMIN_KEY,
        }),
        emit: (r: EntityOrphanResult) => {
          submitGauge(ctx, env, req, ORPHANS_REMOVED_METRIC, r.deleted, [
            `entity:${r.entity}`,
            `index:${r.indexName}`,
          ]);
          if (r.skippedBySafetyCap) {
            submitGauge(ctx, env, req, ORPHANS_SKIPPED_CAP_METRIC, r.orphanIds.length, [
              `entity:${r.entity}`,
              `index:${r.indexName}`,
            ]);
          }
        },
      },
      { env: ddEnv, apply: true, safetyCap: DEFAULT_SAFETY_CAP },
    );

    const capped = swept.entities.filter((e) => e.skippedBySafetyCap);
    const failed = swept.entities.filter((e) => !e.ok);
    if (swept.totalDeleted > 0 || capped.length > 0 || failed.length > 0) {
      logToDatadog(ctx, env, req, {
        level: capped.length > 0 || failed.length > 0 ? 'warn' : 'info',
        message: `aeci.algolia.orphans_removed on ${ddEnv}: removed ${swept.totalDeleted} orphan object(s)${
          capped.length > 0
            ? `; ${capped.length} index(es) refused by safety cap (re-run the CLI with --force)`
            : ''
        }${failed.length > 0 ? `; ${failed.length} index(es) errored` : ''}`,
        source: 'algolia-drift-cron',
        sweep: swept.entities,
      });
    }

    // `orphanIds` is dropped — an unbounded id list the log above already carries.
    // The counts are what §5.6 renders (AECI-583); until this shipped the sweep's
    // result reached Datadog and nowhere else.
    sweep = {
      ran: true,
      ok: failed.length === 0,
      totalOrphans: swept.totalOrphans,
      totalDeleted: swept.totalDeleted,
      entities: swept.entities.map(toOrphanSweepEntity),
    };
  } catch (error) {
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.algolia.orphans_sweep.crashed',
      source: 'algolia-drift-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    sweep = { ran: false, reason: error instanceof Error ? error.message : String(error) };
  }

  // Since AECI-266 the heal is half this job's contract and the report is its
  // primary measurement, so EITHER half failing is a failed run. Reporting `ok`
  // when the drift gauge never emitted would be the "reports fine because it has
  // no data" failure the whole §5.6 nullable design exists to prevent; `detail`
  // keeps the halves apart so the screen can say which one broke.
  return {
    outcome: report.ran && sweep.ran && sweep.ok ? 'ok' : 'failed',
    detail: { job: 'algolia-drift', report, sweep },
  };
}

async function runHomeStatsJob(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/stats');
  const { db } = cronDb(env);

  const started = Date.now();
  let result: HomeStatsResult;
  try {
    result = await runHomeStats(db, new Date());
  } catch (error) {
    // `runHomeStats` is per-key best-effort and never throws on a compute/write
    // failure, so reaching here is a pre-compute crash (e.g. a missing DB binding).
    // Log loudly + count an outright failure; never rethrow (a thrown cron is an
    // opaque failed invocation with no detail).
    submitCount(ctx, env, req, 'aeci.stats.compute', 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.stats.compute.crashed',
      source: 'stats-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'failed',
      detail: { job: 'home-stats', reason: error instanceof Error ? error.message : String(error) },
    };
  }

  const written = result.keys.filter((k) => k.status === 'written').length;
  const failed = result.keys.filter((k) => k.status === 'failed').length;
  const skipped = result.keys.filter((k) => k.status === 'skipped').length;

  for (const k of result.keys) {
    logToDatadog(ctx, env, req, {
      level: k.status === 'failed' ? 'error' : 'info',
      message: `aeci.stats.compute ${k.key} status=${k.status}`,
      source: 'stats-cron',
      key: k.key,
      status: k.status,
      ...(k.error ? { reason: k.error } : {}),
    });
  }

  // Job-level + per-key outcome/duration metrics (AECI-180 / 4.5) — the dashboard
  // and the failure + freshness monitors query these. The shared emitter derives
  // the run `outcome` from the per-key statuses so it can't drift from the log.
  const durationMs = Date.now() - started;
  emitHomeStatsMetrics(metricSink(ctx, env, req), 'cron', result, durationMs);
  logToDatadog(ctx, env, req, {
    level: failed > 0 ? 'warn' : 'info',
    message: `aeci.stats.computed keys_written=${written} keys_failed=${failed} keys_skipped=${skipped}`,
    source: 'stats-cron',
    keys_written: written,
    keys_failed: failed,
    keys_skipped: skipped,
  });

  // Derived from the SAME `jobOutcome` the Datadog tag uses, so `job_runs` and the
  // metric cannot grow separate opinions of what a partial run is. §7.2's vocabulary
  // has no `partial`, so it collapses to `failed`: a run that failed to write a
  // `home.*` key must not show the operator a green tick.
  return {
    outcome: jobOutcome(result) === 'success' ? 'ok' : 'failed',
    detail: { job: 'home-stats', durationMs, written, failed, skipped, keys: result.keys },
  };
}

/** Capture the prior COMPLETE UTC day into `metrics_daily` (AECI-581 / §7.1) —
 *  the admin panel's long memory, because §4 shows neither `stats_cache` (which
 *  is overwritten) nor `audit_log` (additions, not net totals) can answer "how
 *  many did we have on this date". `runMetricsSnapshot` is per-metric
 *  best-effort and never throws on a compute/write failure, so reaching the catch
 *  here is a pre-compute crash (e.g. a missing DB binding): log loudly, count an
 *  outright failure, never rethrow. */
async function runMetricsSnapshotJob(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/metrics-snapshot');
  const { db } = cronDb(env);
  // The prior complete UTC day. Running at 00:15 means "yesterday" is closed and
  // the stock sample is only minutes past its end.
  const day = shiftDay(new Date().toISOString().slice(0, 10), -1);

  const started = Date.now();
  let result: MetricsSnapshotResult;
  try {
    result = await runMetricsSnapshot(db, day, new Date());
  } catch (error) {
    submitCount(ctx, env, req, 'aeci.metrics_snapshot.run', 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.metrics_snapshot.crashed',
      source: 'metrics-snapshot-cron',
      day,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'failed',
      detail: {
        job: 'metrics-snapshot',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const written = result.metrics.filter((m) => m.status === 'written').length;
  const failed = result.metrics.filter((m) => m.status === 'failed');

  for (const m of failed) {
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: `aeci.metrics_snapshot.metric ${m.metric} status=failed`,
      source: 'metrics-snapshot-cron',
      day,
      metric: m.metric,
      reason: m.error,
    });
  }

  const durationMs = Date.now() - started;
  emitMetricsSnapshotMetrics(metricSink(ctx, env, req), result, durationMs);
  logToDatadog(ctx, env, req, {
    level: failed.length > 0 ? 'warn' : 'info',
    message: `aeci.metrics_snapshot.captured day=${day} metrics_written=${written} metrics_failed=${failed.length}`,
    source: 'metrics-snapshot-cron',
    day,
    metrics_written: written,
    metrics_failed: failed.length,
  });

  // §7.2 (AECI-583). Any failed metric collapses `partial → failed`, in step with
  // the per-metric `outcome:failed` Datadog tag: the panel must not claim more
  // success than Datadog does for the same run.
  return {
    outcome: failed.length === 0 ? 'ok' : 'failed',
    detail: {
      job: 'metrics-snapshot',
      day,
      durationMs,
      written,
      failed: failed.length,
      metrics: result.metrics,
    },
  };
}

/**
 * The §7.4 retention prune (AECI-584 / Phase 8.3 P3.2) — the system's only
 * scheduled `DELETE`.
 *
 * Everything load-bearing lives in `./lib/retention-prune`; this is the shell
 * that supplies `env`, the clock, the Datadog sink, and the §26.5 forward. Three
 * things about it are specific to a destructive job:
 *
 *   - **`runRetentionPrune` is allowed to throw.** Unlike the snapshot job (per
 *     metric best-effort) a D1 failure here must NOT be swallowed into a
 *     partial-success story: the batch is atomic, so a throw means nothing was
 *     deleted, and `outcome: 'failed'` is the honest record.
 *   - **The audit forward is post-commit and fire-and-forget** (§26.5). The row
 *     itself already committed inside the batch with the deletes; this is only
 *     the Datadog copy. `routes/*.ts` build their forwarder from a Hono
 *     `Context` — a cron has none, so it binds the synthetic request instead.
 *   - **A skip is loud.** `outcome: 'skipped'` with the missing days, an
 *     `error`-level log, and `aeci.retention.prune{outcome:skipped}` — the
 *     monitor that catches "the long memory stopped being written".
 */
async function runRetentionPruneJob(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/retention-prune');
  const { db } = cronDb(env);

  const windows = resolveRetentionWindows(env, (table, reason) => {
    // An override we refused. Loud, because the operator who set it believes a
    // different window is in force than the one about to run.
    logToDatadog(ctx, env, req, {
      level: 'warn',
      message: 'aeci.retention.invalid_window_override',
      source: 'retention-prune-cron',
      table,
      reason,
    });
  });

  const started = Date.now();
  let result: Awaited<ReturnType<typeof runRetentionPrune>>;
  try {
    result = await runRetentionPrune(db, new Date(), windows);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    submitCount(ctx, env, req, RETENTION_RUN_METRIC, 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.retention.crashed',
      source: 'retention-prune-cron',
      reason,
    });
    return { outcome: 'failed', detail: { job: 'retention-prune', reason } };
  }

  const durationMs = Date.now() - started;
  emitRetentionPruneMetrics(metricSink(ctx, env, req), result, durationMs);

  if (result.status === 'skipped') {
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: `aeci.retention.skipped reason=${result.reason} missing_days=${result.missingCount}`,
      source: 'retention-prune-cron',
      reason: result.reason,
      window_from: result.window.fromDay,
      window_to: result.window.toDay,
      missing_days: result.missingDays.join(','),
      missing_count: result.missingCount,
    });
    return {
      outcome: 'skipped',
      detail: {
        job: 'retention-prune',
        reason: result.reason,
        window: result.window,
        missingCount: result.missingCount,
        missingDays: result.missingDays,
      },
    };
  }

  const truncated = result.tables.filter((t) => t.truncated);
  logToDatadog(ctx, env, req, {
    level: truncated.length > 0 ? 'warn' : 'info',
    message: `aeci.retention.pruned rows_deleted=${result.rowsDeleted}`,
    source: 'retention-prune-cron',
    rows_deleted: result.rowsDeleted,
    tables: result.tables.map((t) => `${t.table}=${t.rowsDeleted}`).join(','),
    truncated: truncated.map((t) => t.table).join(','),
  });

  if (result.auditEntry) {
    const entry = result.auditEntry;
    const forward: AuditLogForwarder = (e) => {
      logToDatadog(ctx, env, req, {
        level: 'info',
        message: `audit ${e.action}`,
        source: 'audit_log',
        audit: e,
      });
    };
    ctx.waitUntil(forwardAuditLog(entry, forward));
  }

  return {
    outcome: 'ok',
    detail: {
      job: 'retention-prune',
      durationMs,
      rowsDeleted: result.rowsDeleted,
      tables: result.tables,
    },
  };
}

/** Snapshot the pending-review moderation queue and emit its health gauges
 *  (AECI-206 / Phase 5.15): depth + oldest-pending age. Report-only — like the
 *  index-drift check it never mutates; the alert is the Datadog "moderation
 *  backlog" monitor. Two cheap indexed reads, so it runs inline (no queue). */
async function runModerationQueueMetrics(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/moderation-queue');
  const { db } = cronDb(env);

  try {
    const [pendingRows, oldest] = await Promise.all([
      db.select({ value: count() }).from(reviews).where(eq(reviews.status, 'pending')),
      db.query.reviews.findFirst({
        columns: { createdAt: true },
        where: eq(reviews.status, 'pending'),
        orderBy: asc(reviews.createdAt),
      }),
    ]);
    const pendingCount = pendingRows[0]?.value ?? 0;
    // `created_at` is ISO-8601 TEXT under D1 — parse for the age math.
    const ageHours = oldestPendingAgeHours(
      pendingCount,
      oldest ? new Date(oldest.createdAt).getTime() : null,
      Date.now(),
    );
    emitModerationQueueMetrics(metricSink(ctx, env, req), {
      pendingCount,
      oldestPendingAgeHours: ageHours,
    });
    logToDatadog(ctx, env, req, {
      level: 'info',
      message: `aeci.moderation.queue depth=${pendingCount} oldest_age_hours=${ageHours.toFixed(2)}`,
      source: 'moderation-cron',
    });
    return {
      outcome: 'ok',
      detail: {
        job: 'moderation-snapshot',
        pendingCount,
        oldestPendingAgeHours: ageHours,
      },
    };
  } catch (error) {
    // Mirror the drift/stats crash path: log loudly, never throw (a failed cron
    // must not tear down the invocation).
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.moderation.queue.crashed',
      source: 'moderation-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'failed',
      detail: {
        job: 'moderation-snapshot',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Run the request→Linear reconciliation sweep (AECI-214 / Phase 6.7): retry
 *  `vendor_requests` stuck `open`/`linear_issue_id=null` and alert on persistent
 *  failures. The sweep's unexpected read failures propagate so the queue re-runs
 *  it (idempotent via `createLinearIssueForRequest`). */
async function runReconcileJob(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/reconcile');
  const { db } = cronDb(env);
  // No try/catch, deliberately: an unexpected read failure propagates so the queue
  // consumer `retry()`s. `withJobRun` records that throw as `outcome:'failed'` and
  // rethrows it, so the retry behaviour is unchanged and each attempt is its own
  // row (a successful retry supersedes by `started_at`).
  const result = await runReconciliationSweep({ env, executionCtx: ctx, req: { raw: req } }, db);
  return { outcome: 'ok', detail: { job: 'request-reconcile', ...result } };
}

/** Run the daily §23.1 data-quality suite (AECI-241 / Phase 7.6): ten read-only
 *  checks → per-check gauge + job heartbeat/duration → email digest to Chris +
 *  Bill. Report-only — no auto-remediation. The Algolia-drift check (#10) reuses
 *  the AECI-140 count (`findAlgoliaIndexDrift`) when creds are present; otherwise
 *  it skips (local/preview). The email transport is fail-open: a missing
 *  `RESEND_API_KEY`/recipients logs `outcome:skipped`, the Datadog monitors are
 *  the delivery backstop. Errors per check are captured, not thrown (the suite is
 *  best-effort), so reaching the catch is a pre-run crash. */
async function runDataQualityJob(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/data-quality');
  const started = Date.now();
  const { db } = cronDb(env);

  // Reuse the AECI-140 drift count when Algolia creds are present (same posture as
  // runAlgoliaDrift); absent → the drift check skips rather than erroring. Shared
  // with `GET /api/admin/overview?recompute=1` (AECI-574) via `algolia-drift-deps`.
  const runDrift = createDriftRunner(env, db);

  let results: DataQualityCheckResult[];
  try {
    results = await runDataQualityChecks({ db, now: new Date(), runDrift });
  } catch (error) {
    // The suite is itself best-effort, so a throw here is a pre-run crash (e.g. a
    // missing DB binding). Count the failure heartbeat + log; never rethrow.
    submitCount(ctx, env, req, DQ_JOB_METRIC, 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.data_quality.crashed',
      source: 'data-quality-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'failed',
      detail: {
        job: 'data-quality',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // Per-check gauge — always emitted (0 when clean) so a monitor can break down by
  // `check` tag and tell "clean" from "didn't run". An errored check emits -1.
  for (const r of results) {
    submitGauge(ctx, env, req, DQ_CHECK_METRIC, r.error ? -1 : r.count, [
      `check:${r.id}`,
      `severity:${r.severity}`,
    ]);
    logToDatadog(ctx, env, req, {
      level: r.error ? 'error' : r.count > 0 ? 'warn' : 'info',
      message: `aeci.data_quality.check ${r.id} count=${r.count}${r.skipped ? ' (skipped)' : ''}`,
      source: 'data-quality-cron',
      check: r.id,
      count: r.count,
      ...(r.error ? { reason: r.error } : {}),
    });
  }

  const outcome = hasErrors(results) ? 'failed' : 'success';
  const durationMs = Date.now() - started;
  submitCount(ctx, env, req, DQ_JOB_METRIC, 1, ['trigger:cron', `outcome:${outcome}`]);
  submitDistribution(ctx, env, req, DQ_DURATION_METRIC, durationMs, ['trigger:cron']);

  // Build + send the digest (always — a clean run still emails so silence means
  // the cron failed). Fail-open: a missing transport returns 'skipped'.
  const digest = buildDataQualityDigest(results, {
    env: algoliaEnvFor(env),
    generatedAt: new Date(),
  });
  const recipients = parseRecipients(env.DATA_QUALITY_EMAIL_TO);
  const emailOutcome = await sendEmail(env, {
    from: env.DATA_QUALITY_EMAIL_FROM ?? '',
    to: recipients,
    subject: digest.subject,
    text: digest.text,
    html: digest.html,
  });
  submitCount(ctx, env, req, DQ_EMAIL_METRIC, 1, [`outcome:${emailOutcome}`]);
  logToDatadog(ctx, env, req, {
    level: emailOutcome === 'failed' ? 'error' : 'info',
    message: `aeci.data_quality.email outcome=${emailOutcome} recipients=${recipients.length}: ${digest.subject}`,
    source: 'data-quality-cron',
  });

  // The whole result set, stored verbatim (§7.2). `DataQualityCheckResult` is
  // field-for-field `AdminDataQualityCheckSchema`, so §5.6 renders exactly what
  // the digest above reported — the round-trip is a parse, not an adapter. This
  // is what turns the ten checks from a daily email into a queryable history.
  // `outcome` reuses the same `hasErrors` expression as DQ_JOB_METRIC above.
  return {
    outcome: outcome === 'failed' ? 'failed' : 'ok',
    detail: { job: 'data-quality', durationMs, checks: results, email: emailOutcome },
  };
}

/** Build + email the daily operator analytics digest (AECI-526): the prior *complete*
 *  UTC day's page views, top products, new + total users, and the live
 *  pending-moderation depth (with day-over-day deltas). Report-only reads — no audit
 *  row, no mutation. The Resend transport is fail-open: an absent `RESEND_API_KEY` /
 *  `EMAIL_FROM` / `ANALYTICS_DIGEST_EMAIL_TO` yields `outcome:skipped` (the expected
 *  local/preview state), and the `aeci.analytics_digest.email` metric is the delivery
 *  signal. Queue-less (like `moderation`/`waf`), so it always runs inline. Never throws:
 *  a read/format crash is logged and counted `outcome:failed` (so the metric still
 *  fires as a liveness heartbeat), never rethrown — a failed cron must not tear down
 *  the invocation. */
/**
 * The digest's client-side human floor (AECI-660), or a structured skip.
 *
 * Fail-open by construction: every failure path returns `{ ok: false, reason }`
 * and the digest renders a short "unavailable" note instead of a number. It must
 * never return a zero on failure — a fabricated 0 beside a real 48 reads as a
 * finding rather than as missing data.
 *
 * Host-scoped to this environment's own `PUBLIC_SITE_URL`, because every tier
 * currently shares one PostHog project and an unscoped read would fold demo and
 * staging traffic into the production figure.
 */
async function readPosthogFloor(env: Env, window: DigestWindow): Promise<PosthogQueryOutcome> {
  const host = publicHostOf(env.PUBLIC_SITE_URL);
  if (!host) return { ok: false, reason: 'public_site_url_unset' };
  return fetchPosthogTraffic(
    {
      apiKey: env.POSTHOG_QUERY_API_KEY,
      projectId: env.POSTHOG_PROJECT_ID,
      host: env.POSTHOG_API_HOST,
    },
    { startIso: window.startIso, endIso: window.endIso, host },
    fetch,
  );
}

async function runAnalyticsDigestJob(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/analytics-digest');
  try {
    const { db } = cronDb(env);
    const window = dailyWindows(new Date());

    // Four reads, deliberately orchestrated HERE rather than folded into
    // `collectAnalyticsMetrics`. The swarm detector imports that module's
    // `HUMAN` / `NOT_INTERNAL` predicates, so calling it from inside would close
    // an import cycle; and the PostHog read reaches the network, which the
    // D1-only collector has never done and should not start doing.
    //
    // The detector runs over the PRIOR day as well (AECI-741). Since the headline
    // is now the count remaining after the automation filter, its day-over-day
    // delta has to subtract from both sides — comparing a filtered day against an
    // unfiltered prior day would print a large fabricated drop every morning.
    // Swarm detection runs FIRST, not alongside, because its result is now an
    // INPUT to the collector (AECI-747): the "most viewed products" and "traffic
    // sources" tables have to exclude the same automated clients the headline
    // subtracts, or the email leads with a filtered number over unfiltered rows.
    // On 2026-08-30 that gap showed a bot-driven page as the day's top product.
    const [swarm, priorSwarm] = await Promise.all([
      detectSwarms(db, window.startIso, window.endIso),
      detectSwarms(db, window.priorStartIso, window.startIso),
    ]);
    const exclusion = {
      uaHashes: swarm.uaCandidates.map((c) => c.userAgentHash),
      asns: swarm.asnCandidates.map((c) => c.cfAsn),
      // Unconditional, unlike the two lists: the union count always includes the
      // verdict matcher, so its complement must too, or the tables would keep rows
      // the headline already subtracted (AECI-744).
      verdicts: [...NON_BROWSER_VERDICTS],
    };
    const [metrics, posthog] = await Promise.all([
      collectAnalyticsMetrics(db, window, exclusion),
      readPosthogFloor(env, window),
    ]);

    const digest = buildAnalyticsDigest(metrics, {
      env: env.ENV ?? 'development',
      dayLabel: window.dayLabel,
      generatedAt: new Date(),
      posthog: posthog.ok ? posthog.traffic : null,
      posthogUnavailable: posthog.ok ? null : posthog.reason,
      automation: {
        flagged: { day: swarm.flaggedViews, prior: priorSwarm.flaggedViews },
        note: swarmNote(swarm),
      },
    });
    const recipients = parseRecipients(env.ANALYTICS_DIGEST_EMAIL_TO);
    const outcome = await sendEmail(env, {
      // Shares the transactional sender (`EMAIL_FROM`) — one verified Resend sender,
      // no separate `_FROM` var. Absent → `sendEmail` skips (fail-open).
      from: env.EMAIL_FROM ?? '',
      to: recipients,
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
    });
    submitCount(ctx, env, req, ANALYTICS_EMAIL_METRIC, 1, [`outcome:${outcome}`]);
    logToDatadog(ctx, env, req, {
      level: outcome === 'failed' ? 'error' : 'info',
      message: `aeci.analytics_digest.email outcome=${outcome} recipients=${recipients.length}: ${digest.subject}`,
      source: 'analytics-digest-cron',
    });
    // 1:1 with `ANALYTICS_EMAIL_METRIC` above — no second opinion. On production
    // all three secrets are set, so a `skipped` row there is a real
    // misconfiguration the operator should see as not-ok; on local/preview it is
    // the expected state.
    return {
      outcome: outcome === 'sent' ? 'ok' : outcome === 'skipped' ? 'skipped' : 'failed',
      detail: {
        job: 'analytics-digest',
        dayLabel: window.dayLabel,
        email: outcome,
        recipients: recipients.length,
        // A projection, not the whole `AnalyticsMetrics`: `botActivity` is every
        // crawler active in the day (unbounded) and the rendered digest is large
        // and re-derivable.
        metrics: {
          pageViewsHuman: metrics.pageViews.day,
          pageViewsBot: metrics.botPageViews.day,
          newUsers: metrics.newUsers.day,
          totalUsers: metrics.totalUsers,
          pendingModeration: metrics.pendingModeration,
          // AECI-660 / AECI-658. Recorded so a join that silently stops running
          // is visible in `job_runs` rather than only as an absence in the email.
          posthogPageViews: posthog.ok ? posthog.traffic.pageviews : null,
          posthogPeople: posthog.ok ? posthog.traffic.people : null,
          posthogSkipped: posthog.ok ? null : posthog.reason,
          swarmCandidates: swarm.uaCandidates.length,
          asnRotatorCandidates: swarm.asnCandidates.length,
          swarmFlaggedViews: swarm.flaggedViews,
          swarmTruncated: swarm.truncated,
          // AECI-744. The third shape: views flagged by their own request headers
          // with no view floor, and the networks they came from. Recorded because
          // the rollup is a read over `page_views`, and by the time anyone asks
          // "which networks were those?" the window may have aged out of retention.
          verdictFlaggedViews: swarm.verdictFlaggedViews,
          nonBrowserCandidates: swarm.verdictCandidates.length,
          nonBrowserNetworks: swarm.verdictCandidates.map((c) => ({
            asn: c.cfAsn,
            org: c.asOrganization,
            views: c.views,
          })),
          // AECI-741. The headline the email actually led with, recorded so the
          // number the operator read is reconstructible from `job_runs` without
          // re-running the detector over a window whose data may since have aged
          // out of retention.
          pageViewsHumanNetAutomation: Math.max(0, metrics.pageViews.day - swarm.flaggedViews),
          // AECI-683. Recorded beside the headline so a leak that starts growing
          // (or a pair rule that starts over-reaching) is visible in `job_runs`
          // history rather than only in one morning's email.
          operatorLeakViews: metrics.operatorLeakViews,
          corroboratedViews: metrics.corroboratedViews.day,
          corroboratedVisitors: metrics.corroboratedVisitors,
        },
      },
    };
  } catch (error) {
    submitCount(ctx, env, req, ANALYTICS_EMAIL_METRIC, 1, ['outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.analytics_digest.crashed',
      source: 'analytics-digest-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'failed',
      detail: {
        job: 'analytics-digest',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Refresh `asn_registry` from PeeringDB (AECI-624 / §7.6) — the weekly job, and
 * the only one here whose output is *annotation* rather than measurement.
 *
 * Everything load-bearing is in `./lib/asn-registry`; this is the shell that
 * supplies the clock, `fetch`, and the Datadog sink. Two things are specific to
 * an annotation feed:
 *
 *   - **It never throws and never deletes.** An upstream outage returns
 *     `status: 'failed'` with the last good rows untouched, so the panel keeps
 *     annotating from a stale registry (visibly stale — §5.6 renders
 *     `fetched_at`) rather than losing the annotation entirely.
 *   - **`written === 0` on a healthy feed is not a failure.** A fresh environment
 *     with an empty `page_views` has nothing to intersect, so the honest outcome
 *     is `skipped`, not `ok` (which would claim a refresh happened) and not
 *     `failed` (nothing broke). The refresh result distinguishes the two by
 *     reporting `seen`.
 */
async function runAsnRegistryJob(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/asn-registry');
  const started = Date.now();

  let db: Db;
  try {
    db = cronDb(env).db;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    submitCount(ctx, env, req, ASN_REGISTRY_METRIC, 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.asn_registry.crashed',
      source: 'asn-registry-cron',
      reason,
    });
    return { outcome: 'failed', detail: { job: 'asn-registry', reason } };
  }

  const result = await refreshAsnRegistry(db, fetch, new Date(), {
    apiKey: env.PEERINGDB_API_KEY,
  });
  const durationMs = Date.now() - started;

  if (result.status === 'failed') {
    submitCount(ctx, env, req, ASN_REGISTRY_METRIC, 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: `aeci.asn_registry.failed reason=${result.reason ?? 'unknown'}`,
      source: 'asn-registry-cron',
      reason: result.reason,
      fetched: result.fetched,
      seen: result.seen,
    });
    return {
      outcome: 'failed',
      detail: { job: 'asn-registry', reason: result.reason ?? 'refresh failed' },
    };
  }

  // Nothing to classify — the expected state on a fresh env, and honestly a
  // non-run rather than a clean one.
  if (result.seen === 0) {
    submitCount(ctx, env, req, ASN_REGISTRY_METRIC, 1, ['trigger:cron', 'outcome:skipped']);
    return { outcome: 'skipped', detail: { job: 'asn-registry', reason: 'no page_views ASNs' } };
  }

  // Coverage is the number worth a gauge: it is what decides whether an
  // annotation exists for a given row, and it degrades silently as new ASNs
  // arrive between runs.
  submitGauge(ctx, env, req, ASN_REGISTRY_COVERAGE_METRIC, result.matched / result.seen, []);
  submitCount(ctx, env, req, ASN_REGISTRY_METRIC, 1, [
    'trigger:cron',
    `outcome:${result.failedChunks > 0 ? 'partial' : 'ok'}`,
  ]);
  logToDatadog(ctx, env, req, {
    level: result.failedChunks > 0 ? 'warn' : 'info',
    message: `aeci.asn_registry.refreshed fetched=${result.fetched} seen=${result.seen} matched=${result.matched} written=${result.written}`,
    source: 'asn-registry-cron',
    fetched: result.fetched,
    seen: result.seen,
    matched: result.matched,
    written: result.written,
    failed_chunks: result.failedChunks,
  });

  // A partial write collapses to `failed`, in step with every other job here:
  // the panel must not show a green tick for a run that dropped rows. The detail
  // carries `written` so "partial" is still recoverable from the row.
  return {
    outcome: result.failedChunks > 0 ? 'failed' : 'ok',
    detail: {
      job: 'asn-registry',
      durationMs,
      fetched: result.fetched,
      seen: result.seen,
      matched: result.matched,
      written: result.written,
      failedChunks: result.failedChunks,
    },
  };
}

/** The host portion of a URL, or `undefined` if it's missing/unparseable. The
 *  WAF poll scopes its query to the env's own host so a shared zone isn't
 *  triple-counted across `env:` tags. */
function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Poll the zone's WAF firewall events for the previous clock hour and emit the
 *  `aeci.waf.ratelimit.blocked` count (AECI-262 / §15.1). Report-only and
 *  fail-safe like the moderation snapshot: a missing token/host or a Cloudflare
 *  error logs + no-ops, never throws (an observability outage can't tear down the
 *  cron). Queue-less (a single read-only HTTP call needs no retry — the next hour
 *  re-polls the next window). The query is scoped to this env's own host
 *  (`PUBLIC_SITE_URL`) because all envs share one Cloudflare zone, so an
 *  unscoped query would count the same zone-wide events under each `env:` tag. */
async function runWafMetricsJob(env: Env, ctx: ExecutionContext): Promise<JobRunReport> {
  const req = cronRequest('/cron/waf-metrics');
  const host = hostFromUrl(env.PUBLIC_SITE_URL);
  const creds = { apiToken: env.CF_ANALYTICS_API_TOKEN, zoneId: env.CF_ZONE_ID };

  // Defensive no-op: the token is provisioned per env when ready (no CI gate),
  // and local/preview legitimately lack it — mirror the Algolia/email fail-safe.
  if (!creds.apiToken || !creds.zoneId || !host) {
    submitCount(ctx, env, req, WAF_POLL_METRIC, 1, ['trigger:cron', 'outcome:skipped_no_creds']);
    logToDatadog(ctx, env, req, {
      level: 'warn',
      message: 'aeci.waf.poll.skipped_no_creds',
      source: 'waf-metrics-cron',
    });
    return { outcome: 'skipped', detail: { job: 'waf-poll', reason: 'no_creds' } };
  }

  const window = { ...previousHourWindow(new Date()), host };
  const outcome = await fetchWafFirewallEvents(fetch, creds, window);
  if (!outcome.ok) {
    submitCount(ctx, env, req, WAF_POLL_METRIC, 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.waf.poll.failed',
      source: 'waf-metrics-cron',
      reason: outcome.message,
      host,
      window_start: window.startIso,
      window_end: window.endIso,
    });
    return { outcome: 'failed', detail: { job: 'waf-poll', reason: outcome.message } };
  }

  // One count per mitigation group (the always-emitted `outcome:ok` heartbeat
  // below carries cron-liveness even when the hour was quiet — no groups).
  emitWafEventMetrics(metricSink(ctx, env, req), outcome.groups);
  submitCount(ctx, env, req, WAF_POLL_METRIC, 1, ['trigger:cron', 'outcome:ok']);

  const events = outcome.groups.reduce((sum, g) => sum + g.count, 0);
  logToDatadog(ctx, env, req, {
    level: outcome.truncated ? 'warn' : 'info',
    message: `aeci.waf.poll host=${host} groups=${outcome.groups.length} events=${events}${
      outcome.truncated ? ' (truncated at the group limit — raise WAF_EVENTS_GROUP_LIMIT)' : ''
    }`,
    source: 'waf-metrics-cron',
    host,
    groups: outcome.groups.length,
    events,
    window_start: window.startIso,
    window_end: window.endIso,
    truncated: outcome.truncated,
  });

  // The group COUNT, not the group array: that is bounded only by
  // `WAF_EVENTS_GROUP_LIMIT`, and Datadog already carries the per-rule breakdown
  // (`aeci.waf.ratelimit.blocked`).
  return {
    outcome: 'ok',
    detail: {
      job: 'waf-poll',
      window: { startIso: window.startIso, endIso: window.endIso, host },
      groups: outcome.groups.length,
      events,
      truncated: outcome.truncated,
    },
  };
}

/** The producer queue binding for a job (absent on local/preview → inline run). */
function queueForJob(env: Env, job: ScheduledJob): Queue<ScheduledJobMessage> | undefined {
  switch (job) {
    case 'sync':
      return env.ALGOLIA_SYNC_QUEUE;
    case 'drift':
      return env.ALGOLIA_DRIFT_QUEUE;
    case 'stats':
      return env.STATS_QUEUE;
    case 'reconcile':
      return env.RECONCILE_QUEUE;
    case 'data_quality':
      return env.DATA_QUALITY_QUEUE;
    case 'moderation':
      // Queue-less by design: a cheap read-only gauge needs no retry/queue, so it
      // always runs inline (AECI-206). No `MODERATION_QUEUE` binding exists.
      return undefined;
    case 'waf':
      // Queue-less like `moderation` (AECI-262): a single read-only Cloudflare
      // GraphQL read needs no retry — the next hour re-polls the next window. No
      // `WAF_QUEUE` binding exists, so it always runs inline.
      return undefined;
    case 'analytics':
      // Queue-less like `moderation`/`waf` (AECI-526): a cheap read-only aggregation
      // + one fail-open email needs no retry — the next day re-runs. No
      // `ANALYTICS_QUEUE` binding exists, so it always runs inline.
      return undefined;
    case 'retention':
      // Queue-less, and for a stronger reason than the others (AECI-584): this
      // is the only DESTRUCTIVE job, and queue-native retries are precisely what
      // it must not have. A run that was skipped, truncated, or died mid-batch is
      // re-attempted tomorrow by the cron, from a re-probed cutoff — never
      // replayed against state it may already have changed. No `RETENTION_QUEUE`
      // binding exists.
      return undefined;
    case 'snapshot':
      // Queue-less like `moderation`/`waf`/`analytics` (AECI-581): every metric is
      // already isolated in its own try/catch, and a missed day is recoverable by
      // re-running `ops:backfill-metrics-daily` over that range — the same
      // idempotent `(day, metric)` upsert — so queue-native retries buy nothing.
      // No `SNAPSHOT_QUEUE` binding exists, so it always runs inline.
      return undefined;
    case 'asn_registry':
      // Queue-less like `waf` (AECI-624): one read-only GET plus an upsert that is
      // idempotent by ASN and never deletes, so a failed week costs nothing but
      // freshness and the next Monday converges. Provisioning a twelfth queue for
      // a job whose retry semantics are already "try again next week" would be
      // infrastructure for its own sake. No `ASN_REGISTRY_QUEUE` binding exists.
      return undefined;
  }
}

/** Cron path + log identifiers for a job's enqueue-failure log. `sync`/`drift`
 *  live under the `algolia` domain (unchanged); `stats` under its own. */
function enqueueFailureLog(job: ScheduledJob): { path: string; message: string; source: string } {
  if (job === 'stats') {
    return { path: '/cron/stats', message: 'aeci.stats.enqueue_failed', source: 'stats-cron' };
  }
  if (job === 'moderation') {
    // Unreachable in practice (moderation is queue-less, so `queue.send` is never
    // called) — kept so the mapping is total over `ScheduledJob`.
    return {
      path: '/cron/moderation-queue',
      message: 'aeci.moderation.queue.enqueue_failed',
      source: 'moderation-cron',
    };
  }
  if (job === 'reconcile') {
    return {
      path: '/cron/reconcile',
      message: 'aeci.linear.reconcile.enqueue_failed',
      source: 'reconcile',
    };
  }
  if (job === 'data_quality') {
    return {
      path: '/cron/data-quality',
      message: 'aeci.data_quality.enqueue_failed',
      source: 'data-quality-cron',
    };
  }
  if (job === 'waf') {
    // Unreachable in practice (waf is queue-less, so `queue.send` is never
    // called) — kept so the mapping is total over `ScheduledJob`.
    return {
      path: '/cron/waf-metrics',
      message: 'aeci.waf.poll.enqueue_failed',
      source: 'waf-metrics-cron',
    };
  }
  if (job === 'analytics') {
    // Unreachable in practice (analytics is queue-less, so `queue.send` is never
    // called) — kept so the mapping is total over `ScheduledJob`.
    return {
      path: '/cron/analytics-digest',
      message: 'aeci.analytics_digest.enqueue_failed',
      source: 'analytics-digest-cron',
    };
  }
  if (job === 'snapshot') {
    // Unreachable in practice (snapshot is queue-less, so `queue.send` is never
    // called) — kept so the mapping is total over `ScheduledJob`.
    return {
      path: '/cron/metrics-snapshot',
      message: 'aeci.metrics_snapshot.enqueue_failed',
      source: 'metrics-snapshot-cron',
    };
  }
  if (job === 'retention') {
    // Unreachable in practice (retention is queue-less, so `queue.send` is never
    // called) — kept so the mapping is total over `ScheduledJob`.
    return {
      path: '/cron/retention-prune',
      message: 'aeci.retention.enqueue_failed',
      source: 'retention-prune-cron',
    };
  }
  if (job === 'asn_registry') {
    // Unreachable in practice (asn_registry is queue-less, so `queue.send` is
    // never called) — kept so the mapping is total over `ScheduledJob`.
    return {
      path: '/cron/asn-registry',
      message: 'aeci.asn_registry.enqueue_failed',
      source: 'asn-registry-cron',
    };
  }
  return {
    path: `/cron/algolia-${job}`,
    message: `aeci.algolia.${job}.enqueue_failed`,
    source: `algolia-${job}-cron`,
  };
}

/** Run a job, or — preferably — enqueue it. On staging/production the matching
 *  queue binding is present, so we `send` a message and return immediately; the
 *  `queue` consumer below does the work (ADR 0013). On an env without the binding
 *  (local `wrangler dev`, preview) there is no queue, so run inline — a
 *  `--test-scheduled` tick must never be silently dropped. */
async function enqueueOrRun(env: Env, ctx: ExecutionContext, job: ScheduledJob): Promise<void> {
  const queue = queueForJob(env, job);
  if (queue) {
    const message: ScheduledJobMessage = {
      job,
      trigger: 'cron',
      enqueuedAt: new Date().toISOString(),
    };
    try {
      await queue.send(message);
      return;
    } catch (error) {
      // `queue.send` can reject (transient queue error / throttling, or a
      // deleted/missing queue). Don't let it escape as an opaque failed-cron
      // with no detail — log loudly (as the job impls do) and fall through to
      // an inline run so the scheduled tick is never silently dropped.
      const log = enqueueFailureLog(job);
      logToDatadog(ctx, env, cronRequest(log.path), {
        level: 'error',
        message: log.message,
        source: log.source,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    console.warn(`scheduled: no queue binding for "${job}" — running inline (local/preview)`);
  }
  await runScheduledJob(env, ctx, job);
}

/** Dispatch a job kind to its implementation. Every impl returns a
 *  {@link JobRunReport} rather than `void`, because the impls swallow their own
 *  operational errors — a wrapper that only watched for a throw would record `ok`
 *  for a run that failed. `Promise<JobRunReport>` also makes the type checker
 *  enumerate every exit path in all ten, which is what makes "each of the ten
 *  writes a row, on every path" verifiable rather than a review checklist. */
async function dispatchScheduledJob(
  env: Env,
  ctx: ExecutionContext,
  job: ScheduledJob,
): Promise<JobRunReport> {
  switch (job) {
    case 'sync':
      return runAlgoliaSync(env, ctx);
    case 'drift':
      return runAlgoliaDrift(env, ctx);
    case 'stats':
      return runHomeStatsJob(env, ctx);
    case 'moderation':
      return runModerationQueueMetrics(env, ctx);
    case 'reconcile':
      return runReconcileJob(env, ctx);
    case 'data_quality':
      return runDataQualityJob(env, ctx);
    case 'waf':
      return runWafMetricsJob(env, ctx);
    case 'analytics':
      return runAnalyticsDigestJob(env, ctx);
    case 'snapshot':
      return runMetricsSnapshotJob(env, ctx);
    case 'retention':
      return runRetentionPruneJob(env, ctx);
    case 'asn_registry':
      return runAsnRegistryJob(env, ctx);
  }
}

/**
 * Run a job under §7.2 `job_runs` bookkeeping (AECI-583). Shared by the inline
 * fallback and the queue consumer so both paths stay identical — and it keeps its
 * name, signature and throw-on-failure semantics, so the consumer's ack/retry is
 * preserved by construction.
 *
 * The row is written on ENTRY and completed on EXIT, so a run the isolate never
 * came back from leaves `finished_at NULL`. `withJobRun` owns the ordering, the
 * failure isolation, and the rethrow; see `lib/job-runs.ts`. **No `audit_log`
 * row** — ADR 0022.
 *
 * Note what is deliberately NOT instrumented: the *enqueue*. On staging/prod
 * `enqueueOrRun` returns as soon as `queue.send` resolves, and the row belongs to
 * the execution, which is the consumer's. So there is a real window where the
 * cron fired and no row exists yet; the read side must not read that as "didn't
 * run", which is why an absent row stays `unknown`/`derived` rather than failing.
 */
async function runScheduledJob(env: Env, ctx: ExecutionContext, job: ScheduledJob): Promise<void> {
  await withJobRun(
    { db: jobRunDb(env), job: ADMIN_CRON_JOB[job], sink: jobRunSink(ctx, env) },
    () => dispatchScheduledJob(env, ctx, job),
  );
}

/**
 * Worker `scheduled` handler — the cron trigger. It does not run the work; it
 * enqueues the job (see `enqueueOrRun` / ADR 0013). Dispatches on the cron
 * expression so additional scheduled jobs register their own trigger + case
 * without a second Worker.
 */
export const scheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env, ctx) => {
  switch (controller.cron) {
    case STATS_CRON:
      await enqueueOrRun(env, ctx, 'stats');
      return;
    case SNAPSHOT_CRON:
      await enqueueOrRun(env, ctx, 'snapshot');
      return;
    case ASN_REGISTRY_CRON:
      await enqueueOrRun(env, ctx, 'asn_registry');
      return;
    case RETENTION_CRON:
      await enqueueOrRun(env, ctx, 'retention');
      return;
    case ALGOLIA_SYNC_CRON:
      await enqueueOrRun(env, ctx, 'sync');
      return;
    case ALGOLIA_DRIFT_CRON:
      await enqueueOrRun(env, ctx, 'drift');
      return;
    case MODERATION_CRON:
      await enqueueOrRun(env, ctx, 'moderation');
      return;
    case RECONCILE_CRON:
      await enqueueOrRun(env, ctx, 'reconcile');
      return;
    case DATA_QUALITY_CRON:
      await enqueueOrRun(env, ctx, 'data_quality');
      return;
    case WAF_CRON:
      await enqueueOrRun(env, ctx, 'waf');
      return;
    case ANALYTICS_CRON:
      await enqueueOrRun(env, ctx, 'analytics');
      return;
    default:
      // A trigger fired with no matching case. This used to be a bare
      // `console.warn`, which made it indistinguishable from a job that never
      // ran at all: `asn_registry` sat unnoticed in exactly this state, because
      // the only evidence was an absent `job_runs` row, and an absent row looks
      // identical to a quiet week (AECI-661).
      //
      // `controller.cron` is matched by EXACT STRING above, so any drift between
      // a deployed `triggers.crons` entry and `lib/cron-schedules.ts` lands here.
      // Forward it to the observability pipeline as an error so it can alert.
      console.warn(`scheduled: no handler for cron "${controller.cron}"`);
      logToDatadog(ctx, env, cronRequest('/cron/unmatched'), {
        level: 'error',
        message: 'aeci.cron.no_handler',
        source: 'cron-dispatch',
        reason: `no handler for cron "${controller.cron}"`,
      });
      submitCount(ctx, env, cronRequest('/cron/unmatched'), 'aeci.cron.no_handler', 1, [
        `cron:${controller.cron}`,
      ]);
  }
};

/**
 * Fill in the properties an out-of-band queue message can omit. The cron
 * producer (`enqueueOrRun`) always stamps `trigger` + `enqueuedAt`, but an
 * operator force-run — a Cloudflare Queues REST push of just `{ "job": "stats" }`
 * (ADR 0013) — does not. The consumer implies them after the fact: a body with
 * no `trigger` was not enqueued by the cron, so it's `'manual'`; `enqueuedAt`
 * falls back to when the queue received the message. Pure + exported so the
 * contract is unit-tested directly.
 */
export function normalizeJobMessage(
  body: ScheduledJobMessageInput,
  receivedAt: string,
): ScheduledJobMessage {
  return {
    job: body.job,
    trigger: body.trigger ?? 'manual',
    enqueuedAt: body.enqueuedAt ?? receivedAt,
  };
}

/**
 * Worker `queue` consumer — runs the actual scheduled job for each message the
 * cron `scheduled` handler enqueued (ADR 0013). Bound to every job queue in
 * `wrangler.jsonc`; `batch.queue` would distinguish them, but the message body's
 * `job` is authoritative. Messages may also be pushed out-of-band (an operator
 * force-run sending just `{ job }`); `normalizeJobMessage` implies the missing
 * `trigger` / `enqueuedAt`. Batches are size-1 (each job is a singleton), so this
 * loops at most once per invocation. The job impls (`runAlgoliaSync`,
 * `runAlgoliaDrift`, `runHomeStatsJob`) swallow their own operational errors
 * (logging to Datadog), so reaching the `catch` means an unexpected throw (e.g.
 * a missing D1 binding) — `retry()` it per the consumer's `max_retries`;
 * everything else `ack()`s.
 */
export const queue: ExportedHandlerQueueHandler<Env, ScheduledJobMessageInput> = async (
  batch,
  env,
  ctx,
) => {
  for (const message of batch.messages) {
    const { job, trigger } = normalizeJobMessage(message.body, message.timestamp.toISOString());
    try {
      await runScheduledJob(env, ctx, job);
      message.ack();
    } catch (error) {
      console.error(
        `queue: scheduled job "${job}" (trigger=${trigger}) threw on ${batch.queue} (retrying):`,
        error instanceof Error ? error.message : String(error),
      );
      message.retry();
    }
  }
};
