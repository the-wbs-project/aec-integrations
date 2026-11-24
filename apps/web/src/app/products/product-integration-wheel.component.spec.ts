/**
 * AECI-2018: the integrations wheel in the product hero (`product-integration-wheel.ts`).
 *
 * Named `.component.spec.ts` so it runs under `ng test`. The geometry is pinned in
 * `integration-wheel.spec.ts` and the order in `on-page-ordering-firewall.spec.ts`; this
 * spec pins what reaches the page: the server layouts by width, the A to Z list, the ring
 * count per slide, the dots rule, the centre, ruling 64's logo choice, the card's label,
 * the lines under the wheel, stepping, the title list and the keyboard.
 */
import { OverlayContainer } from '@angular/cdk/overlay';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail, ProductIntegrationItem, ProductLink, WheelMark } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';

import { ProductHero } from './product-hero';
import { ProductIntegrationWheel } from './product-integration-wheel';

const link = (slug: string, name: string): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name,
  logo_url: null,
});

const page = link('page', 'Revu');
let seq = 0;

function edge(partner: ProductLink, categories: string[]): ProductIntegrationItem {
  seq += 1;
  return {
    id: `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
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
    partner_categories: categories.map((c) => ({ slug: c.toLowerCase(), name: c })),
    partner_vendor_name: `${partner.name} Inc`,
    agreement: null,
    caption: null,
    corrections: [],
    under_review: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as ProductIntegrationItem;
}

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    claim_status: 'claimed',
    id: page.id,
    slug: 'revu',
    name: 'Revu',
    logo_url: 'https://cdn.example/revu.png',
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

/** n partners "P00".. A to Z, the first `inField` also in "Field". */
function partners(n: number, inField = 0): ProductIntegrationItem[] {
  return Array.from({ length: n }, (_, i) =>
    edge(link(`p${String(i).padStart(2, '0')}`, `P${String(i).padStart(2, '0')}`), [
      'All Of Them',
      ...(i < inField ? ['Field'] : []),
    ]),
  );
}

function setup(product: ProductDetail) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(ProductIntegrationWheel);
  fixture.componentRef.setInput('product', product);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const root = el.querySelector<HTMLElement>('.aec-wheel')!;
  return { fixture, el, root };
}

const tiles = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLAnchorElement>('[data-testid="product-hero-wheel-tile"]'),
];
const labels = (el: HTMLElement) =>
  tiles(el).map((a) => a.querySelector('.aec-wheel-label')!.textContent!.trim());
/** The slide's mode at each band of WHEEL_BANDS: 224, 260, 279, 294, 320, 336, 400, 476. */
const modes = (root: HTMLElement) =>
  ['0', '1', '2', '3', '4', '5', '6', '7'].map((k) => root.getAttribute(`data-m${k}`));

describe('ProductIntegrationWheel: the server render', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    seq = 0;
  });

  it('lays the first slide out for every width: tiles by fit, dots past it', () => {
    // 40 products: dots on the five phone bands, two rings from 336.
    expect(modes(setup(buildProduct({ integrations_as_source: partners(40) })).root)).toEqual([
      'dots',
      'dots',
      'dots',
      'dots',
      'dots',
      'two',
      'two',
      'two',
    ]);
    TestBed.resetTestingModule();
    // 6 products: one ring everywhere.
    expect(modes(setup(buildProduct({ integrations_as_source: partners(6) })).root)).toEqual(
      Array(8).fill('one'),
    );
    TestBed.resetTestingModule();
    // 24 products: one ring on the 294 and 320 phone bands, dots on the narrower ones, two
    // rings from 336, where the phone rule ends.
    expect(modes(setup(buildProduct({ integrations_as_source: partners(24) })).root)).toEqual([
      'dots',
      'dots',
      'dots',
      'one',
      'one',
      'two',
      'two',
      'two',
    ]);
  });

  it('is a list of links to the pair pages, A to Z ignoring capitals, every link a tab stop', () => {
    const rows = [
      edge(link('zeta', 'Zeta'), ['AI']),
      edge(link('alpha', 'alpha'), ['AI']),
      edge(link('beta', 'Beta'), ['AI']),
    ];
    const { el } = setup(buildProduct({ integrations_as_source: rows }));
    expect(labels(el)).toEqual(['alpha', 'Beta', 'Zeta']);
    expect(tiles(el).map((a) => a.getAttribute('href'))).toEqual([
      '/products/revu/integrations/alpha',
      '/products/revu/integrations/beta',
      '/products/revu/integrations/zeta',
    ]);
    // That the server HTML carries no roving tab stop is pinned in the e2e spec: a test
    // bed renders in the browser, where the wheel hydrates at once.
    const ring = el.querySelector('ul[data-testid="product-hero-wheel-ring"]')!;
    expect(ring.getAttribute('aria-label')).toBe('All integrations, 3 products, A to Z');
    expect(ring.getAttribute('aria-describedby')).toBe('aec-wheel-hint aec-wheel-lines');
  });

  it('every tile carries a position per width, as percentages', () => {
    const { el } = setup(buildProduct({ integrations_as_source: partners(6) }));
    const style = tiles(el)[0]!.parentElement!.getAttribute('style')!;
    for (const k of ['0', '1', '2', '3', '4', '5', '6', '7']) {
      expect(style).toContain(`--x${k}:0;`);
    }
    // The first tile is at 12 o'clock.
    expect(style).toMatch(/--y7:-\d+(\.\d+)?/);
  });

  it('titles the slide with a count line, and names the arrows by their destination', () => {
    const { el } = setup(buildProduct({ integrations_as_source: partners(3, 1) }));
    const title = el.querySelector('[data-testid="product-hero-wheel-title"]')!;
    expect(title.textContent!.replace(/\s+/g, ' ').trim()).toBe('All integrations, 3 products');
    expect(
      el.querySelector('[data-testid="product-hero-wheel-prev"]')!.getAttribute('aria-label'),
    ).toBe('Previous category: Field');
    expect(
      el.querySelector('[data-testid="product-hero-wheel-next"]')!.getAttribute('aria-label'),
    ).toBe('Next category: All Of Them');
  });

  it('says "1 product" in the singular, and a single slide has no arrows', () => {
    const { el } = setup(buildProduct({ integrations_as_source: [edge(link('a', 'A'), [])] }));
    expect(el.querySelector('[data-testid="product-hero-wheel-prev"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="product-hero-wheel-static-title"]')!.textContent,
    ).toContain('1 product');
  });

  it.each(['claimed', 'unclaimed', 'mixed'] as const)(
    'shows both lines under a tile slide when the listings are %s, and the dots line apart',
    (mix) => {
      const rows = partners(4);
      const marks: WheelMark[] = rows.map((r, i) => ({
        product_id: r.target.id,
        logo_url: i % 2 ? 'https://cdn.example/l.png' : null,
        claim_status:
          mix === 'claimed' || (mix === 'mixed' && i % 2 === 0) ? 'claimed' : 'unclaimed',
      }));
      const { el } = setup(buildProduct({ integrations_as_source: rows, wheel_marks: marks }));
      expect(
        el
          .querySelector('[data-testid="product-hero-wheel-lines"]')!
          .textContent!.replace(/\s+/g, ' ')
          .trim(),
      ).toBe(
        'Shown A to Z. Position is not a ranking. Logos identify products only and imply no endorsement or affiliation. Listings may be unclaimed.',
      );
      expect(
        el.querySelector('[data-testid="product-hero-wheel-dots-line"]')!.textContent!.trim(),
      ).toBe('Too many to show as tiles. Each dot is one integration.');
    },
  );

  it('a dots slide with no category says only how many integrations', () => {
    const rows = Array.from({ length: 90 }, (_, i) =>
      edge(link(`q${String(i).padStart(2, '0')}`, `Q${String(i).padStart(2, '0')}`), []),
    );
    const { el } = setup(buildProduct({ integrations_as_source: rows }));
    expect(
      el
        .querySelector('[data-testid="product-hero-wheel-hub-count"]')!
        .textContent!.replace(/\s+/g, ' ')
        .trim(),
    ).toBe('90 integrations');
  });

  it('a slide too big for tiles at every width shows no product, one dot per integration', () => {
    const { el, root } = setup(buildProduct({ integrations_as_source: partners(90) }));
    expect(modes(root)).toEqual(Array(8).fill('dots'));
    expect(tiles(el)).toHaveLength(0);
    const dotSvgs = el.querySelectorAll('[data-testid="product-hero-wheel-dots"]');
    expect(dotSvgs).toHaveLength(8);
    for (const svg of dotSvgs) {
      const total = [...svg.querySelectorAll('circle')].reduce(
        (n, c) => n + Number(c.getAttribute('pathLength')),
        0,
      );
      expect(total).toBe(90);
    }
    // The title counts products; the centre counts integrations.
    expect(el.querySelector('[data-testid="product-hero-wheel-title"]')!.textContent).toContain(
      '90 products',
    );
    expect(
      el
        .querySelector('[data-testid="product-hero-wheel-hub-count"]')!
        .textContent!.replace(/\s+/g, ' ')
        .trim(),
    ).toBe('90 integrations in 1 category');
  });

  it("centres the page's own product with the logo we may show, claimed or not", () => {
    const own = (claim: 'claimed' | 'unclaimed', logo: string | null): WheelMark => ({
      product_id: page.id,
      logo_url: logo,
      claim_status: claim,
    });
    const centre = (product: ProductDetail) => {
      TestBed.resetTestingModule();
      return setup(product).el.querySelector('[data-testid="product-hero-wheel-centre"]')!;
    };
    const claimed = centre(
      buildProduct({
        integrations_as_source: partners(3),
        wheel_marks: [own('claimed', 'https://cdn.example/revu.png')],
      }),
    );
    expect(claimed.querySelector('img')!.getAttribute('src')).toContain('revu.png');
    // Unclaimed, with a sourced logo: the logo, at the centre's size (ruling 64).
    const unclaimed = centre(
      buildProduct({
        claim_status: 'unclaimed',
        integrations_as_source: partners(3),
        wheel_marks: [own('unclaimed', 'https://cdn.example/sourced.png')],
      }),
    );
    expect(unclaimed.querySelector('img')!.getAttribute('src')).toContain('sourced.png');
    // No logo we may show: the initial tile.
    const none = centre(
      buildProduct({
        claim_status: 'unclaimed',
        integrations_as_source: partners(3),
        wheel_marks: [own('unclaimed', null)],
      }),
    );
    expect(none.querySelector('img')).toBeNull();
    expect(none.textContent!.trim()).toBe('R');
  });

  it('ruling 64: a tile shows the logo we hold, claimed or not, and an initial when none', () => {
    const rows = [
      edge(link('aa', 'Alpha'), []),
      edge(link('bb', 'Beta'), []),
      edge(link('cc', 'Gamma'), []),
    ];
    const marks: WheelMark[] = [
      {
        product_id: rows[0]!.target.id,
        logo_url: 'https://cdn.example/a.png',
        claim_status: 'unclaimed',
      },
      {
        product_id: rows[1]!.target.id,
        logo_url: 'https://cdn.example/b.png',
        claim_status: 'claimed',
      },
      { product_id: rows[2]!.target.id, logo_url: null, claim_status: 'unclaimed' },
    ];
    const { el } = setup(buildProduct({ integrations_as_source: rows, wheel_marks: marks }));
    const [a, b, c] = tiles(el);
    expect(a!.querySelector('img')!.getAttribute('src')).toContain('a.png');
    expect(b!.querySelector('img')!.getAttribute('src')).toContain('b.png');
    expect(c!.querySelector('img')).toBeNull();
    // No tile is marked: the claimed and the unclaimed tile carry the same classes.
    expect(a!.className).toBe(b!.className);
    expect(a!.querySelector('img')!.className).toBe(b!.querySelector('img')!.className);
    expect(el.textContent).not.toContain('Unclaimed');
  });

  it('a row with no mark (an older API) shows the initial tile', () => {
    const { el } = setup(
      buildProduct({
        integrations_as_source: [edge(link('aa', 'Alpha'), [])],
        wheel_marks: undefined,
      }),
    );
    expect(tiles(el)[0]!.querySelector('img')).toBeNull();
  });
});

describe('ProductIntegrationWheel: after hydration', () => {
  let rect: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    TestBed.resetTestingModule();
    seq = 0;
    rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 476,
      height: 476,
      top: 0,
      left: 0,
      right: 476,
      bottom: 476,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => {
    rect.mockRestore();
    TestBed.inject(OverlayContainer).ngOnDestroy();
  });

  async function live(product: ProductDetail) {
    const ctx = setup(product);
    await ctx.fixture.whenStable();
    ctx.fixture.detectChanges();
    return ctx;
  }

  it('keeps the server layouts and makes the ring one tab stop', async () => {
    const { el, root } = await live(buildProduct({ integrations_as_source: partners(6) }));
    expect(root.hasAttribute('data-live')).toBe(true);
    // Hydration lays nothing out again: every band is still there, as the server wrote it.
    expect(modes(root)).toEqual(Array(8).fill('one'));
    expect(tiles(el).map((a) => a.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
      '-1',
      '-1',
      '-1',
    ]);
  });

  it('steps with the arrows, wrapping, decides the ring count per slide and announces it', async () => {
    const { fixture, el, root } = await live(
      buildProduct({ integrations_as_source: partners(40, 5) }),
    );
    expect(root.getAttribute('data-m7')).toBe('two');
    el.querySelector<HTMLButtonElement>('[data-testid="product-hero-wheel-next"]')!.click();
    fixture.detectChanges();
    // "All Of Them" has all 40.
    expect(root.getAttribute('data-m7')).toBe('two');
    el.querySelector<HTMLButtonElement>('[data-testid="product-hero-wheel-next"]')!.click();
    fixture.detectChanges();
    // "Field" has 5: one ring, at the same tile size.
    expect(root.getAttribute('data-m7')).toBe('one');
    expect(labels(el)).toEqual(['P00', 'P01', 'P02', 'P03', 'P04']);
    expect(el.querySelector('[data-testid="product-hero-wheel-live"]')!.textContent!.trim()).toBe(
      'Field, 5 products. 3 of 3.',
    );
    // The next step wraps to "All integrations".
    el.querySelector<HTMLButtonElement>('[data-testid="product-hero-wheel-next"]')!.click();
    fixture.detectChanges();
    expect(root.getAttribute('data-slide')).toBe('0');
    // Back wraps the other way.
    el.querySelector<HTMLButtonElement>('[data-testid="product-hero-wheel-prev"]')!.click();
    fixture.detectChanges();
    expect(root.getAttribute('data-slide')).toBe('2');
  });

  it('the title opens a flat A to Z list that jumps to a slide', async () => {
    const { fixture, el, root } = await live(
      buildProduct({ integrations_as_source: partners(10, 2) }),
    );
    const title = el.querySelector<HTMLButtonElement>('[data-testid="product-hero-wheel-title"]')!;
    const list = el.querySelector<HTMLElement>('[data-testid="product-hero-wheel-list"]')!;
    expect(list.hidden).toBe(true);
    title.click();
    fixture.detectChanges();
    expect(title.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    const options = [...list.querySelectorAll('button')];
    expect(options.map((b) => b.firstElementChild!.textContent)).toEqual([
      'All integrations',
      'All Of Them',
      'Field',
    ]);
    expect(options[0]!.getAttribute('aria-current')).toBe('true');
    options[2]!.click();
    fixture.detectChanges();
    expect(list.hidden).toBe(true);
    expect(root.getAttribute('data-slide')).toBe('2');
    expect(title.textContent).toContain('2 products');
  });

  it('arrow keys, Home and End move within the ring, wrapping', async () => {
    const { fixture, el } = await live(buildProduct({ integrations_as_source: partners(4) }));
    const press = (key: string) => {
      const current = tiles(el).find((a) => a.getAttribute('tabindex') === '0')!;
      current.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      fixture.detectChanges();
      return tiles(el).findIndex((a) => a.getAttribute('tabindex') === '0');
    };
    expect(press('ArrowRight')).toBe(1);
    expect(press('ArrowDown')).toBe(2);
    expect(press('End')).toBe(3);
    expect(press('ArrowRight')).toBe(0);
    expect(press('ArrowLeft')).toBe(3);
    expect(press('Home')).toBe(0);
    expect(press('ArrowUp')).toBe(3);
  });

  it('the card on focus: logo, name and vendor, and "Unclaimed" only for an unclaimed listing', async () => {
    const rows = [edge(link('aa', 'Alpha'), []), edge(link('bb', 'Beta'), [])];
    const marks: WheelMark[] = [
      {
        product_id: rows[0]!.target.id,
        logo_url: 'https://cdn.example/a.png',
        claim_status: 'unclaimed',
      },
      { product_id: rows[1]!.target.id, logo_url: null, claim_status: 'claimed' },
    ];
    const { fixture, el } = await live(
      buildProduct({ integrations_as_source: rows, wheel_marks: marks }),
    );
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const open = async (i: number) => {
      tiles(el)[i]!.dispatchEvent(new FocusEvent('focus'));
      fixture.detectChanges();
      await fixture.whenStable();
      return overlay.querySelector<HTMLElement>('[data-testid="product-hero-wheel-card"]')!;
    };
    const card = await open(0);
    expect(card.getAttribute('role')).toBe('tooltip');
    expect(card.textContent!.replace(/\s+/g, ' ').trim()).toBe('Alpha, Unclaimed by Alpha Inc');
    expect(card.querySelector('img')!.getAttribute('src')).toContain('a.png');
    expect(tiles(el)[0]!.getAttribute('aria-describedby')).toBe('aec-wheel-card');
    const claimed = await open(1);
    expect(claimed.querySelector('[data-testid="product-hero-wheel-card-unclaimed"]')).toBeNull();
    expect(claimed.textContent).toContain('by Beta Inc');
    // Escape closes it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(overlay.querySelector('[data-testid="product-hero-wheel-card"]')).toBeNull();
  });
});

describe('ProductIntegrationWheel: a card opened by a touch hold (WCAG 1.4.13)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    seq = 0;
  });
  afterEach(() => TestBed.inject(OverlayContainer).ngOnDestroy());

  async function hold(fixture: ReturnType<typeof setup>['fixture'], tile: HTMLElement) {
    tile.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    fixture.detectChanges();
    await fixture.whenStable();
  }
  const card = () =>
    TestBed.inject(OverlayContainer)
      .getContainerElement()
      .querySelector('[data-testid="product-hero-wheel-card"]');

  it('opens after 450ms, does not follow the link, and closes on a press elsewhere', async () => {
    const { fixture, el } = setup(buildProduct({ integrations_as_source: partners(4) }));
    await hold(fixture, tiles(el)[1]!);
    expect(card()).not.toBeNull();
    // The release's click does not navigate.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    tiles(el)[1]!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    // A press outside the card and its tile closes it.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(card()).toBeNull();
  });

  it('a key after a hold ends it, so an Enter with no click before it is not swallowed', async () => {
    const { fixture, el } = setup(buildProduct({ integrations_as_source: partners(4) }));
    await hold(fixture, tiles(el)[0]!);
    expect(card()).not.toBeNull();
    // Android often fires no click after a long press, so `held` is still set here.
    tiles(el)[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
    const spy = vi.spyOn(click, 'stopImmediatePropagation');
    tiles(el)[0]!.dispatchEvent(click);
    expect(spy).not.toHaveBeenCalled();
  });

  it('closes on a resize', async () => {
    const { fixture, el } = setup(buildProduct({ integrations_as_source: partners(4) }));
    await hold(fixture, tiles(el)[0]!);
    expect(card()).not.toBeNull();
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(card()).toBeNull();
  });

  it('closes on a scroll, and a later mouse click is not swallowed', async () => {
    const { fixture, el } = setup(buildProduct({ integrations_as_source: partners(4) }));
    await hold(fixture, tiles(el)[0]!);
    expect(card()).not.toBeNull();
    window.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(card()).toBeNull();
    // A mouse press resets the hold, so its click is not cancelled by the wheel. (A
    // middle-button click, so the test bed's router does not navigate.)
    tiles(el)[0]!.dispatchEvent(
      new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }),
    );
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
    const spy = vi.spyOn(click, 'stopImmediatePropagation');
    tiles(el)[0]!.dispatchEvent(click);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ProductHero: the panel holds the wheel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function hero(product: ProductDetail) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Analytics, useValue: { capture: vi.fn(), track: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(ProductHero);
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the wheel in the hero panel, and no category hub or pair finder', () => {
    const el = hero(buildProduct({ integrations_as_source: partners(3) }));
    expect(el.querySelector('.aec-hero-panel [data-testid="product-hero-wheel"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="product-category-hub"]')).toBeNull();
    expect(el.querySelector('[data-testid="product-pair-finder"]')).toBeNull();
  });

  it('with no integration on record there is no wheel and no panel', () => {
    const el = hero(buildProduct());
    expect(el.querySelector('[data-testid="product-hero-wheel"]')).toBeNull();
    expect(el.querySelector('[data-testid="product-hero-visual"]')).toBeNull();
  });

  it('a pure connector, with only the pairs it powers, has no wheel and no panel', () => {
    const powered = {
      ...partners(1)[0]!,
      source: link('aa', 'Alpha'),
      target: link('bb', 'Beta'),
    } as unknown as ProductDetail['integrations_as_connector'][number];
    const el = hero(
      buildProduct({ product_role: 'connector', integrations_as_connector: [powered] }),
    );
    expect(el.querySelector('[data-testid="product-hero-wheel"]')).toBeNull();
    expect(el.querySelector('[data-testid="product-hero-visual"]')).toBeNull();
  });
});
