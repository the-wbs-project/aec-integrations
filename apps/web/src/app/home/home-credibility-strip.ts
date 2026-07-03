import { Component, computed, input } from '@angular/core';

/**
 * AECI-271 (§4.1 section 2) — the home credibility / social-proof strip. A slim,
 * full-bleed proof bar mounted directly under the hero: coverage counts on one
 * side, the brand's core promise ("independent · no pay-for-placement") stated as
 * fact on the other. NOT a second stats block — the mid-page `home-stats-cards`
 * keeps the "at a glance" job; this is a thin trust bar.
 *
 * Purely presentational: counts arrive as signal inputs from `HomeStatsResponse`
 * (the cached `GET /api/stats/home` snapshot, never live-aggregated) via the 4.11
 * page assembly. No fetching, no cookie/visitor-state read — the SSR output is
 * cache-neutral.
 *
 * Thin-corpus discipline (the §4.1 rule, shared with `home-stats-cards.ts`):
 * each metric is suppressed at `0` — so reviews stay hidden pre-launch (never
 * "0 reviews") and surface automatically once the corpus grows. If every
 * coverage count is `0` (sparse pre-launch cache) the count row collapses to a
 * single honest "Indexing in progress" line; the independence marker always
 * renders. Pluralization is handled in the component (mirrors `IntegrationStat`)
 * rather than ICU, keeping the markup readable.
 *
 * Treatment per DESIGN.md: borders-not-shadows (a 1px `--border-default` band),
 * Forest (`--accent-primary`) on every figure, `--text-secondary` for labels
 * (never `--text-tertiary`, which fails AA). Sentence case, no em dashes. Light
 * theme only (Stage 1). i18n throughout; the Lucide shield glyph is `aria-hidden`
 * (the visible text carries the meaning). Anchor site: Faire (AECI-270).
 *
 * Contributing firms (AECI-284): the distinct count of firms among approved
 * reviews (`HomeStatsResponse.total_contributing_firms`), wired in as another
 * suppressed-at-0 coverage metric — it surfaces once reviews carry firm names.
 */
type CoverageMetric = { key: string; count: number; label: string };

@Component({
  selector: 'aec-home-credibility-strip',
  template: `
    <section
      class="border-y border-(--border-default) bg-(--surface-base)"
      aria-label="Directory coverage and independence"
      i18n-aria-label="@@home.credibility.region.aria"
    >
      <div
        class="mx-auto flex w-full max-w-7xl flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center
          sm:justify-between sm:gap-6 md:px-8"
      >
        @if (metrics().length > 0) {
          <ul role="list" class="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            @for (m of metrics(); track m.key) {
              <li class="flex items-baseline gap-1.5">
                <span
                  class="font-display text-base font-semibold tabular-nums text-(--accent-primary)"
                >
                  {{ m.count }}
                </span>
                <span class="text-sm text-(--text-secondary)">{{ m.label }}</span>
              </li>
            }
          </ul>
        } @else {
          <p class="text-sm text-(--text-secondary)" i18n="@@home.credibility.empty">
            Indexing in progress
          </p>
        }

        <p class="flex items-center gap-2 text-sm font-medium text-(--text-secondary)">
          <svg
            class="h-4 w-4 shrink-0 text-(--accent-primary)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
            />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span i18n="@@home.credibility.independence">Independent · no pay-for-placement</span>
        </p>
      </div>
    </section>
  `,
})
export class HomeCredibilityStrip {
  /** `HomeStatsResponse.total_products` — suppressed at `0`. */
  readonly totalProducts = input.required<number>();
  /** `HomeStatsResponse.total_vendors` — suppressed at `0`. */
  readonly totalVendors = input.required<number>();
  /** `HomeStatsResponse.total_integrations` — suppressed at `0`. */
  readonly totalIntegrations = input.required<number>();
  /** `HomeStatsResponse.total_reviews` — suppressed at `0` (no "0 reviews"); appears as the corpus grows. */
  readonly totalReviews = input.required<number>();
  /** `HomeStatsResponse.total_contributing_firms` — distinct firms among approved
   *  reviews (AECI-284), suppressed at `0` (no "0 contributing firms"). */
  readonly totalContributingFirms = input.required<number>();

  /** The non-zero coverage counts, in display order. A `0` count drops out, so
   *  the strip never shows a bare zero (§4.1 thin-corpus framing). */
  protected readonly metrics = computed<CoverageMetric[]>(() => {
    const out: CoverageMetric[] = [];
    const add = (key: string, count: number, one: string, other: string): void => {
      if (count > 0) out.push({ key, count, label: count === 1 ? one : other });
    };
    add(
      'products',
      this.totalProducts(),
      $localize`:@@home.credibility.products.one:product`,
      $localize`:@@home.credibility.products.other:products`,
    );
    add(
      'vendors',
      this.totalVendors(),
      $localize`:@@home.credibility.vendors.one:vendor`,
      $localize`:@@home.credibility.vendors.other:vendors`,
    );
    add(
      'integrations',
      this.totalIntegrations(),
      $localize`:@@home.credibility.integrations.one:integration`,
      $localize`:@@home.credibility.integrations.other:integrations`,
    );
    add(
      'reviews',
      this.totalReviews(),
      $localize`:@@home.credibility.reviews.one:review`,
      $localize`:@@home.credibility.reviews.other:reviews`,
    );
    add(
      'firms',
      this.totalContributingFirms(),
      $localize`:@@home.credibility.firms.one:contributing firm`,
      $localize`:@@home.credibility.firms.other:contributing firms`,
    );
    return out;
  });
}
