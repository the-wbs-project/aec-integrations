import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';

import { type CategoriesListResponse, TRADE_PUBLISH_MIN_PRODUCTS } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { TaxonomyIndexPage } from './taxonomy-index';

function listOf(
  ...terms: Array<{ slug: string; name: string; count: number; integrations?: number }>
): CategoriesListResponse {
  return {
    data: terms.map((t, i) => ({
      id: `id-${i}`,
      slug: t.slug,
      name: t.name,
      description: null,
      display_order: i,
      product_count: t.count,
      ...(t.integrations === undefined ? {} : { integration_count: t.integrations }),
    })),
  };
}

function mount(kind: TaxonomyKind, terms: CategoriesListResponse | null) {
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
  return fixture;
}

function render(kind: TaxonomyKind, terms: CategoriesListResponse | null): HTMLElement {
  return mount(kind, terms).nativeElement as HTMLElement;
}

/** The rendered card order, read off the grid. */
function cardOrder(root: HTMLElement): string[] {
  return [...root.querySelectorAll('ul > li a')].map(
    (a) => a.querySelector('span')?.textContent?.trim() ?? '',
  );
}

/** Click a sort option by its visible label. */
function clickSort(fixture: ReturnType<typeof mount>, label: string): void {
  const root = fixture.nativeElement as HTMLElement;
  const button = [...root.querySelectorAll('fieldset button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no sort button labelled "${label}"`);
  (button as HTMLButtonElement).click();
  fixture.detectChanges();
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

  describe('sort toggle', () => {
    /** Deliberately: API order, alphabetical order, and product-count order are
     *  three DIFFERENT permutations, so no assertion below can pass by accident
     *  on a list that was already in the right sequence. */
    const facet = () =>
      listOf(
        { slug: 'c', name: 'Charlie', count: 5, integrations: 3 },
        { slug: 'a', name: 'Alpha', count: 1, integrations: 90 },
        { slug: 'b', name: 'Bravo', count: 9, integrations: 40 },
      );

    const optionLabels = (root: HTMLElement) =>
      [...root.querySelectorAll('fieldset button')].map((b) => b.textContent?.trim());

    it.each(['category', 'audience', 'trade'] as const)(
      'offers %s only A→Z and Products, and defaults to A→Z',
      (kind) => {
        const root = render(kind, facet());
        expect(optionLabels(root)).toEqual(['A → Z', 'Products']);
        expect(cardOrder(root)).toEqual(['Alpha', 'Bravo', 'Charlie']);
      },
    );

    it('offers phases Sequence as well, and defaults to it', () => {
      const root = render('phase', facet());
      expect(optionLabels(root)).toEqual(['Sequence', 'A → Z', 'Products']);
      // The API order, untouched — a phase vocabulary is a sequence.
      expect(cardOrder(root)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    });

    it('sorts by product count, descending', () => {
      const fixture = mount('category', facet());
      clickSort(fixture, 'Products');
      // Bravo 9, Charlie 5, Alpha 1 — note Alpha has the MOST integrations and
      // still sorts last, which is what makes this a product-count sort.
      expect(cardOrder(fixture.nativeElement as HTMLElement)).toEqual([
        'Bravo',
        'Charlie',
        'Alpha',
      ]);
    });

    it('returns a phase grid to its sequence when Sequence is re-selected', () => {
      const fixture = mount('phase', facet());
      clickSort(fixture, 'A → Z');
      clickSort(fixture, 'Sequence');
      expect(cardOrder(fixture.nativeElement as HTMLElement)).toEqual([
        'Charlie',
        'Alpha',
        'Bravo',
      ]);
    });

    it('breaks a product-count tie by integrations, then by name', () => {
      const fixture = mount(
        'category',
        listOf(
          { slug: 'z', name: 'Zulu', count: 4, integrations: 2 },
          { slug: 'd', name: 'Delta', count: 4, integrations: 2 },
          { slug: 'e', name: 'Echo', count: 4, integrations: 8 },
        ),
      );
      clickSort(fixture, 'Products');
      // Echo first on the integration tiebreak; Delta before Zulu on name.
      expect(cardOrder(fixture.nativeElement as HTMLElement)).toEqual(['Echo', 'Delta', 'Zulu']);
    });

    it('treats a term carrying no integration_count as zero in the tiebreak', () => {
      const fixture = mount(
        'category',
        listOf(
          { slug: 'legacy', name: 'Legacy', count: 3 },
          { slug: 'known', name: 'Known', count: 3, integrations: 4 },
        ),
      );
      clickSort(fixture, 'Products');
      expect(cardOrder(fixture.nativeElement as HTMLElement)).toEqual(['Known', 'Legacy']);
    });

    it('marks the active option with aria-pressed', () => {
      const fixture = mount('category', facet());
      clickSort(fixture, 'Products');
      const root = fixture.nativeElement as HTMLElement;
      const pressed = [...root.querySelectorAll('fieldset button')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent?.trim());
      expect(pressed).toEqual(['Products']);
    });

    it('sorts only the published trades', () => {
      const fixture = mount(
        'trade',
        listOf(
          { slug: 'roofing', name: 'Roofing', count: 5, integrations: 1 },
          {
            slug: 'hidden',
            name: 'Hidden',
            count: TRADE_PUBLISH_MIN_PRODUCTS - 1,
            integrations: 99,
          },
          { slug: 'electrical', name: 'Electrical', count: 9, integrations: 50 },
        ),
      );
      clickSort(fixture, 'Products');
      // `Hidden` is below the floor, so no ordering may promote it back onto the
      // page — the floor is applied before the sort, not after.
      expect(cardOrder(fixture.nativeElement as HTMLElement)).toEqual(['Electrical', 'Roofing']);
    });

    it('is not rendered when there is nothing to sort', () => {
      const root = render('phase', listOf());
      expect(root.querySelector('fieldset')).toBeNull();
    });
  });

  it('shows the integration count on a card alongside the product count', () => {
    const root = render('category', listOf({ slug: 'a', name: 'A', count: 3, integrations: 12 }));
    const card = root.querySelector('a[href="/categories/a"]');
    expect(card?.textContent).toContain('3 products');
    expect(card?.textContent).toContain('12 integrations');
  });

  it('says "1 product" and "1 integration", not "1 products"', () => {
    const root = render('category', listOf({ slug: 'a', name: 'A', count: 1, integrations: 1 }));
    const card = root.querySelector('a[href="/categories/a"]');
    expect(card?.textContent).toContain('1 product ');
    expect(card?.textContent).toContain('1 integration');
    expect(card?.textContent).not.toContain('1 products');
    expect(card?.textContent).not.toContain('1 integrations');
  });

  // Absent and zero are different claims, so a payload with no integration_count
  // renders no integrations phrase at all rather than "0 integrations".
  it('omits the integration phrase entirely when the payload carries no count', () => {
    const root = render('category', listOf({ slug: 'b', name: 'B', count: 3 }));
    expect(root.querySelector('a[href="/categories/b"]')?.textContent).not.toContain(
      'integrations',
    );
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
