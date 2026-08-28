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
    expect(el.querySelectorAll('article')).toHaveLength(2);
    expect(el.textContent).toContain('Autodesk, Inc.');
    expect(el.textContent).toContain('bluebeam');
  });

  it('links each row to its detail page by id', async () => {
    const { el } = await setup(makeApiMock([makeRow()]));
    const link = el.querySelector('h3 a') as HTMLAnchorElement;
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
    const card = el.querySelector('article') as HTMLElement;
    expect(card.textContent).toContain('Products');
    expect(card.textContent).toContain('4');
    expect(card.textContent).toContain('Integrations built');
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
    expect(el.querySelectorAll('article')).toHaveLength(0);
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
    expect(el.querySelectorAll('article')).toHaveLength(1);
  });

  describe('accessibility (structural)', () => {
    it('nests headings without skipping levels (shell owns h1; h2 → h3 per card)', async () => {
      const { el } = await setup(
        makeApiMock([
          makeRow(),
          makeRow({ id: '00000000-0000-4000-8000-000000000011', slug: 'bluebeam' }),
        ]),
      );
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelectorAll('h3')).toHaveLength(2);
      expect(el.querySelector('h4, h5, h6')).toBeNull();
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
