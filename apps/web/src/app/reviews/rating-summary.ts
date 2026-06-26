import { Component, computed, input } from '@angular/core';

import { RATING_VISIBILITY_MIN_REVIEWS } from '@aeci/shared';

/**
 * Compact, editorial rating display for product **cards and table rows** — the
 * list-surface counterpart to the detail page's five-star `ReviewStars`
 * (`reviews/review-stars.ts`). Deliberately *not* a five-star row: AECi refuses
 * the G2/Capterra "review-farm" look (PRODUCT.md anti-references). The treatment
 * is numeral-forward — a single gold star, the average, and a review-count
 * caption — so a list of products reads like an editorial table, not a ratings
 * wall.
 *
 * Owns the §5.5 visibility gate (`RATING_VISIBILITY_MIN_REVIEWS`) so it behaves
 * identically whether bound to an API `ProductListItem` or a denormalized
 * `AlgoliaProductRecord`: the average is shown only at ≥5 approved reviews AND a
 * non-null `ratingOverall`. (The API list mapper now also nulls sub-5 averages —
 * `drizzle-helpers.ts` `toProductListItem` — so the `ratingOverall != null` half
 * of the guard is belt-and-braces; the `reviewCount` half covers the Algolia
 * path independently.)
 *
 * Two variants for the two empty-state needs:
 *   - `inline` (default, grid + search cards) — renders **nothing** when gated,
 *     so the card reflows with no orphaned label.
 *   - `cell` (dense table row) — renders an en-dash empty state when gated, the
 *     same `–` + `aria-label` pattern the vendor / category cells use, so the
 *     `<td>` stays populated and the column doesn't collapse.
 *
 * Accessibility mirrors `ReviewStars`: the star glyph is decorative
 * (`aria-hidden`) and the precise meaning is carried by the visible numeral +
 * caption and announced once via a `role="img"` + `aria-label`, never by color
 * alone (the Goldenrod `--accent-rating` fill is sub-3:1 but decorative). Light
 * theme only (Stage 1) via tokens.
 */
export type RatingSummaryVariant = 'inline' | 'cell';

@Component({
  selector: 'aec-rating-summary',
  // When the inline variant is gated it renders nothing — collapse the host to
  // `display:none` so it's removed from flex/`gap` layout entirely (an empty but
  // present element would otherwise leave a phantom gap on grid/search cards).
  // The cell variant always renders (rating or en-dash), so it never collapses.
  host: { '[style.display]': "collapsed() ? 'none' : null" },
  template: `
    @if (visible()) {
      <span
        role="img"
        [attr.aria-label]="ariaLabel()"
        class="inline-flex items-baseline gap-1.5 leading-none"
      >
        <span aria-hidden="true" class="text-sm" [style.color]="'var(--accent-rating)'">★</span>
        <span class="font-display text-sm font-semibold tabular-nums text-(--text-primary)">{{
          formatted()
        }}</span>
        <span class="text-xs text-(--text-secondary)">{{ countLabel() }}</span>
      </span>
    } @else if (variant() === 'cell') {
      <span class="text-(--text-secondary)" [attr.aria-label]="noneLabel()">–</span>
    }
  `,
})
export class RatingSummary {
  /** Average overall rating, or `null` when withheld / absent. */
  readonly ratingOverall = input.required<number | null>();
  /** Count of approved reviews — drives both the gate and the caption. */
  readonly reviewCount = input.required<number>();
  readonly variant = input<RatingSummaryVariant>('inline');

  /** §5.5: show the average only at ≥5 approved reviews and a real value. */
  protected readonly visible = computed(
    () => this.reviewCount() >= RATING_VISIBILITY_MIN_REVIEWS && this.ratingOverall() !== null,
  );

  /** The inline variant renders nothing when gated → collapse the host. */
  protected readonly collapsed = computed(() => !this.visible() && this.variant() === 'inline');

  /** One-decimal average (e.g. `4.3`); only read when `visible()`. */
  protected readonly formatted = computed(() => (this.ratingOverall() ?? 0).toFixed(1));

  // Always plural: the caption only renders when `visible()`, which requires
  // `reviewCount >= RATING_VISIBILITY_MIN_REVIEWS` (5) — so the count is never 1.
  // (If the threshold ever drops below 2, reintroduce a singular branch.)
  protected readonly countLabel = computed(
    () => $localize`:@@reviews.rating.count:${this.reviewCount()}:COUNT: reviews`,
  );

  protected readonly ariaLabel = computed(
    () =>
      $localize`:@@reviews.rating.aria:Rated ${this.formatted()}:VALUE: out of 5, from ${this.reviewCount()}:COUNT: reviews`,
  );

  protected readonly noneLabel = computed(
    () => $localize`:@@reviews.rating.none.aria:No ratings yet`,
  );
}
