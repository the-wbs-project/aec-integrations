import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { ProductCardGrid } from './product-card-grid';

function makeProduct(n: number): ProductListItem {
  return {
    id: `00000000-0000-4000-8000-0000000200${String(n).padStart(2, '0')}`,
    slug: `product-${n}`,
    name: `Product ${n}`,
    logo_url: null,
    product_role: 'application',
    vendor: null,
    primary_category: null,
    integration_count: n,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-03-01T00:00:00.000Z',
    updated_at: '2024-06-15T00:00:00.000Z',
  };
}

// Mirrors the /products caller (products-index.ts): binds products + featuredLead
// only, never featuredEyebrow — so this proves the default eyebrow is unchanged.
@Component({
  imports: [ProductCardGrid],
  template: `<aec-product-card-grid [products]="products" />`,
})
class DefaultHost {
  products = [makeProduct(1), makeProduct(2)];
}

@Component({
  imports: [ProductCardGrid],
  template: `<aec-product-card-grid [products]="products" featuredEyebrow="trending" />`,
})
class TrendingHost {
  products = [makeProduct(1), makeProduct(2)];
}

function render<T>(host: new () => T) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(host);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ProductCardGrid featuredEyebrow', () => {
  it('defaults to "Recently added" (the /products caller is untouched)', () => {
    const root = render(DefaultHost);
    expect(root.textContent).toContain('Recently added');
    expect(root.textContent).not.toContain('Most viewed this week');
  });

  it('renders "Most viewed this week" when featuredEyebrow is "trending"', () => {
    const root = render(TrendingHost);
    expect(root.textContent).toContain('Most viewed this week');
    expect(root.textContent).not.toContain('Recently added');
  });
});
