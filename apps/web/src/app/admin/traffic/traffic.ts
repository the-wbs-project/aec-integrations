import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';

import type {
  AdminNote,
  AdminTimeseriesResponse,
  AdminTrafficBreakdownResponse,
  AdminTrafficPopulation,
} from '@aeci/shared';

import { HorizontalBarChart } from '../charts/horizontal-bar-chart';
import { LineChart } from '../charts/line-chart';
import { StackedBarChart } from '../charts/stacked-bar-chart';
import { StatTile } from '../charts/stat-tile';
import { AdminNoteList } from '../notes/admin-note-list';
import { AdminTrafficApi } from './admin-traffic-api';
import { dayKeyParts, formatInstant, formatThousands, type DisplayZone } from '../charts/format';
import type { ChartCategory, ChartSeries } from '../charts/chart-types';

/** Window presets. 90 is the practical ceiling for a day-bucketed column chart;
 *  past it the columns are hairline and the stacked-area variant is the read. */
const RANGE_OPTIONS = [7, 30, 90] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number];

/** Rows per breakdown. Eight is the `dataviz` token ceiling and comfortably under
 *  the API's `perPage` cap of 100. */
const BREAKDOWN_ROWS = 8;

/**
 * `/admin/traffic` — the §5.3 Traffic section. AECI-578 / Phase 8.3 P1.4.
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.3, §9.5, §9.8.
 *
 * Rendered in the `AdminShell` layout's outlet, so the gate and nav SSR via
 * `adminSummaryResolver` on the parent route. This page paints its shell during
 * SSR and fetches in `afterNextRender` — the same-origin reads carry the session
 * cookie, which the API Worker's `requireAdmin()` verifies. It never reads cookies
 * or session state directly. Same shape as `RequestQueue` (AECI-217).
 *
 * ─── Three things this page is careful about ─────────────────────────────────
 *
 * **1. The UTC ↔ WIB toggle changes no query (§9.5).** It re-renders *instants* —
 * the window boundaries and `generated_at` — and re-labels what a bucket is. The
 * day buckets are UTC calendar days computed server-side and cannot be
 * re-bucketed client-side without the raw rows, which the browser never has. A
 * toggle that appeared to rebucket would be inventing data. `traffic.component.spec.ts`
 * asserts that flipping it issues no request. See `charts/format.ts`.
 *
 * **2. "Visitor" is defined next to the number (§9.8).** A visitor is a distinct
 * `(user_agent_hash, cf_asn)` pair in the window; it over-counts on browser
 * update and under-counts behind shared NAT. That caveat is a first-class
 * `StatTile` input, not a footnote, because §9.8 requires it *"next to the number
 * in the UI, not only in this document"*.
 *
 * **3. No deltas here, on purpose.** Deltas belong to §5.1's Overview, where they
 * come from the API's `AdminDelta` — one structured implementation shared with
 * the 05:00 digest email so the two can never disagree. Computing "vs. the
 * previous day" in the browser would be a second implementation of a number the
 * spec deliberately has only one of. `StatTile` accepts a `delta`; this page
 * passes none.
 *
 * ─── What §5.3 asks for that the P1.1 API cannot yet serve ───────────────────
 *
 * §5.3 lists *sources over time*, *crawler activity per bot over time*, and
 * geography by *country + colo*. None are reachable from the shipped contract:
 * `/traffic/breakdown` returns one flat total per group with no time axis,
 * `/metrics/timeseries` has a fixed metric vocabulary with no group-by, and
 * `colo` is not a member of `AdminBreakdownDimensionSchema`. §10 scopes this
 * issue as UI-only, so those three render as **windowed** breakdowns here and the
 * API work is tracked separately rather than smuggled into a UI ticket.
 */
@Component({
  selector: 'aec-admin-traffic',
  imports: [AdminNoteList, HorizontalBarChart, LineChart, StackedBarChart, StatTile],
  templateUrl: './traffic.html',
  host: { class: 'aec-charts block' },
})
export class AdminTraffic {
  private readonly api = inject(AdminTrafficApi);
  private readonly titleSvc = inject(Title);

  // ── Controls ───────────────────────────────────────────────────────────────

  protected readonly rangeDays = signal<RangeDays>(30);
  protected readonly population = signal<AdminTrafficPopulation>('human');
  /** Presentational only. Never reaches a query parameter. */
  protected readonly zone = signal<DisplayZone>('UTC');
  protected readonly excludeInternal = signal(false);

  protected readonly rangeOptions = RANGE_OPTIONS;

  protected readonly populationOptions: ReadonlyArray<{
    key: AdminTrafficPopulation;
    label: string;
  }> = [
    { key: 'human', label: $localize`:@@admin.traffic.population.human:Humans` },
    { key: 'bot', label: $localize`:@@admin.traffic.population.bot:Bots` },
    { key: 'all', label: $localize`:@@admin.traffic.population.all:All` },
  ];

  // ── Load state ─────────────────────────────────────────────────────────────

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  private readonly humanSeries = signal<AdminTimeseriesResponse | null>(null);
  private readonly botSeries = signal<AdminTimeseriesResponse | null>(null);
  private readonly visitorSeries = signal<AdminTimeseriesResponse | null>(null);
  private readonly sources = signal<AdminTrafficBreakdownResponse | null>(null);
  private readonly pages = signal<AdminTrafficBreakdownResponse | null>(null);
  private readonly products = signal<AdminTrafficBreakdownResponse | null>(null);
  private readonly countries = signal<AdminTrafficBreakdownResponse | null>(null);
  private readonly crawlers = signal<AdminTrafficBreakdownResponse | null>(null);

  constructor() {
    this.titleSvc.setTitle(
      $localize`:@@admin.traffic.metaTitle:Traffic · Admin · AEC Integrations`,
    );
    afterNextRender(() => {
      void this.load();
    });
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────

  /**
   * All eight reads in parallel. They share a window and are independent, so
   * serialising them would multiply the slowest round trip by eight for no gain;
   * a single `Promise.all` also means one error state rather than eight partial
   * ones, which is the honest thing to show for a page whose sections must
   * reconcile against the same `window_total`.
   */
  private async load(): Promise<void> {
    const { from, to } = this.utcRange();
    const traffic = this.population();
    const excludeInternal = this.excludeInternal();

    this.loadFailed.set(false);
    this.loading.set(true);
    try {
      const [human, bot, visitors, sources, pages, products, countries, crawlers] =
        await Promise.all([
          this.api.timeseries({ metric: 'traffic.page_views_human', from, to, excludeInternal }),
          this.api.timeseries({ metric: 'traffic.page_views_bot', from, to, excludeInternal }),
          this.api.timeseries({ metric: 'traffic.unique_visitors', from, to, excludeInternal }),
          this.breakdown('source', from, to, traffic, excludeInternal),
          this.breakdown('path', from, to, traffic, excludeInternal),
          this.breakdown('product', from, to, traffic, excludeInternal),
          this.breakdown('country', from, to, traffic, excludeInternal),
          this.breakdown('bot', from, to, traffic, excludeInternal),
        ]);
      this.humanSeries.set(human);
      this.botSeries.set(bot);
      this.visitorSeries.set(visitors);
      this.sources.set(sources);
      this.pages.set(pages);
      this.products.set(products);
      this.countries.set(countries);
      this.crawlers.set(crawlers);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private breakdown(
    dimension: 'source' | 'path' | 'product' | 'country' | 'bot',
    from: string,
    to: string,
    traffic: AdminTrafficPopulation,
    excludeInternal: boolean,
  ): Promise<AdminTrafficBreakdownResponse> {
    return this.api.breakdown({
      dimension,
      from,
      to,
      traffic,
      perPage: BREAKDOWN_ROWS,
      excludeInternal,
    });
  }

  /**
   * The UTC calendar range, both ends inclusive (the API's convention).
   *
   * Browser-only: `load()` runs in `afterNextRender`, so `Date.now()` is never
   * read during SSR. Deriving the range on the server would also bake a date into
   * the SSR HTML, and `/admin/*` is non-cacheable precisely so it does not have
   * to reason about that — but there is no reason to create the problem.
   */
  private utcRange(): { from: string; to: string } {
    const now = new Date();
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = new Date(to.getTime() - (this.rangeDays() - 1) * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }

  // ── Control handlers ───────────────────────────────────────────────────────

  protected setRange(days: RangeDays): void {
    if (this.rangeDays() === days) return;
    this.rangeDays.set(days);
    void this.load();
  }

  protected setPopulation(next: AdminTrafficPopulation): void {
    if (this.population() === next) return;
    this.population.set(next);
    void this.load();
  }

  /** Presentational only — deliberately does NOT reload (§9.5). */
  protected setZone(next: DisplayZone): void {
    this.zone.set(next);
  }

  protected toggleInternal(): void {
    this.excludeInternal.update((v) => !v);
    void this.load();
  }

  protected retry(): void {
    void this.load();
  }

  // ── Derived view state ─────────────────────────────────────────────────────

  /** Day bucket keys, from whichever series loaded. All share the window. */
  private readonly dayKeys = computed<readonly string[]>(
    () => this.humanSeries()?.points.map((p) => p.day) ?? [],
  );

  /** Localized short day labels — `5 Aug`. Bucket keys are never zone-shifted. */
  protected readonly dayLabels = computed(() =>
    this.dayKeys().map((key) => {
      const parts = dayKeyParts(key);
      return parts ? `${parts.day} ${MONTHS[parts.month - 1]}` : key;
    }),
  );

  protected readonly humanValues = computed(() => this.seriesValues(this.humanSeries()));
  protected readonly botValues = computed(() => this.seriesValues(this.botSeries()));
  protected readonly visitorValues = computed(() => this.seriesValues(this.visitorSeries()));

  private seriesValues(res: AdminTimeseriesResponse | null): number[] {
    if (!res) return [];
    // `value_excluding_internal` is only non-null when the filter both exists and
    // applied. `total` is ALWAYS the unfiltered figure by contract, so the
    // filtered view is opt-in and never silently substituted.
    return res.points.map((p) =>
      this.excludeInternal() && p.value_excluding_internal !== null
        ? p.value_excluding_internal
        : p.value,
    );
  }

  /** The primary chart: human vs bot per day. Slots are fixed by entity. */
  protected readonly trafficSeries = computed<ChartSeries[]>(() => [
    {
      key: 'human',
      label: $localize`:@@admin.traffic.series.human:Human`,
      slot: 1,
      values: this.humanValues(),
    },
    {
      key: 'bot',
      label: $localize`:@@admin.traffic.series.bot:Bot`,
      slot: 2,
      values: this.botValues(),
    },
  ]);

  protected readonly visitorChartSeries = computed<ChartSeries[]>(() => [
    {
      key: 'visitors',
      label: $localize`:@@admin.traffic.series.visitors:Unique visitors`,
      slot: 1,
      values: this.visitorValues(),
    },
  ]);

  protected readonly humanTotal = computed(() => this.total(this.humanSeries()));
  protected readonly botTotal = computed(() => this.total(this.botSeries()));
  /**
   * Note this does NOT sum to a window-distinct figure: each bucket is its own
   * `COUNT(DISTINCT …)`, so a visitor active on three days counts three times.
   * The label says "visitor-days" for that reason rather than "visitors" — the
   * window-distinct number is the Overview's, and it covers a single day.
   */
  protected readonly visitorTotal = computed(() => this.total(this.visitorSeries()));

  private total(res: AdminTimeseriesResponse | null): number {
    if (!res) return 0;
    return this.excludeInternal() && res.total.excluding_internal !== null
      ? res.total.excluding_internal
      : res.total.total;
  }

  // ── Breakdowns ─────────────────────────────────────────────────────────────

  protected readonly sourceRows = computed(() =>
    this.rows(this.sources(), $localize`:@@admin.traffic.null.source:Unattributed`),
  );
  protected readonly pageRows = computed(() =>
    this.rows(this.pages(), $localize`:@@admin.traffic.null.path:Unknown page`),
  );
  protected readonly productRows = computed(() =>
    this.rows(this.products(), $localize`:@@admin.traffic.null.product:Unknown product`),
  );
  protected readonly countryRows = computed(() =>
    this.rows(this.countries(), $localize`:@@admin.traffic.null.country:Unknown country`),
  );
  protected readonly crawlerRows = computed(() =>
    this.rows(this.crawlers(), $localize`:@@admin.traffic.null.bot:Other bot`),
  );

  /**
   * Breakdown rows → chart categories.
   *
   * The API's `label` for a NULL group is deliberately untranslated operator text
   * (the same convention as an `AdminNote`'s `message`), and the contract says the
   * UI keys off `key === null` and renders its own placeholder. That is what
   * `nullLabel` is. NULL buckets are surfaced rather than dropped — dropping them
   * is how a source breakdown quietly starts claiming attribution it does not have.
   */
  private rows(res: AdminTrafficBreakdownResponse | null, nullLabel: string): ChartCategory[] {
    if (!res) return [];
    return res.data.map((row) => ({
      key: row.key ?? '',
      label: row.key === null ? nullLabel : row.label,
      value:
        this.excludeInternal() && row.views_excluding_internal !== null
          ? row.views_excluding_internal
          : row.views,
      link: row.ref ? ['/products', row.ref.slug] : null,
    }));
  }

  protected readonly windowTotal = computed(() => {
    const res = this.sources();
    if (!res) return null;
    return this.excludeInternal() && res.window_total.excluding_internal !== null
      ? res.window_total.excluding_internal
      : res.window_total.total;
  });

  /** Crawlers are always the bot population, whatever the page filter says — the
   *  API forces it, so the share must be against the bot window total. Mirrors
   *  `windowTotal` on the internal filter: the rows drop to `views_excluding_internal`
   *  when the toggle is on, so the denominator must too or the shares understate. */
  protected readonly crawlerWindowTotal = computed(() => {
    const res = this.crawlers();
    if (!res) return null;
    return this.excludeInternal() && res.window_total.excluding_internal !== null
      ? res.window_total.excluding_internal
      : res.window_total.total;
  });

  // ── Window labelling (§9.5) ────────────────────────────────────────────────

  private readonly window = computed(() => this.humanSeries()?.window ?? null);

  protected readonly windowLabel = computed(() => {
    const w = this.window();
    if (!w) return '';
    return `${formatInstant(w.from, this.zone())} → ${formatInstant(w.to, this.zone())}`;
  });

  protected readonly generatedLabel = computed(() => {
    const res = this.humanSeries();
    return res ? formatInstant(res.generated_at, this.zone()) : '';
  });

  /**
   * The bucket caption. Always states that buckets are UTC days; in WIB mode it
   * additionally states what that means locally, so the operator can reconcile a
   * bucket against their own clock without being told the bucket moved.
   */
  protected readonly bucketCaption = computed(() =>
    this.zone() === 'WIB'
      ? $localize`:@@admin.traffic.buckets.wib:Daily buckets are UTC days: 07:00 to 07:00 WIB.`
      : $localize`:@@admin.traffic.buckets.utc:Daily buckets are UTC days.`,
  );

  // ── Notes + internal filter ────────────────────────────────────────────────

  /** Every response's notes, deduplicated by code — eight requests over one
   *  window repeat the same caveats, and a reader should see each one once. */
  protected readonly notes = computed<AdminNote[]>(() => {
    const all = [
      ...(this.humanSeries()?.notes ?? []),
      ...(this.botSeries()?.notes ?? []),
      ...(this.visitorSeries()?.notes ?? []),
      ...(this.sources()?.notes ?? []),
      ...(this.pages()?.notes ?? []),
      ...(this.products()?.notes ?? []),
      ...(this.countries()?.notes ?? []),
      ...(this.crawlers()?.notes ?? []),
    ];
    const seen = new Set<string>();
    return all.filter((n) => (seen.has(n.code) ? false : (seen.add(n.code), true)));
  });

  /** The toggle is hidden, not disabled, when `ANALYTICS_INTERNAL_ASNS` is unset
   *  — which is the shipped default. A disabled control invites a support
   *  question about a feature that is not configured. */
  protected readonly internalFilterAvailable = computed(
    () => this.humanSeries()?.internal_filter.available ?? false,
  );

  protected readonly internalFilterLabel = computed(() => {
    const asns = this.humanSeries()?.internal_filter.asns ?? [];
    const list = asns.map((n) => `AS${n}`).join(', ');
    return $localize`:@@admin.traffic.internalFilter:Exclude internal traffic (${list}:ASNS:)`;
  });

  protected readonly hasData = computed(() => this.dayKeys().length > 0);

  protected count(value: number): string {
    return formatThousands(value);
  }

  // ── Static localized labels ────────────────────────────────────────────────
  //
  // Chart `aria-label`s, table captions and column headers are plain inputs, so
  // they are composed in TS with `$localize` rather than as `i18n-*` attributes.
  // That is not a style choice: an interpolated `i18n-*` attribute emits NO
  // attribute at all in this app (AECI-166), which would silently ship charts
  // with no accessible name — the one defect the visually-hidden table cannot
  // compensate for.

  protected readonly humanTileLabel = $localize`:@@admin.traffic.tile.human:Human page views`;
  protected readonly botTileLabel = $localize`:@@admin.traffic.tile.bot:Bot page views`;
  protected readonly visitorTileLabel = $localize`:@@admin.traffic.tile.visitors:Visitor-days`;
  /** §9.8, verbatim in substance: the definition sits next to the number. */
  protected readonly visitorCaveat = $localize`:@@admin.traffic.tile.visitorsCaveat:A visitor is a distinct browser-and-network pair per UTC day. It over-counts when a browser updates and under-counts behind shared networks, and a visitor active on several days counts once per day.`;

  protected readonly dayHeader = $localize`:@@admin.traffic.header.day:Day (UTC)`;
  protected readonly viewsHeader = $localize`:@@admin.traffic.header.views:Views`;
  protected readonly sourceHeader = $localize`:@@admin.traffic.header.source:Source`;
  protected readonly pageHeader = $localize`:@@admin.traffic.header.page:Page`;
  protected readonly productHeader = $localize`:@@admin.traffic.header.product:Product`;
  protected readonly countryHeader = $localize`:@@admin.traffic.header.country:Country`;
  protected readonly crawlerHeader = $localize`:@@admin.traffic.header.crawler:Crawler`;

  protected readonly viewsChartLabel = $localize`:@@admin.traffic.aria.views:Page views per day, human and bot, over the selected UTC window`;
  protected readonly visitorsChartLabel = $localize`:@@admin.traffic.aria.visitors:Unique visitors per UTC day over the selected window`;
  protected readonly sourcesChartLabel = $localize`:@@admin.traffic.aria.sources:Top traffic sources by views in the selected window`;
  protected readonly pagesChartLabel = $localize`:@@admin.traffic.aria.pages:Top pages by views in the selected window`;
  protected readonly productsChartLabel = $localize`:@@admin.traffic.aria.products:Top products by views in the selected window`;
  protected readonly countriesChartLabel = $localize`:@@admin.traffic.aria.countries:Views by country in the selected window`;
  protected readonly crawlersChartLabel = $localize`:@@admin.traffic.aria.crawlers:Crawler activity by bot in the selected window`;

  protected readonly emptyLabel = $localize`:@@admin.traffic.empty:No views recorded in this window.`;
}

/** Short month names. Authored here rather than via `DatePipe` because the axis
 *  labels a `YYYY-MM-DD` bucket key, which is not an instant and must never be
 *  put through a timezone-aware formatter. */
const MONTHS: readonly string[] = [
  $localize`:@@admin.traffic.month.jan:Jan`,
  $localize`:@@admin.traffic.month.feb:Feb`,
  $localize`:@@admin.traffic.month.mar:Mar`,
  $localize`:@@admin.traffic.month.apr:Apr`,
  $localize`:@@admin.traffic.month.may:May`,
  $localize`:@@admin.traffic.month.jun:Jun`,
  $localize`:@@admin.traffic.month.jul:Jul`,
  $localize`:@@admin.traffic.month.aug:Aug`,
  $localize`:@@admin.traffic.month.sep:Sep`,
  $localize`:@@admin.traffic.month.oct:Oct`,
  $localize`:@@admin.traffic.month.nov:Nov`,
  $localize`:@@admin.traffic.month.dec:Dec`,
];
