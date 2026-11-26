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
      [poweredPairCount]="poweredPairCount()"
    ></section>
  `,
})
class Host {
  asSource = signal<readonly ProductIntegrationItem[]>([]);
  asTarget = signal<readonly ProductIntegrationItem[]>([]);
  reachableCount = signal(0);
  hosts = signal<readonly ProductListItem[]>([]);
  poweredPairCount = signal(0);
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
    // Two rows: one row has no Cards/Table toggle (AECI-2021).
    const { fixture, el } = setup([
      edge(link('acumatica', 'Acumatica')),
      edge(link('bluebeam', 'Bluebeam')),
    ]);
    showTable(fixture, el);
    const tables = [...el.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect([...t.classList]).toContain('md:min-w-[34rem]');
      expect([...t.classList].some((c) => /min-w-\[(3[89]|[4-9]\d)rem\]/.test(c))).toBe(false);
    }
  });

  it('renders the partner, categories and connection columns and the trailing arrow, with Direction folded away', () => {
    const { fixture, el } = setup([
      edge(link('acumatica', 'Acumatica')),
      edge(link('bluebeam', 'Bluebeam')),
    ]);
    showTable(fixture, el);
    const headers = [...el.querySelectorAll('thead th')].map((h) => h.textContent?.trim());
    // AECI-1720 restored mock-up 6's categories column, shown from lg.
    expect(headers).toEqual(['Integrates with', 'Categories', 'Connection', 'Details']);
    expect(el.querySelectorAll('thead th')[1]!.classList).toContain('lg:table-cell');
  });
});

describe('ProductIntegrationsSection filter box', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // AECI-2021 (ruled 2026-11-23): the search box needs five rows. A shorter list is
  // read at a glance. This reverses AECI-848 for this section only.
  it('is absent under five rows and present at five', () => {
    const { el } = setup(NINE.slice(0, 4));
    expect(rowCount(el)).toBe(4);
    expect(filterInput(el)).toBeNull();
    TestBed.resetTestingModule();
    const five = setup(NINE.slice(0, 5));
    expect(rowCount(five.el)).toBe(5);
    expect(filterInput(five.el)).not.toBeNull();
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
    const { fixture, el } = setup([
      edge(link('acumatica', 'Acumatica')),
      edge(link('bluebeam', 'Bluebeam')),
    ]);
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

  it('draws each card from the integration card recipe (match-card-recipe.ts)', () => {
    const { el } = setup(withLanes());
    const card = el.querySelector(
      'li[aec-product-integration-card] [data-testid="integration-card"]',
    )!;
    // 24px padding, 32px from md, 20px between blocks.
    expect(card.className).toContain('gap-5');
    expect(card.className).toContain('md:p-8');
    // The name at the Title role, on the partner link.
    expect(card.querySelector('.aec-partner-link')!.className).toContain('text-t-24');
    // The recipe's chips, not the dense chip.
    expect(card.querySelector('aec-chip')).toBeNull();
    // AECI-2021: the pair link is a short muted hint with a 16px chevron, no round
    // button. The closest-match card keeps the recipe's foot button.
    const pair = card.querySelector('[data-testid="integration-card-pair-link"]')!;
    expect(pair.classList).toContain('text-t-13');
    expect(pair.classList).toContain('text-(--text-secondary)');
    expect(pair.classList).toContain('whitespace-nowrap');
    expect(pair.classList).toContain('shrink-0');
    expect(card.querySelector('.size-8\\.5')).toBeNull();
    expect(pair.querySelector('aec-icon[data-testid="integration-card-go"]')).not.toBeNull();
    // Both lists use the integration card grid, not the product card grid.
    const lists = [...el.querySelectorAll('#integrations [data-testid="integration-cards"]')];
    for (const list of lists) {
      expect(list.classList).toContain('aec-integration-grid');
      expect(list.classList).not.toContain('aec-card-grid');
    }
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
    // A fifth row, so the search box shows (AECI-2021: five rows or more).
    edge(link('zeta', 'Zeta'), { context_direction: null }),
  ];

  // AECI-2021: a one-lane page's cards are h3 under the section h2.
  const cardNames = (el: HTMLElement) =>
    [...el.querySelectorAll('li[aec-product-integration-card] h3')].map((h) =>
      h.textContent?.trim(),
    );

  it('renders cards by default, every row, in the lane order', () => {
    const { el } = setup(rows());
    expect(el.querySelector('table')).toBeNull();
    expect(cardNames(el)).toEqual(['Fieldwire', 'Sage', 'Vista', 'Xero', 'Zeta']);
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
      '/products/zeta',
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
    expect(text).toContain('Sends to Sage');
    expect(text).not.toContain('Outbound');
    expect(text).toContain('Invoices');
    expect(text).toContain('Sage REST bridge');
    // A single_source row names no vendor (ruling 2026-11-14 on AECI-1781).
    expect(text).toContain('Confirmed by one company');
    expect(sage.querySelector('a[href="/products/sage"]')).not.toBeNull();
    const pair = sage.querySelector('a[href="/products/procore/integrations/sage"]')!;
    // AECI-2021: the visible hint "View details" starts the link's accessible name, and
    // the rest is visually hidden, so the name still says which integration (WCAG 2.5.3).
    // The name comes from the text, with no aria-label to drift from it.
    expect(pair.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'View details for the Sage integration',
    );
    const rest = pair.querySelector('[data-testid="integration-card-pair-link-rest"]')!;
    expect(rest.classList).toContain('sr-only');
    expect(rest.textContent!.trim()).toBe('for the Sage integration');
    expect(pair.textContent!.trim().startsWith('View details')).toBe(true);
    expect(pair.hasAttribute('aria-label')).toBe(false);
    const head = sage.querySelector('[data-testid="integration-card-head"]')!;
    expect(head.contains(pair)).toBe(true);
    expect(head.querySelector('h3 a[href="/products/sage"]')).not.toBeNull();
    // Still stretched over the card, the partner link above it, the chevron kept.
    expect(pair.className).toContain('after:absolute');
    expect(pair.className).toContain('after:inset-0');
    // The name block keeps 12rem with its mark before the hint drops under it.
    expect(head.firstElementChild!.classList).toContain('flex-[1_1_12rem]');
    const partner = sage.querySelector('a[href="/products/sage"]')!;
    expect(partner.classList).toContain('relative');
    expect(partner.classList).toContain('z-10');
    expect(pair.querySelector('aec-icon[data-testid="integration-card-go"]')).not.toBeNull();
    // Nothing follows the blocks at the foot: the pair link is the head's last child.
    // The table row keeps its chevron name "View the {partner} integration".
    expect(head.lastElementChild).toBe(pair);
    // Mock-up 6's labels over the flow and the mechanism.
    expect(text).toContain('What moves');
    expect(text).toContain('How it connects');
  });

  it('a row with no flow on record shows no agreement badge', () => {
    const { el } = setup(rows());
    const vista = [...el.querySelectorAll('li[aec-product-integration-card]')].find((c) =>
      c.textContent?.includes('Vista'),
    )!;
    expect(vista.querySelector('aec-agreement-badge')).toBeNull();
    expect(vista.textContent).toContain('–');
  });

  // AECI-1720: mock-up 6's head, list row and card byline. AECI-2021 removed the list
  // heading: the section h2 heads the list, and the list row keeps the status.
  it('opens with the kicker as a paragraph, and has no list heading of its own', () => {
    const { fixture, el } = setup(rows());
    const kicker = el.querySelector('[data-testid="integrations-kicker"]')!;
    expect(kicker.tagName).toBe('P');
    expect(kicker.textContent!.trim()).toBe('Integrations on record');
    // The intro line is a promise that waits for Chris.
    expect(el.textContent).not.toContain('with the evidence behind it');
    // The mock-up's "N of N integrations shown" badge is not built: it is the row count,
    // which can differ from the facts card's figure (ruled 2026-11-16).
    expect(el.querySelector('[data-testid="integrations-count-badge"]')).toBeNull();
    expect(el.textContent).not.toContain('integrations shown');
    expect(el.querySelector('[data-testid="integrations-list-heading"]')).toBeNull();
    expect(el.textContent).not.toContain('All integrations on record');
    // Idle, the list row is visually hidden: it holds only the empty status.
    const row = el.querySelector('[data-testid="integrations-list-row"]')!;
    expect(row.className).toBe('sr-only');
    pressChip(fixture, el, 'Enscape sends');
    expect(el.textContent).not.toContain('Integrations that match these filters');
    expect(row.className).not.toBe('sr-only');
    expect(el.querySelector('[role="status"]')!.textContent!.trim()).toBe('Showing 1 of 5');
    // The cards list keeps its accessible name with no heading over it.
    expect(el.querySelector('[data-testid="integration-cards"]')!.getAttribute('aria-label')).toBe(
      'Integrations',
    );
  });

  it('labels the search box, lays the panel out in rows, and names the category row', () => {
    const { el } = setup(rows());
    const label = el.querySelector('label[for="integrations-filter"]')!;
    expect(label.textContent!.trim()).toBe('Search these integrations');
    const top = el.querySelector('[data-testid="integrations-filter-top"]')!;
    expect(top.querySelector('#integrations-filter')).not.toBeNull();
    expect(top.querySelector('[data-testid="integrations-filter-direction"]')).not.toBeNull();
    expect(top.querySelector('aec-listing-view-toggle')).not.toBeNull();
    expect(el.querySelector('#integrations-filter-categories')!.textContent!.trim()).toBe(
      'Partner category',
    );
    // Below md each chip row is one sideways line; from md it wraps.
    const cats = el.querySelector('[data-testid="integrations-filter-categories"]')!;
    expect(cats.classList).toContain('max-md:flex-nowrap');
    expect(cats.classList).toContain('overflow-x-auto');
  });

  it('prints "by {vendor}" under the partner, and nothing without a vendor', () => {
    const { el } = setup([
      edge(link('sage', 'Sage'), { partner_vendor_name: 'Sage Group' }),
      edge(link('vista', 'Vista')),
    ]);
    const vendors = [...el.querySelectorAll('[data-testid="integration-card-vendor"]')].map((v) =>
      v.textContent!.trim(),
    );
    expect(vendors).toEqual(['by Sage Group']);
  });

  it('never prints a mechanism name that only repeats its kind chip', () => {
    const { el } = setup([
      edge(link('sage', 'Sage'), { mechanism_kind: 'native', mechanism_name: 'Native' }),
      edge(link('vista', 'Vista'), { mechanism_kind: 'native', mechanism_name: 'Vista sync' }),
    ]);
    const names = [...el.querySelectorAll('[data-testid="integration-card-mechanism-name"]')].map(
      (n) => n.textContent!.trim(),
    );
    expect(names).toEqual(['Vista sync']);
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
    // AECI-1720 restore C (mock-up 6): "Any direction" first, pressed while no direction
    // chip is, counting every row the other filters keep. Then the page product's words.
    expect(chips(groups[0]!)).toEqual([
      'Any direction 5',
      '→ Enscape sends 1',
      '← Enscape receives 1',
      '⇄ Both ways 1',
    ]);
    expect(
      groups[0]!
        .querySelector('[data-testid="integrations-filter-direction-any"] button')!
        .getAttribute('aria-pressed'),
    ).toBe('true');
    // AECI-1783: "Types of data" sits between direction and categories.
    expect(chips(groups[1]!)).toEqual(['Invoices 1']);
    expect(chips(groups[2]!)).toEqual(['Accounting 2', 'Field management 2']);
  });

  it('a direction chip filters, announces the count politely, and the heading count stays', () => {
    const { fixture, el } = setup(rows());
    const status = el.querySelector('[role="status"]')!;
    // AECI-1720: idle, the status is empty, as on "Integrations it powers": an idle
    // "Showing 4 of 4" would be a row count beside the heading (ruled 2026-11-16).
    expect(status.textContent?.trim()).toBe('');
    pressChip(fixture, el, 'Enscape sends');
    expect(cardNames(el)).toEqual(['Sage']);
    expect(status.textContent).toContain('Showing 1 of 5');
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
    pressChip(fixture, el, 'Both ways');
    expect(cardNames(el)).toEqual(['Xero']);
    type(fixture, filterInput(el)!, 'sage');
    expect(cardNames(el)).toEqual([]);
    // Chips and a search together take the filters message (approved 2026-11-16).
    expect(el.textContent).toContain('No integrations match these filters.');
    expect(el.textContent).not.toContain('No integrations match that search');
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
    expect(cardNames(el)).toEqual(['Fieldwire', 'Sage', 'Vista', 'Xero', 'Zeta']);
    expect(filterInput(el)!.value).toBe('');
    // Only "Any direction" stays pressed: it is the no-direction-chosen state.
    const pressed = [...el.querySelectorAll('aec-chip button[aria-pressed="true"]')];
    expect(pressed.map((b) => b.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Any direction 5',
    ]);
    expect(clear()).toBeNull();
    // The button removed itself, so focus moved to the search field (AECI-1788).
    expect(document.activeElement).toBe(filterInput(el));
  });

  it('renders no direction or category group when no row has one', () => {
    const { el } = setup([
      edge(link('acumatica', 'Acumatica')),
      edge(link('bluebeam', 'Bluebeam')),
    ]);
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
    pressChip(fixture, el, 'Enscape receives');
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
describe('ProductIntegrationsSection approved copy (AECI-1783, 2026-11-16)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const INV = { slug: 'invoice', name: 'Invoices' };
  const RFI = { slug: 'rfi', name: 'RFIs' };
  const ACC = { slug: 'accounting', name: 'Accounting' };
  const rows = () => [
    edge(link('sage', 'Sage'), {
      context_direction: 'outbound',
      partner_categories: [ACC],
      data_objects: [INV, RFI],
      data_object_slugs: ['invoice', 'rfi'],
    }),
    edge(link('vista', 'Vista'), {
      context_direction: 'inbound',
      data_objects: [INV],
      data_object_slugs: ['invoice'],
    }),
    edge(link('xero', 'Xero'), { context_direction: 'inbound' }),
    // Two more rows with nothing on record, so the search box shows (AECI-2021).
    edge(link('yard', 'Yard')),
    edge(link('zeta', 'Zeta')),
  ];
  const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
  const cardNames = (el: HTMLElement) =>
    [...el.querySelectorAll('li[aec-product-integration-card] h3')].map(text);
  const dataGroup = (el: HTMLElement) =>
    el.querySelector<HTMLElement>('[aria-labelledby="integrations-filter-data"]')!;

  // AECI-2021 (ruled 2026-11-23): the rows sort by the partner product's name, so the
  // line says "product", and one row has no order to state.
  it('says "A to Z by product name." under the heading on a page with no Via lane', () => {
    const { el } = setup(rows());
    expect(text(el.querySelector('[data-testid="integrations-order"]')!)).toBe(
      'A to Z by product name.',
    );
  });

  it('drops the order line on a page with one row', () => {
    const { el } = setup(rows().slice(0, 1));
    expect(el.querySelector('[data-testid="integrations-order"]')).toBeNull();
    TestBed.resetTestingModule();
    expect(
      setup(rows().slice(0, 2)).el.querySelector('[data-testid="integrations-order"]'),
    ).not.toBeNull();
  });

  it('drops the order line on a page with a Via lane, whose groups go by row count', () => {
    const { el } = setup([
      ...rows(),
      edge(link('acumatica', 'Acumatica'), { via: AGAVE, mechanism_kind: null }),
    ]);
    expect(el.querySelector('[data-testid="integrations-order"]')).toBeNull();
  });

  it('shows "Types of data" chips A to Z, and the note only while one is pressed', () => {
    const { fixture, el } = setup(rows());
    expect(text(el.querySelector('#integrations-filter-data')!)).toBe('Types of data');
    const chips = [...dataGroup(el).querySelectorAll('button[aria-pressed]')].map(text);
    expect(chips).toEqual(['Invoices 2', 'RFIs 1']);
    expect(el.querySelector('[data-testid="integrations-filter-data-note"]')).toBeNull();
    expect(dataGroup(el).getAttribute('aria-describedby')).toBeNull();

    pressChip(fixture, el, 'Invoices');
    expect(cardNames(el)).toEqual(['Sage', 'Vista']);
    const note = el.querySelector('[data-testid="integrations-filter-data-note"]')!;
    expect(text(note)).toBe(
      'Integrations with no types of data on record are not shown while this filter is on.',
    );
    expect(note.closest('[aria-live="polite"]')).not.toBeNull();
    expect(dataGroup(el).getAttribute('aria-describedby')).toBe(note.id);
    // Data chips AND together: RFIs would leave one row.
    expect(chips.length).toBe(2);
    expect(
      text(
        [...dataGroup(el).querySelectorAll('button[aria-pressed]')].find((b) =>
          text(b).startsWith('RFIs'),
        )!,
      ),
    ).toBe('RFIs 1');
  });

  it('a search alone keeps the search message; chips take the filters message', () => {
    const { fixture, el } = setup(rows());
    type(fixture, filterInput(el)!, 'zzz');
    expect(text(el.querySelector('[data-testid="integrations-filter-empty"]')!)).toBe(
      'No integrations match that search.',
    );
    type(fixture, filterInput(el)!, '');
    pressChip(fixture, el, 'Enscape sends');
    pressChip(fixture, el, 'Invoices');
    type(fixture, filterInput(el)!, 'vista');
    expect(text(el.querySelector('[data-testid="integrations-filter-empty"]')!)).toBe(
      'No integrations match these filters.',
    );
  });

  it('labels each card chip row, and names the list with the same words', () => {
    const { el } = setup(rows());
    const sage = [...el.querySelectorAll('li[aec-product-integration-card]')].find((c) =>
      text(c).includes('Sage'),
    )!;
    const cats = sage.querySelector('[data-testid="integration-card-categories"]')!;
    const data = sage.querySelector('[data-testid="integration-card-data-objects"]')!;
    expect(cats.getAttribute('aria-label')).toBe('Categories');
    expect(data.getAttribute('aria-label')).toBe('Types of data');
    expect(text(sage.querySelector('[data-testid="integration-card-categories-label"]')!)).toBe(
      'Categories',
    );
    // AECI-1720: the data list sits under mock-up 6's "What moves", and keeps "Types of
    // data" as its accessible name.
    expect(text(sage.querySelector('[data-testid="integration-card-moves-label"]')!)).toBe(
      'What moves',
    );
    expect(text(sage.querySelector('[data-testid="integration-card-connects-label"]')!)).toBe(
      'How it connects',
    );
  });

  it('one or two cards share the row; three or more keep the grid steps', () => {
    const grid = (el: HTMLElement) =>
      el.querySelector('[data-testid="integration-cards"]')!.getAttribute('data-columns');
    expect(grid(setup(rows().slice(0, 1)).el)).toBe('1');
    TestBed.resetTestingModule();
    expect(grid(setup(rows().slice(0, 2)).el)).toBe('2');
    TestBed.resetTestingModule();
    expect(grid(setup(rows()).el)).toBeNull();
  });
});

describe('ProductIntegrationsSection controls that can change the list (AECI-2021)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const ACC = { slug: 'accounting', name: 'Accounting' };
  const FIELD = { slug: 'field-management', name: 'Field management' };
  const INV = { slug: 'invoice', name: 'Invoices' };
  const RFI = { slug: 'rfi', name: 'RFIs' };
  const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
  const panel = (el: HTMLElement) => el.querySelector('[data-testid="integrations-filter-panel"]');
  const chipTexts = (el: HTMLElement, group: string) =>
    [...el.querySelectorAll(`[aria-labelledby="${group}"] button[aria-pressed]`)].map(text);

  it('has no panel, no list row and no toggle with one row', () => {
    const { el } = setup([
      edge(link('sage', 'Sage'), {
        context_direction: 'outbound',
        partner_categories: [ACC],
        data_objects: [INV],
        data_object_slugs: ['invoice'],
      }),
    ]);
    expect(rowCount(el)).toBe(1);
    expect(panel(el)).toBeNull();
    expect(el.querySelector('aec-listing-view-toggle')).toBeNull();
    expect(el.querySelector('[data-testid="integrations-list-row"]')).toBeNull();
    expect(filterInput(el)).toBeNull();
  });

  it('shows Cards and Table from two rows, with no search box under five', () => {
    const { el } = setup([edge(link('sage', 'Sage')), edge(link('vista', 'Vista'))]);
    expect(panel(el)).not.toBeNull();
    expect(el.querySelector('aec-listing-view-toggle')).not.toBeNull();
    expect(filterInput(el)).toBeNull();
    expect(el.querySelector('[data-testid="integrations-filter-search"]')).toBeNull();
  });

  it('hides a chip whose count equals the row total, and keeps one that would hide a row', () => {
    const { el } = setup([
      edge(link('sage', 'Sage'), {
        context_direction: 'outbound',
        partner_categories: [ACC],
        data_objects: [INV, RFI],
        data_object_slugs: ['invoice', 'rfi'],
      }),
      edge(link('vista', 'Vista'), {
        context_direction: 'outbound',
        partner_categories: [ACC, FIELD],
        data_objects: [INV],
        data_object_slugs: ['invoice'],
      }),
      edge(link('xero', 'Xero'), {
        context_direction: 'outbound',
        partner_categories: [ACC],
        data_objects: [INV],
        data_object_slugs: ['invoice'],
      }),
    ]);
    // Every row is in Accounting and moves Invoices, so neither chip can hide a row.
    expect(chipTexts(el, 'integrations-filter-categories')).toEqual(['Field management 1']);
    expect(chipTexts(el, 'integrations-filter-data')).toEqual(['RFIs 1']);
    // Every row flows outbound: no direction chip can narrow, so the whole group goes,
    // "Any direction" with it.
    expect(el.querySelector('[data-testid="integrations-filter-direction"]')).toBeNull();
    expect(el.textContent).not.toContain('Any direction');
  });

  it('drops a chip row and its label when no chip in it can narrow the list', () => {
    const { el } = setup([
      edge(link('sage', 'Sage'), { context_direction: 'outbound', partner_categories: [ACC] }),
      edge(link('vista', 'Vista'), { context_direction: 'inbound', partner_categories: [ACC] }),
    ]);
    expect(el.querySelector('#integrations-filter-categories')).toBeNull();
    expect(el.querySelector('[data-testid="integrations-filter-categories"]')).toBeNull();
    expect(chipTexts(el, 'integrations-filter-direction')).toEqual([
      'Any direction 2',
      '→ Enscape sends 1',
      '← Enscape receives 1',
    ]);
  });

  it('judges a chip on the unfiltered rows, so filtering never hides it', () => {
    const { fixture, el } = setup([
      edge(link('sage', 'Sage'), { context_direction: 'outbound', partner_categories: [ACC] }),
      edge(link('vista', 'Vista'), { context_direction: 'inbound', partner_categories: [FIELD] }),
      edge(link('xero', 'Xero'), { context_direction: 'outbound', partner_categories: [ACC] }),
    ]);
    pressChip(fixture, el, 'Enscape sends');
    // Filtered, every row left is in Accounting, but the chip still shows.
    expect(chipTexts(el, 'integrations-filter-categories')).toEqual([
      'Accounting 2',
      'Field management 0',
    ]);
  });

  it('never hides a pressed chip, so the reader can always release it', () => {
    const { fixture, el } = setup([
      edge(link('sage', 'Sage'), { partner_categories: [ACC] }),
      edge(link('vista', 'Vista'), { partner_categories: [FIELD] }),
    ]);
    pressChip(fixture, el, 'Field management');
    // The rows change under the pressed chip: now every row is in Field management.
    fixture.componentInstance.asSource.set([
      edge(link('sage', 'Sage'), { partner_categories: [FIELD] }),
      edge(link('vista', 'Vista'), { partner_categories: [FIELD] }),
    ]);
    fixture.detectChanges();
    const chips = el.querySelectorAll<HTMLButtonElement>(
      '[aria-labelledby="integrations-filter-categories"] button[aria-pressed]',
    );
    expect([...chips].map(text)).toEqual(['Field management 2']);
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
    chips[0]!.click();
    fixture.detectChanges();
    expect(el.querySelector('#integrations-filter-categories')).toBeNull();
  });

  it('"Clear filters" hands focus to the panel when it has no search box', () => {
    const { fixture, el } = setup([
      edge(link('sage', 'Sage'), { partner_categories: [ACC] }),
      edge(link('vista', 'Vista'), { partner_categories: [FIELD] }),
    ]);
    document.body.appendChild(el);
    pressChip(fixture, el, 'Accounting');
    el.querySelector<HTMLButtonElement>('[data-testid="integrations-filter-clear"]')!.click();
    fixture.detectChanges();
    expect(panel(el)!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    el.remove();
  });

  it('shows no "Listed by AEC Integrations" label on a card or a table row, and every other state', () => {
    const rows = [
      edge(link('acumatica', 'Acumatica'), { agreement: 'unverified' }),
      edge(link('bluebeam', 'Bluebeam'), { agreement: 'confirmed' }),
      edge(link('cmic', 'CMiC'), { agreement: 'single_source' }),
      edge(link('deltek', 'Deltek'), { agreement: 'conflict' }),
    ];
    const { fixture, el } = setup(rows);
    const check = (selector: string) => {
      const items = [...el.querySelectorAll(selector)];
      expect(items).toHaveLength(4);
      expect(items[0]!.querySelector('aec-agreement-badge')).toBeNull();
      expect(text(items[0]!)).not.toContain('Listed by AEC Integrations');
      expect(text(items[1]!)).toContain('Confirmed by both companies');
      expect(text(items[2]!)).toContain('Confirmed by one company');
      expect(text(items[3]!)).toContain('Companies disagree');
    };
    check('li[aec-product-integration-card]');
    showTable(fixture, el);
    check('tr[aec-product-integration-row]');
  });
});

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
    // Rows keep the lane order inside a group, and the cards are h4 under the group h3
    // (AECI-2021: the section h2 is the group heading's parent, no level skipped).
    const acc = [...groups(el)[0]!.querySelectorAll('li[aec-product-integration-card] h4')];
    expect(acc.length).toBeGreaterThan(0);
    expect(el.querySelector('li[aec-product-integration-card] h5')).toBeNull();
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
    pressChip(fixture, el, 'Enscape receives');
    check();
    pressChip(fixture, el, 'Scheduling');
    expect(groups(el).map((g) => text(g.querySelector('h3')!))).toEqual(['Scheduling']);
    check();
  });

  it('a closed group shows its first six cards (ruled 2026-11-16); the rest are in the DOM, hidden until found', () => {
    const { fixture, el } = setup(rows(58));
    const first = groups(el)[0]!;
    const cards = [...first.querySelectorAll('li[aec-product-integration-card]')];
    expect(cards.length).toBeGreaterThan(6);
    expect(cards.slice(0, 6).every((c) => !c.hasAttribute('hidden'))).toBe(true);
    expect(cards.slice(6).every((c) => c.getAttribute('hidden') === 'until-found')).toBe(true);
    // Hidden cards keep their pair-page links in the markup.
    expect(cards[6]!.querySelector('a[href^="/products/procore/integrations/"]')).not.toBeNull();

    const button = first.querySelector<HTMLButtonElement>(
      '[data-testid="integration-category-group-toggle"]',
    )!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(text(button.querySelector('[data-testid="integration-show-more"]')!)).toBe(
      `Show ${cards.length - 6} more in Accounting`,
    );
    // AECI-1720: below md the group shows 3, and its label counts from the fourth card.
    expect(text(button.querySelector('[data-testid="integration-show-more-phone"]')!)).toBe(
      `Show ${cards.length - 3} more in Accounting`,
    );
    expect(cards.slice(0, 3).every((c) => !c.hasAttribute('data-phone-extra'))).toBe(true);
    expect(cards.slice(3, 6).every((c) => c.hasAttribute('data-phone-extra'))).toBe(true);
    expect(cards.slice(6).every((c) => !c.hasAttribute('data-phone-extra'))).toBe(true);
    // The stack names the first hidden partners, in row order, with no logo above 32px.
    const stack = [
      ...button.querySelectorAll('[data-testid="integration-stack"] aec-logo-or-initial'),
    ].map(text);
    expect(stack).toEqual(
      cards.slice(6, 11).map((c) => text(c.querySelector('h4')!).charAt(0).toUpperCase()),
    );
    button.click();
    fixture.detectChanges();
    expect(cards.every((c) => !c.hasAttribute('hidden'))).toBe(true);
    expect(cards.every((c) => !c.hasAttribute('data-phone-extra'))).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(text(button)).toBe('Show fewer');
  });

  it('a 13-row list whose rows fall into 13 groups stays one flat list (ruled 2026-11-16)', () => {
    const spread = Array.from({ length: 13 }, (_, i) =>
      edge(link(`s-${i}`, `S ${String(i).padStart(2, '0')}`), {
        partner_categories: [{ slug: `cat-${i}`, name: `Cat ${i}` }],
      }),
    );
    const { el } = setup(spread);
    expect(groups(el)).toHaveLength(0);
    expect(el.querySelector('aec-integration-arrangement-toggle')).toBeNull();
    expect(el.querySelectorAll('li[aec-product-integration-card]')).toHaveLength(13);
  });

  it('a group of six or fewer shows every card from md, and a phone button only past three', () => {
    const { el } = setup(rows(13));
    let phoneOnly = 0;
    for (const group of groups(el)) {
      const cards = group.querySelectorAll('li[aec-product-integration-card]');
      expect(cards.length).toBeLessThanOrEqual(6);
      expect(group.querySelector('li[hidden]')).toBeNull();
      const toggle = group.querySelector('[data-testid="integration-category-group-toggle"]');
      if (cards.length <= 3) {
        expect(toggle).toBeNull();
      } else {
        // AECI-1720: rows 4 to 6 hide below md only, and the button's wrapper hides from md.
        phoneOnly++;
        expect(toggle!.parentElement!.classList).toContain('md:hidden');
        expect(group.querySelectorAll('li[data-phone-extra]')).toHaveLength(cards.length - 3);
      }
    }
    expect(phoneOnly).toBeGreaterThan(0);
  });

  it('a chip that would leave no rows is disabled, unless it is pressed', () => {
    const { fixture, el } = setup(rows(58));
    // Every row is outbound or inbound, so "Both" is absent; narrow by query instead.
    type(fixture, filterInput(el)!, 'Partner 01');
    const chip = (name: string) => categoryChips(el).find((b) => text(b).startsWith(name))!;
    // Partner 01 is in Scheduling and BIM only.
    expect(chip('Accounting').disabled).toBe(true);
    expect(chip('Scheduling').disabled).toBe(false);
    // A pressed chip whose count falls to 0 stays pressable, so it can be released.
    type(fixture, filterInput(el)!, '');
    pressChip(fixture, el, 'Accounting');
    type(fixture, filterInput(el)!, 'Partner 01');
    expect(chip('Accounting').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Accounting').disabled).toBe(false);
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
    connector_kind: null,
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

describe('ProductIntegrationsSection empty branch on a page that powers pairs (AECI-2050)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const host = (slug: string, name: string): ProductListItem => ({
    ...link(slug, name),
    product_role: 'application',
    connector_kind: null,
    vendor: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });

  const box = (el: HTMLElement) => el.querySelector('[data-testid=integrations-empty]');

  function powering(
    pairs: number,
    opts: { reachable?: number; hosts?: readonly ProductListItem[] } = {},
  ) {
    const { fixture, el } = setup([], opts.reachable ?? 0, opts.hosts ?? []);
    fixture.componentInstance.poweredPairCount.set(pairs);
    fixture.detectChanges();
    return el;
  }

  it('keeps the empty sentence and its correction link when the page powers nothing', () => {
    const el = powering(0);

    expect(box(el)!.textContent).toContain('No integrations recorded yet');
    expect(box(el)!.querySelector('a[href="/products/procore/correction"]')).toBeTruthy();
  });

  it('drops the empty sentence, its link and the box when the page powers a pair', () => {
    const el = powering(1);

    expect(el.textContent).not.toContain('No integrations recorded yet');
    expect(el.querySelector('a[href="/products/procore/correction"]')).toBeNull();
    expect(box(el)).toBeNull();
    // The section heading stays, so the section nav link still lands on it.
    expect(el.querySelector('#integrations-title')!.textContent).toContain('Integrations');
  });

  it('keeps the Built within sentence alone in the box on an extension that powers pairs', () => {
    const el = powering(2, { hosts: [host('revit', 'Revit')] });

    expect(box(el)!.textContent).toContain('Enscape runs inside Revit; see Built within.');
    expect(box(el)!.textContent).not.toContain('No integrations recorded yet');
    expect(box(el)!.querySelectorAll('p').length).toBe(1);
  });

  it('keeps the reach line on a page that powers pairs', () => {
    const el = powering(3, { reachable: 2 });

    expect(el.textContent).not.toContain('No integrations recorded yet');
    expect(el.textContent!.replace(/\s+/g, ' ')).toContain('2 pairs reachable via connectors');
  });

  it('ignores the powered pair count when the section has rows of its own', () => {
    const { fixture, el } = setup([edge(link('navisworks', 'Navisworks'))]);
    fixture.componentInstance.poweredPairCount.set(4);
    fixture.detectChanges();

    expect(rowCount(el)).toBe(1);
    expect(box(el)).toBeNull();
  });
});
