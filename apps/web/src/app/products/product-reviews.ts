import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, ChangeDetectionStrategy, computed, inject, input, signal } from '@angular/core';

import type {
  ProductReviewsResponse,
  PublicReview,
  PublicReviewUpdate,
  PublicVendorResponse,
} from '@aeci/shared';

import { AecButton } from '../shared/button/button';
import { AecCard } from '../shared/card/card';
import { AecFigure } from '../shared/figure/figure';
import { ReviewCta } from '../reviews/review-cta';
import { ReviewStars } from '../reviews/review-stars';
import { AecIcon } from '../shared/icon/icon';

/**
 * Page size for the reviews list. Matches the API's `EMBED_REVIEWS_PAGE_SIZE`
 * (`apps/api/src/lib/drizzle-helpers.ts`) so the SSR-embedded first page
 * (`ProductDetail.reviews`) lines up exactly with page 1 of the list endpoint —
 * "Load more" then fetches page 2, 3, … with no overlap or gap.
 */
const REVIEWS_PER_PAGE = 24;

/**
 * AECI-201 — the Reviews section of the product detail page (Phase 5.10).
 *
 * Everything here is **public and cache-safe**: the approved-reviews list and
 * the ratings summary are visitor-neutral, so they are SSR'd into the cached
 * page. The only visitor-specific element — the submission CTA — is delegated
 * to `<aec-review-cta>`, which hydrates client-side (§8). This component reads
 * no cookies and no session.
 *
 * Inputs come straight off the resolved `ProductDetail`:
 *   - `firstPage` is the SSR-embedded page 1 (up to `REVIEWS_PER_PAGE`).
 *   - the averages are already null'd server-side when `reviewCount < 5`
 *     (`toProductDetail`), so the ≥5 gate here is belt-and-braces.
 *
 * Summary gate (§5.5):
 *   - `reviewCount === 0` → "Be the first to review" empty state.
 *   - `0 < reviewCount < 5` → list + "ratings shown at 5+" note, no averages.
 *   - `reviewCount >= 5` → list + the averages summary.
 *
 * "Load more" is an imperative browser fetch on click (never during SSR), so
 * it adds no SSR `/api/*` loopback and keeps the cached HTML to page 1.
 *
 * Layout (AECI-1784, DESIGN.md §5 Score Display and §4 clash 14): at ≥5 reviews
 * two score cards, one per score at the 48px figure and never blended, beside a
 * range marker card. Each review is one `aecCard`. Nothing here reorders: the
 * list is the API's order.
 *
 * Vendor replies (AECI-1178, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.15): each
 * review is an `article` named by its title. The article is the review card. It
 * holds the review as written, then its published `vendor_responses` as nested
 * panels under the review text (clash 14). Each reply
 * is a `section` labelled by its "Response from {vendor}" heading, whose
 * screen-reader-only tail names the review, so a reply is announced as belonging
 * to its review and every reply region has a unique name. The API already
 * filtered to published replies (§11c.11); this component renders what it is
 * given and adds no visitor state, so the cached HTML stays neutral.
 */
@Component({
  selector: 'aec-product-reviews',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecButton, AecCard, AecFigure, AecIcon, DatePipe, ReviewCta, ReviewStars],
  templateUrl: './product-reviews.html',
})
export class ProductReviews {
  private readonly http = inject(HttpClient);

  readonly slug = input.required<string>();
  /** The product's UUID — forwarded to `<aec-review-cta>` for its browser-side
   *  "already reviewed" lookup (AECI-260). Never read during SSR render. */
  readonly productId = input.required<string>();
  readonly reviewCount = input.required<number>();
  readonly ratingOverallAvg = input.required<number | null>();
  readonly ratingOnboardingAvg = input.required<number | null>();
  readonly firstPage = input.required<readonly PublicReview[]>();

  /** Pages 2..N appended by "Load more"; page 1 stays the SSR `firstPage`. */
  private readonly extraPages = signal<readonly PublicReview[]>([]);
  /** The next page number "Load more" will request. */
  private readonly nextPage = signal(2);

  protected readonly loadingMore = signal(false);
  protected readonly loadError = signal(false);

  /** Full displayed list: SSR page 1 + any client-loaded pages. */
  protected readonly reviews = computed<readonly PublicReview[]>(() => [
    ...this.firstPage(),
    ...this.extraPages(),
  ]);

  protected readonly isEmpty = computed(() => this.reviewCount() === 0);

  /** Averages render only at the ≥5 threshold (and only if the API sent them). */
  protected readonly showSummary = computed(
    () => this.reviewCount() >= 5 && this.ratingOverallAvg() !== null,
  );

  /** The "ratings shown at 5+" note: there are reviews, but fewer than 5. */
  protected readonly showThresholdNote = computed(
    () => this.reviewCount() > 0 && this.reviewCount() < 5,
  );

  /**
   * The review grid's column steps (ruling 34, Chris, 2026-11-16). One or two
   * reviews share the row equally, so no blank column is left: one review is
   * full width, two are halves from `md`. Three or more take the grid: two
   * columns from `md`, three from `xl`. Every card in a row is the same width,
   * so no review is featured. It reads only the number of cards shown, never
   * their content, and it never reorders.
   */
  protected readonly listColumnsClass = computed(() => {
    const shown = this.reviews().length;
    if (shown <= 1) return '';
    if (shown === 2) return 'md:grid-cols-2';
    // AECI-1720: a count that would leave one card alone on the last row of three
    // columns, but fills two exactly (4, 10, 16, 22), keeps two columns from xl too.
    // Every card is still the same width, so no review is featured. A count that
    // leaves one card alone in both (7, 13, 19) keeps three: no equal-width grid
    // avoids it there.
    if (shown % 3 === 1 && shown % 2 === 0) return 'md:grid-cols-2';
    return 'md:grid-cols-2 xl:grid-cols-3';
  });

  /** "Showing 6 of 7", the list row's count (mock-up 6, #rvShown). */
  protected readonly shownLabel = computed(() => {
    const shown = this.reviews().length;
    const total = this.reviewCount();
    return $localize`:@@products.detail.filter.status:Showing ${shown}:SHOWN: of ${total}:TOTAL:`;
  });

  /** The small "/5" after each score (mock-up 6, .score .bn small). */
  protected readonly outOfFive = $localize`:@@products.detail.reviews.outOfFive:/5`;

  protected readonly hasMore = computed(() => this.reviews().length < this.reviewCount());

  protected readonly overallDisplay = computed(() => (this.ratingOverallAvg() ?? 0).toFixed(1));
  protected readonly onboardingDisplay = computed(() =>
    (this.ratingOnboardingAvg() ?? 0).toFixed(1),
  );

  /** The score card names. The same ids and words the summary printed as overlines
   *  before AECI-1784; `aec-figure` takes its label as an input, so they moved here. */
  protected readonly overallLabel = $localize`:@@products.detail.reviews.overall:Product quality`;
  protected readonly onboardingLabel = $localize`:@@products.detail.reviews.onboarding:Onboarding experience`;

  /**
   * The range marker's pin positions on the shared 1 to 5 axis, in percent
   * (DESIGN.md §5 Score Display, "Range marker"). Two pins on one axis are two
   * scores, never a blend. Presentation only: the averages arrive already gated.
   */
  protected readonly overallPin = computed(() => this.axisPercent(this.ratingOverallAvg()));
  protected readonly onboardingPin = computed(() => this.axisPercent(this.ratingOnboardingAvg()));
  protected readonly axisTicks = [1, 2, 3, 4, 5] as const;

  private axisPercent(value: number | null): number {
    const v = Math.min(5, Math.max(1, value ?? 1));
    return ((v - 1) / 4) * 100;
  }

  /** Keeps a pin's label inside the axis: centred on the pin in the middle,
   *  starting at the pin at 1 and ending at it at 5. */
  protected labelShift(percent: number): string {
    return `translateX(${50 - percent}%)`;
  }

  /** The leading glyph on the "would recommend" chip. Decorative: the words carry it. */
  protected recommendIcon(recommend: 'yes' | 'no' | 'maybe'): 'thumb-up' | 'thumb-down' | 'meh' {
    switch (recommend) {
      case 'yes':
        return 'thumb-up';
      case 'no':
        return 'thumb-down';
      case 'maybe':
        return 'meh';
    }
  }

  protected readonly summaryCountLabel = computed(() => {
    const count = this.reviewCount();
    return $localize`:@@products.detail.reviews.summaryCount:Based on ${count}:COUNT: reviews`;
  });

  /** The review's published vendor replies. An API from before AECI-1178 omits
   *  the field (deploy skew, `API_CONTRACTS.md` §6.6), so `undefined` is empty. */
  protected repliesOf(review: PublicReview): readonly PublicVendorResponse[] {
    return (
      (review as { vendor_responses?: readonly PublicVendorResponse[] }).vendor_responses ?? []
    );
  }

  /** The review's approved reviewer updates, oldest first (AECI-1613). An API
   *  from before AECI-1613 omits the field (deploy skew), so `undefined` is empty. */
  protected updatesOf(review: PublicReview): readonly PublicReviewUpdate[] {
    return (review as { updates?: readonly PublicReviewUpdate[] }).updates ?? [];
  }

  protected updateLabelId(review: PublicReview, index: number): string {
    return `review-${review.id}-update-${index}`;
  }

  /** Screen-reader-only tail of the update heading: ties the update to its review
   *  and keeps each update region's accessible name unique on the page. A review
   *  can carry more than one update, so the date is part of the name. */
  protected updateContext(reviewTitle: string, date: string): string {
    return $localize`:@@products.detail.reviews.update.context:to the review “${reviewTitle}:TITLE:”, added ${date}:DATE:`;
  }

  protected titleId(review: PublicReview): string {
    return `review-${review.id}-title`;
  }

  protected replyLabelId(review: PublicReview, index: number): string {
    return `review-${review.id}-response-${index}`;
  }

  /** The visible reply label (§11c.15, exact wording). */
  protected responseLabel(vendorName: string): string {
    return $localize`:@@products.detail.reviews.response.label:Response from ${vendorName}:VENDOR:`;
  }

  /** Screen-reader-only tail of the reply heading: ties the reply to its review
   *  and keeps each reply region's accessible name unique on the page. */
  protected responseContext(reviewTitle: string): string {
    return $localize`:@@products.detail.reviews.response.context:to the review “${reviewTitle}:TITLE:”`;
  }

  loadMore(): void {
    if (this.loadingMore()) return;
    this.loadingMore.set(true);
    this.loadError.set(false);
    const page = this.nextPage();
    this.http
      .get<ProductReviewsResponse>(`/api/products/${encodeURIComponent(this.slug())}/reviews`, {
        params: { page, perPage: REVIEWS_PER_PAGE },
      })
      .subscribe({
        next: (res) => {
          this.extraPages.update((cur) => [...cur, ...res.data]);
          this.nextPage.set(page + 1);
          this.loadingMore.set(false);
        },
        error: () => {
          this.loadError.set(true);
          this.loadingMore.set(false);
        },
      });
  }

  protected roleLabel(role: string): string {
    switch (role) {
      case 'practitioner':
        return $localize`:@@products.detail.reviews.role.practitioner:Practitioner`;
      case 'manager':
        return $localize`:@@products.detail.reviews.role.manager:Manager`;
      case 'IT':
        return $localize`:@@products.detail.reviews.role.it:IT`;
      case 'exec':
        return $localize`:@@products.detail.reviews.role.exec:Executive`;
      case 'other':
        return $localize`:@@products.detail.reviews.role.other:Other`;
      default:
        return role;
    }
  }

  /**
   * "Using it 1 year" or "Using it {n} years" (mock-up 6). Two message ids, one per
   * plural form, the idiom this app uses for counts in TS. An ICU plural in the template
   * printed its text twice on one card after hydration, so it is not used here.
   */
  protected yearsLabel(years: number): string {
    return years === 1
      ? $localize`:@@products.detail.reviews.yearsUsing.one:Using it 1 year`
      : $localize`:@@products.detail.reviews.yearsUsing:Using it ${years}:COUNT: years`;
  }

  protected recommendLabel(recommend: 'yes' | 'no' | 'maybe'): string {
    switch (recommend) {
      case 'yes':
        return $localize`:@@products.detail.reviews.recommend.yes:Would recommend`;
      case 'no':
        return $localize`:@@products.detail.reviews.recommend.no:Would not recommend`;
      case 'maybe':
        return $localize`:@@products.detail.reviews.recommend.maybe:Might recommend`;
    }
  }
}
