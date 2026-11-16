import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProductReviewsResponse,
  PublicReview,
  PublicReviewUpdate,
  PublicVendorResponse,
} from '@aeci/shared';

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
    created_at: '2026-01-02T03:04:05.000Z',
    vendor_responses: [],
    updates: [],
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

function makeUpdate(over: Partial<PublicReviewUpdate> = {}): PublicReviewUpdate {
  return {
    body: 'The vendor fixed the export.\nI am raising my rating.',
    rating_overall: 5,
    rating_onboarding: 4,
    published_at: '2026-10-05T10:00:00.000Z',
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

  describe('the score band (AECI-1784, rulings A3 and A4)', () => {
    const summary = () =>
      setup({
        reviewCount: 7,
        ratingOverallAvg: 4.3,
        ratingOnboardingAvg: 3.8,
        firstPage: makeReviews(7),
      }).el;

    it('prints two separate score figures at the 48px token, never one blended number', () => {
      const el = summary();
      const overall = el.querySelector('[data-testid="review-score-overall"]')!;
      const onboarding = el.querySelector('[data-testid="review-score-onboarding"]')!;
      const value = (card: Element) => card.querySelector('.aec-figure-value') as HTMLElement;

      expect(value(overall).textContent?.trim()).toBe('4.3');
      expect(value(onboarding).textContent?.trim()).toBe('3.8');
      expect(value(overall).className).toContain('text-t-48');
      expect(value(onboarding).className).toContain('text-t-48');
      expect(overall.textContent).toContain('Overall');
      expect(onboarding.textContent).toContain('Onboarding');
      // Two figures in the band, and no average of the two anywhere (4.05).
      expect(el.querySelectorAll('[data-testid="review-summary"] aec-figure')).toHaveLength(2);
      expect(el.textContent).not.toContain('4.05');
    });

    it('puts each score on its own card with its own stripe, beside its name', () => {
      const el = summary();
      const overall = el.querySelector('[data-testid="review-score-overall"]')!;
      const onboarding = el.querySelector('[data-testid="review-score-onboarding"]')!;
      for (const card of [overall, onboarding]) {
        expect(card.classList).toContain('shadow-card');
        expect(card.classList).toContain('aec-card-stripe');
      }
      expect(overall.classList).not.toContain('aec-card-stripe-clay');
      expect(onboarding.classList).toContain('aec-card-stripe-clay');
    });

    it('places both pins on one 1 to 5 axis, hidden from assistive tech', () => {
      const el = summary();
      const scale = el.querySelector('[data-testid="review-scale"]')!;
      const axis = scale.querySelector('[aria-hidden="true"]')!;
      const left = (id: string) =>
        (axis.querySelector(`[data-testid="${id}"]`) as HTMLElement).style.left;

      // (4.3 - 1) / 4 = 82.5%, (3.8 - 1) / 4 = 70%.
      expect(left('review-scale-pin-overall')).toBe('82.5%');
      expect(left('review-scale-pin-onboarding')).toBe('70%');
      expect(axis.textContent?.replace(/\s+/g, ' ')).toContain('Overall 4.3');
      expect(axis.textContent?.replace(/\s+/g, ' ')).toContain('Onboarding 3.8');
      // The count line stays readable: it is not inside the hidden axis.
      expect(axis.textContent).not.toContain('Based on');
      expect(scale.textContent).toContain('Based on 7 reviews');
    });

    it('renders no score band below the threshold or with no reviews', () => {
      const below = setup({ reviewCount: 4, firstPage: makeReviews(4) }).el;
      expect(below.querySelector('[data-testid="review-summary"]')).toBeNull();
      expect(below.querySelector('aec-figure')).toBeNull();
      TestBed.resetTestingModule();
      const none = setup({ reviewCount: 0, firstPage: [] }).el;
      expect(none.querySelector('[data-testid="review-summary"]')).toBeNull();
    });
  });

  it('makes each review article one card and keeps the API order', () => {
    const { el } = setup({ reviewCount: 3, firstPage: makeReviews(3) });
    const articles = [...el.querySelectorAll('ul > li > article')];
    expect(articles).toHaveLength(3);
    for (const a of articles) expect(a.classList).toContain('shadow-card');
    expect(articles.map((a) => a.querySelector('h3')?.textContent?.trim())).toEqual([
      'Review 1',
      'Review 2',
      'Review 3',
    ]);
  });

  describe('row sharing (ruling 34, 2026-11-16)', () => {
    const columns = (n: number) => {
      TestBed.resetTestingModule();
      const { el } = setup({ reviewCount: n, firstPage: makeReviews(n) });
      const list = el.querySelector('[data-testid="review-list"]') as HTMLElement;
      return {
        md: list.classList.contains('md:grid-cols-2'),
        xl: list.classList.contains('xl:grid-cols-3'),
        base: list.classList.contains('grid-cols-1') && list.classList.contains('grid'),
        titles: [...list.querySelectorAll('h3')].map((h) => h.textContent?.trim()),
      };
    };

    it('gives one review the full row at every width', () => {
      expect(columns(1)).toMatchObject({ md: false, xl: false, base: true });
    });

    it('splits two reviews into halves from md, never a three-column row', () => {
      expect(columns(2)).toMatchObject({ md: true, xl: false, base: true });
    });

    it('keeps the grid at three or more, in the API order', () => {
      for (const n of [3, 4, 11]) {
        const c = columns(n);
        expect(c).toMatchObject({ md: true, xl: true, base: true });
        expect(c.titles).toEqual(makeReviews(n).map((r) => r.title));
      }
    });

    it('caps the text measure inside the card, not the card', () => {
      TestBed.resetTestingModule();
      const { el } = setup({
        reviewCount: 1,
        firstPage: [makeReview(1, { updates: [makeUpdate()], vendor_responses: [makeResponse()] })],
      });
      const article = el.querySelector('ul > li > article') as HTMLElement;
      expect(article.classList).not.toContain('max-w-prose');
      expect(article.querySelector('[data-testid="review-original"] > p')!.classList).toContain(
        'max-w-prose',
      );
      expect(article.querySelector('[data-testid="review-update"] > p')!.classList).toContain(
        'max-w-prose',
      );
      expect(article.querySelector('[data-testid="vendor-response"] > p')!.classList).toContain(
        'max-w-prose',
      );
    });
  });

  it('shows no company or firm on a review', () => {
    const { el } = setup({
      reviewCount: 1,
      firstPage: [
        // A field the public type does not carry. The card must not print it even
        // if a future API leaked it.
        makeReview(1, { role_at_company: 'manager', reviewer_firm: 'Acme Builders' } as never),
      ],
    });
    expect(el.textContent).not.toContain('Acme Builders');
  });

  it('renders per-review meta: role, years, recommendation, and no verified badge', () => {
    const { el } = setup({
      reviewCount: 1,
      firstPage: [
        makeReview(1, {
          role_at_company: 'manager',
          years_using: 3,
          would_recommend: 'yes',
        }),
      ],
    });

    const text = el.textContent ?? '';
    // AECI-1258: nothing verifies a reviewer, so the badge was removed.
    expect(text).not.toContain('Verified reviewer');
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

    it('renders one reply inside its review card, after the review text, labelled and dated', () => {
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
      // Clash 14 (DESIGN.md section 4): a nested panel inside the review card,
      // after the review as written and never part of it, with no shadow.
      const original = article.firstElementChild as HTMLElement;
      expect(original.dataset['testid']).toBe('review-original');
      expect(original.contains(reply)).toBe(false);
      expect(
        original.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(reply.classList).toContain('rounded-panel');
      expect(reply.classList).not.toContain('shadow-card');

      // Labelled by its heading, which names the vendor and ties it to the review.
      expect(reply.tagName).toBe('SECTION');
      const label = el.querySelector(`[id="${reply.getAttribute('aria-labelledby')}"]`)!;
      expect(label.tagName).toBe('H4');
      expect(reply.contains(label)).toBe(true);
      expect(label.textContent).toContain('Response from Autodesk');
      expect(label.querySelector('.sr-only')?.textContent).toContain('to the review “Saves hours”');
      // `&ngsp;` keeps the space Angular would drop between the two spans (AECI-1471).
      expect(label.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'Response from Autodesk to the review “Saves hours”',
      );

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
          text: el.querySelector('[data-testid="review-summary"]')?.textContent,
        };
      };
      expect(summary(withReply)).toEqual(summary(plain));
    });
  });

  describe('reviewer updates (AECI-1613, §4.7a)', () => {
    it('treats a missing updates field (deploy skew) as no update', () => {
      const old = makeReview(1) as Partial<PublicReview>;
      delete old.updates;
      const { el } = setup({ reviewCount: 1, firstPage: [old as PublicReview] });

      expect(el.querySelectorAll('[data-testid="review-update"]')).toHaveLength(0);
    });

    it('leaves the original card unchanged when the review has an update', () => {
      const cardHtml = (review: PublicReview) => {
        TestBed.resetTestingModule();
        const { el } = setup({ reviewCount: 1, firstPage: [review] });
        return (el.querySelector('ul > li > article')!.firstElementChild as HTMLElement).outerHTML;
      };
      const plain = makeReview(1, { title: 'Saves hours' });
      expect(cardHtml({ ...plain, updates: [makeUpdate()] })).toBe(cardHtml(plain));
    });

    it('renders the update below the card and above the vendor replies, labelled and dated', () => {
      const { el } = setup({
        reviewCount: 1,
        firstPage: [
          makeReview(1, {
            title: 'Saves hours',
            updates: [makeUpdate()],
            vendor_responses: [makeResponse()],
          }),
        ],
      });

      const article = el.querySelector('ul > li > article') as HTMLElement;
      const card = article.firstElementChild as HTMLElement;
      const update = article.querySelector('[data-testid="review-update"]') as HTMLElement;
      const reply = article.querySelector('[data-testid="vendor-response"]') as HTMLElement;
      expect(card.contains(update)).toBe(false);
      expect(card.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(update.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      expect(update.tagName).toBe('SECTION');
      const label = el.querySelector(`[id="${update.getAttribute('aria-labelledby')}"]`)!;
      expect(label.tagName).toBe('H4');
      expect(label.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'Update from the reviewer to the review “Saves hours”, added Oct 5, 2026',
      );
      const time = update.querySelector('time')!;
      expect(time.getAttribute('datetime')).toBe('2026-10-05T10:00:00.000Z');
      expect(time.textContent?.trim()).toBe('Oct 5, 2026');
    });

    it('shows new stars only when the update re-rated', () => {
      const { el } = setup({
        reviewCount: 1,
        firstPage: [
          makeReview(1, {
            updates: [
              makeUpdate(),
              makeUpdate({
                rating_overall: null,
                rating_onboarding: null,
                published_at: '2026-10-09T10:00:00.000Z',
              }),
            ],
          }),
        ],
      });

      const updates = el.querySelectorAll('[data-testid="review-update"]');
      expect(updates).toHaveLength(2);
      const rated = updates[0]!.querySelector('[data-testid="review-update-ratings"]')!;
      expect(rated.querySelector('[aria-label="Overall rating 5 out of 5"]')).not.toBeNull();
      expect(rated.querySelector('[aria-label="Onboarding rating 4 out of 5"]')).not.toBeNull();
      expect(updates[1]!.querySelector('[data-testid="review-update-ratings"]')).toBeNull();
      expect(updates[1]!.querySelector('aec-review-stars')).toBeNull();
      // Each update region has its own accessible name.
      const ids = [...updates].map((u) => u.getAttribute('aria-labelledby'));
      expect(new Set(ids).size).toBe(2);
      const names = ids.map((id) => el.querySelector(`[id="${id}"]`)!.textContent);
      expect(new Set(names).size).toBe(2);
    });

    it('renders the update body as plain text with its line breaks, never as HTML', () => {
      const { el } = setup({
        reviewCount: 1,
        firstPage: [
          makeReview(1, {
            updates: [makeUpdate({ body: 'See <b>this</b> https://x.test\nThanks' })],
          }),
        ],
      });

      const body = el.querySelector('[data-testid="review-update"] > p') as HTMLElement;
      expect(body.querySelector('b')).toBeNull();
      expect(body.textContent?.trim()).toBe('See <b>this</b> https://x.test\nThanks');
      expect(body.className).toContain('whitespace-pre-line');
    });
  });
});
