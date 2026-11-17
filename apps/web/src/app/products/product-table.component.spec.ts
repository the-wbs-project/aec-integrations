import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { ProductRow } from './product-card';
import { ProductTable } from './product-table';

function row(slug: string, name: string, extra: Partial<ProductRow> = {}): ProductRow {
  return {
    slug,
    name,
    logo_url: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    vendor: { name: `${name} Inc.`, slug: `${slug}-inc` },
    ...extra,
  };
}

@Component({
  imports: [ProductTable],
  template: `<aec-product-table [rows]="rows()" />`,
})
class Host {
  rows = signal<readonly ProductRow[]>([
    row('zeta', 'Zeta', { integration_count: 12 }),
    row('alpha', 'Alpha', { vendor: null }),
  ]);
}

function setup() {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ProductTable (AECI-1793)', () => {
  it('heads the rating column "Product quality", the product page\'s name for the score (ruling 4, AECI-1720 restore C)', () => {
    const { el } = setup();
    const heads = Array.from(el.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
    expect(heads).toEqual(['Name', 'Vendor', 'Product quality', 'Integrations']);
    for (const th of Array.from(el.querySelectorAll('thead th'))) {
      expect(th.getAttribute('scope')).toBe('col');
    }
  });

  it('keeps the host order: no re-sort inside the table', () => {
    const { el } = setup();
    const names = Array.from(el.querySelectorAll('tbody tr a[href^="/products/"]')).map((a) =>
      a.textContent?.trim(),
    );
    expect(names).toEqual(['Zeta', 'Alpha']);
  });

  it('renders one row per product, each a real <tr> inside <tbody>', () => {
    const { el, fixture } = setup();
    expect(el.querySelectorAll('tbody > tr')).toHaveLength(2);
    fixture.componentInstance.rows.set([row('only', 'Only')]);
    fixture.detectChanges();
    expect(el.querySelectorAll('tbody > tr')).toHaveLength(1);
  });

  it('shows a dash with hidden words below five reviews, and the count on one line', () => {
    const { el } = setup();
    const first = el.querySelectorAll('tbody tr')[0]!;
    const cells = first.querySelectorAll('td');
    expect(cells[2]!.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('–');
    expect(cells[2]!.querySelector('.sr-only')?.textContent?.trim()).toBe('No ratings yet');
    // One line: the number and its noun sit in one inline row, not a column.
    const stat = cells[3]!.querySelector('aec-integration-stat > span')!;
    expect(stat.className).toContain('whitespace-nowrap');
    expect(stat.className).not.toContain('flex-col');
    expect(stat.textContent?.replace(/\s+/g, ' ').trim()).toBe('12 integrations');
  });

  it('names the table for assistive tech', () => {
    const { el } = setup();
    expect(el.querySelector('table')?.getAttribute('aria-label')).toBe('Products');
  });
});
