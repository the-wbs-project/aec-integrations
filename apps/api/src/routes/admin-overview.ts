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
 * Both live in `lib/admin-status.ts` (`runExpensiveStatusItems`), shared verbatim
 * with `GET /api/admin/system` (AECI-580) so the two screens cannot report
 * different numbers for the same check — see that file for why the flag gates
 * exactly these two and why the drift runner is invoked only once.
 */

import {
  AdminOverviewQuerySchema,
  AdminOverviewResponseSchema,
  type AdminNote,
  type AdminOverviewResponse,
} from '@aeci/shared';
import { and, count, eq, gte, isNull, lt } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrations,
  mailingList,
  pageViews,
  products,
  vendorRequests,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import {
  countAll,
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
import {
  runExpensiveStatusItems,
  statsFreshness,
  type ExpensiveStatusDeps,
} from '../lib/admin-status';
import {
  automationExclusionFor,
  collectAnalyticsMetrics,
  computeDelta,
  dailyWindows,
  humanViewsAfterAutomation,
  windowsForDay,
} from '../lib/analytics-digest';
import { HUMAN, NOT_INTERNAL as EXCLUDE_OPERATOR_TRAFFIC } from '../lib/page-view-predicates';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-summary.ts`.
type AdminContext = Context<{ Bindings: Env }>;

/** Trailing window for the overview's traffic chart (§5.1). */
const CHART_DAYS = 30;

/** Both halves of the 7-day delta. */
const WEEK_DAYS = 7;

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
    const weekW = trailingWindow(day, WEEK_DAYS);
    const priorWeekW = trailingWindow(shiftDay(day, -WEEK_DAYS), WEEK_DAYS);

    // The overview always ASKS for the internal split — showing both figures side
    // by side is the screen's job (§13 D10 constraint 2). Whether it runs depends
    // only on the var being set.
    const filter = resolveInternalFilter(c.env, true);

    // `collectAnalyticsMetrics` runs the automation detector (AECI-745), and its
    // result is an INPUT to the filtered human count below — `excluding_internal`
    // on the post-automation figure has to exclude the same rows the headline
    // subtracted. So this one read is awaited first rather than folded into the
    // fan-out; everything that does not depend on it still runs concurrently.
    //
    // Cost, recorded because it is not obvious from the call: the detector adds
    // roughly 14 D1 reads here (about seven per window, over the reported day and
    // the prior one) on every request, `?day=` and `?recompute=1` included. It is
    // bounded — `SWARM_MAX_CANDIDATES` caps the bound-parameter count and the
    // 14-day recurrence lookback rides `page_views_operator_pair_idx` — and it is
    // the price of the panel and the 05:00 email leading with one number.
    const metrics = await collectAnalyticsMetrics(db, digestWindow);
    const exclusion = automationExclusionFor(metrics.swarm);
    const net = humanViewsAfterAutomation(metrics);

    const [
      humanExcl,
      humanExclNet,
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
      countViewsExcludingInternal(db, dayW, 'human', filter),
      countViewsExcludingInternal(db, dayW, 'human', filter, exclusion),
      countViewsExcludingInternal(db, dayW, 'bot', filter),
      countUniqueVisitorsBoth(db, dayW, 'human', filter),
      trafficSeries(db, chartW),
      countHumanViews(db, weekW),
      countHumanViews(db, priorWeekW),
      countAll(db, mailingList, isNull(mailingList.unsubscribedAt)),
      countAll(db, vendorRequests, eq(vendorRequests.status, 'open')),
      catalogTotals(db),
      statsFreshness(db, now),
      trafficNotes(db, dayW, {
        unique: true,
        sources: true,
        corroborated: true,
        operatorLeak: true,
        // Explicitly passed, `null` included: this response's headline IS the
        // post-automation figure, so it owes the reader either the thresholds
        // behind it or the warning that the filter did not run.
        automation: metrics.automation,
      }),
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
      traffic: {
        // The headline, and the same one the 05:00 email leads with (AECI-745).
        // Through `humanViewsAfterAutomation` rather than an inline subtraction
        // so the two surfaces cannot grow separate definitions of it — the same
        // reason the AECI-683 figures below come straight off the collector.
        page_views_human: { total: net.day, excluding_internal: humanExclNet },
        page_views_human_raw: {
          total: metrics.pageViews.day,
          excluding_internal: humanExcl,
        },
        automation_flagged: metrics.automation?.flagged.day ?? null,
        page_views_bot: { total: metrics.botPageViews.day, excluding_internal: botExcl },
        unique_visitors: uniqueVisitors,
        // Filtered on BOTH sides — `net` carries the prior day's post-automation
        // count too, which is why the detector runs over the prior window at all.
        delta_day: computeDelta(net),
        // RAW on both sides, unlike `delta_day`, and the schema says so: a
        // filtered 7-day pair means running the detector over 14 further days on
        // every request. Two deltas with different populations side by side is a
        // real hazard — the answer is that the panel labels it, not that we
        // fabricate a filtered week out of an unfiltered one.
        delta_7d: computeDelta({ day: weekHuman, prior: priorWeekHuman }),
        series_30d: series30d,
        top_sources: metrics.referrers.map((r) => ({ source: r.source, views: r.views })),
        top_products: metrics.topProducts.map((p) => ({
          name: p.name,
          slug: p.slug,
          views: p.views,
        })),
        // Straight off `collectAnalyticsMetrics`, like `top_products` above and
        // for the same reason: recomputing them here would put a second
        // definition of "corroborated" in the codebase, and §6.10's parity
        // guarantee is only structural while the panel reads the digest's own
        // numbers rather than its own reimplementation of them.
        corroborated_views: metrics.corroboratedViews.day,
        corroborated_visitors: metrics.corroboratedVisitors,
        operator_leak_excluded: metrics.operatorLeakViews,
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
        EXCLUDE_OPERATOR_TRAFFIC,
      ),
    );
  return row?.value ?? 0;
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
    countAll(db, integrations),
    countAll(db, vendors),
    countAll(db, claims),
    countAll(db, attestations),
    countAll(db, connectorEvidencedPairs),
  ]);
  return { products: p, integrations: i + ep, vendors: v, claims: cl, attestations: at };
}
