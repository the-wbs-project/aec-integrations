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

  it('renders the mechanism label', () => {
    const el = setup();
    expect(el.textContent).toContain('Native');
  });

  it('omits the mechanism badge when mechanism_kind is null', () => {
    const el = setup({ ...baseRecord, mechanism_kind: null });
    expect(el.textContent).not.toContain('Native');
  });
});

// AECI-1939: the record is oriented so the source sends on a one-way record. The
// headline glyph and the meta line follow `record().direction`, never a fixed arrow.
describe('SearchIntegrationCard direction (AECI-1939)', () => {
  const glyphOf = (el: HTMLElement) => el.querySelector('h3 a span[aria-hidden="true"]')!;

  it.each([
    ['one-way', '→', 'Revit sends to Navisworks', true],
    ['bidirectional', '⇄', 'Revit and Navisworks sync both ways', false],
  ] as const)('draws a %s record as %s with "%s"', (direction, glyph, sentence, mirrors) => {
    const el = setup({ ...baseRecord, direction });
    const span = glyphOf(el);
    expect(span.textContent?.trim()).toBe(glyph);
    expect(span.classList.contains('rtl:-scale-x-100')).toBe(mirrors);
    expect(el.textContent).toContain(sentence);
  });

  it('draws a neutral dot and no flow line when the direction is unknown', () => {
    const el = setup({ ...baseRecord, direction: null });
    expect(glyphOf(el).textContent?.trim()).toBe('·');
    expect(el.textContent).not.toContain('→');
    expect(el.textContent).not.toContain('sends to');
    expect(el.textContent).not.toContain('sync both ways');
    // The meta row holds only the mechanism chip.
    const meta = el.querySelector('article > div')!;
    expect(meta.querySelectorAll('span.text-xs')).toHaveLength(0);
  });

  it('links the same pair page whichever endpoint sends', () => {
    const swapped = setup({
      ...baseRecord,
      direction: 'one-way',
      source_product_name: 'Navisworks',
      source_product_slug: 'navisworks',
      target_product_name: 'Revit',
      target_product_slug: 'revit',
    });
    expect(
      swapped.querySelector('a[href="/products/navisworks/integrations/revit"]'),
    ).not.toBeNull();
    expect(swapped.textContent).toContain('Navisworks sends to Revit');
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
