import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, ChangeDetectionStrategy, computed, inject, input, signal } from '@angular/core';

import type { ProductReviewsResponse, PublicReview } from '@aeci/shared';

import { ReviewCta } from '../reviews/review-cta';
import { ReviewStars } from '../reviews/review-stars';

/**
 * Page size for the reviews list. Matches the API's `EMBED_REVIEWS_PAGE_SIZE`
 * (`apps/api/src/lib/prisma-helpers.ts`) so the SSR-embedded first page
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
 */
@Component({
  selector: 'aec-product-reviews',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ReviewCta, ReviewStars],
  templateUrl: './product-reviews.html',
})
export class ProductReviews {
  private readonly http = inject(HttpClient);

  readonly slug = input.required<string>();
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

  protected readonly hasMore = computed(() => this.reviews().length < this.reviewCount());

  protected readonly overallDisplay = computed(() => (this.ratingOverallAvg() ?? 0).toFixed(1));
  protected readonly onboardingDisplay = computed(() =>
    (this.ratingOnboardingAvg() ?? 0).toFixed(1),
  );

  protected readonly summaryCountLabel = computed(() => {
    const count = this.reviewCount();
    return $localize`:@@products.detail.reviews.summaryCount:Based on ${count}:COUNT: reviews`;
  });

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

  protected yearsLabel(years: number): string {
    return $localize`:@@products.detail.reviews.years:${years}:COUNT: yrs using`;
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
