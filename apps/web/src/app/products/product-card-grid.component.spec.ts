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

@Component({
  imports: [ProductCardGrid],
  template: `<aec-product-card-grid [products]="products" [featuredLead]="false" />`,
})
class RoleHost {
  products = [makeProduct(1), { ...makeProduct(2), product_role: 'connector' as const }];
}

describe('ProductCardGrid role chip row', () => {
  it('renders the role chip only on a non-application tile, with no category chip', () => {
    const root = render(RoleHost);
    const tiles = root.querySelectorAll('li');
    expect(tiles).toHaveLength(2);
    // An application tile carries no chip row at all, so it leaves no empty flex gap.
    expect(tiles[0]!.querySelector('aec-role-badge')).toBeNull();
    expect(tiles[1]!.querySelector('aec-role-badge')?.textContent).toContain('Connector');
    expect(root.querySelector('a[href^="/categories/"]')).toBeNull();
  });
});

describe('ProductCardGrid card surface (AECI-1765)', () => {
  it('caps the grid at three columns with the shared grid class', () => {
    const root = render(DefaultHost);
    expect(root.querySelector('ul')?.classList.contains('aec-card-grid')).toBe(true);
  });

  it('each card is a lifting 24px shadowed card named by the product alone', () => {
    const root = render(DefaultHost);
    const links = Array.from(root.querySelectorAll('li > a'));
    expect(links).toHaveLength(2);
    for (const [i, a] of links.entries()) {
      expect(a.classList.contains('shadow-card')).toBe(true);
      expect(a.classList.contains('rounded-card')).toBe(true);
      expect(a.classList.contains('motion-safe:hover:-translate-y-1')).toBe(true);
      expect(a.className).not.toContain('hover:border');
      // The whole card text is not the link name (PLAN.md 10.2).
      expect(a.getAttribute('aria-label')).toBe(`Product ${i + 1}`);
    }
  });

  it('the card title takes the card-title role with a tight line', () => {
    const root = render(DefaultHost);
    const title = root.querySelectorAll('li > a')[1].querySelector('p')!;
    expect(title.classList.contains('text-t-20')).toBe(true);
    expect(title.classList.contains('leading-tight')).toBe(true);
    expect(title.classList.contains('text-lg')).toBe(false);
  });
});
