/**
 * AECI-652 — `VendorList` logic + structural a11y.
 *
 * The live axe pass runs in Playwright against the authenticated route
 * (`authed-console.spec.ts`); an unauthenticated run would only ever audit the
 * loading state. Here we assert the filter/pagination logic and the structural
 * invariants axe relies on.
 *
 * The filter cases carry the weight. This screen exists so an operator can find a
 * vendor that never filed a claim, so "search finds nothing" and "the Unverified
 * filter returns verified vendors" are both failures of the whole point.
 *
 * AECI-694 turned the cards into a table with two sortable headers, so the
 * structural assertions target `tbody tr` rather than `article`, and the sort
 * cases pin the thing that could silently become a lie: the request must carry
 * the key, because a control that reordered only the 25 rows on this page would
 * present a page as a ranking.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminVendorRow, AdminVendorsListResponse } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';
import { VendorList } from './vendor-list';

const VENDOR_ID = '00000000-0000-4000-8000-000000000010';

function makeRow(over: Partial<AdminVendorRow> = {}): AdminVendorRow {
  return {
    id: VENDOR_ID,
    slug: 'autodesk',
    company_name: 'Autodesk, Inc.',
    verified: true,
    tier: 'verified',
    status: 'active',
    period_end: '2027-09-01',
    product_count: 4,
    integration_count: 2,
    updated_at: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

interface ApiMock {
  listVendors: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: AdminVendorRow[], total = rows.length): ApiMock {
  const page: AdminVendorsListResponse = { data: rows, page: 1, perPage: 25, total };
  return { listVendors: vi.fn(async () => structuredClone(page)) };
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
      { provide: AdminVendorsApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(VendorList);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function lastQuery(api: ApiMock): Record<string, unknown> {
  return api.listVendors.mock.calls.at(-1)![0] as Record<string, unknown>;
}

function bodyRows(el: HTMLElement): HTMLTableRowElement[] {
  return [...el.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

/** The `<th>` whose button carries this label, from the header row. */
function header(el: HTMLElement, label: string): HTMLTableCellElement | undefined {
  return [...el.querySelectorAll<HTMLTableCellElement>('thead th')].find((th) =>
    th.textContent?.trim().startsWith(label),
  );
}

describe('VendorList', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('loads the first page and renders each vendor', async () => {
    const { el } = await setup(
      makeApiMock([
        makeRow(),
        makeRow({
          id: '00000000-0000-4000-8000-000000000011',
          slug: 'bluebeam',
          company_name: 'Bluebeam',
        }),
      ]),
    );
    expect(bodyRows(el)).toHaveLength(2);
    expect(el.textContent).toContain('Autodesk, Inc.');
    expect(el.textContent).toContain('bluebeam');
  });

  it('links each row to its detail page by id', async () => {
    const { el } = await setup(makeApiMock([makeRow()]));
    const link = el.querySelector('tbody th[scope="row"] a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/admin/vendors/${VENDOR_ID}`);
  });

  it('shows the mirror and the entitlement side by side, not one derived from the other', async () => {
    // `verified` is a denormalized copy of "an active entitlement row exists".
    // Rendering only one of them would hide drift, which is the failure mode the
    // `entitlement_mirror_drift` check exists for.
    const { el } = await setup(
      makeApiMock([makeRow({ verified: true, tier: null, status: null, period_end: null })]),
    );
    expect(el.textContent).toContain('Verified');
    expect(el.textContent).toContain('No entitlement');
  });

  it('renders per-row product and integration counts', async () => {
    const { el } = await setup(makeApiMock([makeRow({ product_count: 4, integration_count: 2 })]));
    expect(header(el, 'Products')).toBeTruthy();
    expect(header(el, 'Integrations')).toBeTruthy();
    const cells = [...bodyRows(el)[0]!.querySelectorAll('td')].map((td) => td.textContent?.trim());
    expect(cells).toContain('4');
    expect(cells).toContain('2');
  });

  it('renders a date-only term end on the day it actually ends', async () => {
    // `period_end` is legally a bare `YYYY-MM-DD` (`EntitlementTermDateSchema`
    // is a union, and the admin form is an `<input type="date">`). Handing that
    // to `DatePipe` with `'UTC'` parses it as LOCAL midnight and then shifts it,
    // so west of UTC a term ending on 1 September renders as 31 August. This
    // asserts the day, which is the part an operator would take to a supplier.
    const { el } = await setup(makeApiMock([makeRow({ period_end: '2027-09-01' })]));
    expect(el.textContent).toContain('Sep 1, 2027');
    expect(el.textContent).not.toContain('Aug 31, 2027');
  });

  it('sends the search term only on submit, not on every keystroke', async () => {
    const { el, fixture, api } = await setup(makeApiMock([makeRow()]));
    const input = el.querySelector('input[type="search"]') as HTMLInputElement;

    input.value = 'auto';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    // A request per keystroke over a `LIKE '%…%'` full scan would be a lot of
    // scans to answer a question the operator has not finished asking.
    expect(api.listVendors).toHaveBeenCalledTimes(1);

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await settle();
    fixture.detectChanges();

    expect(api.listVendors).toHaveBeenCalledTimes(2);
    expect(lastQuery(api)['search']).toBe('auto');
  });

  it('omits `verified` entirely for the "any status" default', async () => {
    const { api } = await setup(makeApiMock([makeRow()]));
    expect(lastQuery(api)).not.toHaveProperty('verified');
  });

  it("sends verified='false' as a string the API can distinguish", async () => {
    // The API's query schema is an enum-plus-transform, not `z.coerce.boolean()`
    // — sending a real `false` would be coerced back to `true` by the public
    // schema's shape (AECI-691). The string is the contract.
    const { fixture, api } = await setup(makeApiMock([makeRow()]));
    fixture.componentInstance['onVerifiedChange']('false');
    await settle();
    fixture.detectChanges();
    expect(lastQuery(api)['verified']).toBe('false');
  });

  it('resets to page 1 on any filter change', async () => {
    // Narrowing a filter while on page 6 would otherwise land on an empty page
    // that reads as "no results".
    const { fixture, api } = await setup(makeApiMock([makeRow()], 200));
    fixture.componentInstance['goToPage'](3);
    await settle();
    fixture.detectChanges();
    expect(lastQuery(api)['page']).toBe(3);

    fixture.componentInstance['onVerifiedChange']('true');
    await settle();
    fixture.detectChanges();
    expect(lastQuery(api)['page']).toBe(1);
  });

  it('renders the empty state when nothing matches', async () => {
    const { el } = await setup(makeApiMock([]));
    expect(el.textContent).toContain('No vendors match this search');
    expect(el.querySelector('table')).toBeNull();
  });

  it('shows a retryable state when the load fails, then recovers', async () => {
    const api = makeApiMock([makeRow()]);
    api.listVendors.mockRejectedValueOnce(new Error('boom'));
    const { el, fixture } = await setup(api);

    expect(el.querySelector('[role="alert"]')).toBeTruthy();
    (
      [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try again') as
        | HTMLButtonElement
        | undefined
    )?.click();
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(bodyRows(el)).toHaveLength(1);
  });

  describe('sorting (AECI-694)', () => {
    it('defaults to alphabetical, because this is a lookup surface', async () => {
      const { api } = await setup(makeApiMock([makeRow()]));
      expect(lastQuery(api)['sort']).toBe('name');
    });

    it('sends the key to the API rather than reordering the page in place', async () => {
      const { el, fixture, api } = await setup(makeApiMock([makeRow()], 200));
      header(el, 'Updated')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      expect(lastQuery(api)['sort']).toBe('updated');
      // A sort is a filter change: staying on page 6 of a reordered set lands on
      // rows the operator did not ask for.
      expect(lastQuery(api)['page']).toBe(1);
    });

    it('marks exactly the active column with aria-sort, in the direction the server uses', async () => {
      const { el, fixture } = await setup(makeApiMock([makeRow()]));
      expect(header(el, 'Vendor')?.getAttribute('aria-sort')).toBe('ascending');
      expect(header(el, 'Updated')?.getAttribute('aria-sort')).toBe('none');

      header(el, 'Updated')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();

      // `updated` descends on the server (`resolveVendorOrderBy`), so that is
      // what `aria-sort` has to report.
      expect(header(el, 'Updated')?.getAttribute('aria-sort')).toBe('descending');
      expect(header(el, 'Vendor')?.getAttribute('aria-sort')).toBe('none');
    });

    it('gives the unsortable columns no control at all', async () => {
      const { el } = await setup(makeApiMock([makeRow()]));
      // The API takes `created | name | updated` and no direction, so a control
      // on Products or Term ends could only ever sort one page of results.
      for (const label of ['Verified', 'Entitlement', 'Products', 'Integrations', 'Term ends']) {
        expect(header(el, label)?.querySelector('button')).toBeFalsy();
      }
    });
  });

  describe('accessibility (structural)', () => {
    it('nests headings without skipping levels (shell owns h1; the screen owns the only h2)', async () => {
      const { el } = await setup(
        makeApiMock([
          makeRow(),
          makeRow({ id: '00000000-0000-4000-8000-000000000011', slug: 'bluebeam' }),
        ]),
      );
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      // Rows are `th[scope=row]`, not headings: a table of 25 vendors would
      // otherwise put 25 h3s between the screen's h2 and anything after it.
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
      expect(regions[0].getAttribute('aria-live')).toBe('polite');
    });
  });
});
