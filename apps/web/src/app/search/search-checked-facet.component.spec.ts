import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import { createSearchEngine, SEARCH_ENGINE_FACTORY } from './search-controller.factory';
import { SearchPage } from './search-page';

/**
 * AECI-1899: a checked filter stays on screen when its facet is missing from
 * the response. This runs the REAL InstantSearch connectors (the production
 * factory) against a fake search client that leaves the `trades` facet out of
 * every response while `trades` is filtered, as Algolia does when no record
 * matches. Before the fix the Trades group vanished with Roofing still checked.
 */

const CONFIG = {
  appId: 'APP',
  searchKey: 'KEY',
  indexes: { products: 'p', vendors: 'v', integrations: 'i' },
};

interface FakeRequest {
  indexName: string;
  params?: Record<string, unknown>;
}

/** Every request the fake client answered, in order. */
let requests: FakeRequest[] = [];

/** True when a request filters on `attribute` (its `facetFilters`). */
function filtersOn(request: FakeRequest, attribute: string): boolean {
  return JSON.stringify(request.params?.['facetFilters'] ?? []).includes(`"${attribute}:`);
}

/**
 * While the main products request filters on trades, nothing matches: no hits,
 * no `trades` facet, and Accounting & ERP absent from `categories`. Without the
 * trades filter the catalogue answers normally.
 */
const fakeClient = {
  search(batch: FakeRequest[]) {
    requests.push(...batch);
    const main = batch.find((r) => r.indexName.startsWith('p'));
    const empty = main ? filtersOn(main, 'trades') : false;
    return Promise.resolve({
      results: batch.map((r) => {
        const products = r.indexName.startsWith('p');
        const facets: Record<string, Record<string, number>> = !products
          ? {}
          : empty
            ? { categories: { AI: 3 } }
            : {
                categories: { 'Accounting & ERP': 12, AI: 3 },
                trades: { Roofing: 2, Electrical: 5 },
              };
        const nbHits = products && !empty ? 12 : 0;
        return {
          index: r.indexName,
          query: (r.params?.['query'] as string | undefined) ?? '',
          params: '',
          hits: Array.from({ length: Math.min(nbHits, 24) }, (_, i) => ({
            objectID: `p-${i}`,
            name: `Product ${i}`,
            slug: `product-${i}`,
          })),
          nbHits,
          page: 0,
          nbPages: nbHits > 0 ? 1 : 0,
          hitsPerPage: 24,
          processingTimeMS: 1,
          exhaustiveNbHits: true,
          exhaustiveFacetsCount: true,
          facets,
        };
      }),
    });
  },
};

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function settle(fixture: { detectChanges(): void }, until: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await tick(20);
    fixture.detectChanges();
    if (until()) return;
  }
}

async function mount(url: string) {
  (globalThis as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__ = CONFIG;
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'search', component: SearchPage }]),
      {
        provide: SEARCH_ENGINE_FACTORY,
        useValue: async () => ({
          lib: (await createSearchEngine(CONFIG)).lib,
          searchClient: fakeClient,
        }),
      },
    ],
  });
  await TestBed.inject(Router).navigateByUrl(url);
  const fixture = TestBed.createComponent(SearchPage);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  await settle(fixture, () => !!el.querySelector('aec-search-refinement-list fieldset'));
  return { fixture, el };
}

/** Rendered rows per group legend: label, count text and checked state. */
function renderedGroups(el: HTMLElement): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const fs of el.querySelectorAll('aec-search-refinement-list fieldset')) {
    const legend = fs.querySelector('legend')?.textContent?.trim() ?? '';
    const rows = [...fs.querySelectorAll('label')].map((label) => {
      const [name, count] = [...label.querySelectorAll('span')].map((s) => s.textContent?.trim());
      const box = label.querySelector('input') as HTMLInputElement;
      return `${box.checked ? '[x]' : '[ ]'} ${name} ${count}`;
    });
    out.set(legend, rows);
  }
  return out;
}

function caption(el: HTMLElement): string | undefined {
  return el.querySelector('aec-facet-panel p.text-t-13')?.textContent?.trim();
}

describe('/search keeps a checked filter whose facet the response left out (AECI-1899)', () => {
  afterEach(() => {
    delete (globalThis as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__;
    TestBed.resetTestingModule();
    requests = [];
  });

  it('draws the Trades group with Roofing checked at 0, and keeps empty groups hidden', async () => {
    const { el } = await mount('/search?trades=Roofing&categories=Accounting%20%26%20ERP');
    const groups = renderedGroups(el);

    expect(groups.get('Trades')).toEqual(['[x] Roofing (0)']);
    // The helper adds Accounting & ERP back itself (its facet is in the response).
    expect(groups.get('Categories')).toEqual(['[x] Accounting & ERP (0)', '[ ] AI (3)']);
    // No values and nothing checked: still hidden, as before.
    expect([...groups.keys()].sort()).toEqual(['Categories', 'Trades']);
  });

  it('names only groups with a count order in the caption', async () => {
    const { el } = await mount('/search?trades=Roofing&categories=Accounting%20%26%20ERP');
    // Trades shows only a checked row at 0, so the caption does not claim an
    // order for it. Categories has a row with matching products.
    expect(caption(el)).toBe('Categories: most matching products first.');
  });

  it('unchecks the missing value and searches without it, restoring results', async () => {
    const { fixture, el } = await mount('/search?trades=Roofing&categories=Accounting%20%26%20ERP');
    const roofing = [...el.querySelectorAll('aec-search-refinement-list label')].find((l) =>
      l.textContent?.includes('Roofing'),
    );
    expect(roofing).toBeTruthy();
    const sent = requests.length;
    (roofing!.querySelector('input') as HTMLInputElement).click();
    await settle(fixture, () => el.querySelectorAll('aec-search-product-card').length > 0);

    const after = requests.slice(sent).filter((r) => r.indexName.startsWith('p'));
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((r) => filtersOn(r, 'trades'))).toBe(false);
    expect(el.querySelectorAll('aec-search-product-card').length).toBe(12);
    expect(renderedGroups(el).get('Trades')).toEqual(['[ ] Electrical (5)', '[ ] Roofing (2)']);
    await settle(fixture, () => !TestBed.inject(Router).url.includes('trades='));
    expect(TestBed.inject(Router).url).not.toContain('trades=');
  });

  it('adds nothing when the checked value is in the response', async () => {
    const { el } = await mount('/search?categories=AI');
    expect(renderedGroups(el).get('Categories')).toEqual([
      '[x] AI (3)',
      '[ ] Accounting & ERP (12)',
    ]);
  });
});
