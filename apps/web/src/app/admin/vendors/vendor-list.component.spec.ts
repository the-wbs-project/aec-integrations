/**
 * AECI-652 — `VendorList` logic + structural a11y.
 *
 * The live axe pass runs in Playwright against the authenticated route
 * (`authed-console.spec.ts`); an unauthenticated run would only ever audit the
 * loading state. Here we assert the filter/pagination logic and the structural
 * invariants axe relies on.
 *
 * The search cases carry the weight. This screen exists so an operator can find
 * a vendor that never filed a claim, so "search finds nothing" is a failure of
 * the whole point. AECI-1375 dropped the Account status filter and the
 * Entitlement and Term ends columns, and added a sortable Live licenses column.
 *
 * AECI-694 turned the cards into a table with two sortable headers, so the
 * structural assertions target `tbody tr` rather than `article`, and the sort
 * cases pin the thing that could silently become a lie: the request must carry
 * the key, because a control that reordered only the rows already loaded would
 * present a chunk as a ranking.
 *
 * The vendor-list revision made **every** column sortable and swapped prev/next
 * paging for scroll append, so two families of case carry weight here:
 *
 *  - every header sends its key to the API, and each one is a key the API's
 *    `AdminVendorSortSchema` actually accepts (a header naming a key the server
 *    rejects would 400, or worse, silently fall back to the default);
 *  - a sort/filter/search change RESETS the accumulation. Appending across a
 *    reordered set would splice duplicates into the table, which is the one
 *    failure mode scroll paging adds over prev/next.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminVendorSortSchema } from '@aeci/shared';
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
    live_license_count: 2,
    product_count: 4,
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

  it('shows Account active and the live license count side by side (AECI-1375)', async () => {
    // Neither is derived from the other on screen, so an active account with no
    // live license is visible at a glance.
    const { el } = await setup(makeApiMock([makeRow({ verified: true, live_license_count: 0 })]));
    expect(header(el, 'Account active')).toBeTruthy();
    expect(header(el, 'Live licenses')).toBeTruthy();
    const cells = [...bodyRows(el)[0]!.querySelectorAll('td')].map((td) => td.textContent?.trim());
    expect(cells).toContain('Active');
    expect(cells).toContain('0');
  });

  it('renders the live license count from the row', async () => {
    const { el } = await setup(makeApiMock([makeRow({ live_license_count: 7, product_count: 4 })]));
    const cells = [...bodyRows(el)[0]!.querySelectorAll('td')].map((td) => td.textContent?.trim());
    expect(cells).toContain('7');
  });

  it('has no Entitlement or Term ends column and no Account status filter (AECI-1375)', async () => {
    const { el } = await setup(makeApiMock([makeRow()]));
    expect(header(el, 'Entitlement')).toBeFalsy();
    expect(header(el, 'Term ends')).toBeFalsy();
    expect(el.querySelector('aec-select')).toBeNull();
    expect(el.textContent).not.toContain('Account status');
  });

  it('renders the per-row product count, and no integration column at all', async () => {
    const { el } = await setup(makeApiMock([makeRow({ product_count: 4 })]));
    expect(header(el, 'Products')).toBeTruthy();
    const cells = [...bodyRows(el)[0]!.querySelectorAll('td')].map((td) => td.textContent?.trim());
    expect(cells).toContain('4');
    // The count is a catalog fact acted on at `/admin/vendors/:id`; carrying it
    // here cost a correlated subquery per row for a number nobody triaged on.
    expect(header(el, 'Integrations')).toBeFalsy();
  });

  it('gives the slug its own column rather than a second line under the name', async () => {
    const { el } = await setup(makeApiMock([makeRow({ slug: 'autodesk' })]));
    expect(header(el, 'Slug')).toBeTruthy();
    // Not inside the row header: that cell is the link, and the slug is a
    // separately scannable (and separately sortable) identifier.
    const rowHeader = bodyRows(el)[0]!.querySelector('th[scope="row"]')!;
    expect(rowHeader.textContent).not.toContain('autodesk');
    const cells = [...bodyRows(el)[0]!.querySelectorAll('td')].map((td) => td.textContent?.trim());
    expect(cells).toContain('autodesk');
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

  it('never sends a `verified` filter: the API no longer takes one', async () => {
    const { api } = await setup(makeApiMock([makeRow()]));
    expect(lastQuery(api)).not.toHaveProperty('verified');
  });

  it('resets to chunk 1 AND discards the accumulation on any filter change', async () => {
    // Appending a re-filtered chunk onto rows fetched under the old filter would
    // show the operator rows that no longer match, and duplicate ids.
    const { fixture, el, api } = await setup(makeApiMock([makeRow()], 200));
    fixture.componentInstance['loadMore']();
    await settle();
    fixture.detectChanges();
    expect(lastQuery(api)['page']).toBe(2);
    expect(bodyRows(el)).toHaveLength(2);

    fixture.componentInstance['searchDraft'].set('auto');
    fixture.componentInstance['submitSearch']();
    await settle();
    fixture.detectChanges();
    expect(lastQuery(api)['page']).toBe(1);
    expect(bodyRows(el)).toHaveLength(1);
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

    it('gives EVERY column a control, and each sends a key the API accepts', async () => {
      // The rule is unchanged — a header the server cannot honour would reorder
      // only what is loaded and present it as a ranking. What changed is that
      // `resolveAdminVendorOrderBy` now orders by all six columns, so parsing
      // each emitted key against the real schema is what keeps them honest.
      const { el, fixture, api } = await setup(makeApiMock([makeRow()], 200));
      const labels = ['Vendor', 'Slug', 'Account active', 'Live licenses', 'Products', 'Updated'];
      for (const label of labels) {
        const button = header(el, label)?.querySelector('button');
        expect(button, label).toBeTruthy();
        button!.click();
        await settle();
        fixture.detectChanges();
        expect(AdminVendorSortSchema.parse(lastQuery(api)['sort'])).toBe(lastQuery(api)['sort']);
      }
      expect(
        new Set(api.listVendors.mock.calls.map((c) => (c[0] as { sort: string }).sort)).size,
      ).toBe(labels.length);
    });

    it('sends the natural direction on a first click, not a bare key', async () => {
      // `updated` descends naturally, so the first click must produce the same
      // order a pre-`order` bookmark produced.
      const { el, fixture, api } = await setup(makeApiMock([makeRow()], 200));
      header(el, 'Updated')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      expect(lastQuery(api)['sort']).toBe('updated');
      expect(lastQuery(api)['order']).toBe('desc');
    });

    it('sorts Live licenses by the `licenses` key, most licenses first (AECI-1375)', async () => {
      const { el, fixture, api } = await setup(makeApiMock([makeRow()], 200));
      expect(header(el, 'Live licenses')?.getAttribute('aria-sort')).toBe('none');
      header(el, 'Live licenses')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      expect(lastQuery(api)['sort']).toBe('licenses');
      expect(lastQuery(api)['order']).toBe('desc');
      expect(lastQuery(api)['page']).toBe(1);
      expect(header(el, 'Live licenses')?.getAttribute('aria-sort')).toBe('descending');
    });

    it('REVERSES on a second click of the active column', async () => {
      // The defect this replaced: clicking an active header was a deliberate
      // no-op, so an arrow that reads as a toggle did nothing.
      const { el, fixture, api } = await setup(makeApiMock([makeRow()], 200));
      const button = () => header(el, 'Updated')?.querySelector('button');

      button()?.click();
      await settle();
      fixture.detectChanges();
      expect(lastQuery(api)['order']).toBe('desc');
      expect(header(el, 'Updated')?.getAttribute('aria-sort')).toBe('descending');

      button()?.click();
      await settle();
      fixture.detectChanges();
      expect(lastQuery(api)['sort']).toBe('updated');
      expect(lastQuery(api)['order']).toBe('asc');
      // aria-sort has to follow, or the flip is invisible to assistive tech.
      expect(header(el, 'Updated')?.getAttribute('aria-sort')).toBe('ascending');
    });

    it("resets to the new column's natural direction when switching columns", async () => {
      // Moving from "Updated ↓" to "Vendor" must give A–Z, not Z–A: direction is
      // a property of the key, not a mode the table stays in.
      const { el, fixture, api } = await setup(makeApiMock([makeRow()], 200));
      header(el, 'Updated')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();

      header(el, 'Vendor')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      expect(lastQuery(api)['sort']).toBe('name');
      expect(lastQuery(api)['order']).toBe('asc');
      expect(header(el, 'Vendor')?.getAttribute('aria-sort')).toBe('ascending');
    });

    it('says what the next press will do, since the arrow is aria-hidden', async () => {
      const { el, fixture } = await setup(makeApiMock([makeRow()], 200));
      expect(header(el, 'Vendor')?.textContent).toContain('press to sort descending');

      header(el, 'Vendor')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      expect(header(el, 'Vendor')?.textContent).toContain('press to sort ascending');
    });

    it('discards the accumulation when the sort changes', async () => {
      const { el, fixture } = await setup(makeApiMock([makeRow()], 200));
      fixture.componentInstance['loadMore']();
      await settle();
      fixture.detectChanges();
      expect(bodyRows(el)).toHaveLength(2);

      header(el, 'Products')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      // Splicing a differently-ordered chunk onto the old one duplicates rows.
      expect(bodyRows(el)).toHaveLength(1);
    });
  });

  describe('scroll paging', () => {
    it('appends the next chunk instead of replacing the page', async () => {
      const { el, fixture, api } = await setup(makeApiMock([makeRow()], 200));
      fixture.componentInstance['loadMore']();
      await settle();
      fixture.detectChanges();
      expect(lastQuery(api)['page']).toBe(2);
      expect(bodyRows(el)).toHaveLength(2);
    });

    it('does not request a chunk past the end', async () => {
      // `total` is the count over the FILTER, so it — not an empty response — is
      // what says the accumulation is complete.
      const { fixture, api } = await setup(makeApiMock([makeRow()], 1));
      fixture.componentInstance['loadMore']();
      await settle();
      expect(api.listVendors).toHaveBeenCalledTimes(1);
    });

    it('reports the loaded and matching counts, not a page number', async () => {
      const { el } = await setup(makeApiMock([makeRow()], 200));
      expect(el.textContent).toContain('Showing 1 of 200');
      expect(el.textContent).not.toContain('Page 1');
    });

    it('keeps the loaded rows when an APPEND fails, and retries that same chunk', async () => {
      const api = makeApiMock([makeRow()], 200);
      const { el, fixture } = await setup(api);
      api.listVendors.mockRejectedValueOnce(new Error('boom'));

      fixture.componentInstance['loadMore']();
      await settle();
      fixture.detectChanges();
      // The first chunk is still on screen — a failed append is not a failed screen.
      expect(bodyRows(el)).toHaveLength(1);
      expect(el.querySelector('[role="alert"]')).toBeTruthy();

      (
        [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try again') as
          | HTMLButtonElement
          | undefined
      )?.click();
      await settle();
      fixture.detectChanges();
      // Chunk 2 again, not chunk 3 — a skipped chunk would silently lose rows.
      expect(lastQuery(api)['page']).toBe(2);
      expect(bodyRows(el)).toHaveLength(2);
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
