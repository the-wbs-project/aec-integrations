/**
 * `GET /api/admin/system` (AECI-580 / Phase 8.3 P1.6) — the §5.6 bundle:
 * "effectively the daily procedure in `POST_LAUNCH_MONITORING.md` turned into one
 * screen". Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.6/§6,
 * `docs/API_CONTRACTS.md` §6.10.
 *
 * Admin-gated (`requireAdmin()`, registered in `index.ts` — the single
 * enforcement point) and strictly **read-only**: no `audit_log` row, no
 * `Cache-Tag`, no purge, no email, no external write. `json()` already sets
 * `private, no-store`, and `/admin/*` is absent from `ROUTE_CACHE_PATTERNS`, so a
 * cached admin response — a visitor-state leak (§9.2) — cannot happen.
 *
 * ─── The design constraint: never report "fine" for want of data ─────────────
 *
 * AECI-583 (§7.2 `job_runs`) closed most of the gap this screen was built around,
 * but the constraint that shaped the response is unchanged — a status screen that
 * reports "fine" because it has no data is worse than one that reports nothing:
 *
 *   1. **Cron liveness** is read from `job_runs`, which every cron writes on entry
 *      and completes on exit. Three things stay deliberately un-green.
 *      `source: 'derived'` survives as the fallback for a job that has not run
 *      since instrumentation deployed ({@link CRON_DERIVATIONS}) and still reports
 *      `last_outcome: null`, because a `stats_cache` stamp proves the job RAN, not
 *      that it SUCCEEDED. A job with neither is `'unknown'`. And an OPEN row
 *      (`finished_at IS NULL` — in flight, or an isolate reclaimed mid-run) reports
 *      `run_state: 'in_flight'` with a null outcome *whatever is stored*, so an
 *      unfinished run structurally cannot render as `'ok'`.
 *   2. **The orphan sweep** is read from the 09:00 drift run's `job_runs.detail`.
 *      `null` means no completed run has stored one — never "clean".
 *   3. **D1 size.** Read from D1's own `meta.size_after`; `null` where that is
 *      unavailable rather than estimated from the row counts.
 *
 * Everything crossing the `job_runs` boundary is treated as untrusted: another
 * process wrote it, so stamps are normalized through `Date`, outcomes are narrowed
 * against the enum, and stored payloads are Zod-parsed with a
 * `stored_result_unreadable` note on failure rather than partially reported.
 *
 * ─── The SSR half of the version pair is NOT here ────────────────────────────
 *
 * `version` is the **API Worker's** build metadata, identical to what
 * `GET /api/version` returns (same Worker, same `COMMIT_SHA` / `DEPLOYED_AT` /
 * `ENV` vars). The SSR Worker's SHA is unreachable from this process — the SSR
 * Worker forwards `/api/*` untouched — which is precisely why `/_version` exists
 * as a separate, unproxied endpoint (AECI-92). The UI fetches both and compares;
 * a stale SSR deploy is invisible if you render only one.
 *
 * ─── `?recompute=1` (§13 D8) ─────────────────────────────────────────────────
 *
 * The default view now serves the ten data-quality checks from the last stored
 * 04:00 run (`source: 'job_runs'` + its own `computed_at`); the recompute runs
 * them — and the Algolia drift count, which has no default — live. Both go
 * through the same `runExpensiveStatusItems` the §5.1 status strip uses, so the
 * two screens cannot disagree about a check on either path. Still a pure read: it
 * writes nothing (including no `job_runs` row), sends nothing, and carries no
 * audit obligation. The side-effecting `POST /api/admin/jobs/:job/run` stays
 * deferred; do not add one.
 */

import {
  AdminSystemQuerySchema,
  AdminSystemResponseSchema,
  type AdminAlgoliaWatermark,
  type AdminCronJob,
  type AdminCronRun,
  type AdminNote,
  type AdminOrphanSweepStatus,
  type AdminSystemResponse,
  type AdminTableCount,
} from '@aeci/shared';
import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';

import { getDb, type Db } from '../db/client';
import { statsCache } from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import { note } from '../lib/admin-analytics';
import {
  runExpensiveStatusItems,
  statsFreshness,
  type ExpensiveStatusDeps,
} from '../lib/admin-status';
import { ALGOLIA_WATERMARK_KEY } from '../lib/algolia-sync';
import { CRON_JOBS, CRON_SCHEDULES } from '../lib/cron-schedules';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { latestJobRuns, orphanSweepDetail, type JobRunRow } from '../lib/job-runs';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-overview.ts`.
type AdminContext = Context<{ Bindings: Env }>;

/** Seams the specs replace: the clock, the two network seams that
 *  `runExpensiveStatusItems` consumes, and the D1 size probe (whose value comes
 *  from a D1-only response field). Production defaults are the real ones. */
export interface AdminSystemDeps extends ExpensiveStatusDeps {
  now?: () => Date;
  /** Returns the D1 file size in bytes, or null when unknowable. */
  dbSizeProbe?: (db: Db) => Promise<number | null>;
}

/**
 * The only two crons whose last run leaves a trace in D1 *other than* its
 * `job_runs` row, and what to read it from.
 *
 * Since AECI-583 this is a **fallback, not the primary source**: a `job_runs` row
 * always wins. It earns its keep in exactly one window — between a deploy and a
 * job's first instrumented run — and deleting it would make all eight rows read
 * "unknown" for up to 24 hours after every deploy, which is a regression against
 * what P1.6 already showed.
 *
 * Both are `stats_cache` rows, and both are honest about what they prove: the row
 * exists because the job wrote it, so the timestamp is a real "it ran at". Not
 * "it succeeded" — `runHomeStats` is per-key best-effort and `runDailySync`
 * advances the fence per entity, so a partially-failed run still stamps a row.
 * Hence `last_outcome: null` on these rows.
 */
const CRON_DERIVATIONS: Partial<Record<AdminCronJob, string>> = {
  // The 07:00 job upserts the twelve `home.*` keys; the newest stamp across the
  // table is its liveness signal (the same read the §5.1 strip reports).
  'home-stats': 'stats_cache.computed_at',
  // The 08:00 sync upserts the singleton watermark row after pushing.
  'algolia-sync': `stats_cache['${ALGOLIA_WATERMARK_KEY}'].computed_at`,
};

/**
 * Table names that are never user data: SQLite internals (`sqlite_%`),
 * Cloudflare D1 internals (`_cf_%`), and the per-database migration ledger.
 * Byte-equal to `apps/datatool/src/introspect.ts`'s predicate — the other place
 * in the repo that enumerates D1's user tables.
 */
const EXCLUDE_TABLES_SQL = sql`name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`;

/**
 * **D1 compiles SQLite with `SQLITE_MAX_COMPOUND_SELECT = 5`.** A sixth `UNION
 * ALL` term fails at runtime with `D1_ERROR: too many terms in compound SELECT`.
 *
 * This is NOT catchable by the specs: `test/d1.ts` runs better-sqlite3, which
 * ships the stock limit of 500, so a single 28-term union passes every unit test
 * and 500s on the first real request. Found exactly that way against local D1
 * (AECI-580) and measured by bisecting term counts through
 * `wrangler d1 execute --local`. Keep the chunking, and keep this number at 5.
 */
const D1_MAX_COMPOUND_SELECT = 5;

/** The stored orphan-sweep half of a `job_runs.detail` payload. Zod rather than a
 *  cast: another process wrote it, and `validateResponseInDev` would throw on a
 *  mis-shaped response only in dev — production would just ship it. */
const StoredOrphanSweepSchema = z.union([
  z.object({
    ran: z.literal(true),
    ok: z.boolean(),
    totalOrphans: z.number().int().nonnegative(),
    totalDeleted: z.number().int().nonnegative(),
    entities: z.array(
      z.object({
        entity: z.string().min(1),
        indexName: z.string().min(1),
        indexCount: z.number().int().nonnegative(),
        promotedCount: z.number().int().nonnegative(),
        orphans: z.number().int().nonnegative(),
        deleted: z.number().int().nonnegative(),
        skippedBySafetyCap: z.boolean(),
        ok: z.boolean(),
        error: z.string().optional(),
      }),
    ),
  }),
  z.object({ ran: z.literal(false), reason: z.string() }),
]);

const CRON_OUTCOMES = new Set(['ok', 'failed', 'skipped']);

/** Narrow a stored `job_runs.outcome` to the wire enum. Anything else — a value
 *  from a newer writer, a hand-edited row — reads as "no outcome" rather than
 *  being passed through and failing response validation. */
function isOutcome(value: string | null): value is 'ok' | 'failed' | 'skipped' {
  return value !== null && CRON_OUTCOMES.has(value);
}

/**
 * Normalize a writer-controlled timestamp to ISO-8601, or null.
 *
 * `AdminCronRunSchema.last_run_at` is `z.string().datetime()`, and
 * `validateResponseInDev` throws on a violation *in dev only* — production would
 * ship the bad value. Routing every stamp that crosses the `job_runs` boundary
 * through `Date` makes that unrepresentable, and an unparseable stamp drops the
 * row to the `derived`/`unknown` branch, which is the honest reading.
 */
function isoOrNull(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `finished_at − started_at`, or null while in flight. Clamped at ≥ 0: the
 *  schema requires non-negative, and a clock skew between two writes must not
 *  500 the whole screen. */
function durationMs(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
}

/**
 * Per-table row counts for every user table.
 *
 * Enumerating `sqlite_master` rather than walking the Drizzle schema keeps the
 * screen honest about what is actually in the database — a table created by a
 * migration but not yet modelled still shows up — and matches `datatool`'s
 * runtime-introspection precedent.
 *
 * The names are then interpolated into `UNION ALL`s of `COUNT(*)`, batched at
 * {@link D1_MAX_COMPOUND_SELECT} and issued concurrently: ~6 round trips for the
 * current ~28 tables rather than one per table. The interpolation is over raw
 * identifiers and is safe for the same reason `apps/datatool/src/copy.ts`
 * documents — the names come from `sqlite_master`, i.e. from the database's own
 * schema, never from user input.
 */
async function tableCounts(db: Db): Promise<AdminTableCount[]> {
  const tables = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND ${EXCLUDE_TABLES_SQL} ORDER BY name`,
  );
  const names = tables.map((t) => t.name);
  if (names.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += D1_MAX_COMPOUND_SELECT) {
    chunks.push(names.slice(i, i + D1_MAX_COMPOUND_SELECT));
  }

  const results = await Promise.all(
    chunks.map((chunk) => {
      const union = chunk
        .map((name) => `SELECT '${name.replaceAll("'", "''")}' AS t, COUNT(*) AS n FROM "${name}"`)
        .join(' UNION ALL ');
      return db.all<{ t: string; n: number }>(sql.raw(union));
    }),
  );

  // Re-sort: the chunks resolve out of order and UNION ALL does not guarantee
  // branch order back either.
  return results
    .flat()
    .map((r) => ({ table: r.t, rows: Number(r.n) }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * D1 reports the post-query database size on every response's `meta.size_after`
 * — there is no supported `PRAGMA page_count` on D1, so this is the size read.
 * `db.run(sql\`SELECT 1\`)` is the cheapest carrier (the same probe
 * `routes/health.ts` already uses).
 *
 * Returns null wherever the field is absent — notably the better-sqlite3 test
 * harness, whose `run()` returns a `RunResult` with no `meta`. Null renders as
 * "unknown"; it is never approximated.
 */
async function probeDbSize(db: Db): Promise<number | null> {
  try {
    const result = (await db.run(sql`SELECT 1`)) as unknown as {
      meta?: { size_after?: number };
    };
    const size = result?.meta?.size_after;
    return typeof size === 'number' && Number.isFinite(size) ? size : null;
  } catch {
    // A size read must never take the screen down; the whole page is diagnostic.
    return null;
  }
}

/** The incremental sync's watermark row, or null when it has never been written
 *  (a fresh database / a tier where the sync has not yet run). Null, not epoch —
 *  "never ran" and "ran, cursor at epoch" are different facts. */
async function algoliaWatermark(db: Db): Promise<AdminAlgoliaWatermark | null> {
  const [row] = await db
    .select({ value: statsCache.value, computedAt: statsCache.computedAt })
    .from(statsCache)
    .where(eq(statsCache.key, ALGOLIA_WATERMARK_KEY));
  if (!row) return null;

  // `value` is JSON-moded (`Record<IndexEntity, string>`), but this is a
  // diagnostic screen reading a row another job wrote — treat the shape as
  // untrusted rather than assuming it.
  const raw = row.value;
  const entities =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>)
          .map(([entity, watermark]) => ({
            entity,
            watermark: typeof watermark === 'string' ? watermark : null,
          }))
          .sort((a, b) => a.entity.localeCompare(b.entity))
      : [];

  return { computed_at: row.computedAt, entities };
}

/**
 * One liveness row per cron. All eight are always present — omitting a job would
 * read as "not configured", a different and wrong claim from "we have no record
 * of its last run".
 */
async function cronRuns(
  db: Db,
  runs: Partial<Record<AdminCronJob, JobRunRow>>,
): Promise<AdminCronRun[]> {
  const [statsRow] = await db
    .select({ computedAt: sql<string | null>`max(${statsCache.computedAt})` })
    .from(statsCache);
  const [watermarkRow] = await db
    .select({ computedAt: statsCache.computedAt })
    .from(statsCache)
    .where(eq(statsCache.key, ALGOLIA_WATERMARK_KEY));

  const derivedAt: Partial<Record<AdminCronJob, string | null>> = {
    'home-stats': statsRow?.computedAt ?? null,
    'algolia-sync': watermarkRow?.computedAt ?? null,
  };

  return CRON_JOBS.map((job): AdminCronRun => {
    // A real recorded run beats an inference, always. `CRON_DERIVATIONS` survives
    // as the fallback for a job that has not run since AECI-583 deployed —
    // deleting it would make all eight read "unknown" for up to 24h after every
    // deploy, a regression against P1.6.
    const run = runs[job];
    const startedAt = run ? isoOrNull(run.startedAt) : null;
    if (run && startedAt) {
      const finishedAt = isoOrNull(run.finishedAt);
      return {
        job,
        schedule: CRON_SCHEDULES[job],
        source: 'job_runs',
        last_run_at: startedAt,
        // An OPEN row can never carry an outcome, even if one is somehow stored.
        // That is what makes "an in-flight run never renders as ok" structural
        // rather than incidental. An unrecognized stored value is null too — the
        // writer is another process, so the value is untrusted.
        last_outcome: finishedAt && isOutcome(run.outcome) ? run.outcome : null,
        duration_ms: durationMs(startedAt, finishedAt),
        derived_from: null,
        run_state: finishedAt ? 'complete' : 'in_flight',
      };
    }

    const derivedFrom = CRON_DERIVATIONS[job];
    const lastRunAt = derivedAt[job] ?? null;
    // `derived` only when the artifact actually exists. A configured derivation
    // whose row has never been written is still `unknown` — an absent stamp is
    // not evidence of anything.
    const isDerived = derivedFrom !== undefined && lastRunAt !== null;
    return {
      job,
      schedule: CRON_SCHEDULES[job],
      source: isDerived ? ('derived' as const) : ('unknown' as const),
      last_run_at: isDerived ? lastRunAt : null,
      // A derived timestamp attests to the run, not to its outcome — so these
      // stay null even though `job_runs` now exists.
      last_outcome: null,
      duration_ms: null,
      derived_from: isDerived ? (derivedFrom ?? null) : null,
      run_state: null,
    };
  });
}

/**
 * The last 09:00 drift run's orphan sweep, or null when no completed run has
 * stored one. Reads the `algolia-drift` row already fetched for the liveness
 * table — no extra query.
 *
 * Returns `'unreadable'` (rather than null) when a payload exists but does not
 * parse, so the caller can say so with a note instead of implying "never ran".
 */
function orphanSweepStatus(
  run: JobRunRow | undefined,
): AdminOrphanSweepStatus | 'unreadable' | null {
  const sweep = run ? orphanSweepDetail(run.detail) : null;
  if (!sweep) return null;
  const parsed = StoredOrphanSweepSchema.safeParse(sweep);
  if (!parsed.success) return 'unreadable';
  // A sweep that threw before producing results is a record of "it did not run",
  // which is what null already means here — surface the counts only.
  if (!parsed.data.ran) return null;

  return {
    ran_at: run ? isoOrNull(run.finishedAt) : null,
    ok: parsed.data.ok,
    total_orphans: parsed.data.totalOrphans,
    total_deleted: parsed.data.totalDeleted,
    capped: parsed.data.entities.filter((e) => e.skippedBySafetyCap).length,
    indexes: parsed.data.entities.map((e) => ({
      entity: e.entity,
      index_name: e.indexName,
      index_count: e.indexCount,
      promoted_count: e.promotedCount,
      orphans: e.orphans,
      deleted: e.deleted,
      skipped_by_safety_cap: e.skippedBySafetyCap,
      ok: e.ok,
      ...(e.error ? { error: e.error } : {}),
    })),
  };
}

export function createAdminSystemHandler(
  dbFor: DbFactory = getDb,
  deps: AdminSystemDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  const sizeProbe = deps.dbSizeProbe ?? probeDbSize;

  return async (c) => {
    const query = AdminSystemQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const now = clock();
    const { db } = dbFor(c.env);

    // One `job_runs` read feeds both the liveness table and the orphan sweep.
    const runs = await latestJobRuns(db, CRON_JOBS);

    const [crons, watermark, tables, sizeBytes, freshness, expensive] = await Promise.all([
      cronRuns(db, runs),
      algoliaWatermark(db),
      tableCounts(db),
      sizeProbe(db),
      statsFreshness(db, now),
      runExpensiveStatusItems(db, c.env, now, query.recompute, deps),
    ]);

    const notes: AdminNote[] = [...expensive.notes];

    const unknownCrons = crons.filter((r) => r.source === 'unknown').length;
    if (unknownCrons > 0) {
      notes.push(
        note(
          'cron_liveness_unavailable',
          `${unknownCrons} of ${crons.length} scheduled jobs have no job_runs row yet — they have not run since run recording shipped, or they were added since. Datadog's no-data monitors remain the authority for "a job stopped firing".`,
          { unknown: unknownCrons, total: crons.length },
        ),
      );
    }

    // The `orphan_sweep_not_persisted` note is gone: AECI-583 persists the sweep
    // in the 09:00 run's `job_runs.detail`, so claiming it is unrecorded would now
    // be false. A null `orphan_sweep` means no completed drift run has stored one.
    const sweep = orphanSweepStatus(runs['algolia-drift']);
    if (sweep === 'unreadable') {
      notes.push(
        note(
          'stored_result_unreadable',
          'The last index-drift run stored an orphan-sweep payload this endpoint could not parse, so it is omitted rather than partially reported.',
          { job: 'algolia-drift' },
        ),
      );
    }

    const body: AdminSystemResponse = {
      generated_at: now.toISOString(),
      source: 'live',
      recomputed: query.recompute,
      notes,
      version: {
        sha: c.env.COMMIT_SHA ?? 'unknown',
        deployed_at: c.env.DEPLOYED_AT ?? new Date(0).toISOString(),
        environment: c.env.ENV ?? 'development',
      },
      crons,
      data_quality: expensive.dataQuality,
      algolia: {
        watermark,
        drift: expensive.algoliaDrift,
        orphan_sweep: sweep === 'unreadable' ? null : sweep,
      },
      database: { size_bytes: sizeBytes, tables },
      stats_freshness: freshness,
    };

    validateResponseInDev(c.env, () => {
      AdminSystemResponseSchema.parse(body);
    });

    return json(body);
  };
}
