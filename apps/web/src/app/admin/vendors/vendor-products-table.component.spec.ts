/**
 * The Products tab table: AECI-1238's per-product listing hide (§11d.6), AECI-2036's
 * connector type, AECI-2045's delivered pairs, AECI-2046's Sync Service facts, and
 * since AECI-2202 the one Actions menu per row and the dialog each action opens.
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
import { ConnectorKindControl } from './connector-kind-control';
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
  const edited = vi.fn();
  const announce = vi.fn();
  fixture.componentInstance.listingChanged.subscribe(listingChanged);
  fixture.componentInstance.edited.subscribe(edited);
  fixture.componentInstance.announce.subscribe(announce);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, listingChanged, edited, announce };
}

type Fixture = Awaited<ReturnType<typeof setup>>['fixture'];

async function settle(fixture: Fixture) {
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function actions(el: HTMLElement, id = PRODUCT_ID): HTMLButtonElement {
  return el.querySelector(`#product-actions-${id}`) as HTMLButtonElement;
}

/** The overlay renders into the CDK container on `document.body`. */
function menu(): HTMLElement | null {
  return document.querySelector('[data-testid="product-actions-menu"]');
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="product-action-dialog"]');
}

async function openMenu(fixture: Fixture, el: HTMLElement, id = PRODUCT_ID) {
  actions(el, id).click();
  await settle(fixture);
  return menu()!;
}

async function pick(fixture: Fixture, el: HTMLElement, testId: string, id = PRODUCT_ID) {
  const m = await openMenu(fixture, el, id);
  (m.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
  await settle(fixture);
  return dialog()!;
}

function itemIds(m: HTMLElement): string[] {
  return [...m.querySelectorAll('[data-testid^="product-action-"]')].map(
    (e) => e.getAttribute('data-testid') ?? '',
  );
}

afterEach(() => {
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => (n.innerHTML = ''));
});

describe('VendorProductsTable Actions menu (AECI-2202)', () => {
  it('names the trigger after the product, starting with its visible word', async () => {
    const { el } = await setup([makeRow()]);
    expect(actions(el).textContent?.trim()).toBe('Actions');
    expect(actions(el).getAttribute('aria-label')).toBe('Actions for Revit');
  });

  it('offers View, Change logo and Hide on an application row', async () => {
    const { fixture, el } = await setup([makeRow()]);
    const m = await openMenu(fixture, el);
    expect(itemIds(m)).toEqual([
      'product-action-view',
      'product-action-logo',
      'product-action-hide',
    ]);
    const view = m.querySelector('[data-testid="product-action-view"]') as HTMLAnchorElement;
    expect(view.getAttribute('href')).toBe('/products/revit');
    expect(view.getAttribute('target')).toBe('_blank');
    expect(view.textContent).toContain('opens in a new tab');
  });

  it('adds the connector items on a connector, and facts on a Sync Service', async () => {
    const { fixture, el } = await setup([
      makeRow({ product_role: 'connector', connector_kind: 'sync_service', name: 'Sync' }),
    ]);
    const m = await openMenu(fixture, el);
    expect(itemIds(m)).toEqual([
      'product-action-view',
      'product-action-logo',
      'product-action-kind',
      'product-action-facts',
      'product-action-pairs',
      'product-action-hide',
    ]);
  });

  it('shows the connector type as text in the Role column', async () => {
    const { el } = await setup([
      makeRow(),
      makeRow({
        id: '00000000-0000-4000-8000-000000000031',
        slug: 'sync',
        product_role: 'connector',
        connector_kind: 'sync_service',
      }),
      makeRow({ id: '00000000-0000-4000-8000-000000000032', slug: 'hy', product_role: 'hybrid' }),
    ]);
    const lines = [...el.querySelectorAll('[data-testid="product-connector-kind"]')].map((e) =>
      e.textContent?.trim(),
    );
    expect(lines).toEqual(['Type: Sync Service', 'Type: not set']);
    expect(el.querySelector('aec-connector-kind-control')).toBeNull();
    expect(el.querySelector('aec-sync-facts-control')).toBeNull();
  });
});

describe('VendorProductsTable listing hide', () => {
  it('badges a product hidden on its own and offers Restore', async () => {
    const { fixture, el } = await setup([makeRow({ listing_hide: makeHide() })]);
    expect(el.querySelector('[data-testid="product-hidden-badge"]')?.textContent?.trim()).toBe(
      'Hidden from public site',
    );
    const m = await openMenu(fixture, el);
    expect(itemIds(m)).toContain('product-action-restore');
    expect(itemIds(m)).not.toContain('product-action-hide');
  });

  it('offers no Restore when the product is hidden with its company, and says why', async () => {
    const { fixture, el } = await setup([
      makeRow({ listing_hide: makeHide({ parent_id: '00000000-0000-4000-8000-000000000070' }) }),
    ]);
    expect(el.querySelector('[data-testid="product-listing-with-vendor"]')?.textContent).toContain(
      'Hidden with the company.',
    );
    const m = await openMenu(fixture, el);
    expect(itemIds(m)).not.toContain('product-action-restore');
    expect(
      m.querySelector('[data-testid="product-action-restore-with-vendor"]')?.textContent,
    ).toContain("restore the company's listing on the Vendor tab");
  });

  it('hides one product through the two-step form in a titled dialog', async () => {
    const { fixture, el, listingChanged, announce } = await setup([makeRow()]);
    const d = await pick(fixture, el, 'product-action-hide');
    expect(d.querySelector('h2')?.textContent?.trim()).toBe('Hide Revit from the public site');
    expect(d.querySelector('[data-testid="product-action-intro"]')?.textContent).toContain(
      'its search entry and its integrations leave the public site. Nothing is deleted.',
    );
    const prefix = `product-${PRODUCT_ID}-listing`;
    // A product reads "discontinued", not "defunct" (the company label).
    expect(d.textContent).toContain('Product is discontinued');
    expect(d.textContent).not.toContain('Company is defunct');
    (d.querySelector(`#${prefix}-kind-defunct`) as HTMLInputElement).click();
    const reason = d.querySelector(`#${prefix}-reason`) as HTMLTextAreaElement;
    reason.value = 'The product was discontinued.';
    reason.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    [...d.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Continue')!.click();
    await settle(fixture);
    expect(d.textContent).toContain('Only this product is hidden.');
    [...d.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Hide from the public site')!
      .click();
    await settle(fixture);
    // BrnDialog closes after its 100ms close delay.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await settle(fixture);
    expect(api.hideProduct).toHaveBeenCalledWith(
      PRODUCT_ID,
      expect.objectContaining({ kind: 'defunct', reason: 'The product was discontinued.' }),
    );
    expect(listingChanged).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(announce).toHaveBeenCalledWith(
      'Product hidden. It is off the public site, and the vendor was told.',
    );

    // The page refetches quietly. The row's Actions takes focus back.
    fixture.componentRef.setInput('rows', [makeRow({ listing_hide: makeHide() })]);
    await settle(fixture);
    expect(document.activeElement).toBe(actions(el));
  });
});

describe('VendorProductsTable connector dialogs', () => {
  it('sets the connector type in a dialog that explains each type', async () => {
    const { fixture, el } = await setup([makeRow({ product_role: 'connector', name: 'Sync' })]);
    const d = await pick(fixture, el, 'product-action-kind');
    expect(d.querySelector('h2')?.textContent?.trim()).toBe('Connector type for Sync');
    expect(d.querySelector('aec-connector-kind-control')).not.toBeNull();
    expect(d.textContent).toContain('Integration platform:');
    expect(d.textContent).toContain('Sync Service:');
  });

  it('edits Sync Service facts in a dialog', async () => {
    const { fixture, el } = await setup([
      makeRow({
        product_role: 'connector',
        connector_kind: 'sync_service',
        name: 'Sync',
        sync_facts: {
          sync_frequency: 'Hourly',
          sync_support: null,
          sync_setup: null,
          source_url: 'https://example.com/sync',
          recorded_at: '2026-11-20T00:00:00.000Z',
        },
      }),
    ]);
    const d = await pick(fixture, el, 'product-action-facts');
    expect(d.querySelector('h2')?.textContent?.trim()).toBe('Sync Service facts for Sync');
    expect(
      d.querySelector<HTMLInputElement>(`#sync-facts-sync_frequency-${PRODUCT_ID}`)!.value,
    ).toBe('Hourly');
  });

  it('lists the integrations through a connector, with a line saying what they are', async () => {
    api.getDeliveredPairs = vi.fn(async () => ({
      connector: { id: PRODUCT_ID, name: 'Sync', slug: 'sync', connector_kind: 'sync_service' },
      connector_vendors: [],
      pairs: [],
    }));
    const { fixture, el } = await setup([
      makeRow({ product_role: 'connector', connector_kind: 'sync_service', name: 'Sync' }),
    ]);
    const d = await pick(fixture, el, 'product-action-pairs');
    expect(d.querySelector('h2')?.textContent?.trim()).toBe('Integrations through Sync');
    expect(d.querySelector('[data-testid="product-action-intro"]')?.textContent).toContain(
      'connects two other products and runs through Sync',
    );
    expect(d.querySelector('aec-delivered-pairs-panel')).not.toBeNull();
    expect(api.getDeliveredPairs).toHaveBeenCalledWith(PRODUCT_ID);
  });
});

describe('VendorProductsTable dialog while a write is in flight', () => {
  it('ignores Escape and disables Close until the write settles', async () => {
    const { fixture, el } = await setup([makeRow({ product_role: 'connector', name: 'Sync' })]);
    const d = await pick(fixture, el, 'product-action-kind');
    const control = fixture.debugElement.query(By.directive(ConnectorKindControl))
      .componentInstance as ConnectorKindControl;
    control.busyChange.emit(true);
    await settle(fixture);
    const close = d.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    d.querySelector('h2')!.dispatchEvent(esc);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await settle(fixture);
    expect(dialog()).not.toBeNull();
    expect(esc.defaultPrevented).toBe(true);

    control.busyChange.emit(false);
    await settle(fixture);
    expect(close.disabled).toBe(false);
  });
});

describe('VendorProductsTable refocus after a quiet refetch', () => {
  it('leaves focus alone when the operator opened another dialog first', async () => {
    const { fixture, el } = await setup([makeRow({ product_role: 'connector', name: 'Sync' })]);
    await pick(fixture, el, 'product-action-kind');
    const control = fixture.debugElement.query(By.directive(ConnectorKindControl))
      .componentInstance as ConnectorKindControl;
    control.saved.emit('sync_service');
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await settle(fixture);
    expect(dialog()).toBeNull();

    // Another action opens before the refetched rows land.
    const d = await pick(fixture, el, 'product-action-logo');
    const title = d.querySelector('h2') as HTMLElement;
    title.focus();
    fixture.componentRef.setInput('rows', [
      makeRow({ product_role: 'connector', connector_kind: 'sync_service', name: 'Sync' }),
    ]);
    await settle(fixture);
    expect(document.activeElement).toBe(title);
  });
});

describe('VendorProductsTable logo dialog (AECI-2112)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  async function openEditor() {
    const ctx = await setup([makeRow()]);
    const d = await pick(ctx.fixture, ctx.el, 'product-action-logo');
    const editor = ctx.fixture.debugElement.query(By.directive(AdminLogoEditor))
      ?.componentInstance as AdminLogoEditor | undefined;
    return { ...ctx, d, editor };
  }

  it('opens the editor in a dialog titled for the product', async () => {
    const { d } = await openEditor();
    expect(d.querySelector('h2')?.textContent?.trim()).toBe('Logo for Revit');
    expect(d.querySelector('aec-admin-logo-editor')).not.toBeNull();
  });

  it('keeps Close disabled while the logo saves', async () => {
    const { fixture, d } = await openEditor();
    const close = d.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fixture.componentInstance['logoSaving'].set(true);
    await settle(fixture);
    expect(close.disabled).toBe(true);
  });
});
