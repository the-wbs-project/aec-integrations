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
 * collection: `collectAnalyticsMetrics(db, windowsForDay(day))`. Bot page views,
 * new sign-ins, total users, moderation depth, top products and traffic sources
 * are therefore not re-queried here — they are the email's numbers, passed
 * through. The panel-only additions (unique visitors, the 30-day series,
 * subscribers, catalog totals, the status strip) sit alongside. Since AECI-1460
 * the classification block is the only population figure; the residual is gone.
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
 * Both live in `lib/admin-status.ts` (`runExpensiveStatusItems`), shared verbatim
 * with `GET /api/admin/system` (AECI-580) so the two screens cannot report
 * different numbers for the same check — see that file for why the flag gates
 * exactly these two and why the drift runner is invoked only once.
 */

import {
  AdminOverviewQuerySchema,
  AdminOverviewResponseSchema,
  type AdminClassificationPoint,
  type AdminClassificationSummary,
  type AdminNote,
  type AdminOverviewResponse,
} from '@aeci/shared';
import { isNull } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrations,
  mailingList,
  products,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import {
  countAll,
  countUniqueVisitorsBoth,
  countViewsExcludingInternal,
  enumerateDays,
  internalFilterNote,
  isPartial,
  note,
  readDegradedArrivalDays,
  resolveInternalFilter,
  shiftDay,
  toAdminInternalFilter,
  toAdminWindow,
  trafficNotes,
  trafficSeries,
  trailingWindow,
  utcDayWindow,
} from '../lib/admin-analytics';
import {
  classDeltaBlocker,
  CLASSIFICATION_UNRESOLVED_SHARE_MAX,
  readClassificationSeries,
  readClassificationSummary,
  type ClassificationSeriesRead,
  type ClassificationSummaryRead,
} from '../lib/admin-classification';
import {
  anyNotComparable,
  collectionMethodSeam,
  type CollectionMethodChange,
} from '../lib/collection-method-changes';
import {
  runExpensiveStatusItems,
  statsFreshness,
  type ExpensiveStatusDeps,
} from '../lib/admin-status';
import {
  arrivalTelemetryDegraded,
  collectAnalyticsMetrics,
  computeDelta,
  dailyWindows,
  TABLES_UNCLASSIFIED_NOTE,
  windowsForDay,
} from '../lib/analytics-digest';
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { liveEvidencedPairWhere, liveIntegrationWhere } from '../lib/live-integration';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-summary.ts`.
type AdminContext = Context<{ Bindings: Env }>;

/** Trailing window for the overview's traffic chart (§5.1). */
const CHART_DAYS = 30;

/** Seams the specs replace: the clock, plus the two network seams
 *  (`driftRunnerFor` / `fetchImpl`) that `runExpensiveStatusItems` consumes.
 *  Production defaults are the real ones. */
export interface AdminOverviewDeps extends ExpensiveStatusDeps {
  now?: () => Date;
}

export function createAdminOverviewHandler(
  dbFor: DbFactory = getDb,
  deps: AdminOverviewDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

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

    // The overview always ASKS for the internal split — showing both figures side
    // by side is the screen's job (§13 D10 constraint 2). Whether it runs depends
    // only on the var being set.
    const filter = resolveInternalFilter(c.env, true);

    // Awaited first: the class summary below reuses the collector's own class
    // read, and its operator-leak figure. Everything else runs concurrently.
    const metrics = await collectAnalyticsMetrics(db, digestWindow);
    // AECI-869. One `metrics_daily` read covering the chart window, which also
    // contains the 7-day delta's newer half. Awaited here with the metrics rather
    // than in the fan-out because both `trafficSeries` and `trafficNotes` below
    // consume it, and a second read for the second consumer is how a chart ends
    // up marking days the note did not count.
    const degradedDays = await readDegradedArrivalDays(db, chartW);

    const [
      botExcl,
      uniqueVisitors,
      series30d,
      activeSubscribers,
      queueDepths,
      catalog,
      freshness,
      notes,
      classificationDay,
      classificationSeries,
    ] = await Promise.all([
      countViewsExcludingInternal(db, dayW, 'bot', filter),
      countUniqueVisitorsBoth(db, dayW, 'human', filter),
      trafficSeries(db, chartW, degradedDays),
      countAll(db, mailingList, isNull(mailingList.unsubscribedAt)),
      // AECI-922: the same three predicates the nav badges use, from the one
      // implementation that owns them. An all-kinds `vendor_requests` count would
      // send the operator to `/admin/requests`, which is corrections-only now, with
      // a number that includes every open claim.
      readAdminQueueCounts(db),
      catalogTotals(db),
      statsFreshness(db, now),
      trafficNotes(db, dayW, {
        unique: true,
        sources: true,
        // AECI-869. The reported day's own telemetry, and the trailing window's.
        // Both, because a healthy day can sit on top of a blind month and the two
        // are different statements — see the note codes' own docblocks.
        arrivalCoverage: metrics.arrivalCoverage,
        degradedDays: { degraded: degradedDays.size, requested: chartW.days },
      }),
      // AECI-1345. The stored D19 classes for the same day. Since AECI-1346 the
      // collector reads them for the email, so the panel takes the same read and
      // the two cannot differ. A failed collector read is soft there, so the panel
      // reads again here and fails loudly, as it did before.
      metrics.classification?.day ?? readClassificationSummary(db, dayW, metrics.operatorLeakViews),
      // AECI-1346. The 30-day class chart, its seam, and the prior day the class
      // deltas compare against. One grouped read.
      readClassificationSeries(db, chartW),
    ]);

    // AECI-1346. §3d collection-method changes for this tier (`ENV`; a local run
    // matches none). Two windows, one per comparison: the chart, and the
    // day-over-day pair behind the class deltas.
    const methodChart = collectionMethodSeam(c.env.ENV, chartW);
    const methodDay = collectionMethodSeam(c.env.ENV, {
      startIso: digestWindow.priorStartIso,
      endIso: digestWindow.endIso,
    });
    const classification = withComparisons(
      classificationDay,
      classificationSeries,
      shiftDay(day, -1),
      methodChart,
      anyNotComparable(methodDay),
    );

    const allNotes: AdminNote[] = [
      ...notes,
      internalFilterNote(filter),
      ...classificationNotes(classification),
      ...methodSeamNotes(methodChart),
      ...tablesNotes(metrics.tablesUnclassified),
    ];
    if (isPartial(dayW, now)) {
      allNotes.push(
        note(
          'partial_day',
          `${day} is not a complete UTC day yet; its figures are still filling and will not match the digest until 00:00 UTC.`,
          { day },
        ),
      );
    }

    // The two expensive status items. One drift call, two consumers — shared
    // verbatim with `GET /api/admin/system` (`lib/admin-status.ts`).
    const {
      dataQuality,
      algoliaDrift,
      notes: statusNotes,
    } = await runExpensiveStatusItems(db, c.env, now, query.recompute, deps);
    allNotes.push(...statusNotes);

    const body: AdminOverviewResponse = {
      window: toAdminWindow(dayW),
      generated_at: now.toISOString(),
      source: 'live',
      recomputed: query.recompute,
      notes: allNotes,
      internal_filter: toAdminInternalFilter(filter),
      classification: classification.summary,
      classification_series_30d: classificationPoints(
        enumerateDays(chartW),
        classificationSeries,
        methodChart,
      ),
      traffic: {
        page_views_bot: { total: metrics.botPageViews.day, excluding_internal: botExcl },
        unique_visitors: uniqueVisitors,
        series_30d: series30d,
        // Straight off the collector, so the tables match the email's. Filtered by
        // class since AECI-1460; `tables_unclassified` says when they are not.
        top_sources: metrics.referrers.map((r) => ({ source: r.source, views: r.views })),
        top_products: metrics.topProducts.map((p) => ({
          name: p.name,
          slug: p.slug,
          views: p.views,
        })),
        // Straight off the collector, like every figure above it. `degraded` is
        // decided server-side so the panel, the email and the nightly
        // data-quality check cannot end up holding three thresholds (AECI-869).
        arrival_telemetry: {
          arrivals: metrics.arrivalCoverage.arrivals,
          arrivals_with_asn: metrics.arrivalCoverage.arrivalsWithAsn,
          coverage: metrics.arrivalCoverage.coverage,
          degraded: arrivalTelemetryDegraded(metrics.arrivalCoverage),
        },
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
          // Corrections and claims are counted apart because they are two screens.
          // `pending_reviews` deliberately stays on the digest's own aggregate, so
          // this tile and the 05:00 email lead with the identical number.
          open_requests: queueDepths.pending_requests,
          open_claims: queueDepths.pending_claims,
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

/**
 * The three AECI-1345 notes (`API_CONTRACTS.md` §6.10). The heuristic caveat is
 * unconditional: it says what a permanently present figure means. The other two
 * are gated, because each describes a condition that may not hold (§13 D15(b)).
 */
function classificationNotes(read: ClassificationSummaryRead): AdminNote[] {
  const out: AdminNote[] = [
    note(
      'classification_is_heuristic',
      'Traffic classes are a heuristic judgement about requests. browser_with_human_evidence means the app ran with nothing contradicting it, not that a human was present.',
    ),
  ];
  if (read.unresolvedShareExceeded) {
    out.push(
      note(
        'classification_unresolved_share',
        `${read.unresolved} of ${read.classified} classified views are unresolved, above the ${CLASSIFICATION_UNRESOLVED_SHARE_MAX * 100}% threshold.`,
        { unresolved: read.unresolved, classified: read.classified },
      ),
    );
  }
  const seam = read.summary.version_seam;
  if (seam) {
    out.push(
      note(
        'classification_version_seam',
        `The window spans a classifier change from ${seam.from_version} to ${seam.to_version} on ${seam.changed_on}. Each day is counted on its own latest version.`,
        { ...seam },
      ),
    );
  }
  return out;
}

/**
 * The day's class summary, completed with the comparisons that need more than one
 * day (AECI-1346): each class's `delta_day`, the 30-day `version_seam`, and the
 * §3d rows in the chart window.
 *
 * `version_seam` moves to the chart window because the chart spans it, and §3c
 * step 5 says a window crossing a change shows it. The counts stay single-day.
 */
function withComparisons(
  read: ClassificationSummaryRead,
  series: ClassificationSeriesRead,
  priorDay: string,
  methodChart: readonly CollectionMethodChange[],
  methodDayNotComparable: boolean,
): ClassificationSummaryRead {
  const prior = series.perDay.get(priorDay);
  const blocked = classDeltaBlocker(
    read.summary.classifier_version,
    prior?.version,
    methodDayNotComparable,
  );
  const summary: AdminClassificationSummary = {
    ...read.summary,
    counts: read.summary.counts.map((c) => ({
      ...c,
      delta_day:
        blocked || !prior ? null : computeDelta({ day: c.views, prior: prior.views[c.class] }),
    })),
    version_seam: series.versionSeam,
    method_seams: methodChart.map((r) => ({
      changed_at: r.at,
      summary: r.summary,
      arrivals_comparable: r.arrivalsComparable,
    })),
  };
  return { ...read, summary };
}

/**
 * `classification_series_30d`: one point per day of the chart window, zero-filled
 * by day. A day with no classified rows has `counts: null`, never four zeros, so
 * the chart can draw it as "Not classified".
 */
function classificationPoints(
  days: readonly string[],
  series: ClassificationSeriesRead,
  methodChart: readonly CollectionMethodChange[],
): AdminClassificationPoint[] {
  return days.map((d) => {
    const point = series.perDay.get(d);
    const onDay = methodChart.filter((r) => r.at.slice(0, 10) === d);
    // Two rows on one day: the non-comparable one decides how the boundary reads.
    const change = onDay.find((r) => !r.arrivalsComparable) ?? onDay[0];
    return {
      day: d,
      classifier_version: point?.version ?? null,
      counts: point ? { ...point.views } : null,
      method_change: change
        ? { summary: change.summary, arrivals_comparable: change.arrivalsComparable }
        : null,
    };
  });
}

/**
 * The AECI-1460 table note: gated on the reported day having no classes, when
 * `top_products` and `top_sources` are unfiltered. Same sentence as the email.
 */
function tablesNotes(unclassified: boolean): AdminNote[] {
  return unclassified ? [note('tables_unclassified', TABLES_UNCLASSIFIED_NOTE)] : [];
}

/**
 * One `collection_method_seam` note per §3d row in the chart window (AECI-1346).
 * Gated on a row being there, and unconditional once it is, per §3c step 5.
 */
function methodSeamNotes(rows: readonly CollectionMethodChange[]): AdminNote[] {
  return rows.map((r) =>
    note(
      'collection_method_seam',
      r.arrivalsComparable
        ? `Page-view collection changed at ${r.at} (${r.summary}). Arrival counts stay comparable across it.`
        : `Page-view collection changed at ${r.at} (${r.summary}). Counts either side are not comparable, so deltas across it are null.`,
      {
        changed_at: r.at,
        tier: r.tier,
        summary: r.summary,
        comparable: r.arrivalsComparable ? 'true' : 'false',
      },
    ),
  );
}

/** Live catalog totals — a snapshot as of the request, not windowed. Counts over
 *  time need the §7.1 snapshot table (P2.1); §4 explains why the event stream
 *  cannot reconstruct net totals.
 *
 *  A SECOND, independent implementation of `catalogTotals` — the exported one in
 *  `lib/admin-catalog.ts` is the other, and this module-local function shadows it.
 *  Both are unnamed in §13.5's ten-site list and both must count the evidenced
 *  table (AECI-721), or the overview and the catalog screen disagree with each
 *  other about how many integrations exist, which is worse than either being
 *  wrong alone. Collapsing the duplication is worth doing; it is not this
 *  migration's job, and doing it here would hide the lockstep edit in a refactor. */
async function catalogTotals(db: Db) {
  const [p, i, v, cl, at, ep] = await Promise.all([
    countAll(db, products),
    // Live rows only, in both tables (AECI-1010, AECI-1091).
    countAll(db, integrations, liveIntegrationWhere),
    countAll(db, vendors),
    countAll(db, claims),
    countAll(db, attestations),
    countAll(db, connectorEvidencedPairs, liveEvidencedPairWhere),
  ]);
  return { products: p, integrations: i + ep, vendors: v, claims: cl, attestations: at };
}
