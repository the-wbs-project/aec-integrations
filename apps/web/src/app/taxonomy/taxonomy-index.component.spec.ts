import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';

import { type CategoriesListResponse, TRADE_PUBLISH_MIN_PRODUCTS } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { TaxonomyIndexPage } from './taxonomy-index';

function listOf(
  ...terms: Array<{ slug: string; name: string; count: number }>
): CategoriesListResponse {
  return {
    data: terms.map((t, i) => ({
      id: `id-${i}`,
      slug: t.slug,
      name: t.name,
      description: null,
      display_order: i,
      product_count: t.count,
    })),
  };
}

function render(kind: TaxonomyKind, terms: CategoriesListResponse | null): HTMLElement {
  const data = { kind, terms };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { data }, data: of(data) },
      },
    ],
  });
  const fixture = TestBed.createComponent(TaxonomyIndexPage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('TaxonomyIndexPage', () => {
  it.each([
    ['category', 'Categories', '/categories'],
    ['audience', 'Audiences', '/audiences'],
    ['phase', 'Phases', '/phases'],
    ['trade', 'Trades', '/trades'],
  ] as const)(
    'renders the %s index with cards linking to the browse pages',
    (kind, title, base) => {
      const root = render(kind, listOf({ slug: 'bim', name: 'BIM Authoring', count: 24 }));

      expect(root.querySelector('h1')?.textContent?.trim()).toBe(title);
      const card = root.querySelector(`a[href="${base}/bim"]`);
      expect(card).not.toBeNull();
      expect(card?.textContent).toContain('BIM Authoring');
      // Count surfaced as "<n> products" on the index card.
      expect(card?.textContent).toContain('24');
    },
  );

  it('shows the per-facet empty state when the list is empty', () => {
    const root = render('phase', listOf());
    expect(root.querySelector('ul')).toBeNull();
    expect(root.textContent).toContain('No phases yet');
  });

  describe('trades publication floor (AECI-544)', () => {
    it('omits trades below TRADE_PUBLISH_MIN_PRODUCTS and keeps the rest', () => {
      const root = render(
        'trade',
        listOf(
          { slug: 'electrical', name: 'Electrical', count: TRADE_PUBLISH_MIN_PRODUCTS },
          { slug: 'roofing', name: 'Roofing', count: TRADE_PUBLISH_MIN_PRODUCTS - 1 },
          { slug: 'plumbing', name: 'Plumbing', count: 0 },
        ),
      );

      expect(root.querySelector('a[href="/trades/electrical"]')).not.toBeNull();
      expect(root.querySelector('a[href="/trades/roofing"]')).toBeNull();
      expect(root.querySelector('a[href="/trades/plumbing"]')).toBeNull();
    });

    it('falls back to the trades empty state when every term is below the floor', () => {
      const root = render(
        'trade',
        listOf({ slug: 'roofing', name: 'Roofing', count: TRADE_PUBLISH_MIN_PRODUCTS - 1 }),
      );

      expect(root.querySelector('ul')).toBeNull();
      expect(root.textContent).toContain('No trades have enough tagged products to list yet');
    });

    it('does not apply the floor to the other three facets', () => {
      const root = render('phase', listOf({ slug: 'design', name: 'Design', count: 1 }));
      expect(root.querySelector('a[href="/phases/design"]')).not.toBeNull();
    });
  });

  it('renders a card description when present', () => {
    const list: CategoriesListResponse = {
      data: [
        {
          id: 'id-0',
          slug: 'design',
          name: 'Design',
          description: 'Schematic and detailed design.',
          display_order: 0,
          product_count: 3,
        },
      ],
    };
    const root = render('phase', list);
    expect(root.textContent).toContain('Schematic and detailed design.');
  });
});
