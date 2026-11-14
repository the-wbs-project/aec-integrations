import { Component, computed, input } from '@angular/core';
import { AecIcon } from '../shared/icon/icon';

/**
 * AECI-271: the home credibility row. A slim proof row that closes the hero's
 * Bone band: coverage counts on one side, the brand's core promise
 * ("Independent. Rankings are algorithmic.") stated as fact on the other. It
 * does not repeat "no pay-for-placement": the hero lede and the argument band
 * already say it, and the page says it at most twice (AECI-1555). It is the
 * home's only figure row.
 *
 * Background-agnostic: it paints no ground of its own. `home.ts` mounts it inside
 * the hero's Bone wrapper, and its hairline `border-t` sits inside the centred
 * content column, so it reads as the last row of the hero band.
 *
 * Purely presentational: counts arrive as signal inputs from `HomeStatsResponse`
 * (the cached `GET /api/stats/home` snapshot, never live-aggregated) via the 4.11
 * page assembly. No fetching, no cookie/visitor-state read — the SSR output is
 * cache-neutral.
 *
 * Thin-corpus discipline (the §4.1 rule):
 * each metric is suppressed at `0` — so reviews stay hidden pre-launch (never
 * "0 reviews") and surface automatically once the corpus grows. If every
 * coverage count is `0` (sparse pre-launch cache) the count row collapses to a
 * single honest "Indexing in progress" line; the independence marker always
 * renders. Pluralization is handled in the component (mirrors `IntegrationStat`)
 * rather than ICU, keeping the markup readable.
 *
 * Treatment per DESIGN.md: borders-not-shadows (a 1px `--border-default` rule),
 * Forest (`--accent-primary`) on every figure, `--text-secondary` for labels
 * (never `--text-tertiary`, which fails AA). Sentence case, no em dashes. Light
 * theme only (Stage 1). i18n throughout; the aec-icon scale glyph is `aria-hidden`
 * (the visible text carries the meaning). Anchor site: Faire (AECI-270).
 *
 * The glyph is a BALANCE SCALE, deliberately not a shield-check. A checkmark on a
 * public surface reads as a verification/endorsement signal, and AECi verifies
 * nothing today (zero vendor attestations until the Stage 2 portal). A scale
 * carries the intended meaning here — impartiality — with no trust-badge
 * connotation. Do not swap in a check, shield, or tick glyph.
 *
 * Contributing firms (AECI-284): the distinct count of firms among approved
 * reviews (`HomeStatsResponse.total_contributing_firms`), wired in as another
 * suppressed-at-0 coverage metric — it surfaces once reviews carry firm names.
 *
 * Liveness (AECI-1573): the integrations metric carries "+{n} in the last 30
 * days" from `HomeStatsResponse.integrations_added_30d`, rendered only when the
 * count is above 0 (and only beside a shown integrations count).
 */
/** `note` is a secondary fact rendered after the label (the 30-day liveness line). */
type CoverageMetric = { key: string; count: number; label: string; note?: string };

@Component({
  selector: 'aec-home-credibility-strip',
  imports: [AecIcon],
  template: `
    <section
      aria-label="Directory coverage and independence"
      i18n-aria-label="@@home.credibility.region.aria"
    >
      <div class="mx-auto w-full max-w-7xl px-6 md:px-8">
        <div
          class="flex flex-col gap-3 border-t border-(--border-default) py-4 sm:flex-row
            sm:items-center sm:justify-between sm:gap-6"
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
                  @if (m.note) {
                    <span class="text-sm text-(--text-secondary)" aria-hidden="true">·</span>
                    <span class="text-sm tabular-nums text-(--text-secondary)">{{ m.note }}</span>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="text-sm text-(--text-secondary)" i18n="@@home.credibility.empty">
              Indexing in progress
            </p>
          }

          <p class="flex items-center gap-2 text-sm font-medium text-(--text-secondary)">
            <aec-icon class="text-(--accent-primary)" name="scale" decorative [size]="4" />
            <span i18n="@@home.credibility.promise">Independent. Rankings are algorithmic.</span>
          </p>
        </div>
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
  /** `HomeStatsResponse.integrations_added_30d`: the liveness note on the
   *  integrations metric, suppressed at `0`. */
  readonly integrationsAdded30d = input<number>(0);

  /** The non-zero coverage counts, in display order. A `0` count drops out, so
   *  the strip never shows a bare zero (§4.1 thin-corpus framing). */
  protected readonly metrics = computed<CoverageMetric[]>(() => {
    const out: CoverageMetric[] = [];
    const add = (key: string, count: number, one: string, other: string, note?: string): void => {
      if (count > 0) out.push({ key, count, label: count === 1 ? one : other, note });
    };
    const added = this.integrationsAdded30d();
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
      added > 0
        ? $localize`:@@home.credibility.added30d:+${added}:count: in the last 30 days`
        : undefined,
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
