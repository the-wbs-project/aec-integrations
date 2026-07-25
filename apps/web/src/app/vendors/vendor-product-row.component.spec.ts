import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

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

  it('makes the whole row a stretched link to the product page', () => {
    const { el } = setup();
    const overlay = el.querySelector<HTMLAnchorElement>('a[href="/products/procore-platform"]');
    expect(overlay).not.toBeNull();
    // Named for assistive tech, and covering the whole row.
    expect(overlay?.getAttribute('aria-label')).toContain('Procore Platform');
    expect(overlay?.className).toContain('absolute');
    expect(overlay?.className).toContain('inset-0');
    // The overlay is `absolute inset-0`, so its containing block is the nearest
    // positioned ancestor. That must be the `relative` <tr> host — a `relative`
    // <td> in between would intercept `inset-0` and shrink the click target to
    // one cell instead of the whole row (jsdom can't measure layout, so assert
    // the invariant structurally). Guards the containing-block regression.
    const cell = overlay!.closest('td')!;
    expect(cell.className).not.toContain('relative');
    expect(overlay!.parentElement?.closest('.relative')?.tagName).toBe('TR');
  });

  it('links the primary category chip to its category page, lifted above the row overlay', () => {
    const { el } = setup();
    const link = el.querySelector<HTMLAnchorElement>('a[href="/categories/project-management"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Project Management');
    // The chip is lifted (relative z-10) so its own click wins over the overlay.
    const overlay = el.querySelector<HTMLAnchorElement>('a[href="/products/procore-platform"]')!;
    expect(overlay.contains(link!)).toBe(false);
    expect(link!.contains(overlay)).toBe(false);
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
