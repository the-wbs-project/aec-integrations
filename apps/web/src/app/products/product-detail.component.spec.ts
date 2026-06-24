/**
 * ProductDetailPage — hero rating cluster.
 *
 * Named `.component.spec.ts` so it runs under `ng test` (Angular's TestBed /
 * vitest runner) rather than the node-only Vitest pass that excludes Angular DI
 * (see `apps/web/vitest.config.ts`).
 *
 * Scope: the hero rating surfaced near the product name when the product has a
 * publishable aggregate (`rating_overall_avg !== null`, already gated server-side
 * at ≥5 reviews). The leaf services the page's children pull in (Analytics,
 * AuthService, AccountApi) are stubbed to neutral no-ops — their own specs cover
 * them; here we only assert the hero render branch. The product is delivered via
 * a stub `ActivatedRoute`, the same channel `productDetailResolver` populates in
 * production.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import { Analytics } from '../analytics/analytics';
import { AuthService } from '../auth/auth.service';

import { ProductDetailPage } from './product-detail';

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'procore',
    name: 'Procore',
    logo_url: 'https://example.com/procore.png',
    product_role: 'application',
    vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      name: 'Procore Technologies',
      logo_url: 'https://example.com/procore-logo.png',
    },
    primary_category: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Construction management platform.',
    website: 'https://www.procore.com',
    tool_integrations_url: null,
    api_docs_url: null,
    has_api_docs: false,
    categories: [],
    audiences: [],
    phases: [],
    usefulness: null,
    integrations_as_source: [],
    integrations_as_target: [],
    related_products: [],
    reviews: [],
    ...overrides,
  };
}

function setup(product: ProductDetail) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: { productViewed: vi.fn() } },
      // Embedded review CTA (inside ProductReviews) — keep it on the neutral,
      // no-network path; its own spec exercises the real behaviour.
      { provide: AuthService, useValue: { isConfigured: vi.fn(() => false), isSignedIn: vi.fn() } },
      { provide: AccountApi, useValue: { findMyReviewForProduct: vi.fn(async () => null) } },
      {
        provide: ActivatedRoute,
        useValue: { data: of({ product }), snapshot: { data: { product } } },
      },
    ],
  });
  const fixture = TestBed.createComponent(ProductDetailPage);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ProductDetailPage hero rating', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the rating in the hero when the product has an aggregate', () => {
    // The API sets both averages together (and only at ≥5 reviews); mirror that.
    const { el } = setup(
      buildProduct({ review_count: 7, rating_overall_avg: 4.2, rating_onboarding_avg: 4.0 }),
    );

    const hero = el.querySelector('[slot="hero"]');
    expect(hero).toBeTruthy();
    // Stars + one-decimal score, scoped to the hero (the Reviews summary lower
    // down also renders stars — this assertion must not pick those up).
    expect(hero!.querySelector('aec-review-stars')).toBeTruthy();
    expect(hero!.textContent).toContain('4.2');
    expect(hero!.textContent).toContain('7 reviews');

    // The count is a path-preserving jump link to the Reviews section.
    const jump = hero!.querySelector<HTMLAnchorElement>('a[href$="#reviews"]');
    expect(jump).toBeTruthy();
    expect(jump!.getAttribute('href')).toBe('/products/procore#reviews');
  });

  it('renders no hero rating when the product has no aggregate', () => {
    const { el } = setup(buildProduct({ review_count: 0, rating_overall_avg: null }));

    const hero = el.querySelector('[slot="hero"]');
    expect(hero).toBeTruthy();
    expect(hero!.querySelector('aec-review-stars')).toBeNull();
    expect(hero!.querySelector('a[href$="#reviews"]')).toBeNull();
  });
});
