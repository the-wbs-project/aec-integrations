import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';

import type { CategoriesListResponse } from '@aeci/shared';

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
