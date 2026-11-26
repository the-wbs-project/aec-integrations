/**
 * AECI-1238 — the per-product listing hide on the Products tab (§11d.6): a
 * "Hidden" badge, a Hide or Restore row action, and a Restore that is disabled with
 * a note while the product is hidden with its company.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminListingHide, AdminVendorProductRow } from '@aeci/shared';

import { AdminLogoEditor } from './admin-logo-editor/admin-logo-editor';
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
    connector_kind: null,
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

let api: {
  hideProduct: ReturnType<typeof vi.fn>;
  restoreProduct: ReturnType<typeof vi.fn>;
  getDeliveredPairs?: ReturnType<typeof vi.fn>;
};

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

describe('VendorProductsTable connector kind (AECI-2036)', () => {
  it('shows the kind control on connector and hybrid rows only', async () => {
    const { el } = await setup([
      makeRow(),
      makeRow({
        id: '00000000-0000-4000-8000-000000000031',
        slug: 'sync',
        product_role: 'connector',
      }),
      makeRow({ id: '00000000-0000-4000-8000-000000000032', slug: 'hy', product_role: 'hybrid' }),
    ]);
    const controls = el.querySelectorAll('aec-connector-kind-control');
    expect(controls).toHaveLength(2);
    expect(el.querySelector(`#connector-kind-${PRODUCT_ID}-trigger`)).toBeNull();
  });

  // AECI-2046: the curated facts form sits under the kind control on a Sync Service only.
  it('shows the Sync Service facts form on a Sync Service row only', async () => {
    const { el } = await setup([
      makeRow({
        id: '00000000-0000-4000-8000-000000000031',
        slug: 'sync',
        product_role: 'connector',
        connector_kind: 'sync_service',
        sync_facts: {
          sync_frequency: 'Hourly',
          sync_support: null,
          sync_setup: null,
          source_url: 'https://example.com/sync',
          recorded_at: '2026-11-20T00:00:00.000Z',
        },
      }),
      makeRow({
        id: '00000000-0000-4000-8000-000000000033',
        slug: 'platform',
        product_role: 'connector',
        connector_kind: 'integration_platform',
      }),
      makeRow({ id: '00000000-0000-4000-8000-000000000032', slug: 'hy', product_role: 'hybrid' }),
    ]);
    const forms = el.querySelectorAll('aec-sync-facts-control');
    expect(forms).toHaveLength(1);
    expect(
      el.querySelector<HTMLInputElement>(
        '#sync-facts-sync_frequency-00000000-0000-4000-8000-000000000031',
      )!.value,
    ).toBe('Hourly');
  });
});

describe('VendorProductsTable delivered pairs (AECI-2045)', () => {
  it('opens one connector row’s delivered pairs under it, as a disclosure', async () => {
    api.getDeliveredPairs = vi.fn(async () => ({
      connector: { id: PRODUCT_ID, name: 'Sync', slug: 'sync', connector_kind: 'sync_service' },
      connector_vendors: [],
      pairs: [],
    }));
    const { fixture, el } = await setup([
      makeRow({ product_role: 'connector', connector_kind: 'sync_service', name: 'Sync' }),
    ]);
    const toggle = el.querySelector('[data-testid="delivered-pairs-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(`delivered-pairs-${PRODUCT_ID}`);
    toggle.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      el.querySelector(`#delivered-pairs-${PRODUCT_ID} aec-delivered-pairs-panel`),
    ).not.toBeNull();
    expect(api.getDeliveredPairs).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('offers no delivered pairs on an application row', async () => {
    const { el } = await setup([makeRow()]);
    expect(el.querySelector('[data-testid="delivered-pairs-toggle"]')).toBeNull();
  });
});

describe('VendorProductsTable logo editor close paths (AECI-2112)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  const editLogo = (el: HTMLElement) =>
    el.querySelector(`#product-logo-trigger-${PRODUCT_ID}`) as HTMLButtonElement;
  const editorRow = (el: HTMLElement) =>
    el.querySelector(`#product-logo-${PRODUCT_ID}`) as HTMLTableRowElement;

  async function openEditor() {
    const ctx = await setup([makeRow()]);
    editLogo(ctx.el).click();
    ctx.fixture.detectChanges();
    await ctx.fixture.whenStable();
    const editor = ctx.fixture.debugElement.query(By.directive(AdminLogoEditor))
      .componentInstance as AdminLogoEditor;
    return { ...ctx, editor };
  }

  it("the editor's close request closes it and returns focus to Edit logo", async () => {
    const { fixture, el, editor } = await openEditor();
    expect(editorRow(el).hidden).toBe(false);
    editor.closeRequested.emit();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(editorRow(el).hidden).toBe(true);
    expect(document.activeElement).toBe(editLogo(el));
  });

  it('Edit logo and a close request leave the editor open while it saves', async () => {
    const { fixture, el, editor } = await openEditor();
    editor.savingChange.emit(true);
    editLogo(el).click();
    editor.closeRequested.emit();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(editorRow(el).hidden).toBe(false);

    editor.savingChange.emit(false);
    editLogo(el).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(editorRow(el).hidden).toBe(true);
  });
});
