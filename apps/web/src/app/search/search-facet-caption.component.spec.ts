import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import { createSearchEngine, SEARCH_ENGINE_FACTORY } from './search-controller.factory';
import { compareText } from '@aeci/shared/text-sort';

import { COUNT_ORDERED_FACETS, PHASE_LIFECYCLE_ORDER } from './search-facet-order';
import { SearchPage } from './search-page';

/**
 * The `/search` order caption (AECI-1796, ruled 2026-11-16) promises an order.
 * This runs the REAL InstantSearch connectors (the production factory) against
 * a fake search client whose facet counts arrive shuffled, and checks that the
 * rendered options follow what the caption says. It fails if someone changes
 * the refinement lists' `sortBy` away from count order, sets a facet order in
 * the index settings that the connector picks up, or stops re-sorting phases,
 * without changing the caption too. Equal counts break by `compareText`, so
 * case never decides the order (AECI-825).
 */

const CONFIG = {
  appId: 'APP',
  searchKey: 'KEY',
  indexes: { products: 'p', vendors: 'v', integrations: 'i' },
};

/** Facet counts as Algolia might return them: deliberately out of order. */
const FACETS: Record<string, Record<string, number>> = {
  categories: { 'Field Management': 4, 'Accounting & ERP': 34, AI: 20, 'Bid Management': 10 },
  audiences: { 'Owner/Developer': 2, 'General Contracting': 73, 'Project Manager': 41 },
  trades: { Roofing: 1, 'Earthwork & Excavation': 6, 'HVAC & Mechanical': 3 },
  // Four ties at 2 whose code-unit order differs from `compareText` (the real
  // staging pair for `roofing` is "SRS Distribution" and "Spotable").
  vendor_name: {
    Oracle: 5,
    'Procore Technologies': 8,
    SAP: 2,
    'SRS Distribution': 2,
    Spotable: 2,
    airSlate: 2,
  },
  phases: { Construction: 86, Design: 11, 'Concept & Planning': 9, 'Pre-Construction': 66 },
  // AECI-1662 — counts against the vocabulary order, so a count sort would show.
  connector_kind: { sync_service: 9, integration_platform: 2 },
};

interface FakeRequest {
  indexName: string;
  params?: Record<string, unknown>;
}

/** Answers every request (main and disjunctive) with the same shuffled facets. */
const fakeClient = {
  search(requests: FakeRequest[]) {
    return Promise.resolve({
      results: requests.map((r) => ({
        index: r.indexName,
        query: (r.params?.['query'] as string | undefined) ?? '',
        params: '',
        hits: [],
        nbHits: 0,
        page: 0,
        nbPages: 0,
        hitsPerPage: 24,
        processingTimeMS: 1,
        exhaustiveNbHits: true,
        exhaustiveFacetsCount: true,
        facets: r.indexName.startsWith('p') ? FACETS : {},
      })),
    });
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
  // Load the SDK, mount the controller, let the first search land.
  for (let i = 0; i < 20; i++) {
    await tick(20);
    fixture.detectChanges();
    if (fixture.nativeElement.querySelector('aec-search-refinement-list fieldset')) break;
  }
  return fixture.nativeElement as HTMLElement;
}

/** Rendered option labels per group legend, in DOM order. */
function renderedGroups(el: HTMLElement): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const fs of el.querySelectorAll('aec-search-refinement-list fieldset')) {
    const legend = fs.querySelector('legend')?.textContent?.trim() ?? '';
    const terms = [...fs.querySelectorAll('label span:first-of-type')].map(
      (s) => s.textContent?.trim() ?? '',
    );
    out.set(legend, terms);
  }
  return out;
}

const LEGEND: Record<string, string> = {
  categories: 'Categories',
  audiences: 'Audiences',
  trades: 'Trades',
  vendor_name: 'Vendor',
};

describe('/search order caption is true (AECI-1796)', () => {
  afterEach(() => {
    delete (globalThis as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__;
    TestBed.resetTestingModule();
  });

  it('names the count-ordered groups and phases, and the options follow it', async () => {
    const el = await mount('/search?q=procore');
    const groups = renderedGroups(el);

    for (const attribute of COUNT_ORDERED_FACETS) {
      const counts = FACETS[attribute];
      const expected = Object.keys(counts).sort(
        (a, b) => counts[b] - counts[a] || compareText(a, b),
      );
      expect(groups.get(LEGEND[attribute]), attribute).toEqual(expected);
    }
    const phases = Object.keys(FACETS['phases']).sort(
      (a, b) => PHASE_LIFECYCLE_ORDER.indexOf(a) - PHASE_LIFECYCLE_ORDER.indexOf(b),
    );
    expect(groups.get('Phases')).toEqual(phases);

    const note = el.querySelector('aec-facet-panel p.text-t-13')?.textContent?.trim();
    expect(note).toBe(
      'Categories, Audiences, Trades, and Vendor: most matching products first. Phases in project order.',
    );
  });

  it('breaks equal counts by name with case folded, not by code unit', async () => {
    const el = await mount('/search?q=procore');
    expect(renderedGroups(el).get('Vendor')).toEqual([
      'Procore Technologies',
      'Oracle',
      'airSlate',
      'SAP',
      'Spotable',
      'SRS Distribution',
    ]);
  });

  it('keeps a checked option at the top of its group, then count, then name', async () => {
    const el = await mount('/search?q=procore&vendor_name=Spotable');
    expect(renderedGroups(el).get('Vendor')).toEqual([
      'Spotable',
      'Procore Technologies',
      'Oracle',
      'airSlate',
      'SAP',
      'SRS Distribution',
    ]);
  });

  // AECI-1662 — the "Connector type" group reads as the /products sidebar's does:
  // last, the same two labels, vocabulary order whatever the counts. The caption
  // does not name it, and its order is A to Z, which the /products caption states.
  it('renders Connector type last, labelled, in vocabulary order, unnamed by the caption', async () => {
    const el = await mount('/search?q=procore');
    const groups = renderedGroups(el);
    expect([...groups.keys()].at(-1)).toBe('Connector type');
    expect(groups.get('Connector type')).toEqual(['Integration platform', 'Sync Service']);
    const note = el.querySelector('aec-facet-panel p.text-t-13')?.textContent ?? '';
    expect(note).not.toMatch(/Connector type/);
  });

  it('checks a kind from ?connector_kind and ignores an unknown one', async () => {
    const el = await mount('/search?q=procore&connector_kind=sync_service&connector_kind=junk');
    const group = [...el.querySelectorAll('aec-search-refinement-list fieldset')].find(
      (fs) => fs.querySelector('legend')?.textContent?.trim() === 'Connector type',
    )!;
    const boxes = [...group.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    expect(group.textContent).not.toContain('junk');
  });

  it('shows no caption on the Vendors tab, which has only count ranges and Founded', async () => {
    const el = await mount('/search?q=procore&tab=vendors');
    expect(el.querySelector('aec-facet-panel p.text-t-13')).toBeNull();
  });
});
