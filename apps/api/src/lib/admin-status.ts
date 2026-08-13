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
 * Algolia queries. Loading a dashboard should not do that on every poll, so they
 * are `null` + a `requires_recompute` note by default.
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

import type {
  AdminAlgoliaDriftStatus,
  AdminDataQualityStatus,
  AdminNote,
  AdminStatsFreshness,
} from '@aeci/shared';
import { sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { statsCache } from '../db/schema';
import type { Env } from '../env';
import { note } from './admin-analytics';
import type { AlgoliaIndexDrift } from './algolia-drift';
import { createDriftRunner } from './algolia-drift-deps';
import { runDataQualityChecks } from './data-quality';

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
    return {
      dataQuality: null,
      algoliaDrift: null,
      notes: [
        note(
          'requires_recompute',
          'Data-quality checks and Algolia drift are omitted from the default view because they require network calls. Re-request with ?recompute=1.',
        ),
      ],
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

  const dataQuality: AdminDataQualityStatus = {
    // A skipped check (no creds) is not a failure — only findings and errors are.
    failing: results.filter((r) => r.error !== undefined || r.count > 0).length,
    checks: results.map((r) => ({
      id: r.id,
      label: r.label,
      severity: r.severity,
      count: r.count,
      sample: r.sample,
      ...(r.note ? { note: r.note } : {}),
      ...(r.skipped ? { skipped: r.skipped } : {}),
      ...(r.error ? { error: r.error } : {}),
    })),
  };

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
