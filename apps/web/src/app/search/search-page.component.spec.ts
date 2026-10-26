import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sortReplicasFor } from '@aeci/shared/algolia';

import { PRODUCT_DEFAULT_SORT } from '../shared/listing-toolbar/product-sort-keys';
import { type InstantSearchLib, type IsWidget, type SearchController } from './search-controller';
import { SearchPage } from './search-page';
import { type SearchEngine, SEARCH_ENGINE_FACTORY } from './search-controller.factory';

/**
 * `ng test` shell coverage for `SearchPage`.
 *
 * `afterNextRender` DOES fire in this zoneless test env, so the page's
 * browser-bootstrap path runs: with the public Algolia config absent it degrades
 * to the "unavailable" notice; with it present it stays in the non-degraded
 * shell. We override `SEARCH_ENGINE_FACTORY` (the DI seam) with a never-resolving
 * factory so the config IS present (non-degraded shell) but the real
 * `instantsearch.js` never loads and the controller stays null — letting us
 * assert the deterministic shell (search box, tablist, loading state) and,
 * separately, the degraded notice. (`vi.mock` on a relative import is
 * unsupported by the Angular unit-test runner, hence the token.)
 */
const VALID_CONFIG = {
  appId: 'APP',
  searchKey: 'KEY',
  indexes: { products: 'p', vendors: 'v', integrations: 'i' },
};

type GlobalWithConfig = { __AECI_ALGOLIA__?: unknown };

function setConfigPresent(): void {
  (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = VALID_CONFIG;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'search', component: SearchPage }]),
      // Never resolves → controller stays null, real SDK never loads.
      { provide: SEARCH_ENGINE_FACTORY, useValue: () => new Promise<never>(() => {}) },
    ],
  });
  return TestBed.inject(Router);
}

/**
 * A minimal fake `SearchEngine` for the buffer-replay test (AECI-227). The real
 * `SearchController` runs against it; only `connectSearchBox`'s `refine` is
 * observed. `instance.start()` fires the searchBox render (as real InstantSearch
 * does on start) so the controller captures `refine` — then a replayed
 * `setQuery` shows up as a `refine` call.
 */
function makeFakeEngine(): SearchEngine & {
  refine: ReturnType<typeof vi.fn>;
  options: Parameters<InstantSearchLib['instantsearch']>[0][];
  setUiState: ReturnType<typeof vi.fn>;
} {
  const refine = vi.fn();
  const setUiState = vi.fn();
  const options: Parameters<InstantSearchLib['instantsearch']>[0][] = [];
  let searchBoxRender: ((state: unknown, first: boolean) => void) | null = null;
  const instance = {
    addWidgets: () => instance,
    start: () => searchBoxRender?.({ query: '', refine, isSearchStalled: false }, true),
    dispose: () => {},
    on: () => {},
    setUiState,
  };
  const passthrough =
    (_render: (state: unknown, first: boolean) => void) =>
    (_params: Record<string, unknown> = {}): IsWidget =>
      ({}) as IsWidget;
  const lib: InstantSearchLib = {
    instantsearch: (opts) => {
      options.push(opts);
      return instance;
    },
    index: () => ({ addWidgets: () => ({}) }),
    configure: () => ({}) as IsWidget,
    connectSearchBox: ((render: (state: unknown, first: boolean) => void) => {
      searchBoxRender = render;
      return (_params: Record<string, unknown> = {}): IsWidget => ({}) as IsWidget;
    }) as unknown as InstantSearchLib['connectSearchBox'],
    connectInfiniteHits: passthrough as unknown as InstantSearchLib['connectInfiniteHits'],
    connectStats: passthrough as unknown as InstantSearchLib['connectStats'],
    connectRefinementList: passthrough as unknown as InstantSearchLib['connectRefinementList'],
    connectNumericMenu: passthrough as unknown as InstantSearchLib['connectNumericMenu'],
    connectRange: passthrough as unknown as InstantSearchLib['connectRange'],
    connectSortBy: passthrough as unknown as InstantSearchLib['connectSortBy'],
  };
  return { lib, searchClient: {}, refine, options, setUiState };
}

/** Mount the page against a fake engine that resolves immediately, so a real
 *  `SearchController` is live (lets the sort control + per-tab state render). */
async function setupMounted(url = '/search') {
  setConfigPresent();
  const engine = makeFakeEngine();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'search', component: SearchPage }]),
      { provide: SEARCH_ENGINE_FACTORY, useValue: () => Promise.resolve(engine) },
    ],
  });
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  const fixture = TestBed.createComponent(SearchPage);
  fixture.detectChanges();
  await tick(); // afterNextRender → factory resolves → controller mounts
  fixture.detectChanges();
  return { fixture, router, engine, el: fixture.nativeElement as HTMLElement };
}

/** The page's protected sort handlers, surfaced for direct assertion (the overlay
 *  open→select path is exercised by the live e2e, not unit tests). */
type SortablePage = { onSortChange(indexName: string): void };

describe('SearchPage shell', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => delete (globalThis as GlobalWithConfig).__AECI_ALGOLIA__);

  it('seeds the search input from ?q=', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search?q=revit');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector(
      '#search-input',
    ) as HTMLInputElement;
    expect(input.value).toBe('revit');
  });

  it('renders the two entity tabs (non-degraded shell; integrations excluded)', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const tabs = (fixture.nativeElement as HTMLElement).querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);
    const labels = [...tabs].map((t) => t.textContent?.trim());
    expect(labels[0]).toContain('Products');
    expect(labels[1]).toContain('Vendors');
  });

  it('sets robots noindex and a Search title', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex');
    expect(TestBed.inject(Title).getTitle()).toContain('Search');
  });

  it('shows the loading skeleton while the controller is still null (AECI-228)', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    // The sr-only status region carries the busy state for assistive tech…
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    // …and decorative skeleton placeholders reserve the results-region height
    // (results grid + facet rail) so the first paint doesn't shift.
    expect(el.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    expect(el.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(el.textContent).not.toContain('temporarily unavailable');
  });

  it('replays keystrokes typed before the engine loads (AECI-227)', async () => {
    setConfigPresent();
    const engine = makeFakeEngine();
    // Deferred factory: stays pending so we can type while the controller is null,
    // then resolve and assert the buffered query is replayed as a real search.
    let resolveEngine!: (e: SearchEngine) => void;
    const enginePromise = new Promise<SearchEngine>((resolve) => {
      resolveEngine = resolve;
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'search', component: SearchPage }]),
        { provide: SEARCH_ENGINE_FACTORY, useValue: () => enginePromise },
      ],
    });
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/search');

    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();
    await tick(); // afterNextRender fired → engineFactory called → still pending
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('#search-input') as HTMLInputElement;

    // Type before the controller exists: buffered, shown in the input, NOT searched.
    input.value = 'pay';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(input.value).toBe('pay');
    expect(engine.refine).not.toHaveBeenCalled();

    // Engine resolves → controller mounts → buffered "pay" replays as a search.
    resolveEngine(engine);
    await tick();
    fixture.detectChanges();

    expect(engine.refine).toHaveBeenCalledWith('pay');
    expect(input.value).toBe('pay'); // preserved across mount (no flicker to the seed)
    expect(el.querySelector('[aria-busy="true"]')).toBeNull(); // controller is live
    // Mounted but the first response hasn't landed (ready=false), so the skeleton
    // still reserves height — without the aria-busy live region (AECI-228).
    expect(el.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('degrades to the unavailable notice when the public config is absent', async () => {
    // No __AECI_ALGOLIA__ set → afterNextRender takes the graceful-degradation path.
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('temporarily unavailable');
    expect(el.querySelector('[role="tablist"]')).toBeNull();
  });

  it('selecting a tab updates aria-selected and the ?tab= URL', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const vendorsTab = el.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement;
    vendorsTab.click();
    await tick();
    fixture.detectChanges();

    expect(vendorsTab.getAttribute('aria-selected')).toBe('true');
    expect(router.url).toContain('tab=vendors');
  });

  // ── AECI-175 sort control ──────────────────────────────────────────────────

  // Relevance was dropped on 2026-10-26; /search opens on the /products default.
  it('renders the per-tab sort control once the controller mounts (default = Newest)', async () => {
    const { el } = await setupMounted('/search');
    const trigger = el.querySelector('button[id^="aec-listing-sort-"]') as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute('role')).toBe('combobox');
    expect(trigger!.textContent).toContain('Newest');
  });

  it('does not render the sort control while the controller is null (degraded shell)', () => {
    const router = setup(); // never-resolving factory → controller stays null
    void router; // (navigation not needed; the control is gated on the controller)
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('button[id^="aec-listing-sort-"]'),
    ).toBeNull();
  });

  it('seeds the initial sort from ?sort= and reflects it in the control', async () => {
    const { el } = await setupMounted('/search?sort=name');
    const trigger = el.querySelector('button[id^="aec-listing-sort-"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Name (A–Z)');
  });

  // AECI-636 PR-B retired the "Most integrations" replica. A bookmarked or
  // crawled /search?sort=integrations must land on the default, never error.
  it('falls back to Newest on the retired ?sort=integrations', async () => {
    const { el } = await setupMounted('/search?sort=integrations');
    const trigger = el.querySelector('button[id^="aec-listing-sort-"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Newest');
    expect(trigger.textContent).not.toContain('Most integrations');
  });

  // An old /search?sort=relevance link starts on the default replica, not the
  // primary, so the control never shows an empty trigger.
  it('falls back to the default replica on the retired ?sort=relevance', async () => {
    const { fixture, el } = await setupMounted('/search?sort=relevance');
    const ctrl = (
      fixture.componentInstance as unknown as { controller: () => SearchController }
    ).controller();
    expect(ctrl.products.sortBy()).toBe('p_created_desc');
    const trigger = el.querySelector('button[id^="aec-listing-sort-"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Newest');
  });

  // The default is the first replica; it must stay the /products default, or
  // the two pages open on different orders (DESIGN.md "The Same-Behavior Rule").
  it('opens the products tab on the /products default sort', () => {
    expect(sortReplicasFor('products')[0]?.sort).toBe(PRODUCT_DEFAULT_SORT);
  });

  it('defaults the vendors tab to Name (A–Z)', async () => {
    const { fixture, el } = await setupMounted('/search?tab=vendors');
    const ctrl = (
      fixture.componentInstance as unknown as { controller: () => SearchController }
    ).controller();
    expect(ctrl.vendors.sortBy()).toBe('v_name_asc');
    const trigger = el.querySelector('button[id^="aec-listing-sort-"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Name (A–Z)');
  });

  it('offers exactly the five /products sorts on the products tab, in order', async () => {
    const { fixture } = await setupMounted('/search');
    const options = (
      fixture.componentInstance as unknown as { sortUiOptions: () => readonly { label: string }[] }
    ).sortUiOptions();
    expect(options.map((option) => option.label)).toEqual([
      'Newest',
      'Name (A–Z)',
      'Recently updated',
      'Highest rated',
      'Most reviewed',
    ]);
  });

  it('offers only Name (A–Z) on the vendors tab', async () => {
    const { fixture } = await setupMounted('/search?tab=vendors');
    const options = (
      fixture.componentInstance as unknown as { sortUiOptions: () => readonly { label: string }[] }
    ).sortUiOptions();
    expect(options.map((option) => option.label)).toEqual(['Name (A–Z)']);
  });

  it('seeds ?sort=rating onto the Highest rated replica, the /products token', async () => {
    const { fixture } = await setupMounted('/search?sort=rating');
    const ctrl = (
      fixture.componentInstance as unknown as { controller: () => SearchController }
    ).controller();
    expect(ctrl.products.sortBy()).toBe('p_rating_desc');
  });

  it('writes ?sort= when a non-default sort is chosen, and clears it for the default', async () => {
    const { fixture, router } = await setupMounted('/search');
    const page = fixture.componentInstance as unknown as SortablePage;

    // products replicas are <base>_<suffix> with base 'p' (VALID_CONFIG.indexes).
    page.onSortChange('p_name_asc');
    await tick();
    expect(router.url).toContain('sort=name');

    page.onSortChange('p_created_desc'); // back to the default (Newest) → param cleared
    await tick();
    expect(router.url).not.toContain('sort=');
  });

  it('re-points ?sort= to the new tab’s sort when switching tabs (per-tab)', async () => {
    const { fixture, router, el } = await setupMounted('/search');
    const page = fixture.componentInstance as unknown as SortablePage;

    page.onSortChange('p_name_asc'); // products → Name A–Z
    await tick();
    expect(router.url).toContain('sort=name');

    // Switch to vendors (still at its default) → ?sort= clears, ?tab=vendors set.
    (el.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
    await tick();
    expect(router.url).toContain('tab=vendors');
    expect(router.url).not.toContain('sort=');
  });

  // ── Browse-layout parity with /products ───────────────────────────────────

  it('renders in the shared browse layout with the mobile Filters disclosure', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('aec-browse-layout')).not.toBeNull();
    const trigger = el.querySelector(
      'button[aria-controls="search-facet-panel"]',
    ) as HTMLButtonElement;
    const panel = el.querySelector('#search-facet-panel') as HTMLElement;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.classList.contains('hidden')).toBe(true);

    trigger.click();
    fixture.detectChanges();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.classList.contains('hidden')).toBe(false);
  });

  it('tabs carry the aec-nav-tab class that colours the active underline', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const tabs = (fixture.nativeElement as HTMLElement).querySelectorAll('[role="tab"]');
    expect([...tabs].every((tab) => tab.classList.contains('aec-nav-tab'))).toBe(true);
  });

  it('counts active refinements and clears them on BOTH tabs through each connector', () => {
    setConfigPresent();
    setup();
    const fixture = TestBed.createComponent(SearchPage);

    const listRefine = vi.fn();
    const menuRefine = vi.fn();
    const rangeRefine = vi.fn();
    const view = {
      refinementLists: [
        {
          attribute: 'categories',
          items: signal([
            { value: 'a', label: 'A', count: 1, isRefined: true },
            { value: 'b', label: 'B', count: 1, isRefined: false },
            { value: 'c', label: 'C', count: 1, isRefined: true },
          ]),
          canRefine: signal(true),
          refine: listRefine,
        },
      ],
      numericMenus: [
        {
          attribute: 'integration_count',
          items: signal([
            { value: 'all', label: '', isRefined: false },
            { value: 'lots', label: '51+', isRefined: true },
          ]),
          refine: menuRefine,
        },
      ],
      ranges: [
        {
          attribute: 'founded_year',
          bounds: signal({}),
          start: signal<[number | undefined, number | undefined]>([2000, Infinity]),
          canRefine: signal(true),
          refine: rangeRefine,
        },
      ],
    };
    // The hidden Vendors tab holds one filter of its own.
    const vendorRefine = vi.fn();
    const vendorsView = {
      refinementLists: [],
      numericMenus: [
        {
          attribute: 'product_count',
          items: signal([
            { value: 'all', label: '', isRefined: false },
            { value: 'few', label: '1–10', isRefined: true },
          ]),
          refine: vendorRefine,
        },
      ],
      ranges: [],
    };
    const page = fixture.componentInstance as unknown as {
      controller: WritableSignal<unknown>;
      activeFilterCount: () => number;
      anyFilterCount: () => number;
      clearFilters(): void;
    };
    page.controller.set({ products: view, vendors: vendorsView, dispose: () => {} });

    // Active (products) tab: two checked values + one bucket + one range bound.
    expect(page.activeFilterCount()).toBe(4);
    // Both tabs, which decides whether "Clear filters" shows.
    expect(page.anyFilterCount()).toBe(5);

    // "Clear filters" clears everything, as on /products, not just this tab.
    page.clearFilters();
    expect(listRefine.mock.calls).toEqual([['a'], ['c']]);
    expect(menuRefine).toHaveBeenCalledWith('all');
    expect(rangeRefine).toHaveBeenCalledWith([undefined, undefined]);
    expect(vendorRefine).toHaveBeenCalledWith('all');
  });

  it('shows the /products failed-load message when the first search fails', async () => {
    const { fixture, el } = await setupMounted();
    const page = fixture.componentInstance as unknown as {
      controller: () => SearchController;
    };
    // The first response never landed, so the skeleton would otherwise stay up.
    page.controller().error.set(true);
    fixture.detectChanges();
    expect(el.textContent).toContain("Couldn't load results. Refresh to try again.");
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('renders the shared cards/table toggle and the /products table row on ?view=table', async () => {
    const { fixture, el } = await setupMounted('/search?view=table');
    const ctrl = (
      fixture.componentInstance as unknown as { controller: () => SearchController }
    ).controller();
    (ctrl.products.hits as WritableSignal<unknown[]>).set([
      {
        objectID: 'p1',
        slug: 'revit',
        name: 'Revit',
        logo_url: null,
        vendor_name: 'Autodesk',
        vendor_slug: 'autodesk',
        integration_count: 3,
        review_count: 0,
        rating_overall_avg: null,
      },
    ]);
    ctrl.ready.set(true);
    fixture.detectChanges();

    const pressed = el.querySelector('aec-listing-view-toggle [aria-pressed="true"]');
    expect(pressed?.textContent).toContain('Table');
    const row = el.querySelector('table tbody tr');
    expect(row?.getAttribute('aec-product-card')).not.toBeNull();
    expect(row?.querySelector('a[href="/products/revit"]')).not.toBeNull();
    expect(row?.querySelector('a[href="/vendors/autodesk"]')).not.toBeNull();
  });

  it('starts the search on the filters in the URL', async () => {
    const { engine } = await setupMounted(
      '/search?categories=Scheduling&categories=AI&v_founded_year=2000:',
    );
    const initial = engine.options[0]!.initialUiState!;
    expect(initial['products']).toMatchObject({
      refinementList: { categories: ['AI', 'Scheduling'] },
    });
    expect(initial['vendors']).toMatchObject({ range: { founded_year: '2000:' } });
  });

  it('writes a filter change to the URL as a new history entry', async () => {
    const { engine, router } = await setupMounted('/search?q=revit');
    const navigate = vi.spyOn(router, 'navigate');
    engine.options[0]!.onStateChange!({
      uiState: { products: { refinementList: { trades: ['Roofing'] } } },
      setUiState: () => {},
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const extras = navigate.mock.calls[0]![1]!;
    expect(extras.queryParams).toMatchObject({ trades: ['Roofing'], categories: null });
    expect(extras.queryParamsHandling).toBe('merge');
    // A Back step, not a replace, and no jump to the top.
    expect(extras.replaceUrl).toBeUndefined();
    expect(extras.scroll).toBe('manual');
  });

  it('treats an infinite range bound as unset', () => {
    setConfigPresent();
    setup();
    const fixture = TestBed.createComponent(SearchPage);
    const view = {
      refinementLists: [],
      numericMenus: [],
      ranges: [
        {
          attribute: 'founded_year',
          bounds: signal({}),
          start: signal<[number | undefined, number | undefined]>([-Infinity, Infinity]),
          canRefine: signal(true),
          refine: vi.fn(),
        },
      ],
    };
    const page = fixture.componentInstance as unknown as {
      controller: WritableSignal<unknown>;
      activeFilterCount: () => number;
    };
    page.controller.set({ products: view, vendors: view, dispose: () => {} });
    expect(page.activeFilterCount()).toBe(0);
  });
});
