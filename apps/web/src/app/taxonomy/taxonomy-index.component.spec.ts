import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';

import { type CategoriesListResponse, TRADE_PUBLISH_MIN_PRODUCTS } from '@aeci/shared';

import { ListingSortSelect } from '../shared/listing-toolbar/listing-sort-select';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { TaxonomyIndexPage } from './taxonomy-index';
import { trail } from '../shared/breadcrumb/breadcrumb-trail.harness';

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

/** The shared sort control (AECI-1795), or `null` when the page has none. */
function sortControl(fixture: ReturnType<typeof mount>): ListingSortSelect | null {
  const debug = fixture.debugElement.query(By.directive(ListingSortSelect));
  return debug ? (debug.componentInstance as ListingSortSelect) : null;
}

/** Choose a sort option by its visible label, as the control hands it back. */
function clickSort(fixture: ReturnType<typeof mount>, label: string): void {
  const control = sortControl(fixture);
  const option = control?.options().find((o) => o.label === label);
  if (!control || !option) throw new Error(`no sort option labelled "${label}"`);
  control.sortChange.emit(option.value);
  fixture.detectChanges();
}

/** The card (the list item) that holds the link to `href`. */
function cardFor(root: HTMLElement, href: string): HTMLElement | null {
  return root.querySelector(`a[href="${href}"]`)?.closest('li') ?? null;
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
      const link = root.querySelector(`a[href="${base}/bim"]`);
      expect(link).not.toBeNull();
      // The card recipe: one link, on the title, named by the term alone.
      expect(link?.textContent?.trim()).toBe('BIM Authoring');
      expect(link?.closest('h2')).not.toBeNull();
      // Count surfaced as "<n> products" on the index card.
      expect(cardFor(root, `${base}/bim`)?.textContent).toContain('24 products');
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

    const optionLabels = (fixture: ReturnType<typeof mount>) =>
      sortControl(fixture)
        ?.options()
        .map((o) => o.label);

    it.each(['category', 'audience', 'trade'] as const)(
      'offers %s only Name (A–Z) and Products, and defaults to A to Z',
      (kind) => {
        const fixture = mount(kind, facet());
        const root = fixture.nativeElement as HTMLElement;
        expect(optionLabels(fixture)).toEqual(['Name (A–Z)', 'Products']);
        expect(sortControl(fixture)?.value()).toBe('name');
        expect(cardOrder(root)).toEqual(['Alpha', 'Bravo', 'Charlie']);
      },
    );

    it('offers phases Project order as well, and defaults to it', () => {
      const fixture = mount('phase', facet());
      const root = fixture.nativeElement as HTMLElement;
      expect(optionLabels(fixture)).toEqual(['Project order', 'Name (A–Z)', 'Products']);
      expect(sortControl(fixture)?.value()).toBe('sequence');
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

    it('returns a phase grid to its sequence when Project order is re-selected', () => {
      const fixture = mount('phase', facet());
      clickSort(fixture, 'Name (A–Z)');
      clickSort(fixture, 'Project order');
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

    it('shows the active option in the control trigger', () => {
      const fixture = mount('category', facet());
      clickSort(fixture, 'Products');
      const root = fixture.nativeElement as HTMLElement;
      expect(sortControl(fixture)?.value()).toBe('products');
      expect(root.querySelector('button[role="combobox"]')?.textContent?.trim()).toBe('Products');
    });

    it('ignores a value that is not one of the facet modes', () => {
      const fixture = mount('category', facet());
      sortControl(fixture)?.sortChange.emit('sequence');
      fixture.detectChanges();
      // Categories do not offer the API sequence, so the order stays A to Z.
      expect(cardOrder(fixture.nativeElement as HTMLElement)).toEqual([
        'Alpha',
        'Bravo',
        'Charlie',
      ]);
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
      const fixture = mount('phase', listOf());
      expect(sortControl(fixture)).toBeNull();
    });
  });

  it('shows the integration count on a card alongside the product count', () => {
    const root = render('category', listOf({ slug: 'a', name: 'A', count: 3, integrations: 12 }));
    const card = cardFor(root, '/categories/a');
    expect(card?.textContent).toContain('3 products');
    expect(card?.textContent).toContain('12 integrations');
  });

  it('says "1 product" and "1 integration", not "1 products"', () => {
    const root = render('category', listOf({ slug: 'a', name: 'A', count: 1, integrations: 1 }));
    const card = cardFor(root, '/categories/a');
    expect(card?.textContent).toContain('1 product ');
    expect(card?.textContent).toContain('1 integration');
    expect(card?.textContent).not.toContain('1 products');
    expect(card?.textContent).not.toContain('1 integrations');
  });

  // Absent and zero are different claims, so a payload with no integration_count
  // renders no integrations phrase at all rather than "0 integrations".
  it('omits the integration phrase entirely when the payload carries no count', () => {
    const root = render('category', listOf({ slug: 'b', name: 'B', count: 3 }));
    expect(cardFor(root, '/categories/b')?.textContent).not.toContain('integrations');
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

describe('TaxonomyIndexPage breadcrumb (AECI-1777)', () => {
  it.each([
    ['category', 'Categories'],
    ['audience', 'Audiences'],
    ['phase', 'Phases'],
    ['trade', 'Trades'],
  ] as const)('reads Home, then the %s index as the current page', (kind, title) => {
    const root = render(kind, listOf({ slug: 'bim', name: 'BIM Authoring', count: 24 }));
    expect(trail(root)).toEqual([
      { label: 'Home', href: '/', current: false },
      { label: title, href: null, current: true },
    ]);
  });
});
