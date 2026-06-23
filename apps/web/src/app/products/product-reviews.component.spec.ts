import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductReviewsResponse, PublicReview } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import { AuthService } from '../auth/auth.service';

import { ProductReviews } from './product-reviews';

/**
 * AECI-201 — the Reviews section: the summary gate (0 / <5 / ≥5), the empty
 * state, and "Load more" pagination. The embedded CTA's auth probe is stubbed
 * to the neutral path (unconfigured) so these tests stay focused on the
 * public, cache-safe content.
 */

function makeReview(i: number, over: Partial<PublicReview> = {}): PublicReview {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    rating_overall: 4,
    rating_onboarding: 3,
    title: `Review ${i}`,
    body: `Body of review ${i} — long enough to read.`,
    role_at_company: null,
    years_using: null,
    would_recommend: null,
    verified_work_email: false,
    created_at: '2026-01-02T03:04:05.000Z',
    ...over,
  };
}

function makeReviews(n: number): PublicReview[] {
  return Array.from({ length: n }, (_, i) => makeReview(i + 1));
}

interface Inputs {
  slug?: string;
  productId?: string;
  reviewCount: number;
  ratingOverallAvg?: number | null;
  ratingOnboardingAvg?: number | null;
  firstPage: readonly PublicReview[];
}

function setup(inputs: Inputs) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      // Keep the embedded CTA neutral (no network) — its own spec covers it. The
      // unconfigured auth short-circuits before the AccountApi lookup; the stub
      // just guarantees no real request even if that ever changes.
      { provide: AuthService, useValue: { isConfigured: vi.fn(() => false), isSignedIn: vi.fn() } },
      { provide: AccountApi, useValue: { findMyReviewForProduct: vi.fn(async () => null) } },
    ],
  });
  const fixture = TestBed.createComponent(ProductReviews);
  fixture.componentRef.setInput('slug', inputs.slug ?? 'procore');
  fixture.componentRef.setInput(
    'productId',
    inputs.productId ?? '00000000-0000-4000-8000-000000000001',
  );
  fixture.componentRef.setInput('reviewCount', inputs.reviewCount);
  fixture.componentRef.setInput('ratingOverallAvg', inputs.ratingOverallAvg ?? null);
  fixture.componentRef.setInput('ratingOnboardingAvg', inputs.ratingOnboardingAvg ?? null);
  fixture.componentRef.setInput('firstPage', inputs.firstPage);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, httpMock, el: fixture.nativeElement as HTMLElement };
}

describe('ProductReviews', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the "Be the first to review" empty state at 0 reviews', () => {
    const { el } = setup({ reviewCount: 0, firstPage: [] });

    expect(el.textContent?.toLowerCase()).toContain('be the first to review');
    expect(el.querySelectorAll('ul > li')).toHaveLength(0);
    // No summary, no threshold note.
    expect(el.textContent).not.toContain('Based on');
    expect(el.textContent).not.toContain('Ratings shown once');
  });

  it('shows the list + threshold note (no averages) when 0 < count < 5', () => {
    const { el } = setup({
      reviewCount: 3,
      ratingOverallAvg: null, // API nulls averages below 5
      ratingOnboardingAvg: null,
      firstPage: makeReviews(3),
    });

    expect(el.querySelectorAll('ul > li')).toHaveLength(3);
    expect(el.textContent).toContain('Ratings shown once this product has 5+ reviews');
    // The averages summary must be absent.
    expect(el.textContent).not.toContain('Based on');
  });

  it('shows the averages summary when count >= 5', () => {
    const { el } = setup({
      reviewCount: 7,
      ratingOverallAvg: 4.3,
      ratingOnboardingAvg: 3.8,
      firstPage: makeReviews(7),
    });

    expect(el.querySelectorAll('ul > li')).toHaveLength(7);
    expect(el.textContent).toContain('4.3');
    expect(el.textContent).toContain('3.8');
    expect(el.textContent).toContain('Based on 7 reviews');
    // The sub-5 note must NOT show.
    expect(el.textContent).not.toContain('Ratings shown once');
  });

  it('renders per-review meta: verified badge, role, years, recommendation', () => {
    const { el } = setup({
      reviewCount: 1,
      firstPage: [
        makeReview(1, {
          verified_work_email: true,
          role_at_company: 'manager',
          years_using: 3,
          would_recommend: 'yes',
        }),
      ],
    });

    const text = el.textContent ?? '';
    expect(text).toContain('Verified reviewer');
    expect(text).toContain('Manager');
    expect(text).toContain('3 yrs using');
    expect(text).toContain('Would recommend');
  });

  it('appends the next page on "Load more" and hides the button at the end', async () => {
    const { fixture, el, httpMock } = setup({
      reviewCount: 30,
      ratingOverallAvg: 4.1,
      ratingOnboardingAvg: 3.9,
      firstPage: makeReviews(24),
    });

    // Page 1 (24) is shown, 6 remain → the button is present.
    expect(el.querySelectorAll('ul > li')).toHaveLength(24);
    const button = el.querySelector('button') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('Load more reviews');

    button.click();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/products/procore/reviews' && r.params.get('page') === '2',
    );
    expect(req.request.params.get('perPage')).toBe('24');
    const page2: ProductReviewsResponse = {
      data: makeReviews(6),
      page: 2,
      perPage: 24,
      total: 30,
    };
    req.flush(page2);

    await fixture.whenStable();
    fixture.detectChanges();

    // 24 + 6 = 30 = total → list complete, button gone.
    expect(el.querySelectorAll('ul > li')).toHaveLength(30);
    expect(el.querySelector('button')).toBeNull();
  });
});
