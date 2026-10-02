import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductReviewsResponse, PublicReview, PublicVendorResponse } from '@aeci/shared';

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
    vendor_responses: [],
    ...over,
  };
}

function makeResponse(over: Partial<PublicVendorResponse> = {}): PublicVendorResponse {
  return {
    vendor_slug: 'autodesk',
    vendor_name: 'Autodesk',
    body: 'Thanks for the review.\nWe fixed this in 3.0.',
    published_at: '2026-09-11T10:00:00.000Z',
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

  describe('vendor replies (AECI-1178, §11c.15)', () => {
    it('renders no reply block for a review with no reply', () => {
      const { el } = setup({ reviewCount: 1, firstPage: [makeReview(1)] });

      expect(el.querySelectorAll('[data-testid="vendor-response"]')).toHaveLength(0);
      expect(el.textContent).not.toContain('Response from');
    });

    it('treats a missing vendor_responses (deploy skew) as no reply', () => {
      const old = makeReview(1) as Partial<PublicReview>;
      delete old.vendor_responses;
      const { el } = setup({ reviewCount: 1, firstPage: [old as PublicReview] });

      expect(el.querySelectorAll('[data-testid="vendor-response"]')).toHaveLength(0);
    });

    it('renders one reply under its review, outside the review card, labelled and dated', () => {
      const { el } = setup({
        reviewCount: 1,
        firstPage: [makeReview(1, { title: 'Saves hours', vendor_responses: [makeResponse()] })],
      });

      const article = el.querySelector('ul > li > article') as HTMLElement;
      const titleId = article.getAttribute('aria-labelledby')!;
      const title = el.querySelector(`[id="${titleId}"]`) as HTMLElement;
      expect(title.tagName).toBe('H3');
      expect(title.textContent?.trim()).toBe('Saves hours');

      const replies = article.querySelectorAll('[data-testid="vendor-response"]');
      expect(replies).toHaveLength(1);
      const reply = replies[0] as HTMLElement;
      // A separate block after the review card, never inside it.
      const card = article.firstElementChild as HTMLElement;
      expect(card.contains(reply)).toBe(false);
      expect(card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // Labelled by its heading, which names the vendor and ties it to the review.
      expect(reply.tagName).toBe('SECTION');
      const label = el.querySelector(`[id="${reply.getAttribute('aria-labelledby')}"]`)!;
      expect(label.tagName).toBe('H4');
      expect(reply.contains(label)).toBe(true);
      expect(label.textContent).toContain('Response from Autodesk');
      expect(label.querySelector('.sr-only')?.textContent).toContain('to the review “Saves hours”');

      const time = reply.querySelector('time')!;
      expect(time.getAttribute('datetime')).toBe('2026-09-11T10:00:00.000Z');
      expect(time.textContent?.trim()).toBe('Sep 11, 2026');
    });

    it('renders the body as plain text with its line breaks, never as HTML', () => {
      const { el } = setup({
        reviewCount: 1,
        firstPage: [
          makeReview(1, {
            vendor_responses: [
              makeResponse({ body: 'See <a href="https://x.test">https://x.test</a>\nThanks' }),
            ],
          }),
        ],
      });

      const body = el.querySelector('[data-testid="vendor-response"] p') as HTMLElement;
      expect(body.querySelector('a')).toBeNull();
      expect(body.textContent?.trim()).toBe(
        'See <a href="https://x.test">https://x.test</a>\nThanks',
      );
      expect(body.className).toContain('whitespace-pre-line');
    });

    it('stacks two co-owner replies in wire order, each with a unique label', () => {
      const { el } = setup({
        reviewCount: 2,
        firstPage: [
          makeReview(1, {
            vendor_responses: [
              makeResponse(),
              makeResponse({
                vendor_slug: 'bentley',
                vendor_name: 'Bentley',
                published_at: '2026-09-12T10:00:00.000Z',
              }),
            ],
          }),
          makeReview(2),
        ],
      });

      const items = el.querySelectorAll('ul > li');
      const first = items[0]!.querySelectorAll('[data-testid="vendor-response"]');
      expect([...first].map((r) => r.querySelector('h4 > span')?.textContent?.trim())).toEqual([
        'Response from Autodesk',
        'Response from Bentley',
      ]);
      const ids = [...first].map((r) => r.getAttribute('aria-labelledby'));
      expect(new Set(ids).size).toBe(2);
      expect(items[1]!.querySelectorAll('[data-testid="vendor-response"]')).toHaveLength(0);
    });

    it('does not change the review count, order or summary when a review has a reply', () => {
      const plain = makeReviews(5);
      const withReply = plain.map((r, i) =>
        i === 2 ? { ...r, vendor_responses: [makeResponse()] } : r,
      );
      const summary = (reviews: PublicReview[]) => {
        TestBed.resetTestingModule();
        const { el } = setup({
          reviewCount: 5,
          ratingOverallAvg: 4,
          ratingOnboardingAvg: 3,
          firstPage: reviews,
        });
        return {
          titles: [...el.querySelectorAll('ul > li h3')].map((h) => h.textContent?.trim()),
          text: el.querySelector('.grid.gap-5')?.textContent,
        };
      };
      expect(summary(withReply)).toEqual(summary(plain));
    });
  });
});
