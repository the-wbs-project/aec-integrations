import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { Tab, TabContent, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import { RouterLink } from '@angular/router';

import type {
  AdminCatalogCoverageResponse,
  AdminCoverageGapKey,
  AdminMetricKey,
  AdminNote,
  AdminPromotionStatus,
  AdminResearchStatus,
  AdminTaxonomyFacet,
} from '@aeci/shared';

import { AdminNotes } from '../admin-notes';
import { AdditionsTable, type AdditionsRow } from './additions-table';
import { AdminCatalogApi } from './admin-catalog-api';

/** Days on the Daily tab, matching the overview's 30-day traffic chart. */
const SERIES_DAYS = 30;
/** Calendar months on the Monthly tab, including the current (partial) one.
 *  Twelve consecutive calendar months is 365 or 366 days, comfortably inside
 *  the API's `ADMIN_METRICS_MAX_DAYS` (400). */
const SERIES_MONTHS = 12;
const DAY_MS = 86_400_000;

/** The four `catalog.*` additions series, in the order §5.5 names them. */
const SERIES_METRICS: readonly AdminMetricKey[] = [
  'catalog.products_created',
  'catalog.integrations_created',
  'catalog.vendors_created',
  'catalog.claims_created',
];

/** Which window the additions panel is showing. */
type AdditionsTab = 'daily' | 'monthly';

/** One window's worth of the additions panel: the zipped rows and the caveats
 *  the API attached to that window. They travel together because they describe
 *  each other. */
interface SeriesData {
  rows: readonly AdditionsRow[];
  notes: readonly AdminNote[];
}

const EMPTY_SERIES: SeriesData = { rows: [], notes: [] };

/**
 * AECI-579 / Phase 8.3 P1.5 — the §5.5 catalog screen at `/admin/catalog`, the
 * first section of the operator console and the one that produces a **to-do
 * list** rather than a readout.
 *
 * Like the moderation queues, the gate + nav SSR via `adminSummaryResolver` on
 * the parent `/admin` route, so this screen paints its shell during SSR and
 * fetches client-side in `afterNextRender` — the same-origin reads carry the
 * session cookie, which the API Worker's `requireAdmin()` verifies. It never
 * reads cookies or session state directly.
 *
 * ─── Read-only, emphatically (§2) ────────────────────────────────────────────
 *
 * Nothing here edits. Every gap row links to the product's own page so the
 * operator can see what a visitor sees; the fix happens in the review app and
 * arrives through `POST /api/promote`. A coverage list with a Fix button would be
 * scope creep into the canceled AECI-535.
 *
 * Per-row links deliberately point at AECi, **not** at the review app, even
 * though §5.5 asks for the latter: ADR 0021 kept the curation key out of D1
 * ("AECi does not store your Airtable/record IDs"), so there is no id to build a
 * review-app deep link from. Recorded in `ADMIN_PANEL_SPEC.md` §5.5 rather than
 * papered over.
 *
 * ─── Two renderings that are easy to get wrong ───────────────────────────────
 *
 * **All-affected is a worklist, not an error.** `logo_url IS NULL` is 171 of 171
 * in production. That renders in exactly the same visual register as any other
 * count — the "everything is broken" shape must not look like a failure, because
 * it is simply the state of the catalog.
 *
 * **Additions are not totals.** The panel is fed by
 * `GET /api/admin/metrics/timeseries`, whose `catalog_series_is_additions_only`
 * note is rendered directly above each table. That banner is load-bearing (§4:
 * 827 `integration.created` events back 496 live rows) and is the thing most
 * likely to be quietly dropped in a refactor — hence its own component spec.
 *
 * ─── Daily / Monthly (AECI-668) ──────────────────────────────────────────────
 *
 * The panel is two tabs over the same four series. Monthly is a **client-side
 * calendar-month rollup of the daily points**, not a new endpoint and not a new
 * `interval`: the API zero-fills every day in a window and `catalog.*` values
 * are plain additive counts, so summing by `YYYY-MM` is exact. `interval=day`
 * remains the only wire value.
 *
 * Two things this costs, both handled below. The 12-month window reaches back
 * further than the audit log does on most tiers, so it can carry a
 * `catalog_series_starts_at` caveat the 30-day window never sees — which is why
 * **notes are held per tab** rather than shared. And the wide fetch is four more
 * requests, so it fires **lazily**, the first time Monthly is opened, rather than
 * on every arrival at a screen most operators read for the gap lists.
 */
@Component({
  selector: 'aec-catalog-coverage',
  imports: [AdditionsTable, AdminNotes, RouterLink, Tab, TabContent, TabList, TabPanel, Tabs],
  templateUrl: './catalog-coverage.html',
})
export class CatalogCoverage {
  private readonly api = inject(AdminCatalogApi);

  protected readonly coverage = signal<AdminCatalogCoverageResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** The additions panel is a second request set and fails independently — a
   *  timeseries outage must not blank the gap lists, which are the actionable
   *  half of this screen. Each tab fails independently of the other, too. */
  protected readonly tab = signal<AdditionsTab>('daily');

  protected readonly daily = signal<SeriesData>(EMPTY_SERIES);
  protected readonly dailyLoading = signal(true);
  protected readonly dailyFailed = signal(false);

  protected readonly monthly = signal<SeriesData>(EMPTY_SERIES);
  /** Starts false, not true: nothing is in flight until the tab is opened. */
  protected readonly monthlyLoading = signal(false);
  protected readonly monthlyFailed = signal(false);
  /** Set the moment the first monthly fetch starts, so re-selecting the tab is
   *  free. `loadMonthly()` ignores it, which is what makes the retry button work. */
  private monthlyRequested = false;

  protected readonly notes = computed<readonly AdminNote[]>(() => this.coverage()?.notes ?? []);
  protected readonly gaps = computed(() => this.coverage()?.gaps ?? []);
  protected readonly taxonomy = computed(() => this.coverage()?.taxonomy ?? []);

  /** Column headers for the additions tables, in `SERIES_METRICS` order. */
  protected readonly seriesLabels: readonly string[] = [
    $localize`:@@admin.catalog.series.products:Products`,
    $localize`:@@admin.catalog.series.integrations:Integrations`,
    $localize`:@@admin.catalog.series.vendors:Vendors`,
    $localize`:@@admin.catalog.series.claims:Claims`,
  ];

  constructor() {
    afterNextRender(() => {
      void this.load();
      void this.loadDaily();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    try {
      this.coverage.set(await this.api.coverage());
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * The four `catalog.*` series over one inclusive UTC window, fetched in
   * parallel and zipped into one table. Every response is zero-filled across the
   * same window by the API, so the day spines align by construction and the zip
   * needs no key matching beyond the index.
   *
   * Returns rows **ascending**; callers reverse after any rollup.
   */
  private async fetchSeries(from: string, to: string): Promise<SeriesData> {
    const responses = await Promise.all(
      SERIES_METRICS.map((metric) => this.api.timeseries(metric, from, to)),
    );

    const days = responses[0]?.points.map((p) => p.day) ?? [];
    const rows = days.map((bucket, i) => ({
      bucket,
      values: responses.map((r) => r.points[i]?.value ?? 0),
    }));

    // One note per code across the four responses — they share a window, so the
    // caveats are identical and repeating them four times is noise.
    const seen = new Set<string>();
    const notes = responses
      .flatMap((r) => r.notes)
      .filter((n) => (seen.has(n.code) ? false : (seen.add(n.code), true)));

    return { rows, notes };
  }

  /**
   * The trailing {@link SERIES_DAYS} UTC days INCLUDING today. The API's
   * `from`/`to` are inclusive calendar dates.
   */
  protected async loadDaily(): Promise<void> {
    this.dailyFailed.set(false);
    this.dailyLoading.set(true);
    const now = Date.now();
    try {
      const { rows, notes } = await this.fetchSeries(
        utcDay(now - (SERIES_DAYS - 1) * DAY_MS),
        utcDay(now),
      );
      // Newest day first — the operator reads the most recent additions at the
      // top, not after scrolling 30 rows. The API returns points ascending.
      this.daily.set({ rows: [...rows].reverse(), notes });
    } catch {
      this.dailyFailed.set(true);
      this.daily.set(EMPTY_SERIES);
    } finally {
      this.dailyLoading.set(false);
    }
  }

  /**
   * The trailing {@link SERIES_MONTHS} UTC calendar months, from the 1st of the
   * earliest through today. Requested per day and rolled up here, because
   * `interval` has exactly one wire value.
   */
  protected async loadMonthly(): Promise<void> {
    this.monthlyRequested = true;
    this.monthlyFailed.set(false);
    this.monthlyLoading.set(true);
    const now = Date.now();
    try {
      const { rows, notes } = await this.fetchSeries(
        utcMonthStart(now, SERIES_MONTHS - 1),
        utcDay(now),
      );
      this.monthly.set({ rows: toMonthlyRows(rows).reverse(), notes });
    } catch {
      this.monthlyFailed.set(true);
      this.monthly.set(EMPTY_SERIES);
    } finally {
      this.monthlyLoading.set(false);
    }
  }

  /**
   * `ngTabList` writes its `selectedTab` model and emits here. The fetch hangs
   * off this event rather than off panel render because `ngTabContent` destroys
   * the inactive panel: keying the load off rendering would refetch on every
   * switch back.
   */
  protected selectTab(value: string | undefined): void {
    const next: AdditionsTab = value === 'monthly' ? 'monthly' : 'daily';
    this.tab.set(next);
    if (next === 'monthly' && !this.monthlyRequested) void this.loadMonthly();
  }

  protected retry(): void {
    void this.load();
  }

  // ─── Labels ────────────────────────────────────────────────────────────────

  protected gapLabel(key: AdminCoverageGapKey): string {
    switch (key) {
      case 'products_without_vendor':
        return $localize`:@@admin.catalog.gap.vendor:No vendor`;
      case 'products_without_logo':
        return $localize`:@@admin.catalog.gap.logo:No logo`;
      case 'products_without_description':
        return $localize`:@@admin.catalog.gap.description:No description`;
      case 'products_without_api_docs':
        return $localize`:@@admin.catalog.gap.apiDocs:No API documentation link`;
      case 'products_without_category':
        return $localize`:@@admin.catalog.gap.category:No category`;
      case 'products_without_audience':
        return $localize`:@@admin.catalog.gap.audience:No audience`;
      case 'products_without_phase':
        return $localize`:@@admin.catalog.gap.phase:No project phase`;
      case 'products_without_trade':
        return $localize`:@@admin.catalog.gap.trade:No trade`;
      default: {
        const exhaustive: never = key;
        return exhaustive;
      }
    }
  }

  protected facetLabel(facet: AdminTaxonomyFacet): string {
    switch (facet) {
      case 'category':
        return $localize`:@@admin.catalog.facet.category:Categories`;
      case 'audience':
        return $localize`:@@admin.catalog.facet.audience:Audiences`;
      case 'phase':
        return $localize`:@@admin.catalog.facet.phase:Project phases`;
      case 'trade':
        return $localize`:@@admin.catalog.facet.trade:Trades`;
      case 'data_object':
        return $localize`:@@admin.catalog.facet.dataObject:Data objects`;
      default: {
        const exhaustive: never = facet;
        return exhaustive;
      }
    }
  }

  /** What a facet's `count` column actually counts — data objects hang off
   *  claims, not products, and the header has to say so. */
  protected facetCountLabel(countsWhat: 'products' | 'claims'): string {
    return countsWhat === 'claims'
      ? $localize`:@@admin.catalog.facet.countsClaims:Claims`
      : $localize`:@@admin.catalog.facet.countsProducts:Products`;
  }

  protected promotionStatusLabel(status: AdminPromotionStatus): string {
    switch (status) {
      case 'pending':
        return $localize`:@@admin.catalog.promotion.pending:Pending`;
      case 'ready':
        return $localize`:@@admin.catalog.promotion.ready:Ready`;
      case 'promoted':
        return $localize`:@@admin.catalog.promotion.promoted:Promoted`;
      case 'retracted':
        return $localize`:@@admin.catalog.promotion.retracted:Retracted`;
      case 'rejected':
        return $localize`:@@admin.catalog.promotion.rejected:Rejected`;
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  }

  protected researchStatusLabel(status: AdminResearchStatus): string {
    switch (status) {
      case 'pending':
        return $localize`:@@admin.catalog.research.pending:Pending`;
      case 'in_progress':
        return $localize`:@@admin.catalog.research.inProgress:In progress`;
      case 'done':
        return $localize`:@@admin.catalog.research.done:Done`;
      case 'blocked':
        return $localize`:@@admin.catalog.research.blocked:Blocked`;
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  }

  /** Published / thin against `TRADE_PUBLISH_MIN_PRODUCTS`. `null` means the
   *  facet has no publication gate at all, which is not the same as failing one. */
  protected publicationLabel(published: boolean | null): string {
    if (published === null) return '';
    return published
      ? $localize`:@@admin.catalog.trade.published:Published`
      : $localize`:@@admin.catalog.trade.thin:Thin`;
  }
}

/** `YYYY-MM-DD` for a UTC instant. The API's windows are UTC-only (§9.5); the
 *  browser's local timezone never enters the query. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` for the first UTC day of the month `back` calendar months before
 * the month containing `ms`. Calendar arithmetic, not `back * 30 * DAY_MS` — the
 * Monthly tab's buckets are months, so its window has to start on a month
 * boundary or the earliest row would be a partial month masquerading as a whole
 * one. `Date.UTC` rolls a negative month index into the previous year.
 */
function utcMonthStart(ms: number, back: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * Sum ascending daily rows into `YYYY-MM` buckets, preserving ascending order.
 *
 * Exact rather than approximate: the API zero-fills every day in the window, so
 * a month's bucket is the sum of every day it contains, with no gaps to infer.
 * Insertion order follows the day spine, so the caller's `reverse()` yields
 * newest month first — matching the Daily tab.
 */
function toMonthlyRows(daily: readonly AdditionsRow[]): AdditionsRow[] {
  const buckets = new Map<string, number[]>();
  for (const row of daily) {
    const key = row.bucket.slice(0, 7);
    const acc = buckets.get(key) ?? row.values.map(() => 0);
    row.values.forEach((v, i) => (acc[i] += v));
    buckets.set(key, acc);
  }
  return [...buckets].map(([bucket, values]) => ({ bucket, values }));
}
