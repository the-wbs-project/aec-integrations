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
  trades: [],
  trade_aliases: [],
  name_sort: 'procore', // AECI-825 — replica sort key, never rendered
  integration_count: 12,
  review_count: 3,
  rating_overall_avg: 4.5,
  created_at_ts: 1767225600,
  updated_at_ts: 1767225600,
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
  it('links the whole card to /products/:slug', () => {
    const el = setup();
    const link = el.querySelector('a[href="/products/procore"]');
    expect(link?.textContent).toContain('Procore');
  });

  it('shows the vendor name and the integration badge', () => {
    const el = setup();
    expect(el.textContent).toContain('Procore Technologies');
    expect(el.textContent).toContain('12');
    expect(el.textContent).toContain('integrations');
  });

  it('says "Independent" when vendor_name is null, as the /products tile does', () => {
    const el = setup({ ...baseRecord, vendor_name: null });
    expect(el.textContent).not.toContain('Procore Technologies');
    expect(el.textContent).toContain('Independent');
  });

  it('carries only the /products tile fields: no description, no taxonomy chips', () => {
    const el = setup({ ...baseRecord, trades: ['Roofing'] });
    expect(el.textContent).not.toContain('Construction management platform.');
    expect(el.textContent).not.toContain('Project Management');
    expect(el.textContent).not.toContain('Roofing');
    expect(el.querySelectorAll('li')).toHaveLength(0);
  });

  it('uses the singular noun for one integration', () => {
    const el = setup({ ...baseRecord, integration_count: 1 });
    expect(el.textContent).toMatch(/1\s*integration(?!s)/);
  });
});
