/**
 * `ProductPoweredHub` — AECI-841's additions to the "Integrations it powers"
 * section: the shared collapsible card and the name filter.
 *
 * Named `.component.spec.ts` so it runs under `ng test` rather than the
 * node-only Vitest pass. The grouping heuristic itself (§12.3) is covered by
 * `powered-hub-grouping.spec.ts`, and the section's render gates by
 * `product-detail.component.spec.ts`; neither is repeated here.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, RouterLink } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorKind, PoweredIntegrationItem, ProductLink } from '@aeci/shared';

import { groupPoweredIntegrations, type PoweredHubView } from './powered-hub-grouping';
import {
  INTEGRATION_FILTER_PANEL_CLASS,
  INTEGRATION_LIST_HEADING_CLASS,
  INTEGRATION_LIST_ROW_CLASS,
  INTEGRATION_SEARCH_INPUT_CLASS,
} from './integration-filter-recipe';
import { ProductPoweredHub } from './product-powered-hub';

const link = (slug: string, name: string): ProductLink => ({
  id: 'p-' + slug,
  slug,
  name,
  logo_url: null,
});

const HUB = link('procore', 'Procore');
let seq = 0;

function poweredEdge(source: ProductLink, target: ProductLink): PoweredIntegrationItem {
  seq += 1;
  return {
    id: '00000000-0000-4000-8000-0000000' + String(seq).padStart(5, '0'),
    name: source.name + ' to ' + target.name,
    mechanism_kind: 'api',
    mechanism_name: null,
    direction: 'a_to_b',
    source,
    target,
    via: null,
    data_object_slugs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

@Component({
  imports: [ProductPoweredHub],
  // Attribute selector on a real <section>, exactly as product-detail.ts
  // places it.
  template: `<section
    aec-product-powered-hub
    [view]="view()"
    slug="agave-erp-sync"
    [kind]="kind()"
  ></section>`,
})
class Host {
  view = signal<PoweredHubView>(groupPoweredIntegrations([], 'agave-erp-sync'));
  kind = signal<ConnectorKind | null>(null);
}

function setup(partners: readonly string[], kind: ConnectorKind | null = null) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.kind.set(kind);
  fixture.componentInstance.view.set(
    groupPoweredIntegrations(
      partners.map((name) =>
        poweredEdge(HUB, link(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name)),
      ),
      'agave-erp-sync',
    ),
  );
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const filterInput = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input#powers-filter');
const rows = (el: HTMLElement) => el.querySelectorAll('ul li').length;

function type(fixture: { detectChanges: () => void }, input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

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
];

describe('ProductPoweredHub', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // AECI-853 folded direction out of its own right-hand slot and into the meta
  // line under the partner name. §12.3 pins these rows to
  // `ProductIntegrationRow`'s breakpoint behaviour, so this section has to move
  // with it: fold one and not the other and the same page shows direction as a
  // column in one section and a sublabel in the other. The local seed has no
  // powered-hub rows, so this spec is the only thing that renders them.
  // NINE, not one partner: a hub card only forms once a product has enough
  // degree to claim pairs. A single edge falls through to the "Other
  // connections" pair rows, which are a different template branch and are not
  // what AECI-853 changed.
  it('renders the hub-relative direction inside the partner card, not a separate slot', () => {
    const { el } = setup(NINE);
    const card = el.querySelector('ul li a[data-testid="powered-card"]')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Acumatica');
    expect(card.textContent).toContain('Procore sends to Acumatica');
    expect(card.textContent).toContain('\u2192');
  });

  it('labels the direction for assistive tech now that the slot is gone', () => {
    const { el } = setup(NINE);
    const prefix = [...el.querySelectorAll('span.sr-only')].find((n) =>
      n.textContent?.includes('Direction:'),
    );
    expect(prefix).toBeDefined();
  });

  it('drops the fixed-width direction slot that set the old row min-width', () => {
    const { el } = setup(NINE);
    expect(el.innerHTML).not.toContain('min-w-[7.5rem]');
  });

  // There is no row threshold: a section with rows has a filter. The two
  // integration sections sit next to each other on a connector page, and the
  // same control over one and not the other reads as a bug.
  it('shows the filter on a short section', () => {
    const { el } = setup(['Acumatica', 'Bluebeam']);
    expect(rows(el)).toBe(2);
    expect(filterInput(el)).not.toBeNull();
  });

  it('shows no filter on a section with no rows, which has nothing to filter', () => {
    const { el } = setup([]);
    expect(rows(el)).toBe(0);
    expect(filterInput(el)).toBeNull();
    expect(el.textContent).toContain('No integrations are recorded as running');
  });

  it('renders the heading and its unfiltered count in the section itself', () => {
    const { fixture, el } = setup([...NINE, 'Sage 300 CRE']);
    expect(el.querySelector('h2')!.textContent).toContain('Integrations it powers (10)');
    // A filter is a reader's view, never a claim about the product, so the
    // <h2> count does not move under one.
    type(fixture, filterInput(el)!, 'sage');
    expect(el.querySelector('h2')!.textContent).toContain('Integrations it powers (10)');
  });

  // AECI-2037: the heading and the empty state name the kind.
  it.each([
    ['integration_platform', 'Integrations it powers (2)'],
    ['sync_service', 'Integrations it delivers (2)'],
    [null, 'Integrations it powers (2)'],
  ] as const)('heads a %s section "%s"', (kind, heading) => {
    const { el } = setup(['Acumatica', 'Bluebeam'], kind);
    expect(el.querySelector('h2')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(heading);
  });

  it.each([
    [
      'integration_platform',
      'No integrations are recorded as running on this integration platform yet.',
    ],
    ['sync_service', 'No integrations are recorded for this Sync Service yet.'],
    [null, 'No integrations are recorded as running on this connector yet.'],
  ] as const)('the %s empty state reads "%s", then offers the correction', (kind, lead) => {
    const { el } = setup([], kind);
    const text = el.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain(
      `${lead} Vendor data is curated; if you know of one, suggest a correction.`,
    );
    expect(el.querySelector('a[href="/products/agave-erp-sync/correction"]')).not.toBeNull();
  });

  it('narrows the card to matches and reports the count it kept', () => {
    const { fixture, el } = setup([...NINE, 'Sage 300 CRE']);
    const input = filterInput(el)!;
    expect(input).not.toBeNull();

    type(fixture, input, 'sage');
    expect(rows(el)).toBe(1);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Showing 1 of 10');
    // Under a filter the card size reads as a fraction, so a small group is
    // distinguishable from a heavily filtered large one.
    expect(el.querySelector('h3')!.textContent).toContain('1 of 10');
  });

  it('keeps every partner when the HUB name itself matches', () => {
    const { fixture, el } = setup([...NINE, 'Sage 300 CRE']);
    type(fixture, filterInput(el)!, 'procore');
    expect(rows(el)).toBe(10);
  });

  it('shows a no-match state instead of an empty section', () => {
    const { fixture, el } = setup([...NINE, 'Sage 300 CRE']);
    type(fixture, filterInput(el)!, 'zzz');
    expect(rows(el)).toBe(0);
    expect(el.textContent).toContain('No connections match that search');
  });

  it('opens each card by default and hides, never removes, a collapsed one', () => {
    const { fixture, el } = setup(NINE);
    const button = el.querySelector<HTMLButtonElement>('h3 button')!;
    expect(button.getAttribute('aria-expanded')).toBe('true');

    button.click();
    fixture.detectChanges();

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('#powers-group-procore-panel')!.hasAttribute('hidden')).toBe(true);
    // The crawler invariant: the pair links are still in the HTML.
    expect(rows(el)).toBe(9);
    expect(el.querySelector('a[href^="/products/acumatica/integrations/"]')).not.toBeNull();
  });

  it('navigates pair rows through the ROUTER, not as a plain href', () => {
    // Angular has no global anchor interception: only the RouterLink directive
    // handles the click. A bare `[href]` here still serialises the same URL and
    // still passes an href assertion, while silently turning every row into a
    // full document load. So assert the directive, not the attribute.
    const { fixture } = setup(NINE);
    const rowLinks = fixture.debugElement
      .queryAll(By.directive(RouterLink))
      .filter((d) =>
        (d.nativeElement as HTMLAnchorElement).getAttribute('href')?.includes('/integrations/'),
      );
    expect(rowLinks).toHaveLength(9);
  });

  it('re-opens a collapsed card when a query matches inside it', () => {
    const { fixture, el } = setup([...NINE, 'Sage 300 CRE']);
    const button = el.querySelector<HTMLButtonElement>('h3 button')!;
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');

    type(fixture, filterInput(el)!, 'sage');
    expect(el.querySelector('h3 button')!.getAttribute('aria-expanded')).toBe('true');

    // Clearing restores the reader's own state rather than discarding it.
    type(fixture, filterInput(el)!, '');
    expect(el.querySelector('h3 button')!.getAttribute('aria-expanded')).toBe('false');
  });
  // AECI-1788: the section in the Integrations section's language. The rows became
  // nested cards in the shared card grid, the filter moved into a panel, and nothing
  // else moved: the order, the counts and the link names are the row's.
  describe('the card language (AECI-1788)', () => {
    const cards = (el: HTMLElement) => [
      ...el.querySelectorAll<HTMLAnchorElement>('a[data-testid="powered-card"]'),
    ];

    it('renders each pair as one nested card that is the pair link', () => {
      const { el } = setup(NINE);
      const all = cards(el);
      expect(all).toHaveLength(9);
      for (const card of all) {
        // The nested card surface (clash 14): the panel radius and tint, no shadow.
        expect(card.classList).toContain('aec-card');
        expect(card.classList).toContain('rounded-panel');
        expect(card.classList).not.toContain('shadow-card');
        expect(card.getAttribute('href')).toMatch(/^\/products\/[a-z0-9-]+\/integrations\//);
        // One link per card, as there was one per row: no partner link was added.
        expect(card.querySelectorAll('a')).toHaveLength(0);
        expect(card.closest('li')!.classList).toContain('group/card');
      }
    });

    it('sits the cards in the shared grid inside the group card', () => {
      const { el } = setup(NINE);
      const grid = el.querySelector('#powers-group-procore-panel ul')!;
      expect(grid.classList).toContain('aec-card-grid');
      expect(grid.getAttribute('role')).toBe('list');
    });

    it('lets one or two cards share the row, and leaves three or more to the grid', () => {
      // Two partners never form a hub, so they are the flat list.
      const two = setup(['Acumatica', 'Bluebeam']).el;
      expect(two.querySelector('ul.aec-card-grid')!.getAttribute('data-columns')).toBe('2');
      TestBed.resetTestingModule();

      const { fixture, el } = setup(NINE);
      const grid = () => el.querySelector('#powers-group-procore-panel ul')!;
      expect(grid().hasAttribute('data-columns')).toBe(false);
      // The rule reads the rendered count, so a filter down to one card fills the row.
      type(fixture, filterInput(el)!, 'acumatica');
      expect(grid().getAttribute('data-columns')).toBe('1');
    });

    it('"Clear filters" shows only while the search is on, restores every row and focuses the field', () => {
      const { fixture, el } = setup([...NINE, 'Sage 300 CRE']);
      const panel = el.querySelector('[data-testid="powers-filter-panel"]')!;
      const clear = () =>
        el.querySelector<HTMLButtonElement>('[data-testid="powers-filter-clear"]');
      const status = () => el.querySelector('[role="status"]')!.textContent!.trim();
      expect(clear()).toBeNull();

      type(fixture, filterInput(el)!, 'sage');
      expect(rows(el)).toBe(1);
      expect(status()).toBe('Showing 1 of 10');
      const button = clear()!;
      expect(button.textContent!.trim()).toBe('Clear filters');
      // The Integrations section's place (mock-up 6): the list row under the panel,
      // after the status, not inside the panel.
      const row = el.querySelector('[data-testid="powers-list-row"]')!;
      expect(row.contains(button)).toBe(true);
      expect(panel.contains(button)).toBe(false);
      expect(panel.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(button.querySelector('aec-icon[name="x"]')).not.toBeNull();

      button.click();
      fixture.detectChanges();
      expect(filterInput(el)!.value).toBe('');
      expect(rows(el)).toBe(10);
      expect(status()).toBe('');
      expect(clear()).toBeNull();
      expect(document.activeElement).toBe(filterInput(el));
    });

    it('takes the Integrations section recipe: heading size, Bone panel, field, list row', () => {
      const { el } = setup(NINE);
      // Angular may reorder a bound class list, so compare the classes as sets.
      const classes = (node: Element) => [...node.classList].sort();
      const recipe = (value: string) => value.split(/\s+/).sort();
      const span = el.querySelector('h2 > span')!;
      expect(classes(span)).toEqual(recipe(INTEGRATION_LIST_HEADING_CLASS));
      const panel = el.querySelector('[data-testid="powers-filter-panel"]')!;
      expect(classes(panel)).toEqual(recipe(INTEGRATION_FILTER_PANEL_CLASS));
      expect(panel.classList).toContain('bg-(--accent-warm)');
      expect(classes(filterInput(el)!)).toEqual(recipe(INTEGRATION_SEARCH_INPUT_CLASS));
      expect(panel.querySelector('aec-icon[name="search"]')).not.toBeNull();
      expect(classes(el.querySelector('[data-testid="powers-list-row"]')!)).toEqual(
        recipe(INTEGRATION_LIST_ROW_CLASS),
      );
      // "Filters" names the panel for assistive tech only, as on the Integrations panel.
      expect(el.querySelector('#powers-filters-title')!.classList).toContain('sr-only');
    });

    it('puts the filter in a "Filters" panel under the heading', () => {
      const { el } = setup(NINE);
      const panel = el.querySelector('[data-testid="powers-filter-panel"]')!;
      expect(panel.getAttribute('role')).toBe('group');
      const name = el.querySelector('#' + panel.getAttribute('aria-labelledby'))!;
      expect(name.textContent?.trim()).toBe('Filters');
      expect(panel.querySelector('input#powers-filter')!.classList).toContain('aec-field-control');
      // The heading comes first, then the panel, then the cards.
      const h2 = el.querySelector('h2')!;
      expect(h2.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the order: groups by partner count then name, partners A to Z', () => {
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), provideRouter([])],
      });
      const fixture = TestBed.createComponent(Host);
      const sage = link('sage', 'Sage');
      const edges = [
        ...['Zeta', 'Alpha', 'Mu'].map((n) => poweredEdge(sage, link(n.toLowerCase(), n))),
        ...['Delta', 'Beta', 'Omega', 'Kappa'].map((n) =>
          poweredEdge(HUB, link(n.toLowerCase(), n)),
        ),
      ];
      fixture.componentInstance.view.set(groupPoweredIntegrations(edges, 'agave-erp-sync'));
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const groups = [...el.querySelectorAll('h3 button')].map((b) => b.textContent);
      expect(groups[0]).toContain('Procore');
      expect(groups[1]).toContain('Sage');
      const names = [...el.querySelectorAll('[data-testid="powered-card-name"]')].map((n) =>
        n.textContent?.trim(),
      );
      expect(names).toEqual(['Beta', 'Delta', 'Kappa', 'Omega', 'Alpha', 'Mu', 'Zeta']);
    });
  });

  describe('the depth axis (AECI-1080)', () => {
    function setupWithObjects(slugs: readonly (readonly string[])[]) {
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), provideRouter([])],
      });
      const fixture = TestBed.createComponent(Host);
      fixture.componentInstance.view.set(
        groupPoweredIntegrations(
          slugs.map((objects, i) => ({
            ...poweredEdge(HUB, link('partner-' + i, 'Partner ' + i)),
            data_object_slugs: [...objects],
          })),
          'agave-erp-sync',
        ),
      );
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }

    it('shows the object count beside the badge, once per card at every width (AECI-1788)', () => {
      const el = setupWithObjects([['rfis', 'models', 'issues'], ['rfis']]);
      const chips = [...el.querySelectorAll('[data-testid="hub-data-objects"]')];
      expect(chips.map((c) => c.textContent?.trim())).toEqual([
        '3 types of data',
        '1 type of data',
      ]);
      // A card has room for its chips, so no breakpoint hides them and no meta-line
      // copy repeats them below md.
      for (const chip of chips) expect(chip.closest('.hidden, .md\\:hidden')).toBeNull();
      expect(el.querySelector('[data-testid="hub-data-objects-sublabel"]')).toBeNull();
      // The mechanism badge comes first, then the count, as on the row.
      const row = chips[0]!.parentElement!;
      // The integration card recipe's chips (match-card-recipe.ts): spans in one wrapping row.
      expect([...row.children].map((c) => c.textContent?.trim())).toEqual([
        'API',
        '3 types of data',
      ]);
    });

    it('names the count in the row link, whose aria-label hides the chip', () => {
      const el = setupWithObjects([['rfis', 'models'], []]);
      const labels = [...el.querySelectorAll('ul li a')].map((a) => a.getAttribute('aria-label'));
      expect(labels).toEqual([
        'View the Procore and Partner 0 integration, direction Procore sends to Partner 0, API, 2 types of data',
        'View the Procore and Partner 1 integration, direction Procore sends to Partner 1, API',
      ]);
    });

    it('renders nothing for a pair with no claims', () => {
      const el = setupWithObjects([[], []]);
      expect(el.querySelector('[data-testid="hub-data-objects"]')).toBeNull();
      expect(el.querySelector('[data-testid="hub-data-objects-sublabel"]')).toBeNull();
    });
  });

  // AECI-1117: each row is ONE link whose aria-label replaces its content as the
  // accessible name, so the sr-only "Direction:" prefix, the direction word and
  // the mechanism badge inside it were never announced. The name now restates
  // them, and the trailing affordance is the chevron, not a second arrow.
  describe('row names and affordance (AECI-1117)', () => {
    function setupEdges(edges: readonly PoweredIntegrationItem[]) {
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), provideRouter([])],
      });
      const fixture = TestBed.createComponent(Host);
      fixture.componentInstance.view.set(groupPoweredIntegrations(edges, 'agave-erp-sync'));
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }
    const names = (el: HTMLElement) =>
      [...el.querySelectorAll('ul li a')].map((a) => a.getAttribute('aria-label'));

    it('says the hub-relative direction in words, in both directions and when unknown', () => {
      const sage = link('sage', 'Sage');
      const acumatica = link('acumatica', 'Acumatica');
      const cmic = link('cmic', 'CMiC');
      const el = setupEdges([
        poweredEdge(HUB, sage),
        poweredEdge(acumatica, HUB),
        { ...poweredEdge(HUB, cmic), direction: null, mechanism_kind: null },
      ]);
      expect(names(el)).toEqual([
        'View the Procore and Acumatica integration, direction Acumatica sends to Procore, API',
        'View the Procore and CMiC integration, direction not listed',
        'View the Procore and Sage integration, direction Procore sends to Sage, API',
      ]);
    });

    it('names both ways on a round trip', () => {
      const el = setupEdges([
        { ...poweredEdge(HUB, link('sage', 'Sage')), direction: 'both' },
        poweredEdge(HUB, link('cmic', 'CMiC')),
      ]);
      expect(names(el)[1]).toBe(
        'View the Procore and Sage integration, direction Procore and Sage sync both ways, API',
      );
    });

    it('says which way a flat one-way row flows, which its arrow alone carried', () => {
      const bluebeam = link('bluebeam', 'Bluebeam');
      const fieldwire = link('fieldwire', 'Fieldwire');
      const raken = link('raken', 'Raken');
      const zeta = link('zeta', 'Zeta');
      const el = setupEdges([
        poweredEdge(fieldwire, bluebeam),
        { ...poweredEdge(raken, zeta), direction: 'both' },
      ]);
      // AECI-1788 after restore C: the card's own words, framed on A, the name it
      // prints first. The flow runs Fieldwire to Bluebeam, so Bluebeam receives.
      expect(names(el)).toEqual([
        'View the Bluebeam and Fieldwire integration, direction Fieldwire sends to Bluebeam, API',
        'View the Raken and Zeta integration, direction Raken and Zeta sync both ways, API',
      ]);
      const words = [...el.querySelectorAll('a[data-testid="powered-card"]')].map((a) =>
        a.textContent!.replace(/\s+/g, ' '),
      );
      expect(words[0]).toContain('Fieldwire sends to Bluebeam');
      expect(words[1]).toContain('Raken and Zeta sync both ways');
      expect(words.join(' ')).not.toMatch(/One-way|Bidirectional/);
    });

    it('frames a hub card on the hub when the hub is endpoint B of the stored pair', () => {
      // Endpoints are stored A to Z, so with Zeta Hub as the hub every pair stores the
      // hub as B. One flow per direction, each read from the hub: the partner the hub
      // sends to, the partner it receives from, and a round trip.
      const hub = link('zeta-hub', 'Zeta Hub');
      const el = setupEdges([
        poweredEdge(hub, link('alpha', 'Alpha')),
        poweredEdge(link('beta', 'Beta'), hub),
        { ...poweredEdge(hub, link('gamma', 'Gamma')), direction: 'both' },
      ]);
      expect(el.querySelector('h3 button')!.textContent).toContain('Zeta Hub');
      expect(names(el)).toEqual([
        'View the Zeta Hub and Alpha integration, direction Zeta Hub sends to Alpha, API',
        'View the Zeta Hub and Beta integration, direction Beta sends to Zeta Hub, API',
        'View the Zeta Hub and Gamma integration, direction Zeta Hub and Gamma sync both ways, API',
      ]);
    });

    it('wraps long product names rather than truncating them, as ProductIntegrationRow does', () => {
      const el = setupEdges([
        poweredEdge(HUB, link('sage', 'Sage Intacct Construction Enterprise Edition')),
        poweredEdge(HUB, link('cmic', 'CMiC')),
        poweredEdge(link('fieldwire', 'Fieldwire'), link('bluebeam', 'Bluebeam')),
      ]);
      const names = [...el.querySelectorAll('ul li a span.break-words')];
      expect(names).toHaveLength(4);
      for (const name of names) {
        expect(name.classList).not.toContain('truncate');
        expect(name.classList).toContain('break-words');
      }
    });

    it('marks every card with one aria-hidden chevron, never a trailing arrow', () => {
      const el = setupEdges([
        poweredEdge(HUB, link('sage', 'Sage')),
        poweredEdge(HUB, link('cmic', 'CMiC')),
        poweredEdge(link('fieldwire', 'Fieldwire'), link('bluebeam', 'Bluebeam')),
      ]);
      const anchors = [...el.querySelectorAll('ul li a')];
      expect(anchors).toHaveLength(3);
      for (const a of anchors) {
        // AECI-1788: the chevron sits at the card's top end, as on the integration card.
        const icons = a.querySelectorAll('aec-icon');
        expect(icons).toHaveLength(1);
        const host = icons[0]!;
        expect(host.getAttribute('name')).toBe('chevron-right');
        expect(a.textContent).not.toMatch(/[→←⇄]\s*$/);
        const last = host.querySelector('svg')!;
        expect(last.getAttribute('aria-hidden')).toBe('true');
        expect(last.querySelector('path')!.getAttribute('d')).toBe('m9 18 6-6-6-6');
      }
    });
  });

  describe('Cards and Table (AECI-1924)', () => {
    const toggle = (el: HTMLElement, name: 'Cards' | 'Table') =>
      [...el.querySelectorAll<HTMLButtonElement>('[data-testid=powers-filter-panel] button')].find(
        (b) => b.textContent?.trim() === name,
      )!;
    const cardNames = (el: HTMLElement) =>
      [...el.querySelectorAll('a[data-testid="powered-card"]')].map((a) =>
        a.getAttribute('aria-label'),
      );
    const tableNames = (el: HTMLElement) =>
      [...el.querySelectorAll('a[data-testid="powered-table-link"]')].map((a) =>
        a.getAttribute('aria-label'),
      );
    function showTable(fixture: { detectChanges: () => void }, el: HTMLElement) {
      toggle(el, 'Table').click();
      fixture.detectChanges();
    }
    const FLAT_AND_HUB = [
      ...NINE.map((name) =>
        poweredEdge(HUB, link(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name)),
      ),
      poweredEdge(link('fieldwire', 'Fieldwire'), link('bluebeam-2', 'Bluebeam Revu')),
    ];
    function setupMixed() {
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), provideRouter([])],
      });
      const fixture = TestBed.createComponent(Host);
      fixture.componentInstance.view.set(groupPoweredIntegrations(FLAT_AND_HUB, 'agave-erp-sync'));
      fixture.detectChanges();
      return { fixture, el: fixture.nativeElement as HTMLElement };
    }

    it('puts one Cards and Table toggle in the panel, Cards pressed, and renders cards first', () => {
      const { el } = setupMixed();
      const panel = el.querySelector('[data-testid=powers-filter-panel]')!;
      const group = panel.querySelector('[role=group][aria-label="Choose a view"]')!;
      expect(group).not.toBeNull();
      expect(el.querySelectorAll('[aria-label="Choose a view"]')).toHaveLength(1);
      expect(toggle(el, 'Cards').getAttribute('aria-pressed')).toBe('true');
      expect(toggle(el, 'Table').getAttribute('aria-pressed')).toBe('false');
      expect(el.querySelector('table')).toBeNull();
      expect(cardNames(el)).toHaveLength(10);
    });

    it('shows every group as a table with the same rows in the same order', () => {
      const { fixture, el } = setupMixed();
      const before = cardNames(el);
      showTable(fixture, el);
      expect(toggle(el, 'Table').getAttribute('aria-pressed')).toBe('true');
      expect(el.querySelector('a[data-testid="powered-card"]')).toBeNull();
      // One table per group card: the hub, then the hubless pairs.
      const tables = [...el.querySelectorAll('table')];
      expect(tables).toHaveLength(2);
      expect(tableNames(el)).toEqual(before);
      // Each table is named by its group card's heading.
      expect(tables[0]!.getAttribute('aria-labelledby')).toBe('powers-group-procore');
      expect(el.querySelector('#powers-group-procore')!.textContent).toContain('Procore');
      expect(tables[1]!.getAttribute('aria-labelledby')).toBe('powers-other');
      expect(el.querySelector('#powers-other')!.textContent).toContain('Other connections');
    });

    it('keeps the header words of the Integrations table, and names both products when hubless', () => {
      const { fixture, el } = setupMixed();
      showTable(fixture, el);
      const [hub, flat] = [...el.querySelectorAll('table')];
      const heads = (t: Element) =>
        [...t.querySelectorAll('thead th')].map((th) => th.textContent!.trim());
      // AECI-1924, 2026-11-19: Direction, How it connects and Types of data as columns.
      const columns = ['Direction', 'How it connects', 'Types of data', 'Details'];
      expect(heads(hub!)).toEqual(['Integrates with', ...columns]);
      expect(heads(flat!)).toEqual(['Products', ...columns]);
      const flatRow = flat!.querySelector('tbody tr')!;
      const shown = [...flatRow.querySelectorAll('[data-testid=powered-table-name]')].map(
        (n) => n.textContent,
      );
      expect(shown).toEqual(['Bluebeam Revu', 'Fieldwire']);
      expect(flatRow.textContent).toContain('Fieldwire sends to Bluebeam');
      const hubRow = hub!.querySelector('tbody tr')!;
      expect(hubRow.textContent).toContain('Procore sends to Acumatica');
      expect(hubRow.querySelectorAll('a')).toHaveLength(1);
    });

    it('fills Direction, How it connects and Types of data from the pair (AECI-1924)', () => {
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), provideRouter([])],
      });
      const fixture = TestBed.createComponent(Host);
      const sage = link('sage', 'Sage');
      fixture.componentInstance.view.set(
        groupPoweredIntegrations(
          [
            {
              ...poweredEdge(HUB, sage),
              mechanism_name: 'Sage connector',
              data_object_slugs: ['rfi', 'submittal'],
            },
            { ...poweredEdge(HUB, link('cmic', 'CMiC')), direction: null, mechanism_kind: null },
          ],
          'agave-erp-sync',
        ),
      );
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      showTable(fixture, el);
      const rows = [...el.querySelectorAll('tbody tr')];
      const cell = (row: Element, id: string) =>
        row.querySelector(`[data-testid=${id}]`)!.textContent!.replace(/\s+/g, ' ').trim();
      // The cards' order: CMiC, then Sage.
      expect(cell(rows[1]!, 'powered-table-direction')).toContain('sends to Sage');
      const connects = rows[1]!.querySelector('[data-testid=powered-table-connects]')!;
      expect(connects.querySelector('aec-chip')!.textContent!.trim()).toBe('API');
      expect(connects.textContent).toContain('Sage connector');
      expect(cell(rows[1]!, 'powered-table-data')).toBe('2 types of data');
      expect(cell(rows[0]!, 'powered-table-direction')).toBe('–');
      expect(
        rows[0]!
          .querySelector('[data-testid=powered-table-connects] [aria-label]')!
          .getAttribute('aria-label'),
      ).toBe('Mechanism not listed');
      expect(cell(rows[0]!, 'powered-table-data')).toContain('No types of data on record');
    });

    it('draws no rounded frame of its own inside the group card (AECI-1924)', () => {
      const { fixture, el } = setupMixed();
      showTable(fixture, el);
      for (const frame of el.querySelectorAll('[data-testid=powered-table-frame]')) {
        expect(frame.className).not.toMatch(/rounded|shadow/);
        expect(frame.className).toContain('overflow-x-auto');
      }
    });

    it('filters both views alike: the same rows, the same "Showing n of m"', () => {
      const { fixture, el } = setupMixed();
      type(fixture, filterInput(el)!, 'b');
      const status = () => el.querySelector('[role="status"]')!.textContent!.trim();
      const cards = cardNames(el);
      const cardStatus = status();
      showTable(fixture, el);
      expect(tableNames(el)).toEqual(cards);
      expect(status()).toBe(cardStatus);
      expect(cardStatus).toMatch(/^Showing \d+ of 10$/);
      // Back to cards: the filter stays, and so do the rows.
      toggle(el, 'Cards').click();
      fixture.detectChanges();
      expect(cardNames(el)).toEqual(cards);
      expect(filterInput(el)!.value).toBe('b');
    });

    it('keeps focus on the toggle after switching', () => {
      const { fixture, el } = setupMixed();
      const table = toggle(el, 'Table');
      table.focus();
      table.click();
      fixture.detectChanges();
      expect(document.activeElement).toBe(toggle(el, 'Table'));
    });

    it('forwards a row click to the row link and leaves the link its own click', () => {
      const { fixture, el } = setupMixed();
      showTable(fixture, el);
      const row = el.querySelector('tbody tr')!;
      const anchor = row.querySelector<HTMLAnchorElement>('a[data-testid="powered-table-link"]')!;
      // Spy on the link's click() so the router never navigates in the test.
      const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
      row.querySelector('td')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(click).toHaveBeenCalledTimes(1);
      expect(anchor.getAttribute('href')).toBe('/products/acumatica/integrations/procore');
    });
  });
});
