/**
 * `ProductIntegrationsSection` — the endpoint `#integrations` section.
 *
 * Named `.component.spec.ts` so it runs under `ng test` rather than the
 * node-only Vitest pass that excludes Angular DI (`apps/web/vitest.config.ts`).
 *
 * Scope is AECI-841's two additions — the collapsible lane cards and the name
 * filter — plus the invariants they could quietly break. The lane split itself
 * (§13.2 / §13.3) is covered by `connector-lane-grouping.spec.ts` and by the
 * page-level `product-detail.component.spec.ts`; nothing is duplicated here.
 */
import { Component, signal } from '@angular/core';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductIntegrationItem, ProductLink, ProductListItem } from '@aeci/shared';

import { ProductIntegrationsSection } from './product-integrations-section';

const link = (slug: string, name: string): ProductLink => ({
  id: 'p-' + slug,
  slug,
  name,
  logo_url: null,
});

const PAGE = link('procore', 'Procore');
const AGAVE = link('agave-erp-sync', 'Agave ERP Sync');

let seq = 0;

function edge(
  partner: ProductLink,
  overrides: Partial<ProductIntegrationItem> = {},
): ProductIntegrationItem {
  seq += 1;
  return {
    id: '00000000-0000-4000-8000-0000000' + String(seq).padStart(5, '0'),
    name: 'Procore to ' + partner.name,
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
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
      [reachableCount]="reachableCount()"
      productName="Enscape"
      [hosts]="hosts()"
    ></section>
  `,
})
class Host {
  asSource = signal<readonly ProductIntegrationItem[]>([]);
  asTarget = signal<readonly ProductIntegrationItem[]>([]);
  reachableCount = signal(0);
  hosts = signal<readonly ProductListItem[]>([]);
}

function setup(
  asSource: readonly ProductIntegrationItem[],
  reachableCount = 0,
  hosts: readonly ProductListItem[] = [],
) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.asSource.set(asSource);
  fixture.componentInstance.reachableCount.set(reachableCount);
  fixture.componentInstance.hosts.set(hosts);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const filterInput = (el: HTMLElement) =>
  el.querySelector<HTMLInputElement>('input#integrations-filter');

function type(fixture: { detectChanges: () => void }, input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

/** Rendered integrations, cards or table rows, excluding the `@defer` placeholder. */
const rowCount = (el: HTMLElement) =>
  el.querySelectorAll('tr[aec-product-integration-row], li[aec-product-integration-card]').length;

/** Press the Cards/Table toggle's "Table" button (AECI-1782: cards are the default). */
function showTable(fixture: { detectChanges: () => void }, el: HTMLElement) {
  [...el.querySelectorAll<HTMLButtonElement>('aec-listing-view-toggle button')]
    .find((b) => b.textContent?.includes('Table'))!
    .click();
  fixture.detectChanges();
}

/** Press a filter chip by its visible text. */
function pressChip(fixture: { detectChanges: () => void }, el: HTMLElement, text: string) {
  const chip = [
    ...el.querySelectorAll<HTMLButtonElement>(
      '[data-testid="integrations-filter-panel"] button[aria-pressed]',
    ),
  ].find((b) => b.textContent?.includes(text));
  if (!chip) throw new Error(`no chip "${text}"`);
  chip.click();
  fixture.detectChanges();
}

/** Nine partners, alphabetical, plus whatever the caller adds. */
const NINE = [
  'Acumatica',
  'Bluebeam',
  'CMiC',
  'Deltek',
  'eSUB Cloud',
  'Fieldwire',
  'Gantt Pro',
  'HeavyBid',
  'iSqFt',
].map((name) => edge(link(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name)));

// AECI-853. These two numbers are a lockstep pair with DetailLayout's dock
// breakpoint, and nothing else couples them: the layout docks the metadata
// sidebar at `lg`, which leaves the body column 608px wide, and a table whose
// min-width exceeds that does not wrap -- it overflows its own overflow-x-auto
// wrapper and scrolls inside a narrow well. Raising the floor back toward the
// pre-853 44rem re-breaks the dock with no other failing test, which is exactly
// why this asserts the class rather than trusting review.
describe('ProductIntegrationsSection table shape', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('keeps every lane table at or under the 38rem the lg dock allows', () => {
    const { fixture, el } = setup([edge(link('acumatica', 'Acumatica'))]);
    showTable(fixture, el);
    const tables = [...el.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect([...t.classList]).toContain('md:min-w-[34rem]');
      expect([...t.classList].some((c) => /min-w-\[(3[89]|[4-9]\d)rem\]/.test(c))).toBe(false);
    }
  });

  it('renders two content columns and the trailing arrow, with Direction folded away', () => {
    const { fixture, el } = setup([edge(link('acumatica', 'Acumatica'))]);
    showTable(fixture, el);
    const headers = [...el.querySelectorAll('thead th')].map((h) => h.textContent?.trim());
    expect(headers).toEqual(['Integrates with', 'Connection', 'Details']);
  });
});

describe('ProductIntegrationsSection filter box', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // There is no row threshold: a section with rows has a filter. This section
  // and #powered-integrations sit next to each other on a connector page, and
  // the same control over one and not the other reads as a bug.
  it('is present on a short section', () => {
    const { el } = setup([edge(link('acumatica', 'Acumatica'))]);
    expect(rowCount(el)).toBe(1);
    expect(filterInput(el)).not.toBeNull();
  });

  it('is present on a long one', () => {
    const { el } = setup([...NINE, edge(link('sage-300-cre', 'Sage 300 CRE'))]);
    expect(filterInput(el)).not.toBeNull();
  });

  // AECI-1782, ruling R5: integration filters sit in one panel of their own.
  it('sits in its own filter panel under the heading, named "Filters"', () => {
    const { el } = setup([...NINE, edge(link('sage-300-cre', 'Sage 300 CRE'))]);
    const panel = el.querySelector('[data-testid="integrations-filter-panel"]')!;
    expect(panel.querySelector('input#integrations-filter')).not.toBeNull();
    expect(panel.getAttribute('role')).toBe('group');
    expect(el.querySelector('#' + panel.getAttribute('aria-labelledby'))!.textContent).toContain(
      'Filters',
    );
    // The heading comes first in document order, the panel after it.
    const heading = el.querySelector('#integrations-title')!;
    expect(heading.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is absent on an empty section, which has no list to filter', () => {
    const { el } = setup([]);
    expect(filterInput(el)).toBeNull();
    expect(el.textContent).toContain('No integrations recorded yet');
  });

  it('filters rows by partner name and reports the count it kept', () => {
    const { fixture, el } = setup([...NINE, edge(link('sage-300-cre', 'Sage 300 CRE'))]);
    type(fixture, filterInput(el)!, 'sage');

    expect(rowCount(el)).toBe(1);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Showing 1 of 10');
  });

  it('leaves the section heading alone under a filter', () => {
    const { fixture, el } = setup([...NINE, edge(link('sage-300-cre', 'Sage 300 CRE'))]);
    type(fixture, filterInput(el)!, 'sage');

    // The heading carries no count (ruled 2026-11-16).
    expect(el.querySelector('#integrations-title')!.textContent!.trim()).toBe('Integrations');
  });

  it('shows a no-match state rather than an empty section', () => {
    const { fixture, el } = setup([...NINE, edge(link('sage-300-cre', 'Sage 300 CRE'))]);
    type(fixture, filterInput(el)!, 'nothing-matches-this');

    expect(rowCount(el)).toBe(0);
    expect(el.textContent).toContain('No integrations match that search');
  });

  it('matches a connector by name and keeps that whole lane', () => {
    const viaRows = ['Sage 300 CRE', 'Viewpoint Vista'].map((name) =>
      edge(link(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name), { via: AGAVE }),
    );
    const { fixture, el } = setup([...NINE, ...viaRows]);
    type(fixture, filterInput(el)!, 'agave');

    expect(rowCount(el)).toBe(2);
    expect(el.querySelector('#integrations-via-agave-erp-sync')).not.toBeNull();
    expect(el.querySelector('#integrations-direct')).toBeNull();
  });

  it('turns the @defer cut off while a query is active', () => {
    // 25 rows: five sit past the 20-row boundary and ship deferred. A filter
    // that matched one of those five would otherwise find nothing to show.
    const many = Array.from({ length: 25 }, (_, i) =>
      edge(link('partner-' + String(i).padStart(2, '0'), 'Partner ' + String(i).padStart(2, '0'))),
    );
    const { fixture, el } = setup(many);
    // AECI-1783: 25 rows group by category in the card view, so the lane cut is
    // exercised in the table, which keeps it.
    showTable(fixture, el);
    expect(rowCount(el)).toBe(20);

    type(fixture, filterInput(el)!, 'Partner 24');
    expect(rowCount(el)).toBe(1);
  });
});

describe('ProductIntegrationsSection collapsible lanes', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const withLanes = () => [
    edge(link('acumatica', 'Acumatica')),
    edge(link('sage-300-cre', 'Sage 300 CRE'), { via: AGAVE }),
  ];

  it('renders NO lane card on a single-lane page, per §13.3', () => {
    const { fixture, el } = setup([edge(link('acumatica', 'Acumatica'))]);
    expect(el.querySelector('aec-integration-group-card')).toBeNull();
    expect(
      el
        .querySelector('#integrations [data-testid="integration-cards"]')!
        .getAttribute('aria-label'),
    ).toBe('Integrations');
    showTable(fixture, el);
    expect(el.querySelector('#integrations table')!.getAttribute('aria-label')).toBe(
      'Integrations',
    );
  });

  it('opens every lane card by default', () => {
    const { el } = setup(withLanes());
    const buttons = el.querySelectorAll('aec-integration-group-card button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.getAttribute('aria-expanded')).toBe('true');
    }
  });

  it('hides a collapsed lane WITHOUT removing its rows from the document', () => {
    const { fixture, el } = setup(withLanes());
    const button = el.querySelector<HTMLButtonElement>('#integrations-direct button')!;
    button.click();
    fixture.detectChanges();

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('#integrations-direct-panel')!.hasAttribute('hidden')).toBe(true);
    // The crawler invariant: every pair link is still in the HTML.
    expect(el.querySelector('a[href="/products/procore/integrations/acumatica"]')).not.toBeNull();
  });

  it('re-opens a collapsed lane when a query matches inside it', () => {
    const many = [
      ...NINE,
      ...Array.from({ length: 3 }, (_, i) =>
        edge(link('via-' + i, 'Via Partner ' + i), { via: AGAVE }),
      ),
    ];
    const { fixture, el } = setup(many);

    const direct = el.querySelector<HTMLButtonElement>('#integrations-direct button')!;
    direct.click();
    fixture.detectChanges();
    expect(direct.getAttribute('aria-expanded')).toBe('false');

    type(fixture, filterInput(el)!, 'bluebeam');
    expect(el.querySelector('#integrations-direct button')!.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('restores the reader collapsed state when the query is cleared', () => {
    const many = [
      ...NINE,
      ...Array.from({ length: 3 }, (_, i) =>
        edge(link('via-' + i, 'Via Partner ' + i), { via: AGAVE }),
      ),
    ];
    const { fixture, el } = setup(many);

    el.querySelector<HTMLButtonElement>('#integrations-direct button')!.click();
    fixture.detectChanges();

    type(fixture, filterInput(el)!, 'bluebeam');
    type(fixture, filterInput(el)!, '');

    expect(el.querySelector('#integrations-direct button')!.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('names each lane card list by its own card heading', () => {
    const { el } = setup(withLanes());
    const lists = [...el.querySelectorAll('#integrations [data-testid="integration-cards"]')];
    expect(lists.map((l) => l.getAttribute('aria-labelledby'))).toEqual([
      'integrations-direct',
      'integrations-via-agave-erp-sync',
    ]);
    // Cards inside a lane card are h4s under the lane's h3, and take the nested surface.
    expect(el.querySelectorAll('li[aec-product-integration-card] h4')).toHaveLength(2);
    expect(el.querySelectorAll('li[aec-product-integration-card] h3')).toHaveLength(0);
  });

  it('names each lane table by its own card heading', () => {
    const { fixture, el } = setup(withLanes());
    showTable(fixture, el);
    const tables = [...el.querySelectorAll('#integrations table')];
    expect(tables.map((t) => t.getAttribute('aria-labelledby'))).toEqual([
      'integrations-direct',
      'integrations-via-agave-erp-sync',
    ]);
    for (const table of tables) {
      expect(el.querySelector('#' + table.getAttribute('aria-labelledby'))).not.toBeNull();
    }
  });
});

describe('ProductIntegrationsSection cards and the filter panel (AECI-1782)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const ACC = { slug: 'accounting', name: 'Accounting' };
  const FIELD = { slug: 'field-management', name: 'Field management' };

  const rows = () => [
    edge(link('sage', 'Sage'), {
      context_direction: 'outbound',
      partner_categories: [ACC],
      data_objects: [{ slug: 'invoice', name: 'Invoices' }],
      data_object_slugs: ['invoice'],
      agreement: 'single_source',
      mechanism_name: 'Sage REST bridge',
    }),
    edge(link('fieldwire', 'Fieldwire'), {
      context_direction: 'inbound',
      partner_categories: [FIELD],
      agreement: 'confirmed',
    }),
    edge(link('xero', 'Xero'), { context_direction: 'both', partner_categories: [ACC, FIELD] }),
    edge(link('vista', 'Vista'), { context_direction: null }),
  ];

  const cardNames = (el: HTMLElement) =>
    [...el.querySelectorAll('li[aec-product-integration-card] h3')].map((h) =>
      h.textContent?.trim(),
    );

  it('renders cards by default, every row, in the lane order', () => {
    const { el } = setup(rows());
    expect(el.querySelector('table')).toBeNull();
    expect(cardNames(el)).toEqual(['Fieldwire', 'Sage', 'Vista', 'Xero']);
  });

  it('switches to the table and back without changing the rows or their order', () => {
    const { fixture, el } = setup(rows());
    showTable(fixture, el);
    const partners = [...el.querySelectorAll('tr[aec-product-integration-row] td a')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => /^\/products\/[^/]+$/.test(h ?? ''));
    expect(partners).toEqual([
      '/products/fieldwire',
      '/products/sage',
      '/products/vista',
      '/products/xero',
    ]);
    const toggle = [...el.querySelectorAll('aec-listing-view-toggle button')];
    expect(toggle.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('a card carries the partner, its categories, direction, objects, mechanism, agreement and pair link', () => {
    const { el } = setup(rows());
    const sage = [...el.querySelectorAll('li[aec-product-integration-card]')].find((c) =>
      c.textContent?.includes('Sage'),
    )!;
    const text = sage.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('Accounting');
    expect(text).toContain('Direction:');
    expect(text).toContain('Outbound');
    expect(text).toContain('Invoices');
    expect(text).toContain('Sage REST bridge');
    // A single_source row names no vendor (ruling 2026-11-14 on AECI-1781).
    expect(text).toContain('Confirmed by one company');
    expect(sage.querySelector('a[href="/products/sage"]')).not.toBeNull();
    const pair = sage.querySelector('a[href="/products/procore/integrations/sage"]')!;
    expect(pair.getAttribute('aria-label')).toBe('View the Sage integration');
  });

  it('a row with no flow on record shows no agreement badge', () => {
    const { el } = setup(rows());
    const vista = [...el.querySelectorAll('li[aec-product-integration-card]')].find((c) =>
      c.textContent?.includes('Vista'),
    )!;
    expect(vista.querySelector('aec-agreement-badge')).toBeNull();
    expect(vista.textContent).toContain('–');
  });

  it('offers direction chips for the directions present, and categories A to Z', () => {
    const { el } = setup(rows());
    const groups = [
      ...el.querySelectorAll(
        '[data-testid="integrations-filter-panel"] [role="group"][aria-labelledby]',
      ),
    ];
    const chips = (g: Element) =>
      [...g.querySelectorAll('button[aria-pressed]')].map((b) =>
        b.textContent!.replace(/\s+/g, ' ').trim(),
      );
    // AECI-1783: every chip prints how many rows it would show.
    expect(chips(groups[0]!)).toEqual(['→ Outbound 1', '← Inbound 1', '⇄ Both 1']);
    expect(chips(groups[1]!)).toEqual(['Accounting 2', 'Field management 2']);
  });

  it('a direction chip filters, announces the count politely, and the heading count stays', () => {
    const { fixture, el } = setup(rows());
    const status = el.querySelector('[role="status"]')!;
    expect(status.textContent?.trim()).toBe('');
    pressChip(fixture, el, 'Outbound');
    expect(cardNames(el)).toEqual(['Sage']);
    expect(status.textContent).toContain('Showing 1 of 4');
    // The heading carries no count (ruled 2026-11-16).
    expect(el.querySelector('#integrations-title')!.textContent!.trim()).toBe('Integrations');
    const chip = [...el.querySelectorAll('aec-chip button[aria-pressed="true"]')];
    expect(chip).toHaveLength(1);
  });

  it('category chips OR together and AND with direction and the query', () => {
    const { fixture, el } = setup(rows());
    pressChip(fixture, el, 'Accounting');
    expect(cardNames(el)).toEqual(['Sage', 'Xero']);
    pressChip(fixture, el, 'Field management');
    expect(cardNames(el)).toEqual(['Fieldwire', 'Sage', 'Xero']);
    pressChip(fixture, el, 'Both');
    expect(cardNames(el)).toEqual(['Xero']);
    type(fixture, filterInput(el)!, 'sage');
    expect(cardNames(el)).toEqual([]);
    expect(el.textContent).toContain('No integrations match that search');
  });

  it('"Clear filters" shows only while a filter is on and clears every facet and the query', () => {
    const { fixture, el } = setup(rows());
    const clear = () =>
      el.querySelector<HTMLButtonElement>('[data-testid="integrations-filter-clear"]');
    expect(clear()).toBeNull();
    pressChip(fixture, el, 'Accounting');
    type(fixture, filterInput(el)!, 'x');
    expect(clear()).not.toBeNull();
    clear()!.click();
    fixture.detectChanges();
    expect(cardNames(el)).toEqual(['Fieldwire', 'Sage', 'Vista', 'Xero']);
    expect(filterInput(el)!.value).toBe('');
    expect(el.querySelectorAll('aec-chip button[aria-pressed="true"]')).toHaveLength(0);
    expect(clear()).toBeNull();
  });

  it('renders no direction or category group when no row has one', () => {
    const { el } = setup([edge(link('acumatica', 'Acumatica'))]);
    const panel = el.querySelector('[data-testid="integrations-filter-panel"]')!;
    expect(panel.querySelectorAll('[role="group"][aria-labelledby]')).toHaveLength(0);
    expect(panel.textContent).not.toContain('Direction');
  });

  it('turns the @defer cut off under a chip filter, as under a query', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      edge(link('p-' + String(i).padStart(2, '0'), 'Partner ' + String(i).padStart(2, '0')), {
        context_direction: i === 24 ? 'inbound' : 'outbound',
      }),
    );
    const { fixture, el } = setup(many);
    // AECI-1783: the card view groups 25 rows, so the lane cut is checked in the table.
    showTable(fixture, el);
    expect(rowCount(el)).toBe(20);
    pressChip(fixture, el, 'Inbound');
    expect(rowCount(el)).toBe(1);
    expect(el.querySelector('tr[aec-product-integration-row]')!.textContent).toContain(
      'Partner 24',
    );
  });
});

/**
 * §13.7's reach line (AECI-892). Every assertion here is a prohibition the
 * section could violate while still looking right, which is why they are
 * asserted rather than reviewed:
 *
 *  - it must not enter the section row count. §13.5 is categorical that reachable
 *    never counts, and the row count is a number a reader can check;
 *  - it must not be a table row or a card. A "Via {connector}" group that
 *    outlives its own delivered row asserts a delivery the I24 ruling has just
 *    said does not exist;
 *  - it must name no connector;
 *  - it must render on the EMPTY branch, which is the page the AECI-889 sweep
 *    creates and the only reason this work exists.
 */
describe('ProductIntegrationsSection long lists (AECI-1783)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const ACC = { slug: 'accounting', name: 'Accounting' };
  const SCHED = { slug: 'scheduling', name: 'Scheduling' };
  const BIM = { slug: 'bim', name: 'BIM' };

  /** `n` partners, A to Z by name; categories cycle, so some rows carry two and some none. */
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const name = `Partner ${String(i).padStart(2, '0')}`;
      const sets = [[ACC], [SCHED, BIM], [], [BIM], [ACC, SCHED]];
      return edge(link(`partner-${i}`, name), {
        context_direction: i % 2 === 0 ? 'outbound' : 'inbound',
        partner_categories: sets[i % sets.length]!,
      });
    });

  const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
  const groups = (el: HTMLElement) => [
    ...el.querySelectorAll<HTMLElement>('section[aec-product-integration-category-group]'),
  ];
  const railLinks = (el: HTMLElement) => [
    ...el.querySelectorAll<HTMLAnchorElement>('[data-testid="integrations-rail-link"]'),
  ];
  const categoryChips = (el: HTMLElement) => [
    ...el.querySelectorAll<HTMLButtonElement>(
      '[aria-labelledby="integrations-filter-categories"] button[aria-pressed]',
    ),
  ];

  it('a list of 12 renders as before: one list, no rail, no arrangement toggle', () => {
    const { el } = setup(rows(12));
    expect(groups(el)).toHaveLength(0);
    expect(el.querySelector('[data-testid="integrations-rail"]')).toBeNull();
    expect(el.querySelector('aec-integration-arrangement-toggle')).toBeNull();
    expect(el.querySelectorAll('li[aec-product-integration-card]')).toHaveLength(12);
  });

  it('a list of 13 groups A to Z by category, with the uncategorised rows last', () => {
    const { el } = setup(rows(13));
    expect(groups(el).map((g) => text(g.querySelector('h3')!))).toEqual([
      'Accounting',
      'BIM',
      'Scheduling',
      'No category on record',
    ]);
    // Rows keep the lane order inside a group, and the cards are h4 under the group h3.
    const acc = [...groups(el)[0]!.querySelectorAll('li[aec-product-integration-card] h4')];
    const names = acc.map(text);
    expect(names).toEqual([...names].sort());
  });

  it('the rail, the group heading and the chip print the same count for one category', () => {
    const { fixture, el } = setup(rows(58));
    const check = () => {
      for (const group of groups(el)) {
        const name = text(group.querySelector('h3')!);
        const heading = text(
          group.querySelector('[data-testid="integration-category-group-count"] [aria-hidden]')!,
        );
        const rail = railLinks(el).find((a) => text(a).startsWith(name))!;
        const railCount = text(rail.querySelector('[aria-hidden]')!);
        expect(railCount, name).toBe(heading);
        const chip = categoryChips(el).find((b) => text(b).startsWith(name));
        if (chip) {
          expect(text(chip.querySelector('[data-testid="integrations-chip-count"]')!), name).toBe(
            heading,
          );
        }
      }
    };
    check();
    pressChip(fixture, el, 'Inbound');
    check();
    pressChip(fixture, el, 'Scheduling');
    expect(groups(el).map((g) => text(g.querySelector('h3')!))).toEqual(['Scheduling']);
    check();
  });

  it('a closed group shows its first three cards; the rest are in the DOM, hidden until found', () => {
    const { fixture, el } = setup(rows(58));
    const first = groups(el)[0]!;
    const cards = [...first.querySelectorAll('li[aec-product-integration-card]')];
    expect(cards.length).toBeGreaterThan(3);
    expect(cards.slice(0, 3).every((c) => !c.hasAttribute('hidden'))).toBe(true);
    expect(cards.slice(3).every((c) => c.getAttribute('hidden') === 'until-found')).toBe(true);
    // Hidden cards keep their pair-page links in the markup.
    expect(cards[3]!.querySelector('a[href^="/products/procore/integrations/"]')).not.toBeNull();

    const button = first.querySelector<HTMLButtonElement>(
      '[data-testid="integration-category-group-toggle"]',
    )!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(text(button.querySelector(':scope > span:not([aria-hidden])')!)).toBe(
      `Show ${cards.length - 3} more in Accounting`,
    );
    // The stack names the first hidden partners, in row order, with no logo above 32px.
    const stack = [...button.querySelectorAll('aec-logo-or-initial')].map(text);
    expect(stack).toEqual(
      cards.slice(3, 8).map((c) => text(c.querySelector('h4')!).charAt(0).toUpperCase()),
    );
    button.click();
    fixture.detectChanges();
    expect(cards.every((c) => !c.hasAttribute('hidden'))).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(text(button)).toBe('Show fewer');
  });

  it('find-in-page opening a hidden card opens its group', () => {
    const { fixture, el } = setup(rows(58));
    const first = groups(el)[0]!;
    const hidden = first.querySelector('li[aec-product-integration-card][hidden]')!;
    hidden.dispatchEvent(new Event('beforematch'));
    fixture.detectChanges();
    expect(first.querySelectorAll('li[aec-product-integration-card][hidden]')).toHaveLength(0);
  });

  it('a rail link targets its group and moves focus to the group heading', async () => {
    const { fixture, el } = setup(rows(58));
    document.body.appendChild(el);
    const link = railLinks(el)[1]!;
    expect(link.getAttribute('href')).toMatch(/#integrations-cat-bim$/);
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
    await new Promise((r) => setTimeout(r, 10));
    fixture.detectChanges();
    expect(document.activeElement?.id).toBe('integrations-cat-bim-title');
    el.remove();
  });

  it('"One list" shows 12 in lane order, and "Load more" adds 12 without fetching', () => {
    const { fixture, el } = setup(rows(30));
    [...el.querySelectorAll<HTMLButtonElement>('aec-integration-arrangement-toggle button')]
      .find((b) => text(b) === 'One list')!
      .click();
    fixture.detectChanges();
    const list = el.querySelector('aec-product-integration-one-list')!;
    const visible = () =>
      [...list.querySelectorAll(':scope > ul > li')].filter((li) => !li.hasAttribute('hidden'));
    expect(visible().map((li) => text(li.querySelector('h3')!))).toEqual(
      Array.from({ length: 12 }, (_, i) => `Partner ${String(i).padStart(2, '0')}`),
    );
    expect(list.querySelectorAll(':scope > ul > li')).toHaveLength(30);
    expect(text(list.querySelector('[aria-live="polite"]')!)).toBe('Showing 12 of 30');
    list.querySelector<HTMLButtonElement>('[data-testid="integrations-load-more"]')!.click();
    fixture.detectChanges();
    expect(visible()).toHaveLength(24);
    list.querySelector<HTMLButtonElement>('[data-testid="integrations-load-more"]')!.click();
    fixture.detectChanges();
    expect(visible()).toHaveLength(30);
    expect(list.querySelector('[data-testid="integrations-load-bar"]')).toBeNull();
  });

  it('the table view stays one flat table on a long list', () => {
    const { fixture, el } = setup(rows(20));
    showTable(fixture, el);
    expect(groups(el)).toHaveLength(0);
    expect(el.querySelector('aec-integration-arrangement-toggle')).toBeNull();
    expect(el.querySelectorAll('table')).toHaveLength(1);
  });
});

describe('ProductIntegrationsSection reach line (§13.7)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const reachText = (el: HTMLElement) =>
    [...el.querySelectorAll('p')]
      .map((p) => p.textContent ?? '')
      .find((t) => t.includes('reachable'));

  it('renders nothing at zero', () => {
    const { el } = setup([edge(link('acumatica', 'Acumatica'))], 0);
    expect(reachText(el)).toBeUndefined();
  });

  it('renders one line beside a populated section, and says MORE', () => {
    const { el } = setup([edge(link('acumatica', 'Acumatica'))], 12);
    expect(reachText(el)).toContain('12 more pairs reachable via connectors');
  });

  it('drops "more" when the section has no delivered rows', () => {
    // The AECI-889 end state: the only connector-delivered edge was retired, so
    // there is nothing for the reach to be MORE than. "3 more pairs" over an
    // empty-integrations notice contradicts the screen it sits on.
    const { el } = setup([], 3);
    expect(reachText(el)).toContain('3 pairs reachable via connectors');
    expect(reachText(el)).not.toContain('more');
  });

  it('renders a non-zero line with ZERO Via cards — the AECI-892 regression', () => {
    const { el } = setup([], 3);
    expect(el.querySelectorAll('aec-integration-group-card')).toHaveLength(0);
    expect(reachText(el)).toBeDefined();
  });

  it('is singular at one, on both branches', () => {
    expect(reachText(setup([edge(link('acumatica', 'Acumatica'))], 1).el)).toContain(
      '1 more pair reachable via connectors',
    );
    TestBed.resetTestingModule();
    expect(reachText(setup([], 1).el)).toContain('1 pair reachable via connectors');
  });

  it('never moves the section heading', () => {
    const { el } = setup(NINE, 99);
    // The heading carries no count (ruled 2026-11-16).
    expect(el.querySelector('#integrations-title')!.textContent!.trim()).toBe('Integrations');
  });

  // With the heading count gone, the "Showing n of m" total is the section's one row
  // count, so it carries the §13.5 guard the heading test used to (AECI-1783 review).
  it('never moves the "Showing n of m" total', () => {
    const { fixture, el } = setup(NINE, 99);
    type(fixture, filterInput(el)!, 'Bluebeam');
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Showing 1 of 9');
  });

  it('is not a table row and not a card', () => {
    const { el } = setup([edge(link('acumatica', 'Acumatica'))], 5);
    const line = [...el.querySelectorAll('p')].find((p) =>
      (p.textContent ?? '').includes('reachable'),
    )!;
    expect(line.closest('table')).toBeNull();
    expect(line.closest('aec-integration-group-card')).toBeNull();
  });

  it('names no connector and links nowhere', () => {
    // §13.7 sanctions an UNATTRIBUTED line, and the "filtered view" it wants to
    // link does not exist as a route. Naming a connector here is the Via card by
    // another name; linking the curated pair set would make this line inherit
    // everything publication is gated on. Both are deferred to AECI-716.
    const { el } = setup([edge(AGAVE, { via: AGAVE })], 7);
    const line = [...el.querySelectorAll('p')].find((p) =>
      (p.textContent ?? '').includes('reachable'),
    )!;
    expect(line.textContent).not.toContain('Agave');
    expect(line.querySelector('a')).toBeNull();
  });
});

describe('ProductIntegrationsSection empty state on an extension (§13.3b / AECI-710)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const host = (slug: string, name: string): ProductListItem => ({
    ...link(slug, name),
    product_role: 'application',
    vendor: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });

  it('names the host in one sentence and points at Built within', () => {
    const { el } = setup([], 0, [host('revit', 'Revit')]);

    expect(el.textContent).toContain('Enscape runs inside Revit; see Built within.');
    // The existing empty-state copy and its correction link still render.
    expect(el.textContent).toContain('No integrations recorded yet');
  });

  it('joins several hosts as prose', () => {
    const { el } = setup([], 0, [host('revit', 'Revit'), host('forma', 'Forma')]);

    expect(el.textContent).toContain('Enscape runs inside Revit and Forma; see Built within.');
  });

  it('says nothing about a host when the product has none', () => {
    const { el } = setup([]);

    expect(el.textContent).not.toContain('runs inside');
  });

  it('says nothing about a host when the section has rows', () => {
    const { el } = setup([edge(link('navisworks', 'Navisworks'))], 0, [host('revit', 'Revit')]);

    expect(el.textContent).not.toContain('runs inside');
  });
});
