/**
 * AECI-1238 — "Listing visibility" on the Vendor tab (§11d.6) and the shared
 * two-step `ListingHideForm` it opens.
 *
 * The load-bearing assertions: nothing is sent from step 1, a complaint without a
 * source never reaches step 2, the confirm step names exactly the products that
 * move (and counts the ones that stay hidden on their own), and a 409 that means
 * the listing moved hands the host a reload.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminListingHide, AdminListingHideProduct, AdminVendorDetail } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';
import { VendorListingVisibility } from './vendor-listing-visibility';

const VENDOR_ID = '00000000-0000-4000-8000-000000000010';
const HIDE_ID = '00000000-0000-4000-8000-000000000070';

function product(over: Partial<AdminListingHideProduct>): AdminListingHideProduct {
  return {
    id: '00000000-0000-4000-8000-000000000031',
    slug: 'revit',
    name: 'Revit',
    hidden_at: null,
    hidden_with_vendor: false,
    ...over,
  };
}

const PRODUCTS: AdminListingHideProduct[] = [
  product({ id: '00000000-0000-4000-8000-000000000031', slug: 'acc', name: 'ACC' }),
  product({ id: '00000000-0000-4000-8000-000000000032', slug: 'revit', name: 'Revit' }),
  product({
    id: '00000000-0000-4000-8000-000000000033',
    slug: 'old',
    name: 'Old Tool',
    hidden_at: '2026-10-01T00:00:00.000Z',
  }),
];

function makeHide(over: Partial<AdminListingHide> = {}): AdminListingHide {
  return {
    id: HIDE_ID,
    entity_type: 'vendor',
    entity_id: VENDOR_ID,
    parent_id: null,
    kind: 'complaint_under_review',
    reason: 'A complaint names this listing.',
    internal_note: 'Ticket 42.',
    received_at: '2026-11-08',
    source_url: 'https://example.com/complaint',
    set_by: null,
    set_at: '2026-11-09T12:00:00.000Z',
    restored_by: null,
    restored_at: null,
    restore_reason: null,
    ...over,
  };
}

function makeVendor(over: Partial<AdminVendorDetail> = {}): AdminVendorDetail {
  return {
    id: VENDOR_ID,
    company_name: 'Autodesk, Inc.',
    listing_hide: null,
    listing_hide_products: PRODUCTS,
    ...over,
  } as AdminVendorDetail;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

let api: {
  hideVendor: ReturnType<typeof vi.fn>;
  restoreVendor: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    hideVendor: vi.fn(async () => ({
      entity_type: 'vendor',
      entity_id: VENDOR_ID,
      hidden_at: '2026-11-09T12:00:00.000Z',
      hide: makeHide(),
      product_ids: [],
    })),
    restoreVendor: vi.fn(async () => ({
      entity_type: 'vendor',
      entity_id: VENDOR_ID,
      hidden_at: null,
      hide: null,
      product_ids: [],
    })),
  };
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminVendorsApi, useValue: api }],
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(vendor: AdminVendorDetail) {
  const fixture = TestBed.createComponent(VendorListingVisibility);
  fixture.componentRef.setInput('vendor', vendor);
  fixture.componentRef.setInput('idPrefix', 'detail');
  const changed = vi.fn();
  const announce = vi.fn();
  fixture.componentInstance.changed.subscribe(changed);
  fixture.componentInstance.announce.subscribe(announce);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, changed, announce };
}

async function render(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.replace(/\s+/g, ' ').trim() === text,
  );
  if (!found) throw new Error(`No button "${text}"`);
  return found as HTMLButtonElement;
}

function type(el: HTMLElement, id: string, value: string): void {
  const field = el.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

function squash(el: Element | null): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('VendorListingVisibility', () => {
  it('says the company is on the public site and offers the hide', async () => {
    const { el } = await setup(makeVendor());
    expect(squash(el)).toContain('On the public site.');
    expect(button(el, 'Hide from the public site')).toBeTruthy();
    expect(el.querySelector('[data-testid="listing-hide-form"]')).toBeNull();
  });

  it('refuses step 1 without a kind, a reason and, for a complaint, a source link', async () => {
    const { fixture, el } = await setup(makeVendor());
    button(el, 'Hide from the public site').click();
    await render(fixture);
    expect(el.querySelector('[data-testid="listing-hide-form"]')).not.toBeNull();
    // The received date defaults to today.
    const received = el.querySelector('#detail-vendor-listing-received') as HTMLInputElement;
    expect(received.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    button(el, 'Continue').click();
    await render(fixture);
    expect(squash(el)).toContain('Choose why the listing is hidden.');
    expect(squash(el)).toContain('Enter a reason for the vendor.');

    (
      el.querySelector('#detail-vendor-listing-kind-complaint_under_review') as HTMLInputElement
    ).click();
    type(el, 'detail-vendor-listing-reason', 'A complaint names this listing.');
    await render(fixture);
    button(el, 'Continue').click();
    await render(fixture);
    expect(squash(el)).toContain('A complaint under review needs the link to the public source.');
    expect(el.querySelector('[data-testid="listing-hide-confirm-heading"]')).toBeNull();

    type(el, 'detail-vendor-listing-source', 'http://example.com/complaint');
    await render(fixture);
    button(el, 'Continue').click();
    await render(fixture);
    expect(squash(el)).toContain('Use an https:// link.');
    expect(api.hideVendor).not.toHaveBeenCalled();
  });

  it('confirms with the products that go down, then sends the hide', async () => {
    const { fixture, el, changed, announce } = await setup(makeVendor());
    button(el, 'Hide from the public site').click();
    await render(fixture);
    (el.querySelector('#detail-vendor-listing-kind-lawful_order') as HTMLInputElement).click();
    type(el, 'detail-vendor-listing-received', '2026-11-08');
    type(el, 'detail-vendor-listing-reason', 'A court order names this listing.');
    type(el, 'detail-vendor-listing-note', 'Order 7.');
    await render(fixture);
    button(el, 'Continue').click();
    await render(fixture);

    expect(squash(el.querySelector('[data-testid="listing-hide-confirm-heading"]'))).toBe(
      'Hide Autodesk, Inc. from the public site?',
    );
    const impact = el.querySelector('[data-testid="listing-visibility-impact"]');
    expect(squash(impact)).toContain('2 products are also hidden:');
    expect([...(impact?.querySelectorAll('li') ?? [])].map((li) => squash(li))).toEqual([
      'ACC',
      'Revit',
    ]);
    expect(squash(impact)).toContain('1 product is already hidden on its own and stays hidden.');
    // Step 2 is the only place a request leaves from.
    expect(api.hideVendor).not.toHaveBeenCalled();

    button(el, 'Hide from the public site').click();
    await render(fixture);
    expect(api.hideVendor).toHaveBeenCalledWith(VENDOR_ID, {
      kind: 'lawful_order',
      reason: 'A court order names this listing.',
      internalNote: 'Order 7.',
      receivedAt: '2026-11-08',
      sourceUrl: null,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('Listing hidden.'));
    expect(el.querySelector('[data-testid="listing-hide-form"]')).toBeNull();
  });

  it('shows the hide, and its restore lists the products that come back', async () => {
    const vendor = makeVendor({
      listing_hide: makeHide(),
      listing_hide_products: [
        product({
          id: '00000000-0000-4000-8000-000000000031',
          name: 'ACC',
          hidden_at: '2026-11-09T12:00:00.000Z',
          hidden_with_vendor: true,
        }),
        product({
          id: '00000000-0000-4000-8000-000000000033',
          name: 'Old Tool',
          hidden_at: '2026-10-01T00:00:00.000Z',
        }),
      ],
    });
    const { fixture, el, changed } = await setup(vendor);
    const state = squash(el.querySelector('[data-testid="listing-visibility-hidden"]'));
    expect(state).toContain('Hidden from the public site since');
    expect(state).toContain('Complaint under review');
    expect(state).toContain('A complaint names this listing.');
    expect(state).toContain('Ticket 42.');
    expect(
      el.querySelector('[data-testid="listing-visibility-source"]')?.getAttribute('href'),
    ).toBe('https://example.com/complaint');

    button(el, 'Restore the listing').click();
    await render(fixture);
    // A restore asks only for the reason pair.
    expect(el.querySelector('#detail-vendor-listing-kind-lawful_order')).toBeNull();
    type(el, 'detail-vendor-listing-reason', 'The complaint was withdrawn.');
    await render(fixture);
    button(el, 'Continue').click();
    await render(fixture);
    const impact = el.querySelector('[data-testid="listing-visibility-impact"]');
    expect(squash(impact)).toContain('1 product comes back with it:');
    expect([...(impact?.querySelectorAll('li') ?? [])].map((li) => squash(li))).toEqual(['ACC']);
    expect(squash(impact)).toContain('1 product is already hidden on its own and stays hidden.');

    button(el, 'Put back on the public site').click();
    await render(fixture);
    expect(api.restoreVendor).toHaveBeenCalledWith(VENDOR_ID, 'The complaint was withdrawn.', '');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('hands the host a reload when the listing moved under the operator', async () => {
    api.hideVendor.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'LISTING_HIDDEN', message: 'Already hidden.' } },
      }),
    );
    const { fixture, el, changed, announce } = await setup(makeVendor());
    button(el, 'Hide from the public site').click();
    await render(fixture);
    (el.querySelector('#detail-vendor-listing-kind-defunct') as HTMLInputElement).click();
    type(el, 'detail-vendor-listing-reason', 'The company closed.');
    await render(fixture);
    button(el, 'Continue').click();
    await render(fixture);
    button(el, 'Hide from the public site').click();
    await render(fixture);
    expect(announce).toHaveBeenCalledWith(
      'This listing is already hidden. The page has been reloaded.',
    );
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps the form open with the error on a refusal that is not a state change', async () => {
    api.hideVendor.mockRejectedValue(
      new HttpErrorResponse({ status: 500, error: { error: { code: 'INTERNAL' } } }),
    );
    const { fixture, el, changed } = await setup(makeVendor());
    button(el, 'Hide from the public site').click();
    await render(fixture);
    (el.querySelector('#detail-vendor-listing-kind-defunct') as HTMLInputElement).click();
    type(el, 'detail-vendor-listing-reason', 'The company closed.');
    await render(fixture);
    button(el, 'Continue').click();
    await render(fixture);
    button(el, 'Hide from the public site').click();
    await render(fixture);
    expect(squash(el.querySelector('[role="alert"]'))).toBe(
      'Could not save the change. Nothing was saved. Try again.',
    );
    expect(changed).not.toHaveBeenCalled();
  });
});
