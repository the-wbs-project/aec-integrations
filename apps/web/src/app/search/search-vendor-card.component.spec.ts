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
  verified: false,
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

  it('renders the verified badge when the vendor is verified (AECI-529)', () => {
    const el = setup({ ...baseRecord, verified: true });
    expect(el.querySelector('aec-verified-badge')).not.toBeNull();
    expect(el.textContent).toContain('Verified vendor');
  });

  it('hides the verified badge when the vendor is not verified', () => {
    const el = setup({ ...baseRecord, verified: false });
    expect(el.querySelector('aec-verified-badge')).toBeNull();
    expect(el.textContent).not.toContain('Verified vendor');
  });

  it('hides the verified badge for a stale record missing the field', () => {
    // Records indexed before AECI-529 carry no `verified` field, so it reads as
    // `undefined` at runtime — the `@if` guard must treat that as unverified.
    const el = setup({ ...baseRecord, verified: undefined as unknown as boolean });
    expect(el.querySelector('aec-verified-badge')).toBeNull();
  });
});
