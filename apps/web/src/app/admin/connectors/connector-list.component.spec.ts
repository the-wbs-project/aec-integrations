/**
 * AECI-722 — `ConnectorList` logic + structural a11y.
 *
 * The live axe pass runs in Playwright against the authenticated route; an
 * unauthenticated run would only ever audit the loading state. Here we assert the
 * filter round trips and the structural invariants axe relies on.
 *
 * One assertion is doing real work rather than covering the happy path: a
 * catalogue whose feed has never delivered must render **"Not measured"**, not
 * "0" and not a bare dash. §5.1 settled that rule for the whole console — showing
 * a zero would claim a freshness reading nobody took — and this screen is where
 * the operator goes to answer "is this vendor's feed still arriving?".
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminConnectorCatalogRow,
  AdminConnectorCatalogsListResponse,
  AdminConnectorCounts,
} from '@aeci/shared';

import { AdminConnectorsApi } from './admin-connectors-api';
import { ConnectorList } from './connector-list';

const PRODUCT_ID = '00000000-0000-4000-8000-000000000010';

function makeCounts(over: Partial<AdminConnectorCounts> = {}): AdminConnectorCounts {
  return {
    surfaces: 2,
    stubs_total: 35,
    stubs_removed: 1,
    stubs_undecided: 22,
    mappings_mapped: 8,
    mappings_ruled_out: 1,
    mappings_out_of_scope: 1,
    mappings_no_record: 1,
    mappings_ambiguous_parked: 1,
    mappings_publishable: 6,
    pairs_curated: 1,
    pairs_generated: 1,
    pairs_unknown: 1,
    evidenced_pairs: 0,
    ...over,
  };
}

function makeRow(over: Partial<AdminConnectorCatalogRow> = {}): AdminConnectorCatalogRow {
  return {
    id: 'cat-mindcloud',
    connector_product: { id: PRODUCT_ID, name: 'MindCloud', slug: 'mindcloud' },
    connector_authorship: 'platform',
    managed_by: 'review',
    notes: null,
    last_ingested_at: '2026-08-29T02:00:00.000Z',
    counts: makeCounts(),
    updated_at: '2026-08-30T00:00:00.000Z',
    ...over,
  };
}

interface ApiMock {
  listCatalogs: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: AdminConnectorCatalogRow[], total = rows.length): ApiMock {
  const page: AdminConnectorCatalogsListResponse = {
    data: rows,
    page: 1,
    perPage: 25,
    total,
  };
  return { listCatalogs: vi.fn(async () => structuredClone(page)) };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminConnectorsApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(ConnectorList);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function lastQuery(api: ApiMock): Record<string, unknown> {
  return api.listCatalogs.mock.calls.at(-1)![0] as Record<string, unknown>;
}

function bodyRows(el: HTMLElement): HTMLTableRowElement[] {
  return [...el.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

describe('ConnectorList', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders a catalogue with its triage backlog', async () => {
    const { el } = await setup(makeApiMock([makeRow()]));
    const row = bodyRows(el)[0]!;
    expect(row.textContent).toContain('MindCloud');
    expect(row.textContent).toContain('22');
  });

  it('renders a never-ingested feed as "Not measured", never as zero', async () => {
    const { el } = await setup(makeApiMock([makeRow({ last_ingested_at: null })]));
    const row = bodyRows(el)[0]!;
    expect(row.textContent).toContain('Not measured');
    // The freshness cell must not read as a measured zero.
    expect(row.textContent).not.toMatch(/\b0\b/);
  });

  it('sends the lane filter and resets to page 1', async () => {
    const { fixture, api } = await setup(makeApiMock([makeRow()], 60));
    const component = fixture.componentInstance as unknown as {
      goToPage(p: number): void;
      onManagedChange(v: string | null): void;
    };

    component.goToPage(2);
    await settle();
    expect(lastQuery(api)['page']).toBe(2);

    component.onManagedChange('vendor');
    await settle();
    expect(lastQuery(api)['managed_by']).toBe('vendor');
    expect(lastQuery(api)['page']).toBe(1);
  });

  it('omits the lane filter entirely when set back to any', async () => {
    const { fixture, api } = await setup(makeApiMock([makeRow()]));
    const component = fixture.componentInstance as unknown as {
      onManagedChange(v: string | null): void;
    };
    component.onManagedChange('vendor');
    await settle();
    component.onManagedChange('any');
    await settle();
    // Absent, not `managed_by=any` — the API has no such value and would 400.
    expect(lastQuery(api)).not.toHaveProperty('managed_by');
  });

  it('shows a retry on failure and keeps the table out of the DOM', async () => {
    const api = { listCatalogs: vi.fn(async () => Promise.reject(new Error('nope'))) };
    const { el } = await setup(api as unknown as ApiMock);
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.querySelector('table')).toBeNull();
  });

  it('renders an empty state rather than an empty table', async () => {
    const { el } = await setup(makeApiMock([]));
    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('No catalogues yet');
  });

  describe('accessibility (structural)', () => {
    it('nests headings without skipping levels (shell owns h1; the screen owns the only h2)', async () => {
      const { el } = await setup(makeApiMock([makeRow()]));
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      // Rows are `th[scope=row]`, not headings: 25 catalogues would otherwise put
      // 25 h3s between the screen's h2 and anything after it.
      expect(el.querySelector('h3, h4, h5, h6')).toBeNull();
    });

    it('gives the table a name and scopes every header cell', async () => {
      const { el } = await setup(makeApiMock([makeRow()]));
      expect(el.querySelector('caption')?.textContent?.trim()).toBeTruthy();
      for (const th of el.querySelectorAll('thead th')) {
        expect(th.getAttribute('scope')).toBe('col');
      }
      expect(bodyRows(el)[0]?.querySelector('th')?.getAttribute('scope')).toBe('row');
    });

    it('labels the search input', async () => {
      const { el } = await setup(makeApiMock([makeRow()]));
      const input = el.querySelector('input[type="search"]') as HTMLInputElement;
      expect(el.querySelector(`label[for="${input.id}"]`)?.textContent?.trim()).toBeTruthy();
    });

    it('exposes one polite live region for the result count', async () => {
      const { el } = await setup(makeApiMock([makeRow()]));
      const regions = el.querySelectorAll('[role="status"]');
      expect(regions).toHaveLength(1);
      expect(regions[0]!.getAttribute('aria-live')).toBe('polite');
    });
  });
});
