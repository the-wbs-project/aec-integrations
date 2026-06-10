import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SearchPage } from './search-page';
import { SEARCH_ENGINE_FACTORY } from './search-controller.factory';

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

  it('renders the three entity tabs (non-degraded shell)', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const tabs = (fixture.nativeElement as HTMLElement).querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(3);
    const labels = [...tabs].map((t) => t.textContent?.trim());
    expect(labels[0]).toContain('Products');
    expect(labels[1]).toContain('Vendors');
    expect(labels[2]).toContain('Integrations');
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

  it('shows the loading state while the controller is still null', async () => {
    setConfigPresent();
    const router = setup();
    await router.navigateByUrl('/search');
    const fixture = TestBed.createComponent(SearchPage);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(el.textContent).not.toContain('temporarily unavailable');
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
