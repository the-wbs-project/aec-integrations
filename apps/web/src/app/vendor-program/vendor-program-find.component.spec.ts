import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';
import type { AutocompleteResult, AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { AUTOCOMPLETE_SEARCH_FACTORY } from '../search/autocomplete-search.factory';
import { SearchAutocomplete } from '../search/search-autocomplete';
import { ClaimDialogService } from '../shared/claim-dialog/claim-dialog.service';
import { VendorProgramFind } from './vendor-program-find';

/**
 * Find your product (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §6, AECI-1287). The real
 * `aec-search-autocomplete` runs against a fake search seam, so the settle path
 * (debounce, controller, `searchSettled`) is the shipped one. Choosing an option is
 * driven through the box's own `suggestionChosen` output: the Aria listbox commit
 * itself is pinned in `search-autocomplete.component.spec.ts`.
 */
type GlobalWithConfig = { __AECI_ALGOLIA__?: unknown };

const PRODUCT: AutocompleteSuggestion = {
  kind: 'product',
  objectID: 'p1',
  title: 'Acme Takeoff',
  subtitle: 'Acme Software',
  routerLink: ['/products', 'acme-takeoff'],
};
const VENDOR: AutocompleteSuggestion = {
  kind: 'vendor',
  objectID: 'v1',
  title: 'Acme Software',
  subtitle: null,
  routerLink: ['/vendors', 'acme-software'],
};

/** Past the box's 180 ms debounce, then a macrotask for the resolved search. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 260));

async function setup(results: (query: string) => AutocompleteResult) {
  (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = {
    appId: 'APP',
    searchKey: 'key',
    indexes: { products: 'p', vendors: 'v', integrations: 'i' },
  };
  const search = vi.fn((query: string) => Promise.resolve(results(query)));
  const planCtaClicked = vi.fn();
  const vendorProductSearch = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', children: [] }]),
      { provide: AUTOCOMPLETE_SEARCH_FACTORY, useValue: () => Promise.resolve(search) },
      { provide: Analytics, useValue: { planCtaClicked, vendorProductSearch } },
    ],
  });
  const fixture = TestBed.createComponent(VendorProgramFind);
  fixture.detectChanges();
  await fixture.whenStable();
  const host = fixture.nativeElement as HTMLElement;
  const input = host.querySelector('input')!;
  const typeQuery = async (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
    fixture.detectChanges();
  };
  const choose = (hit: AutocompleteSuggestion) => {
    const box = fixture.debugElement.query(By.directive(SearchAutocomplete))
      .componentInstance as SearchAutocomplete;
    box.suggestionChosen.emit(hit);
    fixture.detectChanges();
  };
  return { fixture, host, input, typeQuery, choose, search, planCtaClicked, vendorProductSearch };
}

const hits = (...list: AutocompleteSuggestion[]): AutocompleteResult => ({
  products: list.filter((s) => s.kind === 'product'),
  vendors: list.filter((s) => s.kind === 'vendor'),
  nbHits: list.length,
});
const none = (): AutocompleteResult => ({ products: [], vendors: [], nbHits: 0 });

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('VendorProgramFind', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    delete (globalThis as GlobalWithConfig).__AECI_ALGOLIA__;
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
  });

  it('has its own input with a visible label and the house placeholder', async () => {
    const { host, input } = await setup(none);
    expect(input.id).toBe('vendor-program-search');
    const label = host.querySelector(`label[for="vendor-program-search"]`)!;
    expect(label.classList).not.toContain('sr-only');
    expect(text(label)).toBe('Your product or company');
    expect(input.placeholder).toBe('Search for your product or company');
  });

  it('falls back without JS to a GET form on /search', async () => {
    const { host } = await setup(none);
    const form = host.querySelector('form')!;
    expect(form.getAttribute('action')).toBe('/search');
    expect(form.getAttribute('method')).toBe('get');
    expect(host.querySelector('input')?.getAttribute('name')).toBe('q');
  });

  it('a product hit shows a card that claims the product, and views the listing', async () => {
    const { host, choose, planCtaClicked } = await setup(() => hits(PRODUCT));
    choose(PRODUCT);
    const card = host.querySelector('[data-testid="vp-find-result"]')!;
    expect(text(card)).toContain('Acme Takeoff');
    expect(text(card)).toContain('Acme Software');
    const [claim, view] = [...card.querySelectorAll('a')];
    expect(text(claim)).toBe('Claim this listing');
    expect(claim.getAttribute('href')).toBe('/products/acme-takeoff/claim');
    expect(text(view)).toMatch(/^View the listing ?\(opens in a new tab\)$/);
    expect(view.getAttribute('href')).toBe('/products/acme-takeoff');
    // Ruling 2026-10-12: the listing opens in a new tab, so the claim stays here.
    expect(view.getAttribute('target')).toBe('_blank');
    expect(view.getAttribute('rel')).toBe('noopener');
    expect(view.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(claim.getAttribute('target')).toBeNull();

    claim.click();
    expect(planCtaClicked).toHaveBeenCalledExactlyOnceWith({
      plan: 'free',
      placement: 'search_result',
      page: 'vendor_program',
    });
  });

  it('a vendor hit claims the company listing', async () => {
    const { host, choose } = await setup(() => hits(VENDOR));
    choose(VENDOR);
    const [claim, view] = [...host.querySelectorAll('[data-testid="vp-find-result"] a')];
    expect(claim.getAttribute('href')).toBe('/vendors/acme-software/claim');
    expect(view.getAttribute('href')).toBe('/vendors/acme-software');
  });

  it('choosing does not navigate away', async () => {
    const { choose } = await setup(() => hits(PRODUCT));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    choose(PRODUCT);
    expect(navigate).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  // Settled 2026-10-12 (spec section 6): the ask is always under the box, and it
  // goes to the contact page's add-product topic. It fires no analytics event.
  it('always shows "Can\'t find your product? Ask us to add it." under the box', async () => {
    const { host, planCtaClicked, vendorProductSearch } = await setup(none);
    const ask = host.querySelector('[data-testid="vp-find-ask"]')!;
    expect(text(ask)).toBe("Can't find your product? Ask us to add it.");
    const link = ask.querySelector('a')!;
    expect(text(link)).toBe('Ask us to add it.');
    expect(link.getAttribute('href')).toBe('/contact?topic=add-product');
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
    expect(planCtaClicked).not.toHaveBeenCalled();
    expect(vendorProductSearch).not.toHaveBeenCalled();
  });

  it('a miss shows the may-already-be-listed line, ending in "ask us to add it"', async () => {
    const { host, typeQuery } = await setup(none);
    await typeQuery('zzz unknown');
    const miss = host.querySelector('[data-testid="vp-find-miss"]')!;
    expect(text(miss)).toBe(
      'Your products may already be listed, under a different name. If you cannot find yours, ask us to add it.',
    );
    expect(miss.querySelector('a')?.getAttribute('href')).toBe('/contact?topic=add-product');
    expect(host.querySelector('[data-testid="vp-find-result"]')).toBeNull();
    // The ask under the box stays too.
    expect(host.querySelector('[data-testid="vp-find-ask"]')).not.toBeNull();
  });

  it('clearing the box drops the miss line', async () => {
    const { host, typeQuery } = await setup(none);
    await typeQuery('zzz');
    expect(host.querySelector('[data-testid="vp-find-miss"]')).not.toBeNull();
    await typeQuery('');
    expect(host.querySelector('[data-testid="vp-find-miss"]')).toBeNull();
  });

  it('a failed search is not a miss and is not counted', async () => {
    const { host, input, fixture, search, typeQuery, vendorProductSearch } = await setup(none);
    // An earlier miss is cleared by the failure too.
    await typeQuery('zzz');
    expect(host.querySelector('[data-testid="vp-find-miss"]')).not.toBeNull();
    vendorProductSearch.mockClear();
    search.mockRejectedValueOnce(new Error('network'));
    input.value = 'acme';
    input.dispatchEvent(new Event('input'));
    await settle();
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="vp-find-miss"]')).toBeNull();
    expect(vendorProductSearch).not.toHaveBeenCalled();
  });

  it('counts each settled non-empty query once, with the count and never the text', async () => {
    const { typeQuery, vendorProductSearch } = await setup((q) =>
      q === 'acme' ? hits(PRODUCT, VENDOR) : none(),
    );
    await typeQuery('acme');
    await typeQuery('acme ');
    await typeQuery('');
    await typeQuery('zzz');
    expect(vendorProductSearch.mock.calls).toEqual([
      [{ results_count: 2 }],
      [{ results_count: 0 }],
    ]);
    for (const [props] of vendorProductSearch.mock.calls) {
      expect(Object.keys(props)).toEqual(['results_count']);
      expect(JSON.stringify(props)).not.toMatch(/acme|zzz/);
    }
  });

  it('Enter with no choice goes to /search, as in the header', async () => {
    const { fixture } = await setup(none);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const box = fixture.debugElement.query(By.directive(SearchAutocomplete))
      .componentInstance as SearchAutocomplete;
    box.querySubmitted.emit('acme');
    expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'acme' } });
  });

  // AECI-1293 (spec §15.1): with the page's claim dialog mounted, a result opens it at
  // step 2 with the listing, and "Ask us to add it" opens it at the typed-in step.
  describe('claim dialog (AECI-1293)', () => {
    const plainClick = (link: Element, init: MouseEventInit = {}): boolean => {
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init,
      });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    };

    it('"Claim this listing" opens the dialog with that listing', async () => {
      const { host, choose, planCtaClicked } = await setup(() => hits(VENDOR));
      const dialog = TestBed.inject(ClaimDialogService);
      dialog.attachHost();
      choose(VENDOR);
      const claim = host.querySelector('[data-testid="vp-find-result"] a')!;
      expect(plainClick(claim)).toBe(true);
      expect(dialog.opening()).toEqual({
        page: 'vendor_program',
        entry: 'search_result',
        listing: { targetType: 'vendor', slug: 'acme-software', name: 'Acme Software' },
      });
      expect(planCtaClicked).toHaveBeenCalledWith({
        plan: 'free',
        placement: 'search_result',
        page: 'vendor_program',
      });
    });

    it('"Ask us to add it" opens the dialog at the typed-in step, untracked as a plan click', async () => {
      const { host, planCtaClicked } = await setup(none);
      const dialog = TestBed.inject(ClaimDialogService);
      dialog.attachHost();
      const ask = host.querySelector('[data-testid="vp-find-ask"] a')!;
      expect(ask.getAttribute('href')).toBe('/contact?topic=add-product');
      expect(plainClick(ask)).toBe(true);
      expect(dialog.opening()).toEqual({
        page: 'vendor_program',
        entry: 'ask_to_add',
        typed: true,
      });
      expect(planCtaClicked).not.toHaveBeenCalled();
    });

    it('a modified click, or no dialog host, follows the link', async () => {
      const { host } = await setup(none);
      const dialog = TestBed.inject(ClaimDialogService);
      const ask = host.querySelector('[data-testid="vp-find-ask"] a')!;
      ask.addEventListener('click', (e) => e.preventDefault(), { once: false });
      // No host: the dialog stays closed.
      plainClick(ask);
      expect(dialog.isOpen()).toBe(false);
      dialog.attachHost();
      plainClick(ask, { metaKey: true });
      expect(dialog.isOpen()).toBe(false);
    });
  });
});
