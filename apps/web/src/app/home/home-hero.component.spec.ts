import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductListItem, TaxonomyTermWithCount } from '@aeci/shared';

import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { AUTOCOMPLETE_SEARCH_FACTORY } from '../search/autocomplete-search.factory';
import { SearchAutocomplete } from '../search/search-autocomplete';

import { HomeHero } from './home-hero';

/**
 * `ng test` coverage for `HomeHero`.
 *
 * The hero MOUNTS the reused `SearchAutocomplete` (AECI-144); the widget's own
 * behaviour is covered by its spec, so here we assert the hero's contract: the
 * editorial copy + i18n surfaces render, the widget is mounted as the
 * `hero-search` instance with its real `<label>`, the two search outputs are
 * wired to Router navigation (mirroring `SiteHeader`), and the "Most viewed" row
 * renders from the `popularProducts` input (AECI-1572): capped at five, each
 * linking to its product page, with the `largestCategories` input as its fallback
 * when it is empty. Both rows are inputs, so both are in the server render, and
 * the slot keeps its height when both are empty (AECI-1862).
 *
 * Algolia is never loaded: `__AECI_ALGOLIA__` is absent so the widget's
 * `afterNextRender` returns before touching the factory; the never-resolving
 * factory below is belt-and-suspenders.
 */
type GlobalWithConfig = { __AECI_ALGOLIA__?: unknown };

function popular(slug: string, name: string): ProductListItem {
  return {
    id: `id-${slug}`,
    slug,
    name,
    logo_url: null,
    product_role: 'application',
    connector_kind: null,
    vendor: { id: 'v', slug: 'v', name: 'Vendor', logo_url: null },
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

const SUGGESTION: AutocompleteSuggestion = {
  kind: 'product',
  objectID: 'revit',
  title: 'Revit',
  subtitle: 'Autodesk',
  routerLink: ['/products', 'revit'],
};

async function setup(
  popularProducts: ProductListItem[] = [],
  categories: TaxonomyTermWithCount[] = [],
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: AUTOCOMPLETE_SEARCH_FACTORY, useValue: () => new Promise<never>(() => {}) },
    ],
  });
  const fixture = TestBed.createComponent(HomeHero);
  fixture.componentRef.setInput('popularProducts', popularProducts);
  fixture.componentRef.setInput('largestCategories', categories);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

type HeroFixture = Awaited<ReturnType<typeof setup>>['fixture'];

/** The three widget mounts, in DOM order: hero search, "Your tool", "Connects to". */
function widgets(fixture: HeroFixture): SearchAutocomplete[] {
  return fixture.debugElement
    .queryAll(By.directive(SearchAutocomplete))
    .map((d) => d.componentInstance as SearchAutocomplete);
}

function heroSearch(fixture: HeroFixture): SearchAutocomplete {
  return widgets(fixture)[0]!;
}

function product(slug: string, title: string): AutocompleteSuggestion {
  return {
    kind: 'product',
    objectID: slug,
    title,
    subtitle: null,
    routerLink: ['/products', slug],
  };
}

function submitPairForm(host: HTMLElement): SubmitEvent {
  const form = host.querySelector<HTMLFormElement>('form[aria-labelledby="hero-pair-title"]')!;
  const event = new SubmitEvent('submit', { cancelable: true });
  form.dispatchEvent(event);
  return event;
}

describe('HomeHero', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => delete (globalThis as GlobalWithConfig).__AECI_ALGOLIA__);

  it('renders the editorial hero with no ground of its own', async () => {
    const { host } = await setup();

    // The Bone ground and the wrap belong to the page's one aec-bone-band (home.ts).
    expect(host.querySelector('[class*="bg-(--accent-warm)"]')).toBeNull();
    expect(host.querySelector('[class*="max-w-7xl"]')).toBeNull();

    expect(host.querySelector('h1')?.textContent?.trim()).toBe(
      'Find the integrations between your AEC tools.',
    );
    // Ruling 2: Display size, weight 400. The size sits on the inner span because
    // the unlayered h1 rule beats any utility on the h1 itself.
    const title = host.querySelector<HTMLElement>('h1 > [data-testid="home-hero-title"]')!;
    expect(title.classList).toContain('text-t-display');
    expect(title.classList).toContain('font-normal');
    expect(host.querySelector('h1')!.className).not.toMatch(/text-(t-|[0-9]?xl|lg|base|sm)/);
    expect(host.querySelector('.aec-overline')?.textContent?.trim()).toBe(
      'The independent reference for AEC software',
    );
    expect(host.textContent).toContain('with no pay-for-placement');
    // AECI-1555: the lead-capture link moved out of the hero.
    expect(host.textContent).not.toContain('Get product updates');
    expect(host.querySelector('a[href="/updates"]')).toBeNull();
    // One h1, then the pair finder's h2: a valid heading order.
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h2')?.textContent?.trim()).toBe('Do these two connect?');
    // AECI-1316: vendors write some product copy, so the claim is gone.
    expect(host.textContent).not.toContain('vendor marketing');
  });

  it('mounts the reused autocomplete widget as the hero-search instance with a real label', async () => {
    const { host } = await setup();

    const input = host.querySelector<HTMLInputElement>('#hero-search')!;
    const label = host.querySelector('label[for="hero-search"]')!;
    expect(input).not.toBeNull();
    expect(label.textContent?.trim()).not.toBe(''); // real <label>, not placeholder-as-label
    // AECI-1555: product examples instead of the shared "Search directory".
    expect(input.getAttribute('placeholder')).toBe('Try Procore, Sage 300, Bluebeam');
  });

  it('puts all three fields on the shared control recipe, so each has a 3:1 edge on Bone', async () => {
    const { host } = await setup();

    for (const id of ['hero-search', 'hero-pair-tool', 'hero-pair-other']) {
      const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
      expect(input.classList, id).toContain('aec-field-control');
      expect(input.classList, id).toContain('focus-visible:outline-3');
    }
    // The hero search makes room for its leading glyph.
    expect(host.querySelector('#hero-search')!.classList).toContain('ps-12');
  });

  it('navigates to /search when the widget emits a free-text query', async () => {
    const { fixture } = await setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const search = heroSearch(fixture);
    search.querySubmitted.emit('  revit  ');

    expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'revit' } });
  });

  it('navigates to a suggestion detail page when the widget emits a choice', async () => {
    const { fixture } = await setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const search = heroSearch(fixture);
    search.suggestionChosen.emit(SUGGESTION);

    expect(navigate).toHaveBeenCalledWith(['/products', 'revit']);
  });

  it('keeps the row height reserved but unlabelled when both lists are empty (AECI-1862)', async () => {
    const { host } = await setup([]);

    const slot = host.querySelector<HTMLElement>('[data-testid="home-popular"]')!;
    expect(slot).not.toBeNull();
    // Three 24px lines below sm, two from sm: the slot never collapses.
    expect(slot.classList).toContain('min-h-[72px]');
    expect(slot.classList).toContain('sm:min-h-12');
    expect(slot.textContent?.trim()).toBe('');
    expect(host.querySelector('a[href^="/products/"]')).toBeNull();
  });

  it('falls back to the five largest categories when no product clears the view floor', async () => {
    const cats: TaxonomyTermWithCount[] = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      slug: `cat-${i}`,
      name: `Category ${i}`,
      description: null,
      display_order: i,
      product_count: 50 - i,
    }));
    const { host } = await setup([], cats);

    // Ruling 3: the fallback names its own order.
    expect(host.textContent).toContain('Largest categories:');
    expect(host.textContent).not.toContain('Most viewed');
    expect(host.textContent).not.toContain('Popular');
    const links = host.querySelectorAll('a[href^="/categories/"]');
    expect(links).toHaveLength(5);
    expect(links[0]?.getAttribute('href')).toBe('/categories/cat-0');
    expect(host.querySelector('a[href^="/products/"]')).toBeNull();
  });

  it('prefers popular products over the category fallback when both exist', async () => {
    const cats: TaxonomyTermWithCount[] = [
      {
        id: 'c0',
        slug: 'cat-0',
        name: 'Category 0',
        description: null,
        display_order: 0,
        product_count: 9,
      },
    ];
    const { host } = await setup([popular('procore', 'Procore')], cats);

    expect(host.querySelector('a[href="/products/procore"]')).not.toBeNull();
    expect(host.querySelector('a[href^="/categories/"]')).toBeNull();
    expect(host.textContent).not.toContain('Largest categories');
  });

  it('renders up to five product links from the popularProducts input, in rank order', async () => {
    const { host } = await setup([
      popular('procore', 'Procore'),
      popular('revit', 'Revit'),
      popular('bluebeam-revu', 'Bluebeam Revu'),
      popular('sage-300-cre', 'Sage 300 CRE'),
      popular('fieldwire', 'Fieldwire'),
      popular('newforma', 'Newforma'), // 6th: must be dropped by the slice(0, 5)
    ]);

    // Ruling 3: the label states the order.
    expect(host.textContent).toContain('Most viewed, last 30 days:');
    expect(host.textContent).not.toContain('Popular');
    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href^="/products/"]'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/products/procore',
      '/products/revit',
      '/products/bluebeam-revu',
      '/products/sage-300-cre',
      '/products/fieldwire',
    ]);
    expect(links[0]?.textContent?.trim()).toBe('Procore');
    // No category quick-links any more: the row names products.
    expect(host.querySelector('a[href^="/categories/"]')).toBeNull();
  });

  describe('pair finder (AECI-1555)', () => {
    it('SSR-renders a static GET /search form with two named, labelled product fields', async () => {
      const { host } = await setup();

      const form = host.querySelector<HTMLFormElement>('form[aria-labelledby="hero-pair-title"]')!;
      expect(form.getAttribute('action')).toBe('/search');
      expect(form.getAttribute('method')).toBe('get');
      // The pickers mount formless, so forms never nest.
      expect(form.querySelector('form')).toBeNull();

      const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input'));
      expect(inputs.map((i) => [i.id, i.name])).toEqual([
        ['hero-pair-tool', 'q'],
        ['hero-pair-other', 'q'],
      ]);
      expect(form.querySelector('label[for="hero-pair-tool"]')?.textContent?.trim()).toBe(
        'Your tool',
      );
      expect(form.querySelector('label[for="hero-pair-other"]')?.textContent?.trim()).toBe(
        'Connects to',
      );
      const button = form.querySelector('button[type="submit"]')!;
      expect(button.textContent?.trim()).toBe('Show integrations');
      expect(button.getAttribute('data-variant')).toBe('primary');
      expect(button.getAttribute('type')).toBe('submit');
    });

    it('limits both pickers to product suggestions and leaves the hero search unfiltered', async () => {
      const { fixture } = await setup();
      const [search, tool, other] = widgets(fixture);
      expect(search!.kinds()).toBeUndefined();
      expect(tool!.kinds()).toEqual(['product']);
      expect(other!.kinds()).toEqual(['product']);
      expect(tool!.ownForm()).toBe(false);
      // The finder stays on the page, so the field shows the picked product.
      expect(tool!.fillOnSelect()).toBe(true);
      expect(search!.fillOnSelect()).toBe(false);
    });

    it('two products chosen: navigates to the pair page with the canonical first slug as context', async () => {
      const { fixture, host } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const http = TestBed.inject(HttpTestingController);
      const [, tool, other] = widgets(fixture);

      tool!.suggestionChosen.emit(product('revit', 'Revit'));
      other!.suggestionChosen.emit(product('bluebeam', 'Bluebeam'));
      const event = submitPairForm(host);

      expect(event.defaultPrevented).toBe(true);
      // The finder reads the pair first, with the context slug first (AECI-1823).
      http.expectOne('/api/products/bluebeam/integrations/revit').flush({ mechanisms: [] });
      await fixture.whenStable();
      expect(navigate).toHaveBeenCalledWith(['/products', 'bluebeam', 'integrations', 'revit']);
      http.verify();
    });

    /** Let the async lookups after a flushed read issue their requests. */
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    /** Flush a canonical NOT_FOUND envelope, optionally naming the missing slug. */
    function flushNotFound(req: TestRequest, slug?: string): void {
      req.flush(
        { error: { code: 'NOT_FOUND', message: 'not found', details: slug ? { slug } : {} } },
        { status: 404, statusText: 'Not Found' },
      );
    }

    /** Two picks (revit, stale-slug) with their field text, pair read pending. */
    async function pickStalePair(submit = true) {
      const ctx = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const navigateByUrl = vi
        .spyOn(TestBed.inject(Router), 'navigateByUrl')
        .mockResolvedValue(true);
      const http = TestBed.inject(HttpTestingController);
      const [, tool, other] = widgets(ctx.fixture);
      tool!.suggestionChosen.emit(product('revit', 'Revit'));
      other!.suggestionChosen.emit(product('stale-slug', 'Stale Product'));
      ctx.host.querySelector<HTMLInputElement>('#hero-pair-tool')!.value = 'Revit';
      ctx.host.querySelector<HTMLInputElement>('#hero-pair-other')!.value = 'Stale Product';
      if (submit) submitPairForm(ctx.host);
      return { ...ctx, navigate, navigateByUrl, http };
    }

    it('pair NOT_FOUND, no retired slug: routes to /search with the typed name (AECI-1823)', async () => {
      const { navigate, navigateByUrl, http } = await pickStalePair();

      flushNotFound(http.expectOne('/api/products/revit/integrations/stale-slug'));
      await settle();
      // Both slugs are looked up in the retired-slug map; neither is mapped.
      flushNotFound(http.expectOne('/api/slug-redirects/product/revit'));
      flushNotFound(http.expectOne('/api/slug-redirects/product/stale-slug'));
      await settle();

      expect(navigateByUrl).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'Revit' } });
    });

    it('pair NOT_FOUND naming the second slug: searches the second typed name', async () => {
      const { navigate, http } = await pickStalePair();

      flushNotFound(http.expectOne('/api/products/revit/integrations/stale-slug'), 'stale-slug');
      await settle();
      flushNotFound(http.expectOne('/api/slug-redirects/product/revit'));
      flushNotFound(http.expectOne('/api/slug-redirects/product/stale-slug'));
      await settle();

      expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'Stale Product' } });
    });

    it('pair NOT_FOUND but a slug was retired: navigates to the survivor pair, not search (AECI-991)', async () => {
      const { navigate, navigateByUrl, http } = await pickStalePair();

      flushNotFound(http.expectOne('/api/products/revit/integrations/stale-slug'));
      await settle();
      flushNotFound(http.expectOne('/api/slug-redirects/product/revit'));
      http
        .expectOne('/api/slug-redirects/product/stale-slug')
        .flush({ entity: 'product', from_slug: 'stale-slug', to_slug: 'survivor' });
      await settle();

      expect(navigateByUrl).toHaveBeenCalledWith('/products/revit/integrations/survivor');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('a second submit while the read is in flight is ignored, and the form says it is busy', async () => {
      const { fixture, host, http } = await pickStalePair();
      const form = host.querySelector<HTMLFormElement>('form[aria-labelledby="hero-pair-title"]')!;
      const button = form.querySelector('button[type="submit"]')!;
      fixture.detectChanges();
      expect(form.getAttribute('aria-busy')).toBe('true');
      expect(button.hasAttribute('aria-disabled')).toBe(false);
      expect(button.hasAttribute('disabled')).toBe(false);

      const read = http.expectOne('/api/products/revit/integrations/stale-slug');
      submitPairForm(host); // a second submit while the first read is in flight
      http.expectNone('/api/products/revit/integrations/stale-slug'); // no second read

      read.flush({ mechanisms: [] });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(form.hasAttribute('aria-busy')).toBe(false);
      expect(button.hasAttribute('aria-disabled')).toBe(false);
    });

    it('a pending slug-redirect lookup keeps the form busy and blocks a second pair read', async () => {
      const { host, http } = await pickStalePair();
      const form = host.querySelector<HTMLFormElement>('form[aria-labelledby="hero-pair-title"]')!;
      flushNotFound(http.expectOne('/api/products/revit/integrations/stale-slug'));
      await settle();
      const lookups = [
        http.expectOne('/api/slug-redirects/product/revit'),
        http.expectOne('/api/slug-redirects/product/stale-slug'),
      ];

      submitPairForm(host);
      http.expectNone('/api/products/revit/integrations/stale-slug');
      expect(form.getAttribute('aria-busy')).toBe('true');
      expect(lookups).toHaveLength(2);
    });

    it('a slug-redirect lookup that outlasts the timeout falls through to /search', async () => {
      const { host, navigate, navigateByUrl, http } = await pickStalePair(false);
      vi.useFakeTimers();
      try {
        submitPairForm(host);
        flushNotFound(http.expectOne('/api/products/revit/integrations/stale-slug'));
        await vi.advanceTimersByTimeAsync(0);
        http.expectOne('/api/slug-redirects/product/revit'); // never answered
        http.expectOne('/api/slug-redirects/product/stale-slug');
        await vi.advanceTimersByTimeAsync(2500);
        expect(navigateByUrl).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'Revit' } });
      } finally {
        vi.useRealTimers();
      }
    });

    it('a picker edited during the slug-redirect lookup drops the result', async () => {
      const { host, navigate, navigateByUrl, http } = await pickStalePair();
      flushNotFound(http.expectOne('/api/products/revit/integrations/stale-slug'));
      await settle();
      host
        .querySelector<HTMLInputElement>('#hero-pair-other')!
        .dispatchEvent(new Event('input', { bubbles: true }));
      flushNotFound(http.expectOne('/api/slug-redirects/product/revit'));
      http
        .expectOne('/api/slug-redirects/product/stale-slug')
        .flush({ entity: 'product', from_slug: 'stale-slug', to_slug: 'survivor' });
      await settle();
      expect(navigate).not.toHaveBeenCalled();
      expect(navigateByUrl).not.toHaveBeenCalled();
    });

    it('a read that outlasts the timeout navigates to the pair page', async () => {
      const { host, navigate, http } = await pickStalePair(false);
      vi.useFakeTimers();
      try {
        submitPairForm(host);
        http.expectOne('/api/products/revit/integrations/stale-slug');
        await vi.advanceTimersByTimeAsync(2500);
        expect(navigate).toHaveBeenCalledWith(['/products', 'revit', 'integrations', 'stale-slug']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a picker edited while the read is in flight: the stale result is dropped', async () => {
      const { fixture, host, navigate, navigateByUrl, http } = await pickStalePair();
      host
        .querySelector<HTMLInputElement>('#hero-pair-other')!
        .dispatchEvent(new Event('input', { bubbles: true }));

      flushNotFound(http.expectOne('/api/products/revit/integrations/stale-slug'));
      await fixture.whenStable();

      http.expectNone('/api/slug-redirects/product/revit');
      expect(navigate).not.toHaveBeenCalled();
      expect(navigateByUrl).not.toHaveBeenCalled();
    });

    it('two products chosen and the pair read fails otherwise: still navigates to the pair page', async () => {
      const { fixture, host } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const http = TestBed.inject(HttpTestingController);
      const [, tool, other] = widgets(fixture);

      tool!.suggestionChosen.emit(product('revit', 'Revit'));
      other!.suggestionChosen.emit(product('bluebeam', 'Bluebeam'));
      host.querySelector<HTMLInputElement>('#hero-pair-tool')!.value = 'Revit';
      submitPairForm(host);

      http
        .expectOne('/api/products/bluebeam/integrations/revit')
        .flush('boom', { status: 500, statusText: 'Server Error' });
      await fixture.whenStable();
      expect(navigate).toHaveBeenCalledWith(['/products', 'bluebeam', 'integrations', 'revit']);
    });

    it('one product chosen: navigates to its integrations section', async () => {
      const { fixture, host } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const [, , other] = widgets(fixture);

      other!.suggestionChosen.emit(product('procore', 'Procore'));
      submitPairForm(host);

      expect(navigate).toHaveBeenCalledWith(['/products', 'procore'], {
        fragment: 'integrations',
      });
    });

    it('the same product twice: treated as one product', async () => {
      const { fixture, host } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const [, tool, other] = widgets(fixture);

      tool!.suggestionChosen.emit(product('procore', 'Procore'));
      other!.suggestionChosen.emit(product('procore', 'Procore'));
      submitPairForm(host);

      expect(navigate).toHaveBeenCalledWith(['/products', 'procore'], {
        fragment: 'integrations',
      });
    });

    it('none chosen but text typed: routes to /search with the first typed text', async () => {
      const { host } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      host.querySelector<HTMLInputElement>('#hero-pair-other')!.value = '  sage 300 ';
      submitPairForm(host);

      expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'sage 300' } });
    });

    it('editing a picker after choosing drops that choice', async () => {
      const { fixture, host } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const [, tool] = widgets(fixture);

      tool!.suggestionChosen.emit(product('procore', 'Procore'));
      const input = host.querySelector<HTMLInputElement>('#hero-pair-tool')!;
      input.value = 'proc';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      submitPairForm(host);

      expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'proc' } });
    });

    it('Enter in a picker runs the finder, not the hero search', async () => {
      const { fixture, host } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const [, tool] = widgets(fixture);

      host.querySelector<HTMLInputElement>('#hero-pair-tool')!.value = 'bluebeam';
      tool!.querySubmitted.emit('bluebeam');

      expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'bluebeam' } });
    });

    it('nothing chosen and nothing typed: stays put and focuses the first picker', async () => {
      const { host } = await setup();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      submitPairForm(host);

      expect(navigate).not.toHaveBeenCalled();
      expect(document.activeElement?.id).toBe('hero-pair-tool');
    });
  });
});
