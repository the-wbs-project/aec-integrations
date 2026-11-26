/**
 * The on-page ordering firewall, component half (AECI-1814, `STAGE_2_PAID_TIERS_SPEC.md`
 * §3.2 assertion 8).
 *
 * Two orders live inside components, so they are tested by rendering them:
 *
 *  - The taxonomy index's "Most products" sort (`TaxonomyIndexPage`), part of the
 *    accepted exception `taxonomy-term-product-count`. Its declared inputs are
 *    `product_count`, the term's integration count, then the name. The fixture ties on
 *    all three, and every other field is set rising and falling: a tie-break on any
 *    other field moves the order in one direction or the other.
 *  - The product page Integrations section (`ProductIntegrationsSection`). The rendered
 *    row order and row set must not move when any paid input changes. With no filter
 *    selected every row renders (up to the 20-row `@defer` cut): a default filter on a
 *    paid input is placement. A filter the reader types is allowed, and is checked to
 *    keep the same rows whatever the paid inputs.
 *  - The product page Similar products section (`ProductSimilarProducts`, AECI-1785).
 *    The API orders `related_products` A to Z by name, id breaking a tie (R1). The
 *    section must render that order and every row, whatever the paid inputs.
 */

import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  CategoriesListResponse,
  ProductIntegrationItem,
  ProductLink,
  ProductListItem,
  TaxonomyTermWithCount,
} from '@aeci/shared';

import { ListingSortSelect } from '../shared/listing-toolbar/listing-sort-select';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';
import { TaxonomyIndexPage } from '../taxonomy/taxonomy-index';

import { INTEGRATIONS_ABOVE_FOLD } from './connector-lane-grouping';
import { ProductIntegrationsSection } from './product-integrations-section';
import { ProductSimilarProducts } from './product-similar-products';

type Direction = 'rising' | 'falling';
const DIRECTIONS = ['rising', 'falling'] as const;
const levelOf = (i: number, n: number, dir: Direction) => (dir === 'rising' ? i : n - 1 - i);

// ─── The taxonomy index "Most products" sort ──────────────────────────────────

function mountIndex(kind: TaxonomyKind, terms: CategoriesListResponse) {
  const data = { kind, terms };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data }, data: of(data) } },
    ],
  });
  const fixture = TestBed.createComponent(TaxonomyIndexPage);
  fixture.detectChanges();
  return fixture;
}

/** The rendered order after choosing "Products", as positions in the input list. */
function productsOrder(kind: TaxonomyKind, terms: TaxonomyTermWithCount[]): number[] {
  const fixture = mountIndex(kind, { data: terms });
  const root = fixture.nativeElement as HTMLElement;
  // The shared sort control (AECI-1795) hands its choice back on `sortChange`.
  const select = fixture.debugElement.query(By.directive(ListingSortSelect));
  if (!select) throw new Error('no sort control');
  const control = select.componentInstance as ListingSortSelect;
  if (!control.options().some((o) => o.value === 'products' && o.label === 'Products')) {
    throw new Error('no "Products" sort option');
  }
  control.sortChange.emit('products');
  fixture.detectChanges();
  return [...root.querySelectorAll('ul > li a')].map((a) => {
    const href = a.getAttribute('href') ?? '';
    return terms.findIndex((t) => href.endsWith(`/${t.slug}`));
  });
}

const term = (name: string, products: number, integrations: number, i: number) =>
  ({
    id: `id-${i}`,
    slug: `term-${i}`,
    name,
    description: null,
    display_order: i,
    product_count: products,
    integration_count: integrations,
  }) satisfies TaxonomyTermWithCount;

/**
 * Ties at every declared level. Three terms share count 4 and integrations 2, and two
 * of them share the name "Delta" too, so only the input order separates them.
 */
function terms(): TaxonomyTermWithCount[] {
  return [
    term('Zulu', 4, 2, 0),
    term('Delta', 4, 2, 1),
    term('Echo', 4, 8, 2),
    term('Mike', 9, 0, 3),
    term('Delta', 4, 2, 4),
    term('Bravo', 1, 0, 5),
    term('Alpha', 4, 2, 6),
  ];
}

/** Every field but the three declared inputs, set by position. Descriptions vary in
 *  length and in letter, in opposite senses, so a length or a text tie-break both move. */
function flipTerms(list: TaxonomyTermWithCount[], dir: Direction): TaxonomyTermWithCount[] {
  return list.map((t, i) => {
    const level = levelOf(i, list.length, dir);
    return {
      ...t,
      id: `id-flipped-${level}`,
      slug: `flipped-${level}`,
      description: `${'more '.repeat(level)}${String.fromCharCode(90 - level)} described`,
      display_order: level,
    };
  });
}

describe('on-page ordering firewall: the taxonomy index "Most products" sort', () => {
  beforeEach(() => TestBed.resetTestingModule());

  for (const kind of ['audience', 'phase', 'trade'] as const) {
    it(`[surface:taxonomy-term-product-count] ${kind}: orders by count, integrations, then name, and nothing else`, () => {
      const base = productsOrder(kind, terms());
      // Mike 9; Echo 4/8; then the 4/2 tie by name: Alpha, Delta, Delta, Zulu; Bravo 1.
      expect(base).toEqual([3, 2, 6, 1, 4, 0, 5]);
      for (const dir of DIRECTIONS) {
        TestBed.resetTestingModule();
        expect(productsOrder(kind, flipTerms(terms(), dir)), dir).toEqual(base);
      }
    });
  }
});

// ─── The product page Integrations section, rendered ──────────────────────────

const link = (slug: string, name: string): ProductLink => ({
  id: `p-${slug}`,
  slug,
  name,
  logo_url: null,
});
const PAGE = link('procore', 'Procore');
const AGAVE = link('agave-erp-sync', 'Agave ERP Sync');
const KROO = link('kroo-connector', 'Kroo Connector');

let seq = 0;
function edge(partner: ProductLink, extra: Partial<ProductIntegrationItem> = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name: `Procore to ${partner.name}`,
    mechanism_kind: 'native',
    mechanism_name: null,
    direction: 'a_to_b',
    context_direction: null,
    source: PAGE,
    target: partner,
    via: null,
    powered_by_product: null,
    data_object_slugs: [],
    data_objects: [],
    partner_categories: [],
    agreement: null,
    caption: null,
    corrections: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  } satisfies ProductIntegrationItem;
}

/** Direct partners named out of order, with case and a tie, plus two Via groups. */
function sectionFixture(directCount: number): ProductIntegrationItem[] {
  seq = 0;
  const rows: ProductIntegrationItem[] = [];
  for (let i = 0; i < directCount; i++) {
    const n = (i * 7) % directCount;
    const name = `${n % 2 === 0 ? 'Partner' : 'partner'} ${String(Math.floor(n / 2)).padStart(2, '0')}`;
    rows.push(edge(link(`partner-${i}`, name)));
  }
  rows.push(edge(link('sage', 'Sage'), { via: AGAVE, mechanism_kind: null }));
  rows.push(edge(link('xero', 'Xero'), { via: AGAVE, mechanism_kind: null }));
  rows.push(edge(link('vista', 'Vista'), { via: KROO, mechanism_kind: null }));
  return rows;
}

/** Every paid input on a row at `level`, 0 being none. */
function paid(row: ProductIntegrationItem, level: number): ProductIntegrationItem {
  const objects = Array.from({ length: level }, (_, i) => `object-${level}-${i}`);
  return {
    ...row,
    data_object_slugs: objects,
    data_objects: objects.map((slug) => ({ slug, name: slug })),
    partner_categories: objects.map((slug) => ({ slug, name: slug })),
    agreement:
      level === 0
        ? null
        : level >= 9
          ? 'confirmed'
          : (['unverified', 'single_source', 'confirmed', 'conflict'] as const)[level % 4]!,
    caption:
      level === 0
        ? null
        : { form: 'updated', vendor_names: [`Vendor ${level}`], date: '2026-11-10' },
    corrections: [],
    updated_at: `2026-${String((level % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`,
  };
}

@Component({
  imports: [ProductIntegrationsSection],
  template: `
    <section
      aec-product-integrations-section
      id="integrations"
      aria-labelledby="integrations-title"
      slug="procore"
      [asSource]="asSource()"
      [asTarget]="asTarget()"
      [reachableCount]="0"
      productName="Procore"
      [hosts]="hosts()"
    ></section>
  `,
})
class Host {
  asSource = signal<readonly ProductIntegrationItem[]>([]);
  asTarget = signal<readonly ProductIntegrationItem[]>([]);
  hosts = signal<readonly ProductListItem[]>([]);
}

/** What the reader did before the rows are read (AECI-1782). */
interface ReaderChoices {
  readonly query?: string;
  /** The default is cards, as the server renders it. */
  readonly view?: 'cards' | 'table';
  /** Visible chip text to press, in the direction or category group. */
  readonly chips?: readonly string[];
}

function pressChip(el: HTMLElement, text: string): void {
  const chip = [...el.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!chip) throw new Error(`no filter chip "${text}"`);
  chip.click();
}

/** The partner each rendered row links to, in render order, after the reader's choices. */
function renderedRows(
  rows: ProductIntegrationItem[],
  choices: ReaderChoices | string = {},
): string[] {
  const {
    query,
    view = 'cards',
    chips = [],
  } = typeof choices === 'string' ? { query: choices } : choices;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.asSource.set(rows);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  if (view === 'table') {
    const button = [
      ...el.querySelectorAll<HTMLButtonElement>('aec-listing-view-toggle button'),
    ].find((b) => b.textContent?.includes('Table'))!;
    button.click();
    fixture.detectChanges();
  }
  if (query !== undefined) {
    const input = el.querySelector<HTMLInputElement>('input#integrations-filter')!;
    input.value = query;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }
  for (const chip of chips) {
    pressChip(el, chip);
    fixture.detectChanges();
  }
  const selector =
    view === 'table' ? 'tr[aec-product-integration-row]' : 'li[aec-product-integration-card]';
  return [...el.querySelectorAll(selector)].map((tr) => {
    const a = [...tr.querySelectorAll('a')].find((x) =>
      /^\/products\/[^/]+$/.test(x.getAttribute('href') ?? ''),
    );
    return a?.getAttribute('href') ?? '?';
  });
}

describe('on-page ordering firewall: the product page Integrations section, rendered', () => {
  for (const size of [12, 26] as const) {
    it(`[surface:product-integrations-above-fold] ${size} direct rows: the rendered rows and their order ignore every paid input`, () => {
      const rows = sectionFixture(size);
      const base = renderedRows(rows);
      // No filter selected: every row renders. The card view has no @defer cut since
      // AECI-1891. The table keeps it, and its eager rows are the same head, in order.
      expect(base).toHaveLength(rows.length);
      expect(base).not.toContain('?');
      const table = renderedRows(rows, { view: 'table' });
      expect(table).toEqual(base.slice(0, Math.min(rows.length, INTEGRATIONS_ABOVE_FOLD)));

      for (const dir of DIRECTIONS) {
        const flipped = rows.map((r, i) => paid(r, levelOf(i, rows.length, dir)));
        expect(renderedRows(flipped), dir).toEqual(base);
      }
      for (let i = 0; i < rows.length; i += 3) {
        const loaded = rows.map((r, j) => paid(r, j === i ? 9 : 0));
        expect(renderedRows(loaded), `row ${i} loaded`).toEqual(base);
      }
    });
  }

  it('[surface:product-integrations-direct-lane] a filter the reader types keeps the same rows whatever the paid inputs', () => {
    const rows = sectionFixture(12);
    const base = renderedRows(rows, 'partner 0');
    expect(base.length).toBeGreaterThan(1);
    for (const dir of DIRECTIONS) {
      const flipped = rows.map((r, i) => paid(r, levelOf(i, rows.length, dir)));
      expect(renderedRows(flipped, 'partner 0'), dir).toEqual(base);
    }
  });
});

// ─── AECI-1782: the redesigned section (cards, table, filter panel) ───────────

/**
 * Only the inputs a paid plan can change, at `level`: the data objects (adding a
 * flow needs `attestation.author`), "confirmed by both companies", and the edit
 * stamps. The direction and the partner categories stay as the fixture set them,
 * because they are what the reader filters on.
 */
function paidOnly(row: ProductIntegrationItem, level: number): ProductIntegrationItem {
  const { partner_categories, context_direction } = row;
  return { ...paid(row, level), partner_categories, context_direction };
}

const ACCOUNTING = { slug: 'accounting', name: 'Accounting' };
const FIELD = { slug: 'field-management', name: 'Field management' };

/**
 * Real ties: two partners share a name and two share a name and an edge name, so
 * the id decides. Directions and categories are spread so each chip keeps several
 * rows, and a Via group gives the lane cards.
 */
function redesignFixture(): ProductIntegrationItem[] {
  seq = 0;
  const twinA = link('twin-a', 'Twin Co');
  const twinB = link('twin-b', 'Twin Co');
  const spec: [ProductLink, ProductIntegrationItem['context_direction'], (typeof ACCOUNTING)[]][] =
    [
      [link('zeta', 'Zeta ERP'), 'outbound', [ACCOUNTING]],
      [twinB, 'outbound', [ACCOUNTING]],
      [link('alpha', 'alpha docs'), 'inbound', [FIELD]],
      [twinA, 'outbound', [ACCOUNTING, FIELD]],
      [link('mid', 'Mid Field'), 'both', []],
      [link('mid-2', 'Mid Field'), 'outbound', [FIELD]],
      [link('quick', 'QuickBooks'), null, [ACCOUNTING]],
    ];
  const rows = spec.map(([partner, context_direction, partner_categories]) =>
    edge(partner, { context_direction, partner_categories, name: 'Shared edge name' }),
  );
  rows.push(
    edge(link('sage', 'Sage'), {
      via: AGAVE,
      mechanism_kind: null,
      context_direction: 'outbound',
      partner_categories: [ACCOUNTING],
    }),
  );
  return rows;
}

describe('on-page ordering firewall: the redesigned product page Integrations section (AECI-1782)', () => {
  const cases: [string, ReaderChoices][] = [
    ['cards, no filter', {}],
    ['table, no filter', { view: 'table' }],
    ['cards, Procore sends', { chips: ['Procore sends'] }],
    ['table, Accounting', { view: 'table', chips: ['Accounting'] }],
    [
      'cards, Procore sends and Accounting and a query',
      { query: 'co', chips: ['Procore sends', 'Accounting'] },
    ],
  ];

  for (const [label, choices] of cases) {
    it(`[surface:product-page-integrations-redesign] ${label}: the same rows in the same order whatever the paid inputs`, () => {
      const rows = redesignFixture();
      const base = renderedRows(rows, choices);
      expect(base.length).toBeGreaterThan(1);
      expect(base).not.toContain('?');
      for (const dir of DIRECTIONS) {
        const flipped = rows.map((r, i) => paidOnly(r, levelOf(i, rows.length, dir)));
        expect(renderedRows(flipped, choices), `${label} ${dir}`).toEqual(base);
      }
      for (let i = 0; i < rows.length; i++) {
        const loaded = rows.map((r, j) => paidOnly(r, j === i ? 9 : 0));
        expect(renderedRows(loaded, choices), `${label} row ${i} loaded`).toEqual(base);
      }
    });
  }

  it('[surface:product-page-integrations-redesign] no filter: every row renders, A to Z by partner name, id last; the Via lane after', () => {
    const rows = redesignFixture();
    const cards = renderedRows(rows);
    expect(cards).toEqual(renderedRows(rows, { view: 'table' }));
    expect(cards).toHaveLength(rows.length);
    // alpha docs, Mid Field x2 (id order), QuickBooks, Twin Co x2 (id order), Zeta ERP, then Via Agave: Sage.
    expect(cards).toEqual([
      '/products/alpha',
      '/products/mid',
      '/products/mid-2',
      '/products/quick',
      '/products/twin-b',
      '/products/twin-a',
      '/products/zeta',
      '/products/sage',
    ]);
  });

  it('[surface:product-page-integrations-redesign] the panel offers no control on the agreement state and no sort', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.asSource.set(
      redesignFixture().map((r, i) => paidOnly(r, i % 2 === 0 ? 9 : 1)),
    );
    fixture.detectChanges();
    const panel = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="integrations-filter-panel"]',
    )!;
    const controls = [...panel.querySelectorAll('button, select, [role="combobox"]')].map(
      (b) => b.textContent?.trim() ?? '',
    );
    expect(controls.some((t) => /confirm|compan|agree|sort|evidence/i.test(t))).toBe(false);
    expect(panel.querySelector('select, [role="combobox"]')).toBeNull();
  });
});

// ─── The product page Similar products section, rendered ──────────────────────

/**
 * Six related products as the API sends them: A to Z by name, with a real tie
 * ("delta" and "Delta" fold to one name, id decides). Every other field is a
 * payload field that a plan can reach or that a sort could be tempted to read.
 */
function similarFixture(): ProductListItem[] {
  const names = ['Alpha', 'bravo', 'delta', 'Delta', 'Echo', 'foxtrot'];
  return names.map((name, i) => ({
    id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
    slug: `similar-${i}`,
    name,
    logo_url: null,
    product_role: 'application',
    connector_kind: null,
    vendor: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }));
}

/** Every non-order field of one card, raised to `level`. Name and id stay. */
function paidCard(item: ProductListItem, level: number): ProductListItem {
  return {
    ...item,
    logo_url: level === 0 ? null : `https://cdn.example.com/logo-${level}.png`,
    product_role: level % 3 === 0 ? 'application' : level % 3 === 1 ? 'connector' : 'hybrid',
    connector_kind: null,
    vendor:
      level === 0
        ? null
        : { id: `v-${level}`, slug: `vendor-${level}`, name: `Vendor ${level}`, logo_url: null },
    integration_count: level * 40,
    review_count: level * 7,
    rating_overall_avg: level === 0 ? null : 1 + (level % 4),
    rating_onboarding_avg: level === 0 ? null : 1 + ((level + 2) % 4),
    created_at: `2026-${String((level % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`,
    updated_at: `2026-${String(((level + 5) % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`,
  };
}

@Component({
  imports: [ProductSimilarProducts],
  template: `
    <section
      aec-product-similar-products
      id="similar"
      aria-labelledby="similar-title"
      productName="Procore"
      [products]="products()"
    ></section>
  `,
})
class SimilarHost {
  products = signal<readonly ProductListItem[]>([]);
}

/** The product each rendered card links to, in render order. */
function renderedSimilar(items: readonly ProductListItem[]): string[] {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(SimilarHost);
  fixture.componentInstance.products.set(items);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return [...el.querySelectorAll('#similar li a')].map((a) => a.getAttribute('href') ?? '?');
}

describe('on-page ordering firewall: the product page Similar products section, rendered', () => {
  const items = similarFixture();
  const apiOrder = items.map((p) => `/products/${p.slug}`);

  it('[surface:product-page-similar-products] renders every row in the API order, the tie included', () => {
    expect(renderedSimilar(items)).toEqual(apiOrder);
  });

  for (const dir of DIRECTIONS) {
    it(`[surface:product-page-similar-products] the rows and their order ignore every paid input (${dir})`, () => {
      const flipped = items.map((p, i) => paidCard(p, levelOf(i, items.length, dir) + 1));
      expect(renderedSimilar(flipped)).toEqual(apiOrder);
    });
  }

  it('[surface:product-page-similar-products] loading every paid input onto one card moves nothing', () => {
    for (let i = 0; i < items.length; i++) {
      const loaded = items.map((p, j) => paidCard(p, j === i ? 9 : 0));
      expect(renderedSimilar(loaded), `card ${i} loaded`).toEqual(apiOrder);
    }
  });

  it('sees a move when the API order changes (the comparison is not vacuous)', () => {
    expect(renderedSimilar([...items].reverse())).toEqual([...apiOrder].reverse());
  });
});
