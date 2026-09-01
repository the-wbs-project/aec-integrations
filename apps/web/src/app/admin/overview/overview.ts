import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';

import type {
  AdminMetricKey,
  AdminOverviewResponse,
  AdminTimeseriesResponse,
  VersionResponse,
} from '@aeci/shared';

import { AdminNotes } from '../admin-notes';
import { AdminPanelApi } from '../admin-panel-api';
import type { StackedBarPoint } from '../charts/chart-geometry';
import { StackedBarChart } from '../charts/stacked-bar-chart';
import { RankedBarList, type RankedRow } from './ranked-bar-list';
import { StatTile, type StatTileDelta } from './stat-tile';
import { StatusStrip } from './status-strip';

/**
 * Metrics whose 30-day trend the `/overview` bundle does NOT carry, fetched in a
 * second non-blocking wave so the tiles paint on the first response.
 *
 * `active_subscribers` is deliberately absent: there is no metric key for it (it
 * is a live snapshot of `mailing_list`, not a windowed series), so that tile ships
 * with no sparkline rather than an invented one.
 */
const SPARKLINE_METRICS = ['traffic.unique_visitors', 'accounts.sign_ins_new'] as const;

/**
 * AECI-576 / Phase 8.3 P1.2 — `/admin/overview`, the first screen of the operator
 * console: the 05:00 analytics digest as a live page
 * (`docs/ADMIN_PANEL_SPEC.md` §5.1).
 *
 * Structure follows `RequestQueue` exactly, because the shape of the problem is
 * the same: the gate + nav already SSR via the parent route's
 * `adminSummaryResolver`, so this screen paints its chrome during SSR and fetches
 * client-side in `afterNextRender`. The same-origin `GET /api/admin/overview`
 * carries the session cookie, which the API Worker's `requireAdmin()` verifies; it
 * never reads cookies or session state itself.
 *
 * ─── Two load waves ──────────────────────────────────────────────────────────
 *
 * 1. `getOverview()` — the whole §5.1 bundle in one round trip. Everything the
 *    page needs to be useful.
 * 2. Trend series for the two tiles the bundle has no series for, plus the SSR
 *    Worker's `/_version`. All optional: a failure degrades one tile, never the
 *    page, and none of it blocks first paint.
 *
 * ─── Recompute ───────────────────────────────────────────────────────────────
 *
 * "Recompute today's digest" is `GET …?recompute=1` (§13 D8), which additionally
 * runs the ten data-quality checks and the Algolia drift count. It sends no email,
 * writes nothing, and carries no `audit_log` obligation — the line D8 draws is
 * side effects, not manual-ness. A `POST` here would be wrong.
 *
 * ─── What is deliberately NOT rendered ───────────────────────────────────────
 *
 * No delta is computed in the browser. The API's deltas come from the same
 * `computeDelta` the digest email's `deltaText` calls, so the screen and the
 * 05:00 email cannot disagree; re-deriving a missing one here would fork that.
 * Tiles the API gives no delta for (subscribers, catalog) show none and state
 * their window instead.
 */
@Component({
  selector: 'aec-admin-overview',
  imports: [DatePipe, AdminNotes, StackedBarChart, RankedBarList, StatTile, StatusStrip],
  templateUrl: './overview.html',
})
export class AdminOverview {
  private readonly api = inject(AdminPanelApi);

  protected readonly overview = signal<AdminOverviewResponse | null>(null);
  protected readonly loading = signal(true);
  /** The INITIAL load failed, so there is nothing to show. Replaces the page. */
  protected readonly loadFailed = signal(false);
  /** True while a `?recompute=1` round trip is in flight (disables the button). */
  protected readonly recomputing = signal(false);
  /** A RECOMPUTE failed. Deliberately a separate flag from {@link loadFailed}:
   *  the operator is already looking at a good response, and throwing it away to
   *  show a full-page error would lose real information over an optional refresh.
   *  This surfaces inline next to the button instead. */
  protected readonly recomputeFailed = signal(false);
  /** Polite announcements — a recompute changes numbers in place, with no
   *  visible focus change to carry the news. */
  protected readonly liveMessage = signal('');

  /** Second-wave trend series, keyed by metric. Absent = no sparkline. */
  private readonly series = signal<Partial<Record<AdminMetricKey, readonly number[]>>>({});
  /** The SSR Worker's own build, or null when `/_version` could not be read. */
  protected readonly ssrVersion = signal<VersionResponse | null>(null);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  // ── Load ───────────────────────────────────────────────────────────────────

  private async load(recompute = false): Promise<void> {
    this.recomputeFailed.set(false);
    if (recompute) this.recomputing.set(true);
    else {
      this.loadFailed.set(false);
      this.loading.set(true);
    }

    try {
      const res = await this.api.getOverview(recompute ? { recompute: true } : {});
      this.overview.set(res);
      if (recompute) {
        this.liveMessage.set(
          $localize`:@@admin.overview.announce.recomputed:Recomputed. Data-quality checks and index drift are up to date.`,
        );
      }
      // Fire-and-forget: the page is already useful without any of this.
      void this.loadSecondWave(res);
    } catch {
      // A failed recompute keeps the page it already has; a failed first load
      // has nothing to keep.
      if (recompute) {
        this.recomputeFailed.set(true);
        this.liveMessage.set(
          $localize`:@@admin.overview.announce.recomputeFailed:Recompute failed. The figures shown are unchanged.`,
        );
      } else {
        this.loadFailed.set(true);
      }
    } finally {
      this.loading.set(false);
      this.recomputing.set(false);
    }
  }

  /**
   * Trend series + the SSR build, in parallel and individually fault-tolerant.
   * `Promise.allSettled` rather than `all`: one 500 on a sparkline must not cost
   * the page its other sparkline or its deploy-drift check.
   */
  private async loadSecondWave(res: AdminOverviewResponse): Promise<void> {
    const from = res.traffic.series_30d[0]?.day;
    const to = res.traffic.series_30d[res.traffic.series_30d.length - 1]?.day;

    await Promise.allSettled([
      ...(from && to
        ? SPARKLINE_METRICS.map(async (metric) => {
            const ts: AdminTimeseriesResponse = await this.api.getTimeseries({ metric, from, to });
            this.series.update((s) => ({ ...s, [metric]: ts.points.map((p) => p.value) }));
          })
        : []),
      this.api.getSsrVersion().then((v) => this.ssrVersion.set(v)),
    ]);
  }

  protected retry(): void {
    void this.load();
  }

  protected recompute(): void {
    if (this.recomputing()) return;
    this.liveMessage.set($localize`:@@admin.overview.announce.recomputing:Recomputing…`);
    void this.load(true);
  }

  // ── Derived view models ────────────────────────────────────────────────────

  /** The UTC calendar day this response reports. Sliced from the ISO string
   *  rather than parsed: `window.from` is already UTC, and a `Date` round trip
   *  would re-render it in the operator's local zone — the one thing §9.5 says
   *  never to do silently. */
  protected readonly windowDay = computed(() => this.overview()?.window.from.slice(0, 10) ?? '');

  protected readonly trafficPoints = computed<readonly StackedBarPoint[]>(
    () =>
      this.overview()?.traffic.series_30d.map((p) => ({
        label: p.day,
        segments: [p.human, p.bot],
      })) ?? [],
  );

  protected readonly humanSeries = computed(
    () => this.overview()?.traffic.series_30d.map((p) => p.human) ?? [],
  );

  protected readonly uniqueVisitorSeries = computed(
    () => this.series()['traffic.unique_visitors'] ?? [],
  );

  protected readonly signInSeries = computed(() => this.series()['accounts.sign_ins_new'] ?? []);

  /**
   * The two deltas beside the headline.
   *
   * They measure DIFFERENT populations and the API says so: `delta_day` is
   * post-automation on both sides, `delta_7d` is raw on both, because filtering
   * a week would mean running the detector over fourteen further days on every
   * request. Both are internally consistent; only the comparison between them is
   * not, and `deltaPeriodNote` below is what keeps that from being a silent trap.
   */
  protected readonly pageViewDeltas = computed<readonly StatTileDelta[]>(() => {
    const t = this.overview()?.traffic;
    return t
      ? [
          { delta: t.delta_day, period: 'day' as const },
          { delta: t.delta_7d, period: 'week' as const },
        ]
      : [];
  });

  protected readonly signInDeltas = computed<readonly StatTileDelta[]>(() => {
    const a = this.overview()?.audience;
    return a ? [{ delta: a.new_sign_ins, period: 'day' as const }] : [];
  });

  protected readonly sourceRows = computed<readonly RankedRow[]>(
    () =>
      this.overview()?.traffic.top_sources.map((s, i) => ({
        key: s.source ?? `unattributed-${i}`,
        // A null source is surfaced, never dropped: the API returns it so the
        // page reconciles against the window total (§6).
        label: s.source ?? $localize`:@@admin.overview.sources.unattributed:Unattributed`,
        value: s.views,
      })) ?? [],
  );

  protected readonly productRows = computed<readonly RankedRow[]>(
    () =>
      this.overview()?.traffic.top_products.map((p) => ({
        key: p.slug,
        label: p.name,
        value: p.views,
        link: ['/products', p.slug],
      })) ?? [],
  );

  // ── Localized labels needed as strings (chart a11y names, captions) ────────

  protected readonly trafficSeriesLabels: readonly string[] = [
    $localize`:@@admin.overview.chart.series.human:Human`,
    $localize`:@@admin.overview.chart.series.bot:Bots and crawlers`,
  ];

  protected readonly trafficChartLabel = $localize`:@@admin.overview.chart.aria:Page views per day over the last 30 UTC days, split between human and bot traffic.`;
  protected readonly trafficChartEmpty = $localize`:@@admin.overview.chart.empty:No page views recorded in the last 30 days.`;
  protected readonly sourcesEmpty = $localize`:@@admin.overview.sources.empty:No traffic sources recorded for this day.`;
  protected readonly productsEmpty = $localize`:@@admin.overview.products.empty:No product page views recorded for this day.`;

  protected readonly pageViewsSparklineLabel = $localize`:@@admin.overview.tile.pageViews.spark:Human page views per day over the last 30 days, counted server-side with no automation filter applied`;
  protected readonly visitorsSparklineLabel = $localize`:@@admin.overview.tile.visitors.spark:Unique visitors per day over the last 30 days`;
  protected readonly signInsSparklineLabel = $localize`:@@admin.overview.tile.signIns.spark:New sign-ins per day over the last 30 days`;

  /** Captions carry the window (§9 resolution honesty) — and for unique visitors,
   *  the §9.8 definition itself, next to the number rather than behind a tooltip. */
  protected readonly dayCaption = computed(
    () => $localize`:@@admin.overview.caption.day:UTC day ${this.windowDay()}:DAY:`,
  );

  /**
   * The measurement envelope for the headline number (AECI-683), in the caption
   * rather than in a fifth tile.
   *
   * §5.1 calls this page "the analytics digest as a live page", and the 05:00
   * email prints these two figures directly beside its headline — a tile of their
   * own would separate them from the number they qualify, which is the exact
   * arrangement that let a figure ~8x too high read as authoritative for weeks.
   * The `visitorsCaption` below already carries a definition of comparable
   * length, so this costs no layout: the tiles are `h-full` in one grid row and
   * already size to that caption.
   *
   * Phrased with the counts as trailing values (`…: 9.`) rather than inline
   * (`9 views`) so no sentence needs singular/plural inflection — `$localize`
   * tagged templates carry no ICU, and the alternative is a branch per
   * cardinality combination.
   *
   * The CAVEATS live in `aec-admin-notes` above, as
   * `corroborated_is_a_referrer_floor` and `operator_leak_is_an_inference`; only
   * the shortest form of each is repeated here, next to the number.
   */
  protected readonly pageViewsCaption = computed(() => {
    const t = this.overview()?.traffic;
    const flagged = t?.automation_flagged ?? null;
    const parts = [
      // The headline is no longer the raw server-side count (AECI-745), so this
      // sentence no longer calls it an upper bound. That label now belongs to the
      // figure it was subtracted FROM, and moves with it — describing a filtered
      // estimate as an upper bound would be the same class of error the AECI-658
      // hedge was added to fix, pointed the other way.
      flagged === null
        ? $localize`:@@admin.overview.caption.pageViewsUnfiltered:UTC day ${this.windowDay()}:DAY:. The automation filter did not run for this day, so this figure is UNFILTERED and is an upper bound: page views are counted server-side on every full-document load, so a crawler that never runs our JavaScript is still in it. It is not comparable with a day the filter ran on.`
        : $localize`:@@admin.overview.caption.pageViewsAfterAutomation:UTC day ${this.windowDay()}:DAY:. Counted server-side: ${t?.page_views_human_raw.total ?? 0}:RAW:, less those attributed to automated clients: ${flagged}:FLAGGED:. The server-side figure is an upper bound: it counts every full-document load, so a crawler that never runs our JavaScript is in it.`,
      $localize`:@@admin.overview.caption.corroborated:Arrivals carrying an external search or social referrer: ${t?.corroborated_views ?? 0}:VIEWS:, from distinct visitors: ${t?.corroborated_visitors ?? 0}:VISITORS:. A floor, and built on a claim the request made.`,
    ];
    if ((t?.operator_leak_excluded ?? 0) > 0) {
      parts.push(
        $localize`:@@admin.overview.caption.operatorLeak:Excluded as operator self-traffic on a lapsed session: ${t?.operator_leak_excluded ?? 0}:VIEWS:.`,
      );
    }
    // Said once, on the tile that carries both. The 7-day delta and the trend
    // line are raw where the headline is filtered, because filtering them means
    // running the detector over every day they span. That is a defensible cost
    // decision and an indefensible thing to leave unlabelled — a reader comparing
    // a filtered day against a raw week would read the difference as a trend.
    if (flagged !== null) {
      parts.push(
        $localize`:@@admin.overview.caption.pageViewsWeekIsRaw:The 7-day change and the trend line are server-side counts with no automation filter applied, so they sit above this figure.`,
      );
    }
    return parts.join(' ');
  });

  protected readonly visitorsCaption = computed(
    () =>
      $localize`:@@admin.overview.caption.visitors:UTC day ${this.windowDay()}:DAY:. A visitor is a distinct browser-and-network pair; it over-counts when a browser updates and under-counts behind a shared network.`,
  );

  protected readonly snapshotCaption = $localize`:@@admin.overview.caption.snapshot:Live total as of now, not a daily figure.`;
}
