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
 */

import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';
import { TaxonomyIndexPage } from '../taxonomy/taxonomy-index';

import { INTEGRATIONS_ABOVE_FOLD } from './connector-lane-grouping';
import { ProductIntegrationsSection } from './product-integrations-section';

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
  const button = [...root.querySelectorAll('fieldset button')].find(
    (b) => b.textContent?.trim() === 'Products',
  );
  if (!button) throw new Error('no "Products" sort button');
  (button as HTMLButtonElement).click();
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

/** The partner each rendered row links to, in render order; optionally after typing a query. */
function renderedRows(rows: ProductIntegrationItem[], query?: string): string[] {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.asSource.set(rows);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  if (query !== undefined) {
    const input = el.querySelector<HTMLInputElement>('input#integrations-filter')!;
    input.value = query;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }
  return [...el.querySelectorAll('tr[aec-product-integration-row]')].map((tr) => {
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
      // No filter selected: every row renders, up to the @defer cut. Nothing is held back.
      expect(base).toHaveLength(Math.min(rows.length, INTEGRATIONS_ABOVE_FOLD));
      expect(base).not.toContain('?');

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
