/**
 * AECI-1787: the product hero's visual, ruling R3 decision 1. The category hub
 * (`product-category-hub.ts`) with the pair finder (`product-pair-finder.ts`) under it,
 * placed in the hero band's panel by `product-hero.ts`.
 *
 * Named `.component.spec.ts` so it runs under `ng test`. The order and membership of the
 * hub's list are pinned behaviourally in `on-page-ordering-firewall.spec.ts`. This spec
 * pins what reaches the page: the list a screen reader hears, the zero and connector
 * states, the finder's no-JS form and its routing.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail, ProductIntegrationItem, ProductLink } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { AUTOCOMPLETE_SEARCH_FACTORY } from '../search/autocomplete-search.factory';
import { SearchAutocomplete } from '../search/search-autocomplete';

import { ProductHero } from './product-hero';

const link = (slug: string, name: string): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name,
  logo_url: null,
});

const page = link('revu', 'Revu');
let seq = 0;

function edge(
  partner: ProductLink,
  categories: { slug: string; name: string }[],
  extra: Partial<ProductIntegrationItem> = {},
): ProductIntegrationItem {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name: `${partner.name} link`,
    mechanism_kind: 'native',
    mechanism_name: null,
    direction: null,
    context_direction: null,
    source: page,
    target: partner,
    via: null,
    powered_by_product: null,
    data_object_slugs: [],
    data_objects: [],
    partner_categories: categories,
    agreement: null,
    caption: null,
    corrections: [],
    under_review: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as ProductIntegrationItem;
}

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    claim_status: 'claimed',
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'revu',
    name: 'Revu',
    logo_url: null,
    vendor_facts: { company_size: null, ownership_type: null },
    product_role: 'application',
    vendor: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: null,
    website: null,
    tool_integrations_url: null,
    api_docs_url: null,
    categories: [],
    audiences: [],
    phases: [],
    trades: [],
    usefulness: null,
    usefulness_source: null,
    integrations_as_source: [],
    integrations_as_target: [],
    integrations_as_connector: [],
    related_products: [],
    extension_of: [],
    extensions: [],
    reviews: [],
    reachable_pair_count: 0,
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    under_review: [],
    ...overrides,
  } as ProductDetail;
}

const acc = { slug: 'accounting', name: 'Accounting' };
const bim = { slug: 'bim-authoring', name: 'bim authoring' };
const docs = { slug: 'documents', name: 'Documents' };

function setup(product: ProductDetail) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: { capture: vi.fn(), track: vi.fn() } },
      { provide: AUTOCOMPLETE_SEARCH_FACTORY, useValue: () => new Promise<never>(() => {}) },
    ],
  });
  const fixture = TestBed.createComponent(ProductHero);
  fixture.componentRef.setInput('product', product);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const suggestion = (slug: string, title: string): AutocompleteSuggestion => ({
  kind: 'product',
  objectID: slug,
  title,
  subtitle: null,
  routerLink: ['/products', slug],
});

describe('ProductHero visual: the category hub (AECI-1787)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    seq = 0;
  });

  it('lists each partner category A to Z with its count, inside the hero panel', () => {
    const { el } = setup(
      buildProduct({
        integrations_as_source: [
          edge(link('zeta', 'Zeta'), [docs, acc]),
          edge(link('alpha', 'Alpha'), [acc]),
          edge(link('bare', 'Bare'), []),
        ],
        integrations_as_target: [{ ...edge(page, [bim]), source: link('beta', 'Beta') }],
      }),
    );
    const panel = el.querySelector('.aec-hero-panel')!;
    const list = panel.querySelector('ul[data-testid="product-category-hub"]')!;
    expect(list).not.toBeNull();
    // What a reader hears: the aria-hidden bead is skipped, the worded count follows.
    const heard = (li: Element) =>
      [...li.children]
        .filter((c) => c.getAttribute('aria-hidden') !== 'true')
        .map((c) => c.textContent!.replace(/\s+/g, ' ').trim())
        .join(' ');
    const items = [...list.querySelectorAll(':scope > li')];
    expect(items.map(heard)).toEqual([
      'Accounting, 2 integrations',
      'bim authoring, 1 integration',
      'Documents, 1 integration',
    ]);
    // The bead shows the same count.
    expect(
      items.map((li) => li.querySelector('[aria-hidden="true"]')!.textContent!.trim()),
    ).toEqual(['2', '1', '1']);
  });

  it('is named by its heading, keeps list semantics, and hides only the numeral bead', () => {
    const { el } = setup(
      buildProduct({ integrations_as_source: [edge(link('alpha', 'Alpha'), [acc])] }),
    );
    const heading = el.querySelector('h2#product-category-hub-title')!;
    expect(heading.textContent!.trim()).toBe('Integrations by partner category');
    const list = el.querySelector('ul[data-testid="product-category-hub"]')!;
    expect(list.getAttribute('aria-labelledby')).toBe('product-category-hub-title');
    expect(list.getAttribute('role')).toBe('list');
    const li = list.querySelector('li')!;
    expect(li.querySelector('[aria-hidden="true"]')!.textContent!.trim()).toBe('1');
    expect(li.querySelector('.sr-only')!.textContent!.trim()).toBe(', 1 integration');
    // Nothing in the hub is a link or a logo: it features no product.
    expect(list.querySelector('a, img, aec-logo-or-initial')).toBeNull();
  });

  it('carries the entrance class the reduced-motion rule keys on', () => {
    const { el } = setup(
      buildProduct({ integrations_as_source: [edge(link('alpha', 'Alpha'), [acc])] }),
    );
    expect(el.querySelector('ul.aec-category-hub')).not.toBeNull();
  });

  it('a product with no integrations shows the finder alone, with no hub, and no panel below lg', () => {
    const { el } = setup(buildProduct());
    const panel = el.querySelector('.aec-hero-panel')!;
    expect(panel.querySelector('[data-testid="product-category-hub"]')).toBeNull();
    expect(panel.querySelector('h2')).toBeNull();
    expect(panel.querySelector('[data-testid="product-pair-finder"]')).not.toBeNull();
    // styles.css hides the panel below lg on this marker, so no empty box stacks there.
    expect(panel.querySelector('[data-testid="product-hero-visual"]')!.classList).toContain(
      'aec-hero-panel-lg-only',
    );
  });

  it('with a hub, keeps the panel below lg and holds the finder back until lg', () => {
    const { el } = setup(
      buildProduct({ integrations_as_source: [edge(link('alpha', 'Alpha'), [acc])] }),
    );
    const visual = el.querySelector('[data-testid="product-hero-visual"]')!;
    expect(visual.classList).not.toContain('aec-hero-panel-lg-only');
    expect(el.querySelector('aec-product-pair-finder')!.classList).toContain('max-lg:hidden');
    // The server renders no tab stop on the row. The browser adds one only while it overflows.
    expect(
      el.querySelector('ul[data-testid="product-category-hub"]')!.hasAttribute('tabindex'),
    ).toBe(false);
  });

  it('a partner with no category adds no entry, and with none at all there is no hub', () => {
    const { el } = setup(
      buildProduct({ integrations_as_source: [edge(link('bare', 'Bare'), [])] }),
    );
    expect(el.querySelector('[data-testid="product-category-hub"]')).toBeNull();
    expect(el.querySelector('[data-testid="product-pair-finder"]')).not.toBeNull();
  });

  it('a connector reads none of its powered rows into the hub', () => {
    const { el } = setup(
      buildProduct({
        product_role: 'connector',
        integrations_as_connector: [
          {
            id: '00000000-0000-4000-8000-000000000099',
            name: 'A to B',
            mechanism_kind: null,
            mechanism_name: null,
            direction: null,
            source: link('a', 'A'),
            target: link('b', 'B'),
            via: null,
            data_object_slugs: [],
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(el.querySelector('[data-testid="product-category-hub"]')).toBeNull();
    expect(el.querySelector('[data-testid="product-pair-finder"]')).not.toBeNull();
  });
});

describe('ProductHero visual: many categories (ruling 59)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    seq = 0;
  });

  const withCategories = (n: number) =>
    buildProduct({
      integrations_as_source: Array.from({ length: n }, (_, i) =>
        edge(link(`p-${i}`, `Partner ${i}`), [
          {
            slug: `cat-${String(i).padStart(2, '0')}`,
            name: `Category ${String(i).padStart(2, '0')}`,
          },
        ]),
      ),
    });

  it('with eight or fewer categories there is no control', () => {
    const { el } = setup(withCategories(8));
    expect(el.querySelector('[data-testid="product-category-hub-toggle"]')).toBeNull();
    expect(el.querySelectorAll('li.lg\\:hidden')).toHaveLength(0);
  });

  it('with nine, all nine are in the HTML, the ninth waits behind "Show all 9 categories"', () => {
    const { el } = setup(withCategories(9));
    const items = [...el.querySelectorAll('[data-testid="product-category-hub-entry"]')];
    expect(items).toHaveLength(9);
    expect(items.map((li) => li.classList.contains('lg:hidden'))).toEqual([
      ...Array(8).fill(false),
      true,
    ]);
    const button = el.querySelector<HTMLButtonElement>(
      '[data-testid="product-category-hub-toggle"]',
    )!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('product-category-hub-list');
    expect(el.querySelector('#product-category-hub-list')).not.toBeNull();
    expect(button.textContent!.trim()).toBe('Show all 9 categories');
    // No control below lg, where the row scrolls with every entry.
    expect(button.classList).toContain('max-lg:hidden');
  });

  it('toggles: reveals the rest, keeps focus on the button, then collapses again', async () => {
    const { fixture, el } = setup(withCategories(12));
    document.body.appendChild(el);
    const button = el.querySelector<HTMLButtonElement>(
      '[data-testid="product-category-hub-toggle"]',
    )!;
    button.focus();
    button.click();
    await fixture.whenStable();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent!.trim()).toBe('Show fewer');
    expect(
      el.querySelectorAll('[data-testid="product-category-hub-entry"].lg\\:hidden'),
    ).toHaveLength(0);
    expect(document.activeElement).toBe(button);
    button.click();
    await fixture.whenStable();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent!.trim()).toBe('Show all 12 categories');
    expect(
      el.querySelectorAll('[data-testid="product-category-hub-entry"].lg\\:hidden'),
    ).toHaveLength(4);
    el.remove();
  });

  // Owner ruling 2026-11-17, item 82. jsdom has no layout, so the boxes are stubbed to
  // the 1024px numbers measured on `revit` with 12 categories: the grid at 100, the
  // text centred at 256 while collapsed, and at 356 once the panel has grown. The
  // offsets must be read from the collapsed layout, before the hub expands.
  it('"Show all" pins both hero columns where they sat, and "Show fewer" lets them go', async () => {
    const { fixture, el } = setup(withCategories(12));
    const grid = el.querySelector<HTMLElement>('[data-testid="hero-band-grid"]')!;
    const [text, panel] = Array.from(grid.children) as HTMLElement[];
    const collapsed = () => el.querySelectorAll('li.lg\\:hidden').length > 0;
    const box = (top: number) => ({ top }) as DOMRect;
    grid.getBoundingClientRect = () => box(100);
    panel.getBoundingClientRect = () => box(100);
    text.getBoundingClientRect = () => box(collapsed() ? 256 : 356);

    // Collapsed: no hold, so the band centres the columns as before.
    expect(text.hasAttribute('data-held')).toBe(false);
    expect(panel.hasAttribute('data-held')).toBe(false);

    const button = el.querySelector<HTMLButtonElement>(
      '[data-testid="product-category-hub-toggle"]',
    )!;
    button.click();
    await fixture.whenStable();
    expect(collapsed()).toBe(false);
    expect(text.hasAttribute('data-held')).toBe(true);
    expect(text.style.getPropertyValue('--aec-hero-held')).toBe('156px');
    expect(text.classList).toContain('lg:data-held:self-start');
    expect(text.classList).toContain('lg:data-held:mt-(--aec-hero-held)');
    expect(panel.hasAttribute('data-held')).toBe(true);
    expect(panel.style.getPropertyValue('--aec-hero-held')).toBe('0px');
    expect(panel.classList).toContain('lg:data-held:self-start');

    button.click();
    await fixture.whenStable();
    expect(collapsed()).toBe(true);
    expect(text.hasAttribute('data-held')).toBe(false);
    expect(text.style.getPropertyValue('--aec-hero-held')).toBe('');
    expect(panel.hasAttribute('data-held')).toBe(false);
  });
});

describe('ProductHero visual: the pair finder (AECI-1787)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    seq = 0;
  });

  function picker(fixture: ReturnType<typeof setup>['fixture']): SearchAutocomplete {
    return fixture.debugElement.query(By.directive(SearchAutocomplete))
      .componentInstance as SearchAutocomplete;
  }

  function submit(el: HTMLElement): SubmitEvent {
    const form = el.querySelector<HTMLFormElement>('[data-testid="product-pair-finder"]')!;
    const event = new SubmitEvent('submit', { cancelable: true });
    form.dispatchEvent(event);
    return event;
  }

  it('is a native GET to /search with one product picker, a heading naming the product, and no filled button', () => {
    const { fixture, el } = setup(buildProduct());
    const form = el.querySelector<HTMLFormElement>('[data-testid="product-pair-finder"]')!;
    expect(form.getAttribute('action')).toBe('/search');
    expect(form.getAttribute('method')).toBe('get');
    expect(form.getAttribute('role')).toBe('search');
    // Ruling 61: the heading names the product already filled in, with a real ellipsis.
    expect(el.querySelector('#product-pair-title')!.textContent!.trim()).toBe(
      'Does Revu connect to\u2026?',
    );
    expect(form.getAttribute('aria-labelledby')).toBe('product-pair-title');
    const input = form.querySelector<HTMLInputElement>('#product-pair-other')!;
    expect(input.getAttribute('name')).toBe('q');
    expect(form.querySelector('label[for="product-pair-other"]')!.textContent!.trim()).toBe(
      'Connects to',
    );
    expect(input.getAttribute('placeholder')).toBe('Type a product name');
    const button = form.querySelector('button[type="submit"]')!;
    expect(button.textContent!.trim()).toBe('Show integrations');
    // "Visit website" stays the hero's one filled button.
    expect(button.getAttribute('data-variant')).toBe('on-brand-secondary');
    const widget = picker(fixture);
    expect(widget.kinds()).toEqual(['product']);
    expect(widget.ownForm()).toBe(false);
    expect(widget.fillOnSelect()).toBe(true);
  });

  it('another product chosen: reads the pair, then opens the pair page with this product filled', async () => {
    const { fixture, el } = setup(buildProduct());
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const http = TestBed.inject(HttpTestingController);
    picker(fixture).suggestionChosen.emit(suggestion('bluebeam', 'Bluebeam'));
    const event = submit(el);
    expect(event.defaultPrevented).toBe(true);
    http.expectOne('/api/products/bluebeam/integrations/revu').flush({ mechanisms: [] });
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith(['/products', 'bluebeam', 'integrations', 'revu']);
    http.verify();
  });

  it('this product chosen again: opens its integrations, as the home finder routes one product', async () => {
    const { fixture, el } = setup(buildProduct());
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const http = TestBed.inject(HttpTestingController);
    picker(fixture).suggestionChosen.emit(suggestion('revu', 'Revu'));
    el.querySelector<HTMLInputElement>('#product-pair-other')!.value = 'Revu';
    submit(el);
    await fixture.whenStable();
    http.expectNone(() => true);
    expect(navigate).toHaveBeenCalledWith(['/products', 'revu'], { fragment: 'integrations' });
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('only text typed: searches the typed text', async () => {
    const { fixture, el } = setup(buildProduct());
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const http = TestBed.inject(HttpTestingController);
    el.querySelector<HTMLInputElement>('#product-pair-other')!.value = 'Bluebeam';
    submit(el);
    await fixture.whenStable();
    http.expectNone(() => true);
    const calls = [
      ...navigate.mock.calls.map((c) => JSON.stringify(c)),
      ...navigateByUrl.mock.calls.map((c) => JSON.stringify(c)),
    ];
    expect(calls.join(' ')).toContain('Bluebeam');
    expect(calls.join(' ')).toContain('search');
  });

  it('nothing typed: focuses the field and goes nowhere', async () => {
    const { fixture, el } = setup(buildProduct());
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    document.body.appendChild(el);
    submit(el);
    await fixture.whenStable();
    expect(navigate).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('product-pair-other');
    el.remove();
  });
});

// AECI-2037: the hero's role chip and reach line read the connector kind.
describe('ProductHero connector kind (AECI-2037)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    seq = 0;
  });

  // Two pairs the page product sits in the middle of: three distinct endpoints.
  function connector(kind: ProductDetail['connector_kind']): ProductDetail {
    const a = link('procore', 'Procore');
    return buildProduct({
      slug: 'fx-connector',
      name: 'Fixture connector',
      product_role: 'connector',
      connector_kind: kind,
      integrations_as_connector: [
        edge(link('acumatica', 'Acumatica'), [], { source: a }),
        edge(link('quickbooks', 'QuickBooks'), [], { source: a }),
      ],
    });
  }

  function chip(el: HTMLElement): string {
    return el.querySelector('aec-role-badge')?.textContent?.trim() ?? '';
  }

  it.each([
    [
      'integration_platform',
      'Integration platform',
      'Connects 3 products in the AEC Integrations catalog',
    ],
    ['sync_service', 'Sync Service', 'Syncs 3 products in the AEC Integrations catalog'],
    [null, 'Connector', 'Connects 3 products in the AEC Integrations catalog'],
  ] as const)('kind %s: chip "%s" and line "%s"', (kind, label, line) => {
    const { el } = setup(connector(kind));
    expect(chip(el)).toBe(label);
    expect(el.textContent).toContain(line);
  });
});
