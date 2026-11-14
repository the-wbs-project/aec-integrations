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
  it('links the source → target headline to the canonical pair page (AECI-298; context = alphabetically-first slug)', () => {
    const el = setup();
    // source=revit, target=navisworks → context=navisworks (n < r).
    const link = el.querySelector('a[href="/products/navisworks/integrations/revit"]');
    expect(link?.textContent).toContain('Revit');
    expect(link?.textContent).toContain('Navisworks');
    // No link to the retired /integrations/:id detail route.
    expect(el.querySelector('a[href^="/integrations/"]')).toBeNull();
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

describe('SearchIntegrationCard surface (AECI-1765)', () => {
  it('is a shadowed card with the title size on the block link, not the h3', () => {
    const el = setup();
    expect(el.querySelector('aec-search-integration-card')!.classList.contains('group/card')).toBe(
      true,
    );
    const article = el.querySelector('article')!;
    expect(article.classList.contains('shadow-card')).toBe(true);
    expect(article.classList.contains('rounded-card')).toBe(true);
    const h3 = el.querySelector('h3')!;
    // The unlayered h3 rule beats a text-* utility on the h3 itself.
    expect(h3.className).not.toMatch(/text-(t-|base|lg)/);
    const link = h3.querySelector('a')!;
    expect(link.classList.contains('text-t-20')).toBe(true);
    expect(link.classList.contains('leading-tight')).toBe(true);
  });
});
