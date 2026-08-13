/**
 * `GET /api/admin/overview` (AECI-574 / Phase 8.3 P1.1) — the §5.1 bundle in one
 * round trip. Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.1/§6,
 * `docs/API_CONTRACTS.md` §6.10.
 *
 * Admin-gated (`requireAdmin()`, registered in `index.ts` — the single
 * enforcement point) and strictly **read-only**: no `audit_log` row, no
 * `Cache-Tag`, no purge, no email, no external write. `json()` already sets
 * `private, no-store`, and `/admin/*` is absent from `ROUTE_CACHE_PATTERNS`, so a
 * cached admin response — a visitor-state leak (§9.2) — cannot happen.
 *
 * ─── Why this calls the digest instead of mirroring it ───────────────────────
 *
 * The acceptance criterion is that this endpoint's numbers are **identical** to
 * that day's 05:00 analytics digest email. The only way to make that structurally
 * true rather than periodically re-verified is to run the digest's own
 * collection: `collectAnalyticsMetrics(db, windowsForDay(day))`. Human/bot page
 * views, new sign-ins, total users, moderation depth, top products and traffic
 * sources are therefore not re-queried here — they are the email's numbers,
 * passed through. The panel-only additions (unique visitors, the 30-day series,
 * the 7-day delta, subscribers, catalog totals, the status strip) sit alongside.
 *
 * Deltas are returned structured (`computeDelta`, which `deltaText` also calls)
 * rather than as the email's prose: the semantics must match, but the panel has
 * to localize its own strings (§9.4).
 *
 * ─── The window ──────────────────────────────────────────────────────────────
 *
 * Defaults to the prior COMPLETE UTC day — the digest's window — so parity holds
 * without a query param. `?day=YYYY-MM-DD` reports any other single UTC day;
 * today's is legal and carries a `partial_day` note.
 *
 * ─── `?recompute=1` (§13 D8) ─────────────────────────────────────────────────
 *
 * The status strip's first three items are cheap D1/env reads and are always
 * present. The last two are not: the data-quality suite HTTP-probes a sample of
 * logo URLs and the Algolia drift count queries three indexes over the network.
 * Loading a dashboard should not do that on every poll, so the default response
 * returns them as `null` with a `requires_recompute` note and `?recompute=1` runs
 * them live. It remains a pure read — both jobs are already read-only, so this
 * writes nothing, sends nothing, and carries no audit obligation, which is what
 * keeps §6's "all endpoints are GET, read-only" unconditionally true. The
 * side-effecting `POST /api/admin/jobs/:job/run` stays deferred; do not add one.
 *
 * The drift runner is invoked ONCE and its result feeds both the strip and the
 * data-quality suite's `runDrift` dep — check #10 of the ten IS the drift check,
 * so running it twice would double the Algolia round trips to report one number.
 */

import {
  AdminOverviewQuerySchema,
  AdminOverviewResponseSchema,
  type AdminAlgoliaDriftStatus,
  type AdminDataQualityStatus,
  type AdminNote,
  type AdminOverviewResponse,
  type AdminStatsFreshness,
} from '@aeci/shared';
import { and, count, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  attestations,
  claims,
  integrations,
  mailingList,
  pageViews,
  products,
  statsCache,
  vendorRequests,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import {
  countUniqueVisitorsBoth,
  countViewsExcludingInternal,
  internalFilterNote,
  isPartial,
  note,
  resolveInternalFilter,
  shiftDay,
  toAdminInternalFilter,
  toAdminWindow,
  trafficNotes,
  trafficSeries,
  trailingWindow,
  utcDayWindow,
  type UtcWindow,
} from '../lib/admin-analytics';
import { createDriftRunner } from '../lib/algolia-drift-deps';
import type { AlgoliaIndexDrift } from '../lib/algolia-drift';
import {
  collectAnalyticsMetrics,
  computeDelta,
  dailyWindows,
  windowsForDay,
  HUMAN,
  NOT_INTERNAL as EXCLUDE_UNTRACKED_ROUTES,
} from '../lib/analytics-digest';
import { runDataQualityChecks } from '../lib/data-quality';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-summary.ts`.
type AdminContext = Context<{ Bindings: Env }>;

/** `stats_cache` older than this is flagged — the same 48h threshold the §23.1
 *  data-quality suite uses, so the strip and the digest agree on "stale". */
const STATS_STALE_HOURS = 48;

/** Trailing window for the overview's traffic chart (§5.1). */
const CHART_DAYS = 30;

/** Both halves of the 7-day delta. */
const WEEK_DAYS = 7;

/** Seams the specs replace: the clock, the Algolia drift runner (network), and
 *  the data-quality suite's logo probe (network). Production defaults are the
 *  real ones. */
export interface AdminOverviewDeps {
  now?: () => Date;
  driftRunnerFor?: (env: Env, db: Db) => (() => Promise<AlgoliaIndexDrift[]>) | undefined;
  fetchImpl?: typeof fetch;
}

/** `MAX(stats_cache.computed_at)` — the 07:00 home-stats cron's liveness signal.
 *  A never-run cache reports nulls rather than a fabricated age. */
async function statsFreshness(db: Db, now: Date): Promise<AdminStatsFreshness> {
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

export function createAdminOverviewHandler(
  dbFor: DbFactory = getDb,
  deps: AdminOverviewDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  const driftRunnerFor = deps.driftRunnerFor ?? createDriftRunner;

  return async (c) => {
    const query = AdminOverviewQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const { db } = dbFor(c.env);

    // Default to the digest's window (the prior COMPLETE UTC day) so the parity
    // assertion is the default behaviour, not a special case.
    const day = query.day ?? dailyWindows(now).dayLabel;
    const digestWindow = windowsForDay(day);
    const dayW = utcDayWindow(day);
    // No prior-day window is built here: the day-over-day baseline comes from
    // `collectAnalyticsMetrics`, which already counts it (`DigestWindow.priorStartIso`).
    const chartW = trailingWindow(day, CHART_DAYS);
    const weekW = trailingWindow(day, WEEK_DAYS);
    const priorWeekW = trailingWindow(shiftDay(day, -WEEK_DAYS), WEEK_DAYS);

    // The overview always ASKS for the internal split — showing both figures side
    // by side is the screen's job (§13 D10 constraint 2). Whether it runs depends
    // only on the var being set.
    const filter = resolveInternalFilter(c.env, true);

    const [
      metrics,
      humanExcl,
      botExcl,
      uniqueVisitors,
      series30d,
      weekHuman,
      priorWeekHuman,
      activeSubscribers,
      openRequests,
      catalog,
      freshness,
      notes,
    ] = await Promise.all([
      collectAnalyticsMetrics(db, digestWindow),
      countViewsExcludingInternal(db, dayW, 'human', filter),
      countViewsExcludingInternal(db, dayW, 'bot', filter),
      countUniqueVisitorsBoth(db, dayW, 'human', filter),
      trafficSeries(db, chartW),
      countHumanViews(db, weekW),
      countHumanViews(db, priorWeekW),
      countAll(db, mailingList, isNull(mailingList.unsubscribedAt)),
      countAll(db, vendorRequests, eq(vendorRequests.status, 'open')),
      catalogTotals(db),
      statsFreshness(db, now),
      trafficNotes(db, dayW, { unique: true, sources: true }),
    ]);

    const allNotes: AdminNote[] = [...notes, internalFilterNote(filter)];
    if (isPartial(dayW, now)) {
      allNotes.push(
        note(
          'partial_day',
          `${day} is not a complete UTC day yet; its figures are still filling and will not match the digest until 00:00 UTC.`,
          { day },
        ),
      );
    }

    // The two expensive status items. One drift call, two consumers.
    let dataQuality: AdminDataQualityStatus | null = null;
    let algoliaDrift: AdminAlgoliaDriftStatus | null = null;
    if (query.recompute) {
      const runDrift = driftRunnerFor(c.env, db);
      // Memoize at the PROMISE, not the value: data-quality check #10 IS the
      // Algolia drift check, so the suite and the status strip both want this
      // result and neither should pay for a second set of Algolia round trips.
      let driftPromise: Promise<AlgoliaIndexDrift[]> | undefined;
      const sharedDrift = runDrift ? () => (driftPromise ??= runDrift()) : undefined;

      const results = await runDataQualityChecks({
        db,
        now,
        runDrift: sharedDrift,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      dataQuality = {
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
      // dashboard, and the strip honestly reports "unknown" rather than "zero".
      const driftRows = driftPromise ? await driftPromise.catch(() => null) : null;

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
        allNotes.push(
          note(
            'algolia_credentials_absent',
            'ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY are unset, so index drift could not be measured.',
          ),
        );
      }
      // The remaining case — creds present, the drift call threw — needs no note:
      // the `algolia_index_drift` check in `data_quality.checks` carries the real
      // error message, and a `algolia_credentials_absent` note here would name the
      // wrong cause.
    } else {
      allNotes.push(
        note(
          'requires_recompute',
          'Data-quality checks and Algolia drift are omitted from the default view because they require network calls. Re-request with ?recompute=1.',
        ),
      );
    }

    const body: AdminOverviewResponse = {
      window: toAdminWindow(dayW),
      generated_at: now.toISOString(),
      source: 'live',
      recomputed: query.recompute,
      notes: allNotes,
      internal_filter: toAdminInternalFilter(filter),
      traffic: {
        page_views_human: { total: metrics.pageViews.day, excluding_internal: humanExcl },
        page_views_bot: { total: metrics.botPageViews.day, excluding_internal: botExcl },
        unique_visitors: uniqueVisitors,
        delta_day: computeDelta(metrics.pageViews),
        delta_7d: computeDelta({ day: weekHuman, prior: priorWeekHuman }),
        series_30d: series30d,
        top_sources: metrics.referrers.map((r) => ({ source: r.source, views: r.views })),
        top_products: metrics.topProducts.map((p) => ({
          name: p.name,
          slug: p.slug,
          views: p.views,
        })),
      },
      audience: {
        new_sign_ins: computeDelta(metrics.newUsers),
        total_users: metrics.totalUsers,
        active_subscribers: activeSubscribers,
      },
      catalog,
      status: {
        version: {
          sha: c.env.COMMIT_SHA ?? 'unknown',
          deployed_at: c.env.DEPLOYED_AT ?? new Date(0).toISOString(),
          environment: c.env.ENV ?? 'development',
        },
        stats_freshness: freshness,
        moderation: {
          pending_reviews: metrics.pendingModeration,
          open_requests: openRequests,
        },
        data_quality: dataQuality,
        algolia_drift: algoliaDrift,
      },
    };

    validateResponseInDev(c.env, () => {
      AdminOverviewResponseSchema.parse(body);
    });

    return json(body);
  };
}

/** `COUNT(*)` over an arbitrary table with an optional predicate. */
async function countAll(
  db: Db,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one shared counter across five unrelated tables; each call site is type-checked by its own `where`.
  table: any,
  where?: ReturnType<typeof eq>,
): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table).where(where);
  return row?.value ?? 0;
}

/** Human page views over a multi-day window (the 7-day delta halves), using the
 *  digest's own `HUMAN` predicate and its `/admin`+`/account` route exclusion
 *  (AECI-575) so the weekly and daily figures count the same population as the
 *  digest and the rest of the panel. */
async function countHumanViews(db: Db, w: UtcWindow): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, w.startIso),
        lt(pageViews.createdAt, w.endIso),
        HUMAN,
        EXCLUDE_UNTRACKED_ROUTES,
      ),
    );
  return row?.value ?? 0;
}

/** Live catalog totals — a snapshot as of the request, not windowed. Counts over
 *  time need the §7.1 snapshot table (P2.1); §4 explains why the event stream
 *  cannot reconstruct net totals. */
async function catalogTotals(db: Db) {
  const [p, i, v, cl, at] = await Promise.all([
    countAll(db, products),
    countAll(db, integrations),
    countAll(db, vendors),
    countAll(db, claims),
    countAll(db, attestations),
  ]);
  return { products: p, integrations: i, vendors: v, claims: cl, attestations: at };
}
