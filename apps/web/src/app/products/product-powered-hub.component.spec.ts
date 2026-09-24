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
import { beforeEach, describe, expect, it } from 'vitest';

import type { PoweredIntegrationItem, ProductLink } from '@aeci/shared';

import { groupPoweredIntegrations, type PoweredHubView } from './powered-hub-grouping';
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
  template: `<section aec-product-powered-hub [view]="view()" slug="agave-erp-sync"></section>`,
})
class Host {
  view = signal<PoweredHubView>(groupPoweredIntegrations([], 'agave-erp-sync'));
}

function setup(partners: readonly string[]) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
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
  it('renders the hub-relative direction inside the partner cell, not a separate slot', () => {
    const { el } = setup(NINE);
    const stack = el.querySelector('ul li a span.flex.min-w-0.flex-1.flex-col')!;
    expect(stack).not.toBeNull();
    expect(stack.textContent).toContain('Acumatica');
    expect(stack.textContent).toContain('Outbound');
    expect(stack.textContent).toContain('\u2192');
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

    it('shows the object count beside the badge and on the narrow meta line', () => {
      const el = setupWithObjects([['rfis', 'models', 'issues'], ['rfis']]);
      const chips = [...el.querySelectorAll('[data-testid="hub-data-objects"]')].map((c) =>
        c.textContent?.trim(),
      );
      expect(chips).toEqual(['3 data objects', '1 data object']);
      const sublabels = el.querySelectorAll('[data-testid="hub-data-objects-sublabel"]');
      expect(sublabels).toHaveLength(2);
    });

    it('names the count in the row link, whose aria-label hides the chip', () => {
      const el = setupWithObjects([['rfis', 'models'], []]);
      const labels = [...el.querySelectorAll('ul li a')].map((a) => a.getAttribute('aria-label'));
      expect(labels).toEqual([
        'View the Procore and Partner 0 integration, direction Outbound, API, 2 data objects',
        'View the Procore and Partner 1 integration, direction Outbound, API',
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
        'View the Procore and Acumatica integration, direction Inbound, API',
        'View the Procore and CMiC integration, direction not listed',
        'View the Procore and Sage integration, direction Outbound, API',
      ]);
    });

    it('names both ways on a round trip', () => {
      const el = setupEdges([
        { ...poweredEdge(HUB, link('sage', 'Sage')), direction: 'both' },
        poweredEdge(HUB, link('cmic', 'CMiC')),
      ]);
      expect(names(el)[1]).toBe('View the Procore and Sage integration, direction Both, API');
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
      expect(names(el)).toEqual([
        'View the Bluebeam and Fieldwire integration, direction One-way from Fieldwire to Bluebeam, API',
        'View the Raken and Zeta integration, direction Bidirectional, API',
      ]);
    });

    it('ends every row in the aria-hidden chevron, never a trailing arrow', () => {
      const el = setupEdges([
        poweredEdge(HUB, link('sage', 'Sage')),
        poweredEdge(HUB, link('cmic', 'CMiC')),
        poweredEdge(link('fieldwire', 'Fieldwire'), link('bluebeam', 'Bluebeam')),
      ]);
      const anchors = [...el.querySelectorAll('ul li a')];
      expect(anchors).toHaveLength(3);
      for (const a of anchors) {
        const last = a.lastElementChild!;
        expect(last.tagName.toLowerCase()).toBe('svg');
        expect(last.getAttribute('aria-hidden')).toBe('true');
        expect(last.querySelector('path')!.getAttribute('d')).toBe('m9 18 6-6-6-6');
      }
    });
  });
});
