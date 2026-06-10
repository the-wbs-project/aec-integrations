import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { TrendingProductsSection } from './trending-products-section';

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

function products(count: number): ProductListItem[] {
  return Array.from({ length: count }, (_, i) => makeProduct(i + 1));
}

@Component({
  imports: [TrendingProductsSection],
  template: `
    <aec-trending-products-section [products]="trending()" [recentlyAdded]="recentlyAdded()" />
  `,
})
class Host {
  trending = signal<readonly ProductListItem[]>([]);
  recentlyAdded = signal<readonly ProductListItem[]>([]);
}

function setupFixture(
  trending: readonly ProductListItem[],
  recentlyAdded: readonly ProductListItem[] = [],
) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.trending.set(trending);
  fixture.componentInstance.recentlyAdded.set(recentlyAdded);
  fixture.detectChanges();
  return fixture;
}

function el(fixture: ReturnType<typeof setupFixture>) {
  return fixture.nativeElement as HTMLElement;
}

describe('TrendingProductsSection', () => {
  describe('trending mode (trending_products present)', () => {
    it('renders the grid with the trending heading and "Most viewed this week" eyebrow', () => {
      const root = el(setupFixture(products(2)));
      expect(root.querySelector('h2')?.textContent).toContain('Trending products this week');
      expect(root.querySelector('aec-product-card-grid')).not.toBeNull();
      expect(root.textContent).toContain('Most viewed this week');
      expect(root.querySelectorAll('a[href^="/products/"]')).toHaveLength(2);
    });
  });

  describe('fallback mode (trending empty, recently-added present)', () => {
    it('falls back to recently-added products with a truthful heading and default eyebrow', () => {
      const root = el(setupFixture([], products(3)));
      expect(root.querySelector('h2')?.textContent).toContain('Recently added products');
      expect(root.querySelector('h2')?.textContent).not.toContain('Trending products this week');
      expect(root.querySelector('aec-product-card-grid')).not.toBeNull();
      expect(root.textContent).toContain('Recently added');
      expect(root.textContent).not.toContain('Most viewed this week');
      expect(root.textContent).not.toContain('Trending lands once we have product view data');
    });

    it('caps the fallback list at 5 products', () => {
      const root = el(setupFixture([], products(7)));
      expect(root.querySelectorAll('a[href^="/products/"]')).toHaveLength(5);
    });
  });

  describe('empty mode (both lists empty)', () => {
    it('renders the bordered note and no grid', () => {
      const root = el(setupFixture([], []));
      expect(root.querySelector('aec-product-card-grid')).toBeNull();
      expect(root.querySelector('h2')?.textContent).toContain('Trending products this week');
      expect(root.textContent).toContain('Trending lands once we have product view data');
    });
  });
});
