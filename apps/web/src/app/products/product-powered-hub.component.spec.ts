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
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { IntegrationListItem, ProductLink } from '@aeci/shared';

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

function poweredEdge(source: ProductLink, target: ProductLink): IntegrationListItem {
  seq += 1;
  return {
    id: '00000000-0000-4000-8000-0000000' + String(seq).padStart(5, '0'),
    name: source.name + ' to ' + target.name,
    mechanism_kind: 'api',
    mechanism_name: null,
    direction: 'one-way',
    source,
    target,
    via: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

@Component({
  imports: [ProductPoweredHub],
  template: `<aec-product-powered-hub [view]="view()" />`,
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

  it('hides the filter below the threshold', () => {
    const { el } = setup(NINE);
    expect(rows(el)).toBe(9);
    expect(filterInput(el)).toBeNull();
  });

  it('shows the filter at the threshold and narrows the card to matches', () => {
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
});
