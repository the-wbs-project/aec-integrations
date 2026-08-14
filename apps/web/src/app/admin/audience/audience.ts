import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';

import type {
  AdminAudienceBreakdownRow,
  AdminAudienceResponse,
  AdminFeedbackResponse,
  AdminNote,
} from '@aeci/shared';

import { HorizontalBarChart } from '../charts/horizontal-bar-chart';
import { LineChart } from '../charts/line-chart';
import { StackedSeriesChart } from '../charts/stacked-series-chart';
import { StatTile } from '../charts/stat-tile';
import { AdminNoteList } from '../notes/admin-note-list';
import { AdminPaginator } from '../admin-paginator';
import { AdminAudienceApi } from './admin-audience-api';
import {
  dayKeyParts,
  formatInstant,
  formatRate,
  formatThousands,
  type DisplayZone,
} from '../charts/format';
import type { ChartCategory, ChartSeries } from '../charts/chart-types';

/**
 * Window presets. Longer than §5.3's 7/30/90 on purpose: a mailing list moves in
 * weeks where traffic moves in hours, and a 7-day view of a list that gains a
 * subscriber a fortnight is a flat line. 400 is the API's ceiling
 * (`ADMIN_METRICS_MAX_DAYS`), so 365 is the longest preset that fits.
 */
const RANGE_OPTIONS = [30, 90, 365] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number];

/** Rows per breakdown. Eight is the `dataviz` palette ceiling and the API's own
 *  `breakdown_limit` default. */
const BREAKDOWN_ROWS = 8;

/** Feedback submissions per page. Lower than the queues' 24 because each row is a
 *  card carrying two free-text blocks, not a table line. */
const FEEDBACK_PER_PAGE = 10;

const MONTHS = [
  $localize`:@@admin.audience.month.jan:Jan`,
  $localize`:@@admin.audience.month.feb:Feb`,
  $localize`:@@admin.audience.month.mar:Mar`,
  $localize`:@@admin.audience.month.apr:Apr`,
  $localize`:@@admin.audience.month.may:May`,
  $localize`:@@admin.audience.month.jun:Jun`,
  $localize`:@@admin.audience.month.jul:Jul`,
  $localize`:@@admin.audience.month.aug:Aug`,
  $localize`:@@admin.audience.month.sep:Sep`,
  $localize`:@@admin.audience.month.oct:Oct`,
  $localize`:@@admin.audience.month.nov:Nov`,
  $localize`:@@admin.audience.month.dec:Dec`,
];

/**
 * `/admin/audience` — the §5.4 Audience section. AECI-586 / Phase 8.3 P5.1.
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.4, §9.5.
 *
 * Rendered in the `AdminShell` layout's outlet, so the gate and nav SSR via
 * `adminSummaryResolver` on the parent route. This page paints its shell during
 * SSR and fetches in `afterNextRender` — the same-origin reads carry the session
 * cookie, which the API Worker's `requireAdmin()` verifies. Same shape as
 * `AdminTraffic` (AECI-578).
 *
 * ─── Three things this page is careful about ─────────────────────────────────
 *
 * **1. The empty state is the primary deliverable, not a fallback.**
 * `mailing_list` and `feedback` both hold zero rows in production (§3), so an
 * empty screen is what an operator sees on day one and is the state most of this
 * code exists to get right. Two rules follow. A churn rate over nobody reads
 * "Not measured", never `0%` — §5.1's exact wording, and the API sends `null`
 * precisely so the UI cannot fudge it into a figure. And when
 * the list has never had a subscriber, the charts are handed an EMPTY category
 * array rather than a window of zeros, so they render their `emptyLabel` instead
 * of drawing an axis around a flat zero line — a chart of nothing is not the same
 * artefact as a chart of a measured zero.
 *
 * **2. "Exactly computable" is stated on screen, and so is its one limit.**
 * §5.4 asks for churn to be described as exact rather than estimated, which it is:
 * `unsubscribed_at` is a suppression record and no row is ever deleted. The
 * caveat rides beside it in the tile's `caveat` slot rather than in a footnote,
 * the same obligation §9.8 puts on the visitor definition. The *other* half — that
 * a resubscribe erases the churn it is computed from — is a derived note from the
 * API, because it is a property of the data in the window rather than of the
 * definition.
 *
 * **3. The UTC ↔ WIB toggle changes no query (§9.5).** It re-renders instants —
 * the window boundaries and `generated_at` — and re-labels what a bucket is. Day
 * buckets are UTC calendar days computed server-side and cannot be re-bucketed in
 * the browser without the raw rows, which it never has.
 */
@Component({
  selector: 'aec-admin-audience',
  imports: [
    AdminNoteList,
    AdminPaginator,
    HorizontalBarChart,
    LineChart,
    StackedSeriesChart,
    StatTile,
  ],
  templateUrl: './audience.html',
  host: { class: 'aec-charts block' },
})
export class AdminAudience {
  private readonly api = inject(AdminAudienceApi);
  private readonly titleSvc = inject(Title);

  // ── Controls ───────────────────────────────────────────────────────────────

  protected readonly rangeDays = signal<RangeDays>(90);
  /** Presentational only. Never reaches a query parameter. */
  protected readonly zone = signal<DisplayZone>('UTC');
  protected readonly feedbackPage = signal(1);

  protected readonly rangeOptions = RANGE_OPTIONS;
  protected readonly feedbackPerPage = FEEDBACK_PER_PAGE;

  // ── Load state ─────────────────────────────────────────────────────────────

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  private readonly bundle = signal<AdminAudienceResponse | null>(null);
  private readonly inbox = signal<AdminFeedbackResponse | null>(null);

  constructor() {
    this.titleSvc.setTitle(
      $localize`:@@admin.audience.metaTitle:Audience · Admin · AEC Integrations`,
    );
    afterNextRender(() => {
      void this.load();
    });
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────

  /**
   * Both reads in parallel. They are independent, but a single `Promise.all`
   * means one error state rather than two partial ones — and the feedback
   * *count* on the bundle has to reconcile against the inbox's `total`, so
   * showing one without the other invites a comparison that is momentarily
   * wrong.
   */
  private async load(): Promise<void> {
    const { from, to } = this.utcRange();

    this.loadFailed.set(false);
    this.loading.set(true);
    try {
      const [bundle, inbox] = await Promise.all([
        this.api.audience({ from, to, breakdownLimit: BREAKDOWN_ROWS }),
        this.api.feedback({ page: this.feedbackPage(), perPage: FEEDBACK_PER_PAGE }),
      ]);
      this.bundle.set(bundle);
      this.inbox.set(inbox);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Only the inbox — a page change must not re-run the aggregates, which do not
   *  depend on it. */
  private async loadFeedback(): Promise<void> {
    try {
      this.inbox.set(
        await this.api.feedback({ page: this.feedbackPage(), perPage: FEEDBACK_PER_PAGE }),
      );
    } catch {
      this.loadFailed.set(true);
    }
  }

  /**
   * The UTC calendar range, both ends inclusive (the API's convention).
   *
   * Browser-only: `load()` runs in `afterNextRender`, so `Date.now()` is never
   * read during SSR and no date is baked into the server render.
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
    // Back to page 1: staying on page 7 of an inbox is not wrong here (the range
    // does not filter it), but the whole view has just been reframed and landing
    // the operator at the top of both halves is the coherent read.
    this.feedbackPage.set(1);
    void this.load();
  }

  /** Presentational only — deliberately does NOT reload (§9.5). */
  protected setZone(next: DisplayZone): void {
    this.zone.set(next);
  }

  protected goToFeedbackPage(page: number): void {
    this.feedbackPage.set(page);
    void this.loadFeedback();
  }

  protected retry(): void {
    void this.load();
  }

  // ── Derived view state ─────────────────────────────────────────────────────

  protected readonly subscribers = computed(() => this.bundle()?.subscribers ?? null);
  protected readonly windowTotals = computed(() => this.bundle()?.window_totals ?? null);
  protected readonly feedbackCounts = computed(() => this.bundle()?.feedback ?? null);

  /**
   * Whether the list has EVER had a subscriber.
   *
   * This is the switch that decides chart-versus-empty-state, and it is
   * deliberately not "did anything happen in this window". A list with subscribers
   * and a quiet window has a real, flat, non-zero cumulative line worth drawing; a
   * list that has never had one has nothing, and drawing an axis around thirty
   * days of zero would assert a measurement that was never taken.
   */
  protected readonly hasSubscribers = computed(() => (this.subscribers()?.total_ever ?? 0) > 0);

  private readonly dayKeys = computed<readonly string[]>(
    () => this.bundle()?.series.map((p) => p.day) ?? [],
  );

  /** Localized short day labels — `5 Aug`. Bucket keys are never zone-shifted.
   *  Empty when the list has never had a subscriber, which is what makes every
   *  chart fall through to its `emptyLabel`. */
  protected readonly dayLabels = computed(() =>
    this.hasSubscribers()
      ? this.dayKeys().map((key) => {
          const parts = dayKeyParts(key);
          return parts ? `${parts.day} ${MONTHS[parts.month - 1]}` : key;
        })
      : [],
  );

  protected readonly cumulativeSeries = computed<ChartSeries[]>(() => [
    {
      key: 'active',
      label: $localize`:@@admin.audience.series.active:Active subscribers`,
      slot: 1,
      values: this.bundle()?.series.map((p) => p.active_cumulative) ?? [],
    },
  ]);

  protected readonly flowSeries = computed<ChartSeries[]>(() => [
    {
      key: 'signups',
      label: $localize`:@@admin.audience.series.signups:Signups`,
      slot: 1,
      values: this.bundle()?.series.map((p) => p.signups) ?? [],
    },
    {
      key: 'unsubscribes',
      label: $localize`:@@admin.audience.series.unsubscribes:Unsubscribes`,
      slot: 2,
      values: this.bundle()?.series.map((p) => p.unsubscribes) ?? [],
    },
  ]);

  // ── Figures ────────────────────────────────────────────────────────────────

  protected readonly activeCount = computed(() => this.subscribers()?.active ?? null);
  protected readonly unsubscribedCount = computed(() => this.subscribers()?.unsubscribed ?? null);
  protected readonly totalEverCount = computed(() => this.subscribers()?.total_ever ?? null);

  /**
   * All-time churn as prose, or the empty string when the API sent `null` — at
   * which point the tile falls through to its own "Not measured". Never `0%`:
   * a rate over an empty list is undefined, not zero (§5.1).
   */
  protected readonly churnText = computed(
    () => formatRate(this.subscribers()?.churn_rate ?? null) ?? '',
  );

  /** The same figure for the window. This one is not in a tile, so it supplies
   *  the not-measured wording itself. */
  protected readonly windowChurnText = computed(
    () => formatRate(this.windowTotals()?.churn_rate ?? null) ?? this.notMeasuredLabel,
  );

  /** The signed net for the window, with an explicit sign so a gain and a loss
   *  are never confusable at a glance. */
  protected readonly netText = computed(() => {
    const net = this.windowTotals()?.net;
    if (net === undefined) return this.notMeasuredLabel;
    return net > 0 ? `+${formatThousands(net)}` : formatThousands(net);
  });

  /**
   * The denominator behind the window churn rate, stated rather than implied.
   * When it is 0 the rate is an em dash, and this is the sentence that says why —
   * an unexplained dash reads as a bug.
   */
  protected readonly windowChurnBasis = computed(() => {
    const t = this.windowTotals();
    if (!t) return '';
    const unsubscribes = formatThousands(t.unsubscribes);
    const start = formatThousands(t.active_at_start);
    return t.active_at_start === 0
      ? $localize`:@@admin.audience.churn.window.noBasis:Nobody was subscribed when this window opened, so a rate for it is undefined.`
      : $localize`:@@admin.audience.churn.window.basis:${unsubscribes}:LEFT: of the ${start}:START: subscribers active when this window opened.`;
  });

  // ── Breakdowns ─────────────────────────────────────────────────────────────

  protected readonly utmSourceRows = computed(() =>
    this.rows(
      this.bundle()?.utm.source,
      $localize`:@@admin.audience.null.utmSource:No campaign source`,
    ),
  );
  protected readonly utmMediumRows = computed(() =>
    this.rows(
      this.bundle()?.utm.medium,
      $localize`:@@admin.audience.null.utmMedium:No campaign medium`,
    ),
  );
  protected readonly utmCampaignRows = computed(() =>
    this.rows(
      this.bundle()?.utm.campaign,
      $localize`:@@admin.audience.null.utmCampaign:No campaign`,
    ),
  );
  protected readonly countryRows = computed(() =>
    this.rows(
      this.bundle()?.geography.country,
      $localize`:@@admin.audience.null.country:Unknown country`,
    ),
  );
  protected readonly regionRows = computed(() =>
    this.rows(
      this.bundle()?.geography.region,
      $localize`:@@admin.audience.null.region:Unknown region`,
    ),
  );
  protected readonly cityRows = computed(() =>
    this.rows(this.bundle()?.geography.city, $localize`:@@admin.audience.null.city:Unknown city`),
  );
  protected readonly asnRows = computed(() =>
    this.rows(this.bundle()?.geography.asn, $localize`:@@admin.audience.null.asn:Unknown network`),
  );

  /**
   * Breakdown rows → chart categories.
   *
   * The API's `label` for a NULL group is untranslated operator text (the same
   * convention as an `AdminNote`'s `message`), and the contract says the UI keys
   * off `key === null` and supplies its own placeholder — that is `nullLabel`.
   * NULL buckets are rendered, never dropped: an organic signup with no campaign
   * parameters is a real signup, and hiding it is how an attribution breakdown
   * starts claiming attribution it does not have.
   */
  private rows(
    data: readonly AdminAudienceBreakdownRow[] | undefined,
    nullLabel: string,
  ): ChartCategory[] {
    if (!data) return [];
    return data.map((row) => ({
      key: row.key ?? '',
      label: row.key === null ? nullLabel : row.label,
      value: row.subscribers,
      link: null,
    }));
  }

  /** The denominator every breakdown share is against — signups in the window,
   *  which is what the API grouped. */
  protected readonly windowSignups = computed(() => this.windowTotals()?.signups ?? null);

  // ── Feedback inbox ─────────────────────────────────────────────────────────

  protected readonly feedbackRows = computed(() => this.inbox()?.data ?? []);
  protected readonly feedbackTotal = computed(() => this.inbox()?.total ?? 0);
  protected readonly feedbackEmpty = computed(() => this.feedbackTotal() === 0);

  protected feedbackStamp(iso: string): string {
    return formatInstant(iso, this.zone());
  }

  /** The submitter's location as one line, skipping the parts Cloudflare could
   *  not resolve. Empty when it resolved none of them. */
  protected feedbackPlace(row: {
    city: string | null;
    region: string | null;
    country: string | null;
  }): string {
    return [row.city, row.region, row.country].filter(Boolean).join(' · ');
  }

  // ── Window labelling (§9.5) ────────────────────────────────────────────────

  protected readonly windowLabel = computed(() => {
    const w = this.bundle()?.window;
    if (!w) return '';
    return `${formatInstant(w.from, this.zone())} → ${formatInstant(w.to, this.zone())}`;
  });

  protected readonly generatedLabel = computed(() => {
    const res = this.bundle();
    return res ? formatInstant(res.generated_at, this.zone()) : '';
  });

  protected readonly bucketCaption = computed(() =>
    this.zone() === 'WIB'
      ? $localize`:@@admin.audience.buckets.wib:Daily buckets are UTC days: 07:00 to 07:00 WIB.`
      : $localize`:@@admin.audience.buckets.utc:Daily buckets are UTC days.`,
  );

  // ── Notes ──────────────────────────────────────────────────────────────────

  /** Both responses' notes, deduplicated by code. */
  protected readonly notes = computed<AdminNote[]>(() => {
    const all = [...(this.bundle()?.notes ?? []), ...(this.inbox()?.notes ?? [])];
    const seen = new Set<string>();
    return all.filter((n) => (seen.has(n.code) ? false : (seen.add(n.code), true)));
  });

  // ── Static localized labels ────────────────────────────────────────────────

  // Chart `aria-label`s, table captions and column headers are plain inputs, so
  // they are composed here with `$localize` rather than as `i18n-*` attributes.
  // That is not a style choice: an interpolated `i18n-*` attribute emits NO
  // attribute at all in this app (AECI-166), which would silently ship charts
  // with no accessible name.
  protected readonly activeTileLabel = $localize`:@@admin.audience.tile.active:Active subscribers`;
  protected readonly unsubscribedTileLabel = $localize`:@@admin.audience.tile.unsubscribed:Unsubscribed`;
  protected readonly totalEverTileLabel = $localize`:@@admin.audience.tile.totalEver:People who ever joined`;
  protected readonly churnTileLabel = $localize`:@@admin.audience.tile.churn:All-time churn`;

  /** §5.4 asks for this to be said on screen: churn here is exact, not modelled. */
  protected readonly churnCaveat = $localize`:@@admin.audience.tile.churnCaveat:Exact, not estimated: opting out sets a timestamp rather than deleting the subscriber, so every departure is still on record.`;
  protected readonly churnEmptyCaveat = $localize`:@@admin.audience.tile.churnEmptyCaveat:No subscribers yet, so there is no rate to report.`;

  protected readonly dayHeader = $localize`:@@admin.audience.table.day:Day (UTC)`;
  protected readonly subscribersHeader = $localize`:@@admin.audience.table.subscribers:Signups`;

  protected readonly cumulativeChartLabel = $localize`:@@admin.audience.aria.cumulative:Active subscribers per day`;
  protected readonly flowChartLabel = $localize`:@@admin.audience.aria.flow:Signups and unsubscribes per day`;
  protected readonly utmSourceLabel = $localize`:@@admin.audience.aria.utmSource:Signups by campaign source`;
  protected readonly utmMediumLabel = $localize`:@@admin.audience.aria.utmMedium:Signups by campaign medium`;
  protected readonly utmCampaignLabel = $localize`:@@admin.audience.aria.utmCampaign:Signups by campaign`;
  protected readonly countryLabel = $localize`:@@admin.audience.aria.country:Signups by country`;
  protected readonly regionLabel = $localize`:@@admin.audience.aria.region:Signups by region`;
  protected readonly cityLabel = $localize`:@@admin.audience.aria.city:Signups by city`;
  protected readonly asnLabel = $localize`:@@admin.audience.aria.asn:Signups by network`;

  protected readonly emptySubscribersLabel = $localize`:@@admin.audience.empty.subscribers:No subscribers yet.`;
  protected readonly emptySignupsLabel = $localize`:@@admin.audience.empty.signups:No signups in this window.`;

  /** §5.1's wording for a figure that does not exist, used by the two churn
   *  readouts that are not stat tiles. `StatTile` carries its own copy of the
   *  same string for the tiles. */
  protected readonly notMeasuredLabel = $localize`:@@admin.audience.notMeasured:Not measured`;
}
