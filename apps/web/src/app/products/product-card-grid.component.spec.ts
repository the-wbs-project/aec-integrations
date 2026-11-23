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

  it('the lead spans two columns from md, not sm, so it never makes an uneven grid', () => {
    const root = render(DefaultHost);
    const lead = root.querySelector('li')!;
    expect(lead.classList.contains('md:col-span-2')).toBe(true);
    expect(lead.className).not.toContain('sm:col-span-2');
    expect(lead.className).not.toContain('lg:col-span-2');
  });

  it('each card is a lifting card in a static hover wrapper', () => {
    const root = render(DefaultHost);
    const items = Array.from(root.querySelectorAll('li'));
    expect(items).toHaveLength(2);
    for (const li of items) {
      expect(li.classList.contains('group/card')).toBe(true);
      const card = li.firstElementChild!;
      expect(card.classList.contains('shadow-card')).toBe(true);
      expect(card.classList.contains('rounded-card')).toBe(true);
      expect(card.classList.contains('motion-safe:group-hover/card:-translate-y-1')).toBe(true);
      expect(card.className).not.toContain('hover:border');
      // The card is a div, not a link, and carries no label of its own.
      expect(card.tagName).toBe('DIV');
      expect(card.hasAttribute('aria-label')).toBe(false);
    }
  });

  it('the link is the title alone, stretched over the card, and the other facts stay outside it', () => {
    const root = render(DefaultHost);
    for (const [i, li] of Array.from(root.querySelectorAll('li')).entries()) {
      const links = li.querySelectorAll('a');
      expect(links).toHaveLength(1);
      const a = links[0];
      expect(a.getAttribute('href')).toBe(`/products/product-${i + 1}`);
      // The accessible name is the title text, with no aria-label to replace it.
      expect(a.textContent?.trim()).toBe(`Product ${i + 1}`);
      expect(a.hasAttribute('aria-label')).toBe(false);
      expect(a.classList.contains('after:absolute')).toBe(true);
      expect(a.classList.contains('after:inset-0')).toBe(true);
      // The vendor line and the integration count are readable text outside the name.
      expect(li.textContent).toContain('Independent');
      expect(li.textContent).toContain(String(i + 1));
      expect(a.textContent).not.toContain('Independent');
    }
  });

  it('the featured card keeps its eyebrow as text outside the link name', () => {
    const root = render(DefaultHost);
    const li = root.querySelector('li')!;
    expect(li.textContent).toContain('Recently added');
    expect(li.querySelector('a')!.textContent).not.toContain('Recently added');
  });

  it('the card title takes the card-title role with a tight line', () => {
    const root = render(DefaultHost);
    const title = root.querySelectorAll('li')[1].querySelector('p')!;
    expect(title.classList.contains('text-t-20')).toBe(true);
    expect(title.classList.contains('leading-tight')).toBe(true);
    expect(title.classList.contains('text-lg')).toBe(false);
  });
});
