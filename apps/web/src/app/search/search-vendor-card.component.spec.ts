import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import { SearchVendorCard } from './search-vendor-card';

const baseRecord: AlgoliaVendorRecord = {
  objectID: '00000000-0000-4000-8000-000000010001',
  company_name: 'Procore Technologies',
  slug: 'procore-technologies',
  description: 'Construction software vendor.',
  headquarters: 'Carpinteria, CA',
  founded_year: 2002,
  product_count: 8,
  integration_count: 412,
  logo_url: null,
};

@Component({
  imports: [SearchVendorCard],
  template: `<aec-search-vendor-card [record]="record()" />`,
})
class Host {
  record = signal<AlgoliaVendorRecord>(baseRecord);
}

function setup(initial: AlgoliaVendorRecord = baseRecord) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.record.set(initial);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('SearchVendorCard', () => {
  it('links the company name to /vendors/:slug', () => {
    const el = setup();
    const link = el.querySelector('a[href="/vendors/procore-technologies"]');
    expect(link?.textContent).toContain('Procore Technologies');
  });

  it('shows headquarters, product and integration counts', () => {
    const el = setup();
    expect(el.textContent).toContain('Carpinteria, CA');
    expect(el.textContent).toContain('8');
    expect(el.textContent).toContain('412');
  });

  it('shows the founded year when present', () => {
    const el = setup();
    expect(el.textContent).toContain('2002');
  });

  it('omits the founded year when null', () => {
    const el = setup({ ...baseRecord, founded_year: null });
    expect(el.textContent).not.toContain('2002');
  });
});
