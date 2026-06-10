import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { AlgoliaIntegrationRecord } from '@aeci/shared/algolia-records';

import { SearchIntegrationCard } from './search-integration-card';

const baseRecord: AlgoliaIntegrationRecord = {
  objectID: '00000000-0000-4000-8000-000000030001',
  source_product_name: 'Revit',
  source_product_slug: 'revit',
  target_product_name: 'Navisworks',
  target_product_slug: 'navisworks',
  mechanism_kind: 'native',
  mechanism_name: 'Desktop Connector',
  direction: 'bidirectional',
  description: 'Round-trip model coordination.',
  mechanism_rank: 6,
};

@Component({
  imports: [SearchIntegrationCard],
  template: `<aec-search-integration-card [record]="record()" />`,
})
class Host {
  record = signal<AlgoliaIntegrationRecord>(baseRecord);
}

function setup(initial: AlgoliaIntegrationRecord = baseRecord) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.record.set(initial);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('SearchIntegrationCard', () => {
  it('links the source → target headline to /integrations/:objectID', () => {
    const el = setup();
    const link = el.querySelector('a[href="/integrations/00000000-0000-4000-8000-000000030001"]');
    expect(link?.textContent).toContain('Revit');
    expect(link?.textContent).toContain('Navisworks');
  });

  it('renders the mechanism and direction labels', () => {
    const el = setup();
    expect(el.textContent).toContain('Native');
    expect(el.textContent).toContain('Bidirectional');
  });

  it('omits the mechanism badge when mechanism_kind is null', () => {
    const el = setup({ ...baseRecord, mechanism_kind: null });
    expect(el.textContent).not.toContain('Native');
  });

  it('omits the direction text when direction is null', () => {
    const el = setup({ ...baseRecord, direction: null });
    expect(el.textContent).not.toContain('Bidirectional');
  });
});
