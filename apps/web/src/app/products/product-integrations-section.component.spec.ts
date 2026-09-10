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

import type { ProductIntegrationItem, ProductLink } from '@aeci/shared';

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
    direction: 'one-way',
    context_direction: null,
    source: PAGE,
    target: partner,
    via: null,
    powered_by_product: null,
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
    ></section>
  `,
})
class Host {
  asSource = signal<readonly ProductIntegrationItem[]>([]);
  asTarget = signal<readonly ProductIntegrationItem[]>([]);
}

function setup(asSource: readonly ProductIntegrationItem[]) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.asSource.set(asSource);
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

/** Rendered data rows, excluding the `@defer` placeholder row. */
const rowCount = (el: HTMLElement) => el.querySelectorAll('tr[aec-product-integration-row]').length;

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

describe('ProductIntegrationsSection filter box', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is absent below the threshold, where the whole list is already on screen', () => {
    const { el } = setup(NINE);
    expect(rowCount(el)).toBe(9);
    expect(filterInput(el)).toBeNull();
  });

  it('appears at the threshold', () => {
    const { el } = setup([...NINE, edge(link('sage-300-cre', 'Sage 300 CRE'))]);
    expect(filterInput(el)).not.toBeNull();
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

  it('leaves the section heading count alone, because that is a fact about the product', () => {
    const { fixture, el } = setup([...NINE, edge(link('sage-300-cre', 'Sage 300 CRE'))]);
    type(fixture, filterInput(el)!, 'sage');

    expect(el.querySelector('#integrations-title')!.textContent).toContain('Integrations (10)');
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

  it('renders NO card on a single-lane page, per §13.3', () => {
    const { el } = setup([edge(link('acumatica', 'Acumatica'))]);
    expect(el.querySelector('aec-integration-group-card')).toBeNull();
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

  it('names each lane table by its own card heading', () => {
    const { el } = setup(withLanes());
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
