import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { VendorProductRow } from './vendor-product-row';

const baseProduct: ProductListItem = {
  id: '00000000-0000-4000-8000-000000020001',
  slug: 'procore-platform',
  name: 'Procore Platform',
  logo_url: null,
  product_role: 'application',
  vendor: {
    id: '00000000-0000-4000-8000-000000010001',
    slug: 'procore',
    name: 'Procore Technologies',
    logo_url: null,
    verified: false,
  },
  primary_category: {
    id: '00000000-0000-4000-8000-000000030001',
    slug: 'project-management',
    name: 'Project Management',
  },
  integration_count: 7,
  review_count: 6,
  rating_overall_avg: 4.5,
  rating_onboarding_avg: 4.2,
  created_at: '2024-06-01T00:00:00.000Z',
  updated_at: '2024-06-01T00:00:00.000Z',
};

@Component({
  imports: [VendorProductRow],
  template: `
    <table>
      <tbody>
        <tr aec-vendor-product-row [product]="product()"></tr>
      </tbody>
    </table>
  `,
})
class Host {
  product = signal<ProductListItem>(baseProduct);
}

function setup(overrides: Partial<Host> = {}) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  if (overrides.product) host.product = overrides.product;
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, host };
}

describe('VendorProductRow', () => {
  it('renders the product name in the leading cell', () => {
    const { el } = setup();
    const cells = el.querySelectorAll('td');
    expect(cells[0]?.textContent).toContain('Procore Platform');
  });

  it('renders the product link in the trailing cell', () => {
    const { el } = setup();
    const link = el.querySelector<HTMLAnchorElement>('a[href="/products/procore-platform"]');
    expect(link).not.toBeNull();
    // Named for assistive tech; it is the row's one link to the product page.
    expect(link?.getAttribute('aria-label')).toContain('Procore Platform');
    const cells = el.querySelectorAll('td');
    expect(link!.closest('td')).toBe(cells[cells.length - 1]);
  });

  // Safari < 27 computes `position: relative` on a <tr> as `static`, so a
  // stretched `absolute inset-0` link anchored to the row covered the whole
  // viewport instead. jsdom cannot measure layout, so guard the structure.
  it('does not anchor a stretched overlay link to the <tr> (Safari < 27 regression)', () => {
    const { el } = setup();
    expect(el.querySelector('tr')!.className).not.toContain('relative');
    for (const a of Array.from(el.querySelectorAll('a'))) {
      expect(a.className).not.toMatch(/\babsolute\b|\binset-0\b/);
    }
  });

  it('forwards a click anywhere else on the row to the product link', () => {
    const { el } = setup();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    el.querySelectorAll('td')[0]!.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0]![0])).toBe('/products/procore-platform');
  });

  it('links the primary category chip to its category page, and that click wins', () => {
    const { el } = setup();
    const link = el.querySelector<HTMLAnchorElement>('a[href="/categories/project-management"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Project Management');
    const row = el.querySelector<HTMLAnchorElement>('a[href="/products/procore-platform"]')!;
    expect(row.contains(link!)).toBe(false);
    expect(link!.contains(row)).toBe(false);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    link!.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0]![0])).toBe('/categories/project-management');
  });

  it('renders an en-dash placeholder when the product has no primary category', () => {
    const { el } = setup({
      product: signal({ ...baseProduct, primary_category: null }),
    });
    const placeholder = el.querySelector('span[aria-label="No primary category"]');
    expect(placeholder?.textContent?.trim()).toBe('–');
  });

  it('shows the rating average when the §5.5 gate is met (≥5 reviews)', () => {
    const { el } = setup();
    // RatingSummary cell variant renders the numeral-forward average.
    expect(el.textContent).toContain('4.5');
  });

  it('renders an en-dash rating when below the §5.5 review threshold', () => {
    const { el } = setup({
      product: signal({ ...baseProduct, review_count: 2, rating_overall_avg: null }),
    });
    // The cell variant stays populated with an en-dash rather than collapsing.
    expect(el.querySelector('span[aria-label="No ratings yet"]')?.textContent?.trim()).toBe('–');
  });

  it('renders the integration count', () => {
    const { el } = setup();
    const cells = el.querySelectorAll('td');
    // Integrations is the fourth cell (Product, Category, Rating, Integrations).
    expect(cells[3]?.textContent).toContain('7');
  });

  it('shows the graceful zero state when the product has no integrations', () => {
    const { el } = setup({ product: signal({ ...baseProduct, integration_count: 0 }) });
    expect(el.textContent).toContain('Not yet connected');
  });
});
