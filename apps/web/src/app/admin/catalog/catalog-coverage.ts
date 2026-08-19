import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
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
import { AdminCatalogApi } from './admin-catalog-api';

/** Days of catalog additions shown, matching the overview's 30-day traffic chart. */
const SERIES_DAYS = 30;
const DAY_MS = 86_400_000;

/** The four `catalog.*` additions series, in the order §5.5 names them. */
const SERIES_METRICS: readonly AdminMetricKey[] = [
  'catalog.products_created',
  'catalog.integrations_created',
  'catalog.vendors_created',
  'catalog.claims_created',
];

/** One row of the additions table: a UTC day and the four series' values. */
export interface AdditionsRow {
  day: string;
  values: readonly number[];
}

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
 * **Additions are not totals.** The table is fed by
 * `GET /api/admin/metrics/timeseries`, whose `catalog_series_is_additions_only`
 * note is rendered directly above it. That banner is load-bearing (§4: 827
 * `integration.created` events back 496 live rows) and is the thing most likely
 * to be quietly dropped in a refactor — hence its own component spec.
 */
@Component({
  selector: 'aec-catalog-coverage',
  imports: [AdminNotes, RouterLink],
  templateUrl: './catalog-coverage.html',
})
export class CatalogCoverage {
  private readonly api = inject(AdminCatalogApi);

  protected readonly coverage = signal<AdminCatalogCoverageResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** The additions table is a second request set and fails independently — a
   *  timeseries outage must not blank the gap lists, which are the actionable
   *  half of this screen. */
  protected readonly additionsRows = signal<readonly AdditionsRow[]>([]);
  protected readonly additionsNotes = signal<readonly AdminNote[]>([]);
  protected readonly additionsLoading = signal(true);
  protected readonly additionsFailed = signal(false);

  protected readonly notes = computed<readonly AdminNote[]>(() => this.coverage()?.notes ?? []);
  protected readonly gaps = computed(() => this.coverage()?.gaps ?? []);
  protected readonly taxonomy = computed(() => this.coverage()?.taxonomy ?? []);

  /** Column headers for the additions table, in `SERIES_METRICS` order. */
  protected readonly seriesLabels: readonly string[] = [
    $localize`:@@admin.catalog.series.products:Products`,
    $localize`:@@admin.catalog.series.integrations:Integrations`,
    $localize`:@@admin.catalog.series.vendors:Vendors`,
    $localize`:@@admin.catalog.series.claims:Claims`,
  ];

  /** Column totals, so the table has a footer an operator can read at a glance. */
  protected readonly seriesTotals = computed<readonly number[]>(() =>
    SERIES_METRICS.map((_, i) =>
      this.additionsRows().reduce((acc, r) => acc + (r.values[i] ?? 0), 0),
    ),
  );

  /** True when nothing was added in the whole window — common on a quiet catalog
   *  and worth saying, rather than showing 30 rows of zeros. */
  protected readonly additionsEmpty = computed(() => this.seriesTotals().every((v) => v === 0));

  constructor() {
    afterNextRender(() => {
      void this.load();
      void this.loadAdditions();
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
   * The four `catalog.*` series, fetched in parallel and zipped into one table.
   * Every response is zero-filled across the same window by the API, so the day
   * spines align by construction and the zip needs no key matching beyond the
   * index.
   *
   * The window is the trailing {@link SERIES_DAYS} UTC days INCLUDING today. The
   * API's `from`/`to` are inclusive calendar dates.
   */
  private async loadAdditions(): Promise<void> {
    this.additionsFailed.set(false);
    this.additionsLoading.set(true);
    const now = Date.now();
    const to = utcDay(now);
    const from = utcDay(now - (SERIES_DAYS - 1) * DAY_MS);
    try {
      const responses = await Promise.all(
        SERIES_METRICS.map((metric) => this.api.timeseries(metric, from, to)),
      );

      // Newest day first — the operator reads the most recent additions at the
      // top, not after scrolling 30 rows. The API returns points ascending.
      const days = responses[0]?.points.map((p) => p.day) ?? [];
      this.additionsRows.set(
        days
          .map((day, i) => ({
            day,
            values: responses.map((r) => r.points[i]?.value ?? 0),
          }))
          .reverse(),
      );

      // One note per code across the four responses — they share a window, so the
      // caveats are identical and repeating them four times is noise.
      const seen = new Set<string>();
      this.additionsNotes.set(
        responses
          .flatMap((r) => r.notes)
          .filter((n) => (seen.has(n.code) ? false : (seen.add(n.code), true))),
      );
    } catch {
      this.additionsFailed.set(true);
      this.additionsRows.set([]);
      this.additionsNotes.set([]);
    } finally {
      this.additionsLoading.set(false);
    }
  }

  protected retry(): void {
    void this.load();
  }

  protected retryAdditions(): void {
    void this.loadAdditions();
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
