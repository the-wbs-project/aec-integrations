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
 * 10:00 UTC (= 05:00 EST) — daily §7 attestation detector sweep
 * (`./lib/attestation-detectors` + `./lib/attestation-notify`, AECI-302 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §7): four detectors over the claim/attestation
 * spine (silent counterparty, open conflict, stale version, AECi-seeded claim
 * denied) → nudge emails to the vendors' seats and per-finding ops alerts to
 * `ADMIN_ALERT_EMAIL`, deduped against an `audit_log` ledger so a daily sweep
 * cannot re-nag daily. Deliberately last of the daily jobs, so a nudge describes
 * the state the site is actually serving. Unlike the read-only gauges this one
 * RETHROWS on an unexpected failure, so the queue retries — a sweep that never
 * ran is a nudge nobody is ever told about.
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

import type { AlgoliaEnv } from '@aeci/shared/algolia';
import { fetchWafFirewallEvents } from '@aeci/shared/cloudflare-analytics';
import { and, asc, count, eq, inArray } from 'drizzle-orm';

import { getDb } from './db/client';
import { integrations, products, reviews, vendors } from './db/schema';
import { logToDatadog, submitCount, submitDistribution, submitGauge } from './datadog';
import type { ScheduledJob, ScheduledJobMessage, ScheduledJobMessageInput, Env } from './env';
import {
  createAlgoliaCounter,
  findAlgoliaIndexDrift,
  reportAlgoliaDrift,
  type AlgoliaIndexDrift,
  type DriftCount,
} from './lib/algolia-drift';
import { runDailySync } from './lib/algolia-sync';
import {
  createAlgoliaDeleteClient,
  createAlgoliaObjectIdClient,
  DEFAULT_SAFETY_CAP,
  sweepAlgoliaOrphans,
  type EntityOrphanResult,
  type PromotedIdProvider,
} from './lib/algolia-orphans';
import { runAttestationNotifySweep } from './lib/attestation-notify';
import {
  NOTIFY_DURATION_METRIC,
  NOTIFY_JOB_METRIC,
  type AttestationNotifyMetricSink,
} from './lib/attestation-notify-metrics';
import { hasErrors, runDataQualityChecks, type DataQualityCheckResult } from './lib/data-quality';
import { buildDataQualityDigest } from './lib/data-quality-email';
import { parseRecipients, sendEmail } from './lib/email';
import { emitAlgoliaSyncMetrics, type SyncMetricSink } from './lib/algolia-sync-metrics';
import { runHomeStats, type HomeStatsResult } from './lib/home-stats';
import { emitHomeStatsMetrics } from './lib/home-stats-metrics';
import {
  emitModerationQueueMetrics,
  oldestPendingAgeHours,
  type ModerationMetricSink,
} from './lib/moderation-metrics';
import { runReconciliationSweep } from './lib/reconciliation-sweep';
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

/** Cron expression for the daily incremental Algolia sync (`wrangler.jsonc`).
 *  08:00 UTC = 03:00 EST (US-East, our launch customer base). Cloudflare cron
 *  is UTC-only / DST-unaware, so this is 04:00 EDT in summer — both dead-of-night
 *  in the US, deliberately accepted (no per-season retune). MUST stay byte-equal
 *  to the `triggers.crons` entry in `wrangler.jsonc` or `controller.cron` won't
 *  match the `switch` below. */
const ALGOLIA_SYNC_CRON = '0 8 * * *';

/** Cron expression for the daily index-drift check (`wrangler.jsonc`).
 *  09:00 UTC = 04:00 EST — kept one hour after the sync so reconciliation reads
 *  a settled index. MUST stay byte-equal to `wrangler.jsonc` (see sync note). */
const ALGOLIA_DRIFT_CRON = '0 9 * * *';

/** Cron expression for the daily home-stats compute (`wrangler.jsonc`, AECI-178).
 *  07:00 UTC = 02:00 EST — one hour before the Algolia sync, so the `home.*`
 *  `stats_cache` rows are fresh at the start of the US morning. MUST stay
 *  byte-equal to `wrangler.jsonc` (see sync note). */
const STATS_CRON = '0 7 * * *';

/** Cron expression for the daily moderation-queue health snapshot (`wrangler.jsonc`,
 *  AECI-206). 06:00 UTC (= 01:00 EST) — one hour before the home-stats cron, in the
 *  same dead-of-night daily window. A cheap read-only gauge (no queue / ADR 0013
 *  consumer — `queueForJob` returns `undefined`, so it always runs inline). MUST
 *  stay byte-equal to the `triggers.crons` entry in `wrangler.jsonc`. */
const MODERATION_CRON = '0 6 * * *';

/** Cron expression for the request→Linear reconciliation sweep (`wrangler.jsonc`,
 *  AECI-214 / Phase 6.7). **Every 15 minutes** — unlike the daily batch jobs, this
 *  is a tight backstop: a request whose §6.4 on-submit issue creation failed is
 *  retried within ~15 min. Queue-backed (ADR 0013) so it gets native retries. MUST
 *  stay byte-equal to the `triggers.crons` entry in `wrangler.jsonc`. */
const RECONCILE_CRON = '*/15 * * * *';

/** Cron expression for the daily §23.1 data-quality job (`wrangler.jsonc`,
 *  AECI-241 / Phase 7.6). 04:00 UTC — the §23.1 slot, two hours ahead of the
 *  06:00 moderation snapshot, in the same dead-of-night daily window. Runs the
 *  ten checks and emails the digest when they finish (~04:30 UTC). MUST stay
 *  byte-equal to the `triggers.crons` entry in `wrangler.jsonc`. */
const DATA_QUALITY_CRON = '0 4 * * *';

/** Cron expression for the WAF firewall-event poll (`wrangler.jsonc`, AECI-262 /
 *  §15.1). **Every hour** at minute 0 — it reads the *previous clock hour* of
 *  `firewallEventsAdaptiveGroups` from Cloudflare's GraphQL Analytics API and
 *  emits the `aeci.waf.ratelimit.blocked` count, so the hourly cadence matches the
 *  one-hour query window (no overlap / gaps). Queue-less like `moderation` (a
 *  cheap read-only poll). MUST stay byte-equal to the `triggers.crons` entry in
 *  `wrangler.jsonc`. */
const WAF_CRON = '0 * * * *';

/** Cron expression for the daily §7 attestation detector sweep (`wrangler.jsonc`,
 *  AECI-302 / `STAGE_2_ATTESTATIONS_SPEC.md` §7.4). 10:00 UTC = 05:00 EST — after
 *  every other daily job has settled, so a nudge describes the state the site is
 *  actually serving. The slot was picked against BOTH this branch's triggers
 *  (04:00, 06:00, 07:00, 08:00, 09:00, the every-15-minutes reconcile, and the
 *  hourly WAF poll) and `main`'s, which has added 00:15, 03:00 and 05:00 since
 *  `stage-2` forked (§1.4) — 10:00 is free on both. It co-fires with
 *  the hourly WAF poll, exactly as 04:00 and 06:00 already do: Cloudflare passes
 *  the literal cron string, so the `switch` below still discriminates. MUST stay
 *  byte-equal to the `triggers.crons` entry in `wrangler.jsonc`. */
const ATTESTATION_NOTIFY_CRON = '0 10 * * *';

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

/** Per-run heartbeat for the WAF firewall-event poll (AECI-262). One count per
 *  run with `outcome:ok|failed|skipped_no_creds` — the always-emitted `outcome:ok`
 *  series doubles as the cron-liveness signal (see docs/OBSERVABILITY.md). */
const WAF_POLL_METRIC = 'aeci.waf.poll';

/** Synthetic request so the Datadog helpers can derive a `host` tag (the cron
 *  has no incoming Request; `hostnameFromRequest` uses the URL host or falls
 *  back to the worker slug). */
function cronRequest(path: string): Request {
  return new Request(`https://aeci-api${path}`);
}

/** Map the Worker `ENV` var to the Algolia env (unset → `development`, which
 *  folds onto the preview index set — same convention as `/api/version`). */
function algoliaEnvFor(env: Env): AlgoliaEnv {
  return env.ENV ?? 'development';
}

/** A Drizzle-backed `DriftCount` (the index-drift check's injected count
 *  surface). Counts promoted products/vendors and integrations whose BOTH
 *  endpoints are promoted — the same membership filter `algolia-sync` indexes on.
 *  algolia-drift stays ORM-agnostic; only this adapter knows about D1. */
function drizzleDriftCounter(env: Env): DriftCount {
  const { db } = cronDb(env);
  return {
    product: {
      count: async ({ where }) =>
        (
          await db
            .select({ value: count() })
            .from(products)
            .where(eq(products.promotionStatus, where.promotionStatus))
        )[0]?.value ?? 0,
    },
    vendor: {
      count: async ({ where }) =>
        (
          await db
            .select({ value: count() })
            .from(vendors)
            .where(eq(vendors.promotionStatus, where.promotionStatus))
        )[0]?.value ?? 0,
    },
    integration: {
      count: async ({ where }) => {
        const promoted = db
          .select({ id: products.id })
          .from(products)
          .where(eq(products.promotionStatus, where.sourceProduct.promotionStatus));
        return (
          (
            await db
              .select({ value: count() })
              .from(integrations)
              .where(
                and(
                  inArray(integrations.sourceProductId, promoted),
                  inArray(integrations.targetProductId, promoted),
                ),
              )
          )[0]?.value ?? 0
        );
      },
    },
  };
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
 *  `emitAlgoliaSyncMetrics` / `emitHomeStatsMetrics` / `emitModerationQueueMetrics` /
 *  `emitDetectorMetrics` stay free of `ctx`/`env`/`Request` plumbing. The count +
 *  distribution + gauge shape satisfies `SyncMetricSink` / `StatsMetricSink` (count
 *  + distribution), `ModerationMetricSink` (gauge) and
 *  `AttestationNotifyMetricSink` (count + gauge) alike. */
function metricSink(
  ctx: ExecutionContext,
  env: Env,
  req: Request,
): SyncMetricSink & ModerationMetricSink & AttestationNotifyMetricSink {
  return {
    count: (metric, value, tags) => submitCount(ctx, env, req, metric, value, tags),
    distribution: (metric, value, tags) => submitDistribution(ctx, env, req, metric, value, tags),
    gauge: (metric, value, tags) => submitGauge(ctx, env, req, metric, value, tags),
  };
}

async function runAlgoliaSync(env: Env, ctx: ExecutionContext): Promise<void> {
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
    return;
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
    return;
  }

  // Per-entity outcome + records counts and the run-level duration distribution
  // (AECI-141). Shared with the promote hook so the two writers can't drift.
  emitAlgoliaSyncMetrics(metricSink(ctx, env, req), 'cron', result.entities, Date.now() - started);

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
}

async function runAlgoliaDrift(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/algolia-drift');

  // Defensive no-op: production deploys are gated on these secrets
  // (verify-worker-secrets.sh), but local/preview may legitimately lack them.
  if (!env.ALGOLIA_APP_ID || !env.ALGOLIA_ADMIN_KEY) {
    logToDatadog(ctx, env, req, {
      level: 'warn',
      message: 'aeci.algolia.index_drift.skipped_no_creds',
      source: 'algolia-drift-cron',
    });
    return;
  }

  const driftCounter = drizzleDriftCounter(env);
  const algolia = createAlgoliaCounter(env.ALGOLIA_APP_ID, env.ALGOLIA_ADMIN_KEY);
  const ddEnv = algoliaEnvFor(env);

  try {
    await reportAlgoliaDrift(
      {
        db: driftCounter,
        algolia,
        // Gauge per entity, always (0 when clean) so a no-data monitor can tell
        // "ran clean" from "didn't run".
        emitGauge: (row: AlgoliaIndexDrift) =>
          submitGauge(ctx, env, req, DRIFT_METRIC, row.drift, [
            `entity:${row.entity}`,
            `index:${row.indexName}`,
          ]),
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
    const sweep = await sweepAlgoliaOrphans(
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

    const capped = sweep.entities.filter((e) => e.skippedBySafetyCap);
    const failed = sweep.entities.filter((e) => !e.ok);
    if (sweep.totalDeleted > 0 || capped.length > 0 || failed.length > 0) {
      logToDatadog(ctx, env, req, {
        level: capped.length > 0 || failed.length > 0 ? 'warn' : 'info',
        message: `aeci.algolia.orphans_removed on ${ddEnv}: removed ${sweep.totalDeleted} orphan object(s)${
          capped.length > 0
            ? `; ${capped.length} index(es) refused by safety cap (re-run the CLI with --force)`
            : ''
        }${failed.length > 0 ? `; ${failed.length} index(es) errored` : ''}`,
        source: 'algolia-drift-cron',
        sweep: sweep.entities,
      });
    }
  } catch (error) {
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.algolia.orphans_sweep.crashed',
      source: 'algolia-drift-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runHomeStatsJob(env: Env, ctx: ExecutionContext): Promise<void> {
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
    return;
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
  emitHomeStatsMetrics(metricSink(ctx, env, req), 'cron', result, Date.now() - started);
  logToDatadog(ctx, env, req, {
    level: failed > 0 ? 'warn' : 'info',
    message: `aeci.stats.computed keys_written=${written} keys_failed=${failed} keys_skipped=${skipped}`,
    source: 'stats-cron',
    keys_written: written,
    keys_failed: failed,
    keys_skipped: skipped,
  });
}

/** Snapshot the pending-review moderation queue and emit its health gauges
 *  (AECI-206 / Phase 5.15): depth + oldest-pending age. Report-only — like the
 *  index-drift check it never mutates; the alert is the Datadog "moderation
 *  backlog" monitor. Two cheap indexed reads, so it runs inline (no queue). */
async function runModerationQueueMetrics(env: Env, ctx: ExecutionContext): Promise<void> {
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
  } catch (error) {
    // Mirror the drift/stats crash path: log loudly, never throw (a failed cron
    // must not tear down the invocation).
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.moderation.queue.crashed',
      source: 'moderation-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Run the request→Linear reconciliation sweep (AECI-214 / Phase 6.7): retry
 *  `vendor_requests` stuck `open`/`linear_issue_id=null` and alert on persistent
 *  failures. The sweep's unexpected read failures propagate so the queue re-runs
 *  it (idempotent via `createLinearIssueForRequest`). */
async function runReconcileJob(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/reconcile');
  const { db } = cronDb(env);
  await runReconciliationSweep({ env, executionCtx: ctx, req: { raw: req } }, db);
}

/** Run the daily §23.1 data-quality suite (AECI-241 / Phase 7.6): ten read-only
 *  checks → per-check gauge + job heartbeat/duration → email digest to Chris +
 *  Bill. Report-only — no auto-remediation. The Algolia-drift check (#10) reuses
 *  the AECI-140 count (`findAlgoliaIndexDrift`) when creds are present; otherwise
 *  it skips (local/preview). The email transport is fail-open: a missing
 *  `RESEND_API_KEY`/recipients logs `outcome:skipped`, the Datadog monitors are
 *  the delivery backstop. Errors per check are captured, not thrown (the suite is
 *  best-effort), so reaching the catch is a pre-run crash. */
async function runDataQualityJob(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/data-quality');
  const started = Date.now();
  const { db } = cronDb(env);

  // Reuse the AECI-140 drift count when Algolia creds are present (same posture as
  // runAlgoliaDrift); absent → the drift check skips rather than erroring.
  const appId = env.ALGOLIA_APP_ID;
  const adminKey = env.ALGOLIA_ADMIN_KEY;
  const runDrift =
    appId && adminKey
      ? () =>
          findAlgoliaIndexDrift(
            { db: drizzleDriftCounter(env), algolia: createAlgoliaCounter(appId, adminKey) },
            { env: algoliaEnvFor(env) },
          )
      : undefined;

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
    return;
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
  submitCount(ctx, env, req, DQ_JOB_METRIC, 1, ['trigger:cron', `outcome:${outcome}`]);
  submitDistribution(ctx, env, req, DQ_DURATION_METRIC, Date.now() - started, ['trigger:cron']);

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
}

/** Run the daily §7 attestation detector sweep (AECI-302): four detectors over the
 *  claim/attestation spine → vendor nudges + AECi ops alerts via Resend → an
 *  `audit_log` suppression ledger. The sweep owns its own fail-open behaviour (a
 *  Resend outage is an `outcome:failed` count, never a throw) and emits the
 *  per-detector gauge through the injected sink — including the zero case, which
 *  is this job's cron-liveness signal while no vendor has attested yet. Only an
 *  unexpected read failure reaches the catch here; the queue then retries, which
 *  is safe because the ledger makes an already-delivered nudge idempotent. */
async function runAttestationNotifyJob(env: Env, ctx: ExecutionContext): Promise<void> {
  const req = cronRequest('/cron/attestation-notify');
  const started = Date.now();
  const { db } = cronDb(env);

  try {
    const result = await runAttestationNotifySweep(
      { env, executionCtx: ctx, req: { raw: req } },
      db,
      {
        metrics: metricSink(ctx, env, req),
      },
    );
    submitCount(ctx, env, req, NOTIFY_JOB_METRIC, 1, ['trigger:cron', 'outcome:success']);
    submitDistribution(ctx, env, req, NOTIFY_DURATION_METRIC, Date.now() - started, [
      'trigger:cron',
    ]);
    logToDatadog(ctx, env, req, {
      level: result.failed > 0 ? 'warn' : 'info',
      message: `aeci.attestation.notify found=${result.found} sent=${result.sent} suppressed=${result.suppressed} failed=${result.failed} skipped=${result.skipped} capped=${result.capped}`,
      source: 'attestation-notify-cron',
    });
  } catch (error) {
    submitCount(ctx, env, req, NOTIFY_JOB_METRIC, 1, ['trigger:cron', 'outcome:failed']);
    logToDatadog(ctx, env, req, {
      level: 'error',
      message: 'aeci.attestation.notify.crashed',
      source: 'attestation-notify-cron',
      reason: error instanceof Error ? error.message : String(error),
    });
    // Rethrow so the queue consumer retries: unlike the read-only gauges, a sweep
    // that never ran means nudges nobody will ever be told about.
    throw error;
  }
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
async function runWafMetricsJob(env: Env, ctx: ExecutionContext): Promise<void> {
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
    return;
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
    return;
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
    case 'attestation_notify':
      return env.ATTESTATION_NOTIFY_QUEUE;
    case 'moderation':
      // Queue-less by design: a cheap read-only gauge needs no retry/queue, so it
      // always runs inline (AECI-206). No `MODERATION_QUEUE` binding exists.
      return undefined;
    case 'waf':
      // Queue-less like `moderation` (AECI-262): a single read-only Cloudflare
      // GraphQL read needs no retry — the next hour re-polls the next window. No
      // `WAF_QUEUE` binding exists, so it always runs inline.
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
  if (job === 'attestation_notify') {
    return {
      path: '/cron/attestation-notify',
      message: 'aeci.attestation.notify.enqueue_failed',
      source: 'attestation-notify-cron',
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

/** Dispatch a job kind to its implementation. Shared by the inline fallback and
 *  the queue consumer so both paths stay identical. */
async function runScheduledJob(env: Env, ctx: ExecutionContext, job: ScheduledJob): Promise<void> {
  switch (job) {
    case 'sync':
      await runAlgoliaSync(env, ctx);
      return;
    case 'drift':
      await runAlgoliaDrift(env, ctx);
      return;
    case 'stats':
      await runHomeStatsJob(env, ctx);
      return;
    case 'moderation':
      await runModerationQueueMetrics(env, ctx);
      return;
    case 'reconcile':
      await runReconcileJob(env, ctx);
      return;
    case 'data_quality':
      await runDataQualityJob(env, ctx);
      return;
    case 'waf':
      await runWafMetricsJob(env, ctx);
      return;
    case 'attestation_notify':
      await runAttestationNotifyJob(env, ctx);
      return;
  }
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
    case ATTESTATION_NOTIFY_CRON:
      await enqueueOrRun(env, ctx, 'attestation_notify');
      return;
    default:
      // A trigger fired with no matching case — surface it rather than silently
      // doing nothing (e.g. a wrangler.jsonc cron added without a handler).
      console.warn(`scheduled: no handler for cron "${controller.cron}"`);
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
