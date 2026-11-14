/**
 * The on-page ordering firewall, component half (AECI-1814, `STAGE_2_PAID_TIERS_SPEC.md`
 * §3.2 assertion 8).
 *
 * The taxonomy index's "Most products" sort lives inside `TaxonomyIndexPage`, so it is
 * tested by rendering the page. It is part of the tolerated exception
 * `taxonomy-term-product-count` (the API half's registry). Its inputs are declared:
 * `product_count` (the excepted input), then the term's integration count, then name.
 * These cases change every other field, rising and falling, on terms that tie on both
 * counts, and assert the rendered order does not move. A tie-break on any other field
 * would move it in one direction or the other.
 */

import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { CategoriesListResponse, TaxonomyTermWithCount } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';
import { TaxonomyIndexPage } from '../taxonomy/taxonomy-index';

function mount(kind: TaxonomyKind, terms: CategoriesListResponse) {
  const data = { kind, terms };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data }, data: of(data) } },
    ],
  });
  const fixture = TestBed.createComponent(TaxonomyIndexPage);
  fixture.detectChanges();
  return fixture;
}

/** The rendered card order after choosing the "Products" sort. */
function productsOrder(kind: TaxonomyKind, terms: TaxonomyTermWithCount[]): string[] {
  const fixture = mount(kind, { data: terms });
  const root = fixture.nativeElement as HTMLElement;
  const button = [...root.querySelectorAll('fieldset button')].find(
    (b) => b.textContent?.trim() === 'Products',
  );
  if (!button) throw new Error('no "Products" sort button');
  (button as HTMLButtonElement).click();
  fixture.detectChanges();
  return [...root.querySelectorAll('ul > li a')].map(
    (a) => a.querySelector('span')?.textContent?.trim() ?? '',
  );
}

const term = (
  name: string,
  products: number,
  integrations: number,
  i: number,
): TaxonomyTermWithCount => ({
  id: `id-${i}`,
  slug: `term-${i}`,
  name,
  description: null,
  display_order: i,
  product_count: products,
  integration_count: integrations,
});

/** Ties at every level: count, then integration count, so the name decides. */
function terms(): TaxonomyTermWithCount[] {
  return [
    term('Zulu', 4, 2, 0),
    term('Delta', 4, 2, 1),
    term('Echo', 4, 8, 2),
    term('Mike', 9, 0, 3),
    term('Bravo', 1, 0, 4),
    term('Alpha', 4, 2, 5),
  ];
}

/** Every field but the three declared inputs, set by position, rising or falling. */
function flip(list: TaxonomyTermWithCount[], dir: 'rising' | 'falling'): TaxonomyTermWithCount[] {
  return list.map((t, i) => {
    const level = dir === 'rising' ? i : list.length - 1 - i;
    return {
      ...t,
      id: `id-flipped-${level}`,
      slug: `flipped-${level}`,
      description: `Described ${level}`,
      display_order: level,
    };
  });
}

describe('on-page ordering firewall: the taxonomy index "Most products" sort', () => {
  for (const kind of ['audience', 'phase', 'trade'] as const) {
    it(`[surface:taxonomy-term-product-count] ${kind}: orders by count, integrations, then name, and nothing else`, () => {
      const base = productsOrder(kind, terms());
      expect(base).toEqual(['Mike', 'Echo', 'Alpha', 'Delta', 'Zulu', 'Bravo']);
      for (const dir of ['rising', 'falling'] as const) {
        TestBed.resetTestingModule();
        expect(productsOrder(kind, flip(terms(), dir)), dir).toEqual(base);
      }
    });
  }
});
