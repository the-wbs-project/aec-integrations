import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { ProductCard } from './product-card';

const baseProduct: ProductListItem = {
  id: '00000000-0000-4000-8000-000000020001',
  slug: 'procore',
  name: 'Procore',
  logo_url: null,
  product_role: 'application',
  vendor: {
    id: '00000000-0000-4000-8000-000000010001',
    name: 'Procore Technologies',
    slug: 'procore',
    logo_url: null,
    verified: false,
  },
  primary_category: {
    id: '00000000-0000-4000-8000-000000030001',
    name: 'Project Management',
    slug: 'project-management',
  },
  integration_count: 12,
  review_count: 3,
  rating_overall_avg: 4.5,
  rating_onboarding_avg: 4.2,
  created_at: '2024-03-01T00:00:00.000Z',
  updated_at: '2024-06-15T00:00:00.000Z',
};

@Component({
  imports: [ProductCard],
  template: `
    <table>
      <tbody>
        <tr aec-product-card [product]="product()"></tr>
      </tbody>
    </table>
  `,
})
class Host {
  product = signal<ProductListItem>(baseProduct);
}

function setupFixture(initial: ProductListItem = baseProduct) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.product.set(initial);
  fixture.detectChanges();
  return fixture;
}

describe('ProductCard', () => {
  it('renders the product name as a link to /products/:slug', () => {
    const fixture = setupFixture();
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'a[href="/products/procore"]',
    );
    expect(link?.textContent).toContain('Procore');
  });

  it('renders the vendor name as a link to /vendors/:slug', () => {
    const fixture = setupFixture();
    const link = (fixture.nativeElement as HTMLElement).querySelector('a[href="/vendors/procore"]');
    expect(link?.textContent).toContain('Procore Technologies');
  });

  it('renders the primary category as a link to /categories/:slug', () => {
    const fixture = setupFixture();
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'a[href="/categories/project-management"]',
    );
    expect(link?.textContent).toContain('Project Management');
  });

  it('renders an en-dash placeholder when primary_category is null', () => {
    const fixture = setupFixture({ ...baseProduct, primary_category: null });
    const placeholder = (fixture.nativeElement as HTMLElement).querySelector(
      'span[aria-label="No primary category"]',
    );
    expect(placeholder?.textContent?.trim()).toBe('–');
    // No category link should be rendered.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('a[href^="/categories/"]'),
    ).toBeNull();
  });

  it('renders an en-dash placeholder when vendor is null (AECI-115, no /vendors/unknown link)', () => {
    const fixture = setupFixture({ ...baseProduct, vendor: null });
    const placeholder = (fixture.nativeElement as HTMLElement).querySelector(
      'span[aria-label="No vendor listed"]',
    );
    expect(placeholder?.textContent?.trim()).toBe('–');
    // No vendor link should be rendered.
    expect((fixture.nativeElement as HTMLElement).querySelector('a[href^="/vendors/"]')).toBeNull();
  });

  it('renders integration_count as a stat in the last cell', () => {
    const fixture = setupFixture();
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('td');
    // AECI-190: the count now renders via <aec-integration-stat> (number + noun),
    // not a bare digit — assert the figure is present rather than exact-matching.
    expect(cells[cells.length - 1].textContent).toContain('12');
  });

  it('renders the "not yet connected" zero state instead of a bare 0', () => {
    const fixture = setupFixture({ ...baseProduct, integration_count: 0 });
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('td');
    const last = cells[cells.length - 1].textContent ?? '';
    expect(last).not.toContain('0');
    expect(last).toContain('Not yet connected');
  });

  it('renders a monogram fallback in the name cell when logo_url is null', () => {
    const fixture = setupFixture();
    // LogoOrInitial renders the initial letter (code-point safe) when src is null.
    const monogram = (fixture.nativeElement as HTMLElement).querySelector(
      'aec-logo-or-initial span[aria-hidden="true"]',
    );
    expect(monogram?.textContent?.trim()).toBe('P');
  });
});
