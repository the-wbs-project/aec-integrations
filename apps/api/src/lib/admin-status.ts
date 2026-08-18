/**
 * Admin-panel status items shared by the §5.1 status strip
 * (`routes/admin-overview.ts`) and the §5.6 System bundle
 * (`routes/admin-system.ts`): the `stats_cache` freshness read, and the two
 * **network-dependent** items behind `?recompute=1`. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §6, §13 **D8**.
 *
 * It lives in one place for the same reason `/overview` *calls*
 * `collectAnalyticsMetrics` instead of mirroring its queries (§6, P1.1 note 1):
 * two screens reporting the same number must not be able to disagree. Both
 * endpoints expose the identical `?recompute=1` contract, so they run the
 * identical code.
 *
 * ─── Why `?recompute=1` gates these two and nothing else ─────────────────────
 *
 * The line D8 draws is **side effects, not manual-ness**: `runDataQualityChecks`
 * and `findAlgoliaIndexDrift` are already pure reads, so re-running them writes
 * nothing, sends nothing, and carries no `audit_log` obligation — which is what
 * keeps §6's "all endpoints are GET, read-only" and §9.3 unconditionally true.
 * What makes them special is **network cost**, not mutation: the data-quality
 * suite HTTP-probes a sample of logo URLs (check #9) and drift costs three
 * Algolia queries. Loading a dashboard should not do that on every poll.
 *
 * ─── What the default view shows since AECI-583 ──────────────────────────────
 *
 * The two items now diverge, and the reason is where the answer can be READ from
 * rather than how much it costs to compute:
 *
 * - **Data quality is served from storage.** The 04:00 cron persists its whole
 *   result set in `job_runs.detail` (§7.2), so the default replays the last
 *   completed run — tagged `source: 'job_runs'` with its own `computed_at` — and
 *   `?recompute=1` is the refresh. Nothing is fabricated: an environment where
 *   the cron has never run still gets `null`.
 * - **Algolia drift stays `null` by default.** The 09:00 run does store its drift
 *   rows, but serving those here would put two differently-aged drift numbers on
 *   one screen (the stored 09:00 count and the live recompute) on a page whose
 *   whole premise is knowing where a number came from. Left to the recompute.
 *
 * Both cases keep the single `requires_recompute` note, whose prose is true
 * either way.
 *
 * The side-effecting `POST /api/admin/jobs/:job/run` stays **deferred** (§13 D8).
 * Do not add one here.
 *
 * ─── One drift call, two consumers ───────────────────────────────────────────
 *
 * Data-quality check #10 **is** the Algolia drift check, and the status strip
 * wants the same numbers. Memoizing at the PROMISE (not the resolved value) lets
 * the suite and the strip share a single set of Algolia round trips even though
 * they consume it concurrently.
 */

import {
  AdminDataQualityCheckSchema,
  type AdminAlgoliaDriftStatus,
  type AdminDataQualityCheck,
  type AdminDataQualityStatus,
  type AdminNote,
  type AdminStatsFreshness,
} from '@aeci/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../db/client';
import { statsCache } from '../db/schema';
import type { Env } from '../env';
import { note } from './admin-analytics';
import type { AlgoliaIndexDrift } from './algolia-drift';
import { createDriftRunner } from './algolia-drift-deps';
import type { DataQualityCheckResult } from './data-quality';
import { runDataQualityChecks } from './data-quality';
import { latestCompletedJobRun } from './job-runs';

/** `stats_cache` older than this is flagged — the same 48h threshold the §23.1
 *  data-quality suite uses (`data-quality.ts` `STATS_STALE_HOURS`), so the two
 *  admin screens and the 04:00 digest agree on what "stale" means. */
const STATS_STALE_HOURS = 48;

/**
 * `MAX(stats_cache.computed_at)` — the 07:00 home-stats cron's liveness signal,
 * reported identically by the §5.1 status strip and the §5.6 System screen.
 *
 * A never-run cache reports `computed_at: null` / `age_hours: null` rather than a
 * fabricated age, and `stale: true` — absent data is not fresh data.
 */
export async function statsFreshness(db: Db, now: Date): Promise<AdminStatsFreshness> {
  const [row] = await db
    .select({ computedAt: sql<string | null>`max(${statsCache.computedAt})` })
    .from(statsCache);
  const computedAt = row?.computedAt ?? null;
  if (!computedAt) return { computed_at: null, age_hours: null, stale: true };
  const ageHours = (now.getTime() - Date.parse(computedAt)) / 3_600_000;
  return {
    computed_at: computedAt,
    age_hours: Math.round(ageHours * 10) / 10,
    stale: ageHours > STATS_STALE_HOURS,
  };
}

/**
 * The stored form of a data-quality run's `job_runs.detail.checks`.
 *
 * Parsed with the SAME schema the response is validated against, which is what
 * makes the §7.2 round-trip a guarantee rather than a convention: if
 * `DataQualityCheckResult` and `AdminDataQualityCheckSchema` ever drift apart,
 * this parse starts failing instead of silently shipping a mis-shaped payload.
 * `.min(1)` because a stored run with zero checks is a malformed record, not a
 * clean one.
 */
const StoredDataQualityChecksSchema = z.array(AdminDataQualityCheckSchema).min(1);

/**
 * Project a check result set into the wire status. One mapper, both callers (the
 * stored replay and the live recompute), so "what the 04:00 email reports and
 * what §5.6 renders come from the same result" is enforced by construction.
 *
 * `failing` is derived here rather than stored, so a change to its definition
 * needs no backfill.
 */
export function toDataQualityStatus(
  checks: readonly (DataQualityCheckResult | AdminDataQualityCheck)[],
  meta: { source: 'job_runs' | 'live'; computedAt: string | null },
): AdminDataQualityStatus {
  return {
    source: meta.source,
    computed_at: meta.computedAt,
    // A skipped check (no creds) is not a failure — only findings and errors are.
    failing: checks.filter((c) => c.error !== undefined || c.count > 0).length,
    checks: checks.map((c) => ({
      id: c.id,
      label: c.label,
      severity: c.severity,
      count: c.count,
      sample: c.sample,
      ...(c.note ? { note: c.note } : {}),
      ...(c.skipped ? { skipped: c.skipped } : {}),
      ...(c.error ? { error: c.error } : {}),
    })),
  };
}

/**
 * The last data-quality result the 04:00 cron stored (§7.2 / AECI-583).
 *
 * Three-way, because "never ran" and "ran, and the record is corrupt" are
 * different facts an operator needs told apart: `null` = no stored run,
 * `'unreadable'` = a row exists but its `checks` payload did not parse.
 *
 * The underlying read takes the newest **completed** run that stored a `checks`
 * payload, not simply the newest row — the 04:00 job is in flight for its first
 * minutes (no `detail`), and a run that crashed before producing its checks
 * stores a `{ job, reason }` envelope (non-null `detail`, no `checks`). Either
 * would otherwise shadow yesterday's stored result; `requireDetailKey` steps past
 * both so `'unreadable'` stays reserved for a genuinely corrupt checks payload,
 * not a job failure (which the cron-liveness row already reports).
 */
export async function latestStoredDataQuality(
  db: Db,
): Promise<{ checks: AdminDataQualityCheck[]; computedAt: string | null } | 'unreadable' | null> {
  const row = await latestCompletedJobRun(db, 'data-quality', { requireDetailKey: 'checks' });
  if (!row) return null;

  // The payload crossed a process boundary — parse it, never assume it. Same
  // posture `algoliaWatermark()` takes toward `stats_cache.value`.
  const detail = row.detail;
  const checks =
    detail && typeof detail === 'object' && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)['checks']
      : undefined;

  const parsed = StoredDataQualityChecksSchema.safeParse(checks);
  // All-or-nothing: filtering to the checks that happen to parse would report a
  // partial suite as a complete one and understate `failing`.
  if (!parsed.success) return 'unreadable';

  return { checks: parsed.data, computedAt: row.finishedAt };
}

/** Test seams. Production defaults are the real drift runner and global `fetch`. */
export interface ExpensiveStatusDeps {
  /** Swapped in specs to avoid the network; production is `createDriftRunner`. */
  driftRunnerFor?: (env: Env, db: Db) => (() => Promise<AlgoliaIndexDrift[]>) | undefined;
  /** Injected into data-quality check #9's logo probe. */
  fetchImpl?: typeof fetch;
}

export interface ExpensiveStatusResult {
  /** The ten §23.1 checks; null when `recompute` was false. */
  dataQuality: AdminDataQualityStatus | null;
  /** Per-index Algolia drift; null when `recompute` was false, when credentials
   *  are absent, or when the drift call threw. */
  algoliaDrift: AdminAlgoliaDriftStatus | null;
  /** Notes to merge into the response envelope. */
  notes: AdminNote[];
}

/**
 * Run (or deliberately skip) the data-quality suite and the Algolia drift count.
 *
 * `recompute === false` returns both as `null` plus a single `requires_recompute`
 * note — the default dashboard response. `recompute === true` runs both, sharing
 * one drift call.
 */
export async function runExpensiveStatusItems(
  db: Db,
  env: Env,
  now: Date,
  recompute: boolean,
  deps: ExpensiveStatusDeps = {},
): Promise<ExpensiveStatusResult> {
  if (!recompute) {
    const stored = await latestStoredDataQuality(db);
    const notes: AdminNote[] = [
      note(
        'requires_recompute',
        'Algolia index drift is not measured on load because it costs three Algolia queries, and the data-quality checks shown are the last stored scheduled run rather than a fresh one. Re-request with ?recompute=1 to run both live.',
      ),
    ];
    if (stored === 'unreadable') {
      notes.push(
        note(
          'stored_result_unreadable',
          'The last data-quality run stored a payload this endpoint could not parse, so the checks are omitted rather than partially reported.',
          { job: 'data-quality' },
        ),
      );
    }
    return {
      dataQuality:
        stored && stored !== 'unreadable'
          ? toDataQualityStatus(stored.checks, {
              source: 'job_runs',
              computedAt: stored.computedAt,
            })
          : null,
      algoliaDrift: null,
      notes,
    };
  }

  const notes: AdminNote[] = [];
  const runDrift = (deps.driftRunnerFor ?? createDriftRunner)(env, db);

  // Memoize at the PROMISE, not the value: data-quality check #10 IS the Algolia
  // drift check, so the suite and the caller's own drift panel both want this
  // result and neither should pay for a second set of Algolia round trips.
  let driftPromise: Promise<AlgoliaIndexDrift[]> | undefined;
  const sharedDrift = runDrift ? () => (driftPromise ??= runDrift()) : undefined;

  const results = await runDataQualityChecks({
    db,
    now,
    runDrift: sharedDrift,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const dataQuality = toDataQualityStatus(results, {
    source: 'live',
    computedAt: now.toISOString(),
  });

  // A drift call that threw is already reported as an errored check inside
  // `results`; swallowing it here keeps a flaky Algolia from 500-ing the whole
  // dashboard, and the caller honestly reports "unknown" rather than "zero".
  const driftRows = driftPromise ? await driftPromise.catch(() => null) : null;

  let algoliaDrift: AdminAlgoliaDriftStatus | null = null;
  if (driftRows) {
    algoliaDrift = {
      drifted: driftRows.filter((r) => r.drift !== 0).length,
      indexes: driftRows.map((r) => ({
        entity: r.entity,
        index_name: r.indexName,
        database: r.database,
        algolia: r.algolia,
        drift: r.drift,
      })),
    };
  } else if (!runDrift) {
    notes.push(
      note(
        'algolia_credentials_absent',
        'ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY are unset, so index drift could not be measured.',
      ),
    );
  }
  // The remaining case — creds present, the drift call threw — needs no note: the
  // `algolia_index_drift` check in `dataQuality.checks` carries the real error
  // message, and an `algolia_credentials_absent` note here would name the wrong
  // cause.

  return { dataQuality, algoliaDrift, notes };
}
