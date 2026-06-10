import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { MostActiveCategory, MostIntegratedProduct } from '@aeci/shared';

import { HomeStatsCards } from './home-stats-cards';

const PRODUCT: MostIntegratedProduct = {
  product: {
    id: '00000000-0000-4000-8000-000000020001',
    name: 'Procore',
    slug: 'procore',
    logo_url: null,
  },
  integration_count: 12,
};

const CATEGORY: MostActiveCategory = {
  category: {
    id: '00000000-0000-4000-8000-000000030001',
    name: 'Project Management',
    slug: 'project-management',
  },
  integration_count: 34,
};

type Inputs = {
  totalIntegrations: number;
  integrationsAdded30d: number;
  mostIntegratedProduct: MostIntegratedProduct | null;
  mostActiveCategory: MostActiveCategory | null;
};

const DEFAULTS: Inputs = {
  totalIntegrations: 2847,
  integrationsAdded30d: 126,
  mostIntegratedProduct: PRODUCT,
  mostActiveCategory: CATEGORY,
};

function setup(overrides: Partial<Inputs> = {}) {
  const inputs = { ...DEFAULTS, ...overrides };
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(HomeStatsCards);
  fixture.componentRef.setInput('totalIntegrations', inputs.totalIntegrations);
  fixture.componentRef.setInput('integrationsAdded30d', inputs.integrationsAdded30d);
  fixture.componentRef.setInput('mostIntegratedProduct', inputs.mostIntegratedProduct);
  fixture.componentRef.setInput('mostActiveCategory', inputs.mostActiveCategory);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('HomeStatsCards', () => {
  it('renders all three populated cards with figures, delta, and real anchors', () => {
    const el = setup();

    // Card 1: the total figure and the "+X in the last 30 days" line.
    expect(el.textContent).toContain('2847');
    expect(el.textContent).toContain('126');
    expect(el.textContent).toContain('in the last 30 days');

    // Card 2: whole-card link to the product page, carrying its name + count.
    const productLink = el.querySelector('a[href="/products/procore"]');
    expect(productLink?.textContent).toContain('Procore');
    expect(productLink?.textContent).toContain('12');

    // Card 3: whole-card link to the category page, carrying its name + count.
    const categoryLink = el.querySelector('a[href="/categories/project-management"]');
    expect(categoryLink?.textContent).toContain('Project Management');
    expect(categoryLink?.textContent).toContain('34');
  });

  it('renders the zero-total empty state instead of a bare 0 (no big figure, no delta)', () => {
    const el = setup({ totalIntegrations: 0 });

    expect(el.textContent).toContain('No integrations indexed yet');
    // The big Forest numeral only renders when total > 0 — its absence proves no bare 0.
    expect(el.querySelector('.text-5xl')).toBeNull();
    expect(el.textContent).not.toContain('in the last 30 days');
  });

  it('omits the "+X in the last 30 days" line when the 30-day delta is 0', () => {
    const el = setup({ integrationsAdded30d: 0 });

    // Total still renders (total > 0)...
    expect(el.textContent).toContain('2847');
    // ...but never "+0 in the last 30 days".
    expect(el.textContent).not.toContain('in the last 30 days');
  });

  it('renders the empty product card with no /products link when most_integrated_product is null', () => {
    const el = setup({ mostIntegratedProduct: null });

    expect(el.textContent).toContain('No product data yet');
    expect(el.querySelector('a[href^="/products/"]')).toBeNull();
  });

  it('renders the empty category card with no /categories link when most_active_category is null', () => {
    const el = setup({ mostActiveCategory: null });

    expect(el.textContent).toContain('No category data yet');
    expect(el.querySelector('a[href^="/categories/"]')).toBeNull();
  });
});
