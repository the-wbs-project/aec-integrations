/**
 * `VendorConnectorCatalogue` (AECI-1083) — the connector catalogue seat's Catalogue
 * tab. What is pinned:
 *
 *  - the list: summary, one row per listing, every mapping's words, the reach tag;
 *  - the read-only state on a review-managed catalogue: no Edit anywhere;
 *  - a connector product with no catalogue, and a failed read with a retry;
 *  - edit and save: the PATCH echo is spliced in, focus returns to Edit, and the save
 *    is announced through the portal's one live region;
 *  - each save error, in the vendor's words, beside the form;
 *  - the lane taken back mid-edit: the form goes and a list-level alert says why;
 *  - the live cursor: a moved `catalogue` scope re-reads the page, but never over an
 *    open form, where it offers a reload instead.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  VendorConnectorStubMappingEditResponse,
  VendorConnectorCatalogResponse,
  VendorConnectorListing,
} from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi, type VendorConnectorCatalogFilters } from '../vendor-api';
import { catalogueListings } from '../vendor-catalogue-fixtures';
import { VENDOR_ME_CONNECTOR_SEAT_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorConnectorCatalogue } from './vendor-connector-catalogue';

const PRODUCT = VENDOR_ME_CONNECTOR_SEAT_FIXTURE.products[0]!.id;

function page(
  managedBy: 'vendor' | 'review' | null,
  listings: VendorConnectorListing[] = catalogueListings('t').slice(0, 3),
  total = listings.length,
): VendorConnectorCatalogResponse {
  return {
    data: listings,
    page: 1,
    perPage: 25,
    total,
    product_id: PRODUCT,
    catalog:
      managedBy === null
        ? null
        : {
            id: 'rec-cat',
            managed_by: managedBy,
            last_ingested_at: '2026-09-20T06:00:00.000Z',
            listings: 30,
            unmatched: 7,
            publishable: 9,
          },
  };
}

let getConnectorCatalog: ReturnType<typeof vi.fn>;
let updateConnectorMapping: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getConnectorCatalog = vi.fn(async () => page('vendor'));
  updateConnectorMapping = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: VendorApi,
        useValue: {
          getConnectorCatalog,
          updateConnectorMapping,
          searchProducts: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, perPage: 8 }),
        },
      },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_CONNECTOR_SEAT_FIXTURE);
});

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await fixture.whenStable();
    fixture.detectChanges();
  }
}

async function create(): Promise<ComponentFixture<VendorConnectorCatalogue>> {
  const fixture = TestBed.createComponent(VendorConnectorCatalogue);
  fixture.componentRef.setInput('productId', PRODUCT);
  fixture.componentRef.setInput('productName', 'Agave');
  await settle(fixture);
  return fixture;
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim();
const rows = (f: ComponentFixture<unknown>) => [...el(f).querySelectorAll('[data-listing]')];
const editButtons = (f: ComponentFixture<unknown>) =>
  [...el(f).querySelectorAll<HTMLButtonElement>('[data-mapping] button')].filter((b) =>
    text(b)?.startsWith('Edit'),
  );

function echo(
  overrides: Partial<VendorConnectorStubMappingEditResponse['mapping']> = {},
  changed = true,
): VendorConnectorStubMappingEditResponse {
  return {
    catalog_id: 'rec-cat',
    stub_id: 't-st-00',
    changed,
    mapping: {
      id: 't-map-00-0',
      status: 'mapped',
      product: { id: '00000000-0000-4000-8000-000000005301', slug: 'procore', name: 'Procore' },
      confidence: 'low',
      evidence_url: null,
      decided_by: 'vendor',
      decided_at: '2026-09-24T00:00:00.000Z',
      publishable: true,
      ...overrides,
    },
  };
}

function apiError(status: number, code: string, field?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: { error: { code, message: code, ...(field ? { field } : {}) } },
  });
}

async function openFirstEdit(fixture: ComponentFixture<VendorConnectorCatalogue>) {
  editButtons(fixture)[0]!.click();
  await settle(fixture);
  return el(fixture).querySelector('form[aria-label^="Edit the match"]') as HTMLFormElement;
}

describe('VendorConnectorCatalogue — the list', () => {
  it('reads page 1 of the product’s catalogue once, in the browser', async () => {
    await create();
    expect(getConnectorCatalog).toHaveBeenCalledTimes(1);
    const [productId, filters] = getConnectorCatalog.mock.calls[0] as [
      string,
      VendorConnectorCatalogFilters,
    ];
    expect(productId).toBe(PRODUCT);
    expect(filters).toEqual({ page: 1, perPage: 25, state: null, search: '' });
  });

  it('shows the summary, one row per listing, and each match in words', async () => {
    const fixture = await create();
    expect(text(el(fixture).querySelector('[data-catalogue-summary]'))).toBe(
      '30 listings · 7 with no match yet · as of September 20, 2026',
    );
    expect(rows(fixture).map((r) => text(r.querySelector('h3')))).toEqual([
      'Procore',
      'Autodesk Construction Cloud',
      'Acumatica Construction Edition',
    ]);
    const [procore, acc, acumatica] = rows(fixture);
    expect(text(procore)).toContain('Matched to Procore');
    expect(text(procore)).toContain('Counts toward reach');
    expect(text(procore)).toContain('Decided by AECi');
    expect(text(procore)).toContain('Confidence: High');
    // A name-match suggestion is not publishable, and says it is unconfirmed.
    expect(text(acc)).toContain('Suggested by name, not confirmed');
    expect(text(acc)).not.toContain('Counts toward reach');
    expect(text(acumatica)).toContain('Confirmed by your company');
  });

  it('opens listing and evidence links in a new tab, and says so to a screen reader', async () => {
    const fixture = await create();
    const links = [...rows(fixture)[0]!.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('target'))).toEqual(['_blank', '_blank']);
    expect(links.every((a) => a.getAttribute('rel') === 'noopener noreferrer')).toBe(true);
    expect(text(links[0])).toBe('View listing for Procore, opens in a new tab');
  });

  it('says a listing with no match has none, with no control on it', async () => {
    const listings = catalogueListings('t').filter((l) => l.mappings.length === 0);
    getConnectorCatalog.mockResolvedValueOnce(page('vendor', listings.slice(0, 1)));
    const fixture = await create();
    expect(text(rows(fixture)[0])).toContain('No match recorded yet.');
    expect(rows(fixture)[0]!.querySelector('button')).toBeNull();
  });

  it('gives every match an Edit button on a vendor-managed catalogue, named for its listing', async () => {
    const fixture = await create();
    expect(el(fixture).querySelector('[data-catalogue-vendor-managed]')).not.toBeNull();
    const buttons = editButtons(fixture);
    expect(buttons).toHaveLength(3);
    expect(text(buttons[0])).toBe('Edit the match for Procore');
  });

  it('is read-only on a review-managed catalogue, and says the AECi team maintains it', async () => {
    getConnectorCatalog.mockResolvedValueOnce(page('review'));
    const fixture = await create();
    expect(text(el(fixture).querySelector('[data-catalogue-review-managed]'))).toContain(
      'The AECi team maintains this catalogue for now, so it is read-only here.',
    );
    expect(editButtons(fixture)).toHaveLength(0);
    // Not the lapsed-access copy (AECI-1082): nothing here says access comes back.
    expect(text(el(fixture))).not.toContain('paused');
    expect(rows(fixture)).toHaveLength(3);
  });

  it('says so when AECi holds no catalogue for the product', async () => {
    getConnectorCatalog.mockResolvedValueOnce(page(null, []));
    const fixture = await create();
    expect(text(el(fixture).querySelector('[data-catalogue-none]'))).toContain(
      'AECi does not hold a catalogue for this product yet.',
    );
  });

  it('offers a retry when the read fails, and loads on retry', async () => {
    getConnectorCatalog.mockRejectedValueOnce(new Error('offline'));
    const fixture = await create();
    const failed = el(fixture).querySelector('[data-catalogue-failed]');
    expect(text(failed)).toContain('Could not load this catalogue.');
    failed!.querySelector('button')!.click();
    await settle(fixture);
    expect(rows(fixture)).toHaveLength(3);
  });

  it('pages, and says where it is', async () => {
    getConnectorCatalog.mockResolvedValue(page('vendor', catalogueListings('t').slice(0, 3), 60));
    const fixture = await create();
    expect(text(el(fixture).querySelector('[data-catalogue-page]'))).toBe('Page 1 of 3');
    const next = [...el(fixture).querySelectorAll('nav button')].find(
      (b) => text(b) === 'Next',
    ) as HTMLButtonElement;
    next.click();
    await settle(fixture);
    const last = getConnectorCatalog.mock.calls.at(-1) as [string, VendorConnectorCatalogFilters];
    expect(last[1].page).toBe(2);
  });

  it('searches from page 1 with the typed text', async () => {
    const fixture = await create();
    const input = el(fixture).querySelector<HTMLInputElement>('#vendor-catalogue-search')!;
    input.value = 'sage';
    input.dispatchEvent(new Event('input'));
    el(fixture).querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit();
    await settle(fixture);
    const last = getConnectorCatalog.mock.calls.at(-1) as [string, VendorConnectorCatalogFilters];
    expect(last[1]).toMatchObject({ page: 1, search: 'sage' });
  });

  it('says a filtered page is empty differently from an empty catalogue', async () => {
    getConnectorCatalog.mockResolvedValue(page('vendor', [], 0));
    const fixture = await create();
    expect(text(el(fixture).querySelector('[data-catalogue-empty]'))).toBe(
      'This catalogue has no listings yet.',
    );
  });
});

describe('VendorConnectorCatalogue — edit and save', () => {
  it('opens one form, seeded from the row, and disables the other Edit buttons', async () => {
    const fixture = await create();
    const form = await openFirstEdit(fixture);
    expect(form).not.toBeNull();
    expect(text(form.querySelector('[data-chosen-product]'))).toBe('Procore');
    const evidence = form.querySelector<HTMLInputElement>('input[type="url"]')!;
    expect(evidence.value).toBe('https://agave.example.com/integrations/procore');
    // The hint is wired in from first render.
    expect(evidence.getAttribute('aria-describedby')).toContain('-evidence-hint');
    expect(editButtons(fixture).every((b) => b.disabled)).toBe(true);
  });

  it('saves: sends all four fields, splices the echo in, announces, and closes', async () => {
    updateConnectorMapping.mockResolvedValueOnce(echo({ confidence: 'low' }));
    const fixture = await create();
    const form = await openFirstEdit(fixture);
    form.requestSubmit();
    await settle(fixture);

    expect(updateConnectorMapping).toHaveBeenCalledWith('t-map-00-0', {
      status: 'mapped',
      productId: '00000000-0000-4000-8000-000000005301',
      confidence: 'high',
      evidenceUrl: 'https://agave.example.com/integrations/procore',
    });
    expect(el(fixture).querySelector('form[aria-label^="Edit the match"]')).toBeNull();
    const row = rows(fixture)[0]!;
    expect(text(row)).toContain('Confirmed by your company');
    expect(text(row)).toContain('Confidence: Low');
    expect(text(row)).not.toContain('never shown');
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Match for Procore saved.');
    // No refetch: the echo is the committed row.
    expect(getConnectorCatalog).toHaveBeenCalledTimes(1);
  });

  it('announces a no-op save as one', async () => {
    updateConnectorMapping.mockResolvedValueOnce(echo({}, false));
    const fixture = await create();
    (await openFirstEdit(fixture)).requestSubmit();
    await settle(fixture);
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain(
      'Nothing changed on the match for Procore.',
    );
  });

  it('cancel closes the form without a request', async () => {
    const fixture = await create();
    const form = await openFirstEdit(fixture);
    const cancel = [...form.querySelectorAll('button')].find((b) => text(b) === 'Cancel')!;
    cancel.click();
    await settle(fixture);
    expect(el(fixture).querySelector('form[aria-label^="Edit the match"]')).toBeNull();
    expect(updateConnectorMapping).not.toHaveBeenCalled();
  });

  it('refuses an evidence link that is not https, beside the field, without a request', async () => {
    const fixture = await create();
    const form = await openFirstEdit(fixture);
    const evidence = form.querySelector<HTMLInputElement>('input[type="url"]')!;
    evidence.value = 'http://agave.example.com';
    evidence.dispatchEvent(new Event('input'));
    form.requestSubmit();
    await settle(fixture);
    expect(updateConnectorMapping).not.toHaveBeenCalled();
    expect(evidence.getAttribute('aria-invalid')).toBe('true');
    // The error is APPENDED to the hint, never swapped for it.
    expect(evidence.getAttribute('aria-describedby')).toMatch(/-evidence-hint .*-evidence-error$/);
    expect(text(form)).toContain('Use a full link that starts with https://.');
  });

  it('asks for a product when the product was cleared on a status that names one', async () => {
    const fixture = await create();
    const form = await openFirstEdit(fixture);
    [...form.querySelectorAll('button')].find((b) => text(b)?.startsWith('Change'))!.click();
    await settle(fixture);
    form.requestSubmit();
    await settle(fixture);
    expect(updateConnectorMapping).not.toHaveBeenCalled();
    expect(text(form)).toContain('Choose the product, or pick a status that names none.');
  });

  it.each([
    [
      apiError(409, 'MAPPING_CONFLICT'),
      'This listing already has a match to that product, or already carries a decision that names no product.',
    ],
    [
      apiError(422, 'VALIDATION_FAILED', 'productId'),
      'Choose a product that is published on AECi, or pick a status that names no product.',
    ],
    [apiError(404, 'NOT_FOUND'), 'This match no longer exists. Reload the list'],
    [apiError(429, 'RATE_LIMITED'), 'Too many saves in a short time.'],
    [apiError(401, 'UNAUTHORIZED'), 'Your session has ended. Sign in again, then save.'],
    [new Error('offline'), 'Could not save this match. Try again.'],
  ])('shows a failed save beside the form, as an alert (%#)', async (err, words) => {
    updateConnectorMapping.mockRejectedValueOnce(err);
    const fixture = await create();
    const form = await openFirstEdit(fixture);
    form.requestSubmit();
    await settle(fixture);
    const alert = form.querySelector('[role="alert"]');
    expect(text(alert)).toContain(words);
    // The form stays open with the vendor's draft.
    expect(el(fixture).querySelector('form[aria-label^="Edit the match"]')).not.toBeNull();
  });

  it('on CATALOG_REVIEW_MANAGED, drops the form, alerts at the list, and re-reads as read-only', async () => {
    updateConnectorMapping.mockRejectedValueOnce(apiError(409, 'CATALOG_REVIEW_MANAGED'));
    const fixture = await create();
    getConnectorCatalog.mockResolvedValueOnce(page('review'));
    (await openFirstEdit(fixture)).requestSubmit();
    await settle(fixture);
    expect(el(fixture).querySelector('form[aria-label^="Edit the match"]')).toBeNull();
    const alert = el(fixture).querySelector('[data-catalogue-alert]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(text(alert)).toContain('The AECi team took this catalogue back while you were editing');
    expect(el(fixture).querySelector('[data-catalogue-review-managed]')).not.toBeNull();
    expect(editButtons(fixture)).toHaveLength(0);
  });
});

describe('VendorConnectorCatalogue — the live cursor', () => {
  it('re-reads the open page when the catalogue scope moves, without blanking it', async () => {
    const fixture = await create();
    const store = TestBed.inject(VendorPortalStore);
    getConnectorCatalog.mockResolvedValueOnce(page('review'));
    await store.revalidate(['catalogue']);
    await settle(fixture);
    expect(getConnectorCatalog).toHaveBeenCalledTimes(2);
    expect(el(fixture).querySelector('[data-catalogue-review-managed]')).not.toBeNull();
  });

  it('keeps the last list on screen when a background refresh fails, with a retry', async () => {
    const fixture = await create();
    getConnectorCatalog.mockRejectedValueOnce(new Error('offline'));
    await TestBed.inject(VendorPortalStore).revalidate(['catalogue']);
    await settle(fixture);
    expect(rows(fixture)).toHaveLength(3);
    const notice = el(fixture).querySelector('[data-catalogue-refresh-failed]');
    expect(text(notice)).toContain('Could not refresh the list.');
    notice!.querySelector('button')!.click();
    await settle(fixture);
    expect(el(fixture).querySelector('[data-catalogue-refresh-failed]')).toBeNull();
  });

  it('never replaces an open form: it offers a reload instead', async () => {
    const fixture = await create();
    const store = TestBed.inject(VendorPortalStore);
    await openFirstEdit(fixture);
    await store.revalidate(['catalogue']);
    await settle(fixture);
    expect(getConnectorCatalog).toHaveBeenCalledTimes(1);
    expect(el(fixture).querySelector('form[aria-label^="Edit the match"]')).not.toBeNull();
    const stale = el(fixture).querySelector('[data-catalogue-stale]');
    expect(text(stale)).toContain('This catalogue changed elsewhere.');

    stale!.querySelector('button')!.click();
    await settle(fixture);
    expect(getConnectorCatalog).toHaveBeenCalledTimes(2);
    expect(el(fixture).querySelector('form[aria-label^="Edit the match"]')).toBeNull();
    expect(el(fixture).querySelector('[data-catalogue-stale]')).toBeNull();
  });

  it('catches up when the form closes after the list went stale', async () => {
    const fixture = await create();
    const store = TestBed.inject(VendorPortalStore);
    const form = await openFirstEdit(fixture);
    await store.revalidate(['catalogue']);
    await settle(fixture);
    [...form.querySelectorAll('button')].find((b) => text(b) === 'Cancel')!.click();
    await settle(fixture);
    expect(getConnectorCatalog).toHaveBeenCalledTimes(2);
  });
});
