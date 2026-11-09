/**
 * AECI-1238 — the per-product listing hide on the Products tab (§11d.6): a
 * "Hidden" badge, a Hide or Restore row action, and a Restore that is disabled with
 * a note while the product is hidden with its company.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminListingHide, AdminVendorProductRow } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';
import { VendorProductsTable } from './vendor-products-table';

const PRODUCT_ID = '00000000-0000-4000-8000-000000000030';

function makeHide(over: Partial<AdminListingHide> = {}): AdminListingHide {
  return {
    id: '00000000-0000-4000-8000-000000000071',
    entity_type: 'product',
    entity_id: PRODUCT_ID,
    parent_id: null,
    kind: 'lawful_order',
    reason: 'A court order.',
    internal_note: null,
    received_at: '2026-11-08',
    source_url: null,
    set_by: null,
    set_at: '2026-11-09T12:00:00.000Z',
    restored_by: null,
    restored_at: null,
    restore_reason: null,
    ...over,
  };
}

function makeRow(over: Partial<AdminVendorProductRow> = {}): AdminVendorProductRow {
  return {
    logo_url: null,
    id: PRODUCT_ID,
    slug: 'revit',
    name: 'Revit',
    product_role: 'application',
    is_primary: true,
    promotion_status: 'promoted',
    integration_count: 12,
    review_count: 7,
    rating_overall_avg: 4.2,
    updated_at: '2026-08-20T00:00:00.000Z',
    category_slugs: [],
    audience_slugs: [],
    phase_slugs: [],
    trade_slugs: [],
    listing_hide: null,
    ...over,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

let api: { hideProduct: ReturnType<typeof vi.fn>; restoreProduct: ReturnType<typeof vi.fn> };

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    hideProduct: vi.fn(async () => ({
      entity_type: 'product',
      entity_id: PRODUCT_ID,
      hidden_at: '2026-11-09T12:00:00.000Z',
      hide: makeHide(),
      product_ids: [],
    })),
    restoreProduct: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminVendorsApi, useValue: api }],
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(rows: AdminVendorProductRow[]) {
  const fixture = TestBed.createComponent(VendorProductsTable);
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('page', 1);
  fixture.componentRef.setInput('perPage', 25);
  fixture.componentRef.setInput('total', rows.length);
  fixture.componentRef.setInput('loading', false);
  fixture.componentRef.setInput('failed', false);
  const listingChanged = vi.fn();
  fixture.componentInstance.listingChanged.subscribe(listingChanged);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, listingChanged };
}

function trigger(el: HTMLElement): HTMLButtonElement {
  return el.querySelector(`#product-listing-action-${PRODUCT_ID}`) as HTMLButtonElement;
}

describe('VendorProductsTable listing hide', () => {
  it('offers Hide on a product on the public site, with no badge', async () => {
    const { el } = await setup([makeRow()]);
    expect(trigger(el).textContent?.trim()).toBe('Hide');
    expect(trigger(el).disabled).toBe(false);
    expect(el.querySelector('[data-testid="product-hidden-badge"]')).toBeNull();
  });

  it('badges a product hidden on its own and offers Restore', async () => {
    const { el } = await setup([makeRow({ listing_hide: makeHide() })]);
    expect(el.querySelector('[data-testid="product-hidden-badge"]')?.textContent?.trim()).toBe(
      'Hidden',
    );
    expect(trigger(el).textContent?.trim()).toBe('Restore');
    expect(trigger(el).disabled).toBe(false);
  });

  it('disables Restore with a note when the product is hidden with its company', async () => {
    const { el } = await setup([
      makeRow({ listing_hide: makeHide({ parent_id: '00000000-0000-4000-8000-000000000070' }) }),
    ]);
    const restore = trigger(el);
    expect(restore.textContent?.trim()).toBe('Restore');
    expect(restore.disabled).toBe(true);
    const note = el.querySelector('[data-testid="product-listing-with-vendor"]');
    expect(note?.textContent?.trim()).toBe(
      "Hidden with the company. Restore the company's listing.",
    );
    expect(restore.getAttribute('aria-describedby')).toBe(note?.id);
    expect(el.querySelector('[data-testid="product-hidden-badge"]')).not.toBeNull();
  });

  it('hides one product through the two-step form', async () => {
    const { fixture, el, listingChanged } = await setup([makeRow()]);
    trigger(el).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    const prefix = `product-${PRODUCT_ID}-listing`;
    // A product reads "discontinued", not "defunct" (the company label).
    expect(el.textContent).toContain('Product is discontinued');
    expect(el.textContent).not.toContain('Company is defunct');
    (el.querySelector(`#${prefix}-kind-defunct`) as HTMLInputElement).click();
    const reason = el.querySelector(`#${prefix}-reason`) as HTMLTextAreaElement;
    reason.value = 'The product was discontinued.';
    reason.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const continueButton = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Continue',
    )!;
    continueButton.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(el.textContent).toContain('Only this product is hidden.');
    const confirm = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Hide from the public site',
    )!;
    confirm.click();
    await flush();
    fixture.detectChanges();
    expect(api.hideProduct).toHaveBeenCalledWith(
      PRODUCT_ID,
      expect.objectContaining({ kind: 'defunct', reason: 'The product was discontinued.' }),
    );
    expect(listingChanged).toHaveBeenCalledTimes(1);

    // The page refetches quietly. The row's new Restore trigger takes focus back.
    fixture.componentRef.setInput('rows', [makeRow({ listing_hide: makeHide() })]);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(document.activeElement).toBe(trigger(el));
    expect(trigger(el).textContent?.trim()).toBe('Restore');
  });
});
