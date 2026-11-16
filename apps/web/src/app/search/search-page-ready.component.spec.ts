import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import { createSearchEngine, SEARCH_ENGINE_FACTORY } from './search-controller.factory';
import { SearchPage } from './search-page';

/**
 * `/search?q=` runs an empty-query search first and seeds the query after it
 * (`SearchController.start`). Until the seeded query's answer lands, the page
 * must not show the empty query's counts in the tabs or announce them
 * (AECI-1796). Real InstantSearch connectors, a fake client that holds the
 * seeded query's answer until the test releases it.
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

const NB_HITS: Record<string, { p: number; v: number }> = {
  '': { p: 344, v: 230 },
  procore: { p: 106, v: 28 },
};

let release: () => void = () => undefined;

const fakeClient = {
  search(requests: FakeRequest[]) {
    const query = (requests[0]?.params?.['query'] as string | undefined) ?? '';
    const answer = {
      results: requests.map((r) => {
        const nbHits = r.indexName.startsWith('p') ? NB_HITS[query].p : NB_HITS[query].v;
        return {
          index: r.indexName,
          query,
          params: '',
          hits: Array.from({ length: Math.min(nbHits, 3) }, (_, i) => ({
            objectID: `${r.indexName}-${query}-${i}`,
            slug: `s-${i}`,
            name: `Name ${i}`,
            company_name: `Name ${i}`,
          })),
          nbHits,
          page: 0,
          nbPages: 1,
          hitsPerPage: 24,
          processingTimeMS: 1,
          exhaustiveNbHits: true,
          facets: {},
        };
      }),
    };
    if (query === '') return Promise.resolve(answer);
    return new Promise((resolve) => (release = () => resolve(answer)));
  },
};

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  return fixture;
}

const tabTexts = (el: HTMLElement) =>
  [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.replace(/\s+/g, ' ').trim());
const statusText = (el: HTMLElement) =>
  el.querySelector('#search-tabpanel p[role="status"]')?.textContent?.trim() ?? '';

describe('/search before the seeded query answers (AECI-1796)', () => {
  afterEach(() => {
    delete (globalThis as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__;
    TestBed.resetTestingModule();
  });

  it("shows no tab counts and announces nothing until the current query's answer lands", async () => {
    const fixture = await mount('/search?q=procore');
    const el = fixture.nativeElement as HTMLElement;
    // Let the SDK load, the empty-query answer land and the seeded search go out.
    for (let i = 0; i < 25; i++) {
      await tick(20);
      fixture.detectChanges();
    }
    expect(tabTexts(el)).toEqual(['Products', 'Vendors']);
    expect(statusText(el)).toBe('');

    release();
    for (let i = 0; i < 10; i++) {
      await tick(20);
      fixture.detectChanges();
    }
    expect(tabTexts(el)).toEqual(['Products 106', 'Vendors 28']);
    expect(statusText(el)).toBe('106 results');
  });
});
