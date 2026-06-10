import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';

import { SearchProductCard } from './search-product-card';

const baseRecord: AlgoliaProductRecord = {
  objectID: '00000000-0000-4000-8000-000000020001',
  name: 'Procore',
  slug: 'procore',
  description: 'Construction management platform.',
  vendor_name: 'Procore Technologies',
  vendor_slug: 'procore-technologies',
  categories: ['Project Management', 'Document Control'],
  audiences: ['Construction Management'],
  phases: ['Construction'],
  integration_count: 12,
  review_count: 3,
  rating_overall_avg: 4.5,
  has_api_docs: true,
  logo_url: null,
};

@Component({
  imports: [SearchProductCard],
  template: `<aec-search-product-card [record]="record()" />`,
})
class Host {
  record = signal<AlgoliaProductRecord>(baseRecord);
}

function setup(initial: AlgoliaProductRecord = baseRecord) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.record.set(initial);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('SearchProductCard', () => {
  it('links the product name to /products/:slug', () => {
    const el = setup();
    const link = el.querySelector('a[href="/products/procore"]');
    expect(link?.textContent).toContain('Procore');
  });

  it('shows the vendor name and description', () => {
    const el = setup();
    expect(el.textContent).toContain('Procore Technologies');
    expect(el.textContent).toContain('Construction management platform.');
  });

  it('shows the integration count', () => {
    const el = setup();
    expect(el.textContent).toContain('12 integrations');
  });

  it('renders taxonomy names as non-link chips (capped at four)', () => {
    const el = setup();
    const chips = el.querySelectorAll('ul li');
    expect(chips.length).toBe(4);
    expect(el.textContent).toContain('Project Management');
    // Chips are not links (records carry names, not slugs).
    expect(el.querySelector('a[href^="/categories/"]')).toBeNull();
  });

  it('omits the vendor line when vendor_name is null', () => {
    const el = setup({ ...baseRecord, vendor_name: null });
    expect(el.textContent).not.toContain('Procore Technologies');
  });
});
