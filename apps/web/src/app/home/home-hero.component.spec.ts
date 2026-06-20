import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { AUTOCOMPLETE_SEARCH_FACTORY } from '../search/autocomplete-search.factory';
import { SearchAutocomplete } from '../search/search-autocomplete';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';

import { HomeHero } from './home-hero';

/**
 * `ng test` coverage for `HomeHero`.
 *
 * The hero MOUNTS the reused `SearchAutocomplete` (AECI-144); the widget's own
 * behaviour is covered by its spec, so here we assert the hero's contract: the
 * editorial copy + i18n surfaces render, the widget is mounted as the
 * `hero-search` instance with its real `<label>`, the two search outputs are
 * wired to Router navigation (mirroring `SiteHeader`), and the "Popular:" links
 * reflect `TaxonomyNavStore` — absent when the (browser-only) store is empty and
 * capped at five when it has data.
 *
 * Algolia is never loaded: `__AECI_ALGOLIA__` is absent so the widget's
 * `afterNextRender` returns before touching the factory; the never-resolving
 * factory below is belt-and-suspenders.
 */
type GlobalWithConfig = { __AECI_ALGOLIA__?: unknown };

function term(slug: string, name: string): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count: 0 };
}

const SUGGESTION: AutocompleteSuggestion = {
  kind: 'product',
  objectID: 'revit',
  title: 'Revit',
  subtitle: 'Autodesk',
  routerLink: ['/products', 'revit'],
};

async function setup(categories: TaxonomyTermWithCount[] = []) {
  const categoriesTop10 = signal<TaxonomyTermWithCount[]>(categories);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: TaxonomyNavStore, useValue: { categoriesTop10 } },
      { provide: AUTOCOMPLETE_SEARCH_FACTORY, useValue: () => new Promise<never>(() => {}) },
    ],
  });
  const fixture = TestBed.createComponent(HomeHero);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

describe('HomeHero', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => delete (globalThis as GlobalWithConfig).__AECI_ALGOLIA__);

  it('renders the editorial hero on a Bone band', async () => {
    const { host } = await setup();

    const section = host.querySelector('section')!;
    expect(section.className).toContain('bg-(--accent-warm)'); // warm Bone band
    expect(section.className).toContain('border-b'); // 1px bottom rule

    expect(host.querySelector('h1')?.textContent?.trim()).toBe(
      'Find the integrations between your AEC tools.',
    );
    expect(host.textContent).toContain('The specifier');
    expect(host.textContent).toContain('no vendor marketing and no pay-for-placement');
  });

  it('mounts the reused autocomplete widget as the hero-search instance with a real label', async () => {
    const { host } = await setup();

    const input = host.querySelector('input')!;
    const label = host.querySelector('label')!;
    expect(input.id).toBe('hero-search');
    expect(label.getAttribute('for')).toBe('hero-search');
    expect(label.textContent?.trim()).not.toBe(''); // real <label>, not placeholder-as-label
  });

  it('navigates to /search when the widget emits a free-text query', async () => {
    const { fixture } = await setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const search = fixture.debugElement.query(By.directive(SearchAutocomplete))
      .componentInstance as SearchAutocomplete;
    search.querySubmitted.emit('  revit  ');

    expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'revit' } });
  });

  it('navigates to a suggestion detail page when the widget emits a choice', async () => {
    const { fixture } = await setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const search = fixture.debugElement.query(By.directive(SearchAutocomplete))
      .componentInstance as SearchAutocomplete;
    search.suggestionChosen.emit(SUGGESTION);

    expect(navigate).toHaveBeenCalledWith(['/products', 'revit']);
  });

  it('omits the "Popular:" row when the taxonomy store is empty (SSR / pre-hydration)', async () => {
    const { host } = await setup([]);

    expect(host.textContent).not.toContain('Popular');
    expect(host.querySelector('a[href^="/categories/"]')).toBeNull();
  });

  it('renders up to five category quick-links from the taxonomy store', async () => {
    const { host } = await setup([
      term('bim-authoring', 'BIM authoring'),
      term('estimating', 'Estimating'),
      term('scheduling', 'Scheduling'),
      term('project-management', 'Project management'),
      term('reality-capture', 'Reality capture'),
      term('cost-management', 'Cost management'), // 6th — must be dropped by the slice(0, 5)
    ]);

    expect(host.textContent).toContain('Popular:');
    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href^="/categories/"]'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/categories/bim-authoring',
      '/categories/estimating',
      '/categories/scheduling',
      '/categories/project-management',
      '/categories/reality-capture',
    ]);
    expect(links[0]?.textContent?.trim()).toBe('BIM authoring');
  });
});
