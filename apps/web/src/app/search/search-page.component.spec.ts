import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type InstantSearchLib, type IsWidget } from './search-controller';
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
function makeFakeEngine(): SearchEngine & { refine: ReturnType<typeof vi.fn> } {
  const refine = vi.fn();
  let searchBoxRender: ((state: unknown, first: boolean) => void) | null = null;
  const instance = {
    addWidgets: () => instance,
    start: () => searchBoxRender?.({ query: '', refine, isSearchStalled: false }, true),
    dispose: () => {},
    on: () => {},
  };
  const passthrough =
    (_render: (state: unknown, first: boolean) => void) =>
    (_params: Record<string, unknown> = {}): IsWidget =>
      ({}) as IsWidget;
  const lib: InstantSearchLib = {
    instantsearch: () => instance,
    index: () => ({ addWidgets: () => ({}) }),
    configure: () => ({}) as IsWidget,
    connectSearchBox: ((render: (state: unknown, first: boolean) => void) => {
      searchBoxRender = render;
      return (_params: Record<string, unknown> = {}): IsWidget => ({}) as IsWidget;
    }) as unknown as InstantSearchLib['connectSearchBox'],
    connectHits: passthrough as unknown as InstantSearchLib['connectHits'],
    connectStats: passthrough as unknown as InstantSearchLib['connectStats'],
    connectPagination: passthrough as unknown as InstantSearchLib['connectPagination'],
    connectRefinementList: passthrough as unknown as InstantSearchLib['connectRefinementList'],
    connectNumericMenu: passthrough as unknown as InstantSearchLib['connectNumericMenu'],
    connectRange: passthrough as unknown as InstantSearchLib['connectRange'],
  };
  return { lib, searchClient: {}, refine };
}

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
});
