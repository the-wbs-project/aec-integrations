import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import { SearchVendorRow } from './search-vendor-row';

const RECORD = {
  objectID: 'v1',
  company_name: 'Autodesk',
  slug: 'autodesk',
  description: null,
  headquarters: 'San Francisco, CA',
  founded_year: 1982,
  company_name_sort: 'autodesk',
  product_count: 12,
  integration_count: 40,
  logo_url: null,
  listing_tier: 'basic',
} as unknown as AlgoliaVendorRecord;

@Component({
  imports: [SearchVendorRow],
  template: `<table>
    <tbody>
      <tr aec-search-vendor-row [record]="record()"></tr>
    </tbody>
  </table>`,
})
class Host {
  readonly record = signal<AlgoliaVendorRecord>(RECORD);
}

function render(record: AlgoliaVendorRecord = RECORD): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.record.set(record);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('SearchVendorRow', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders a real <tr> with the linked name, headquarters and integration count', () => {
    const el = render();
    const row = el.querySelector('tbody > tr');
    expect(row).not.toBeNull();
    expect(row?.querySelectorAll('td')).toHaveLength(3);
    expect(row?.querySelector('a[href="/vendors/autodesk"]')?.textContent).toContain('Autodesk');
    expect(row?.textContent).toContain('San Francisco, CA');
    expect(row?.textContent).toContain('40');
  });

  it('shows an en dash, not a blank cell, when headquarters is missing', () => {
    const el = render({ ...RECORD, headquarters: null });
    const hqCell = el.querySelectorAll('td')[1];
    expect(hqCell.textContent?.trim()).toBe('–');
    expect(hqCell.querySelector('[aria-label="No headquarters listed"]')).not.toBeNull();
  });
});
