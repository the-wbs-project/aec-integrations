import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { VendorListItem } from '@aeci/shared';

import { VendorCard } from './vendor-card';

const baseVendor: VendorListItem = {
  id: '00000000-0000-4000-8000-000000010001',
  slug: 'procore',
  company_name: 'Procore Technologies',
  logo_url: null,
  verified: true,
  headquarters: 'Carpinteria, CA',
  founded_year: 2002,
  product_count: 3,
  integration_count: 12,
  review_count: 0,
  created_at: '2024-03-01T00:00:00.000Z',
  updated_at: '2024-06-15T00:00:00.000Z',
};

@Component({
  imports: [VendorCard],
  template: `
    <table>
      <tbody>
        <tr aec-vendor-card [vendor]="vendor()"></tr>
      </tbody>
    </table>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  vendor = signal<VendorListItem>(baseVendor);
}

function setupFixture(initial: VendorListItem = baseVendor) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.vendor.set(initial);
  fixture.detectChanges();
  return fixture;
}

describe('VendorCard', () => {
  it('renders the vendor name as a link to /vendors/:slug', () => {
    const fixture = setupFixture();
    const link = (fixture.nativeElement as HTMLElement).querySelector('a[href="/vendors/procore"]');
    expect(link?.textContent).toContain('Procore Technologies');
  });

  it('renders the headquarters in the second cell', () => {
    const fixture = setupFixture();
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('td');
    expect(cells[1]?.textContent).toContain('Carpinteria, CA');
  });

  it('renders an em-dash placeholder when headquarters is null', () => {
    const fixture = setupFixture({ ...baseVendor, headquarters: null });
    const placeholder = (fixture.nativeElement as HTMLElement).querySelector(
      'span[aria-label="Headquarters not listed"]',
    );
    expect(placeholder?.textContent?.trim()).toBe('—');
  });

  it('renders founded_year in the third cell', () => {
    const fixture = setupFixture();
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('td');
    expect(cells[2]?.textContent?.trim()).toBe('2002');
  });

  it('renders an em-dash placeholder when founded_year is null', () => {
    const fixture = setupFixture({ ...baseVendor, founded_year: null });
    const placeholder = (fixture.nativeElement as HTMLElement).querySelector(
      'span[aria-label="Founded year not listed"]',
    );
    expect(placeholder?.textContent?.trim()).toBe('—');
  });

  it('renders product_count in the last cell', () => {
    const fixture = setupFixture();
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('td');
    expect(cells[cells.length - 1]?.textContent?.trim()).toBe('3');
  });
});
