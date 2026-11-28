/**
 * AECI-2040 — a Sync Service adds a pair it delivers, on its product's Integrations tab
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.7).
 *
 * What these pin:
 *   1. Only a Sync Service product offers the form. An Integration platform, an
 *      unclassified connector and an application never do (AECI-1128).
 *   2. Both products are picked with the shared combobox, and the Sync Service itself
 *      is never offered.
 *   3. The copy says the vendors of both products are told.
 *   4. Submit sends the connector, the two products and the fields, with no type.
 *      Required fields and both products are checked first.
 *   5. A `201` revalidates `integrations` and shows the receipt. A `409` on record
 *      shows its own sentence.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { PRODUCT_COMBOBOX_DEBOUNCE_MS } from '../../shared/product-combobox/product-combobox';
import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  VendorSyncServicePairCreate,
  offersSyncServicePairCreate,
  syncServicePairErrorMessage,
} from './vendor-sync-service-pair-create';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const product = (id: string, name: string): ProductListItem => ({
  id,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  logo_url: null,
  product_role: 'application',
  connector_kind: null,
  vendor: {
    id: '00000000-0000-4000-8000-000000009999',
    slug: 'v',
    name: 'Vendor Co',
    logo_url: null,
  },
  integration_count: 0,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
});

const SYNC = { id: '00000000-0000-4000-8000-000000007001', name: 'Rivets Sync' };
const PROCORE = product('00000000-0000-4000-8000-000000007002', 'Procore');
const ACUMATICA = product('00000000-0000-4000-8000-000000007003', 'Acumatica');
const SELF = product(SYNC.id, SYNC.name);

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    searchProducts: vi.fn().mockResolvedValue({
      data: [ACUMATICA, PROCORE, SELF],
      total: 3,
      page: 1,
      perPage: 8,
    }),
    createSyncServicePair: vi.fn().mockResolvedValue({ pair: { id: 'x' } }),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [], owned: [] }),
    getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function mount(): Promise<ComponentFixture<VendorSyncServicePairCreate>> {
  const fixture = TestBed.createComponent(VendorSyncServicePairCreate);
  fixture.componentRef.setInput('product', SYNC);
  await settle(fixture);
  return fixture;
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const q = <T extends Element>(f: ComponentFixture<unknown>, s: string) => el(f).querySelector<T>(s);
const options = () => [...document.querySelectorAll<HTMLElement>('[data-product-option]')];

async function open(f: ComponentFixture<unknown>): Promise<void> {
  q<HTMLButtonElement>(f, '[data-testid="sync-create-open"]')!.click();
  await settle(f);
}

async function pick(f: ComponentFixture<unknown>, side: 'first' | 'second', name: string) {
  const input = q<HTMLInputElement>(f, `#vendor-sync-${side}`)!;
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  input.value = name.slice(0, 3).toLowerCase();
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await settle(f);
  await new Promise((resolve) => setTimeout(resolve, PRODUCT_COMBOBOX_DEBOUNCE_MS + 30));
  await settle(f);
  const row = options().find((o) => o.textContent?.includes(name))!;
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle(f);
}

async function type(f: ComponentFixture<unknown>, selector: string, value: string, ev = 'input') {
  const node = q<HTMLInputElement>(f, selector)!;
  node.value = value;
  node.dispatchEvent(new Event(ev));
  await settle(f);
}

const submit = async (f: ComponentFixture<unknown>) => {
  q<HTMLFormElement>(f, 'form')!.dispatchEvent(new Event('submit'));
  await settle(f);
};

describe('which products offer it', () => {
  it('is offered on a Sync Service only', () => {
    expect(
      offersSyncServicePairCreate({
        ...SYNC,
        product_role: 'connector',
        connector_kind: 'sync_service',
      }),
    ).toBe(true);
    expect(
      offersSyncServicePairCreate({
        ...SYNC,
        product_role: 'hybrid',
        connector_kind: 'sync_service',
      }),
    ).toBe(true);
    for (const [role, kind] of [
      ['connector', 'integration_platform'],
      ['connector', null],
      ['application', 'sync_service'],
      ['application', null],
    ] as const) {
      expect(
        offersSyncServicePairCreate({ ...SYNC, product_role: role, connector_kind: kind }),
      ).toBe(false);
    }
    expect(offersSyncServicePairCreate(null)).toBe(false);
  });
});

describe('the form', () => {
  it('says the vendors of both products are told, and stays closed until opened', async () => {
    const f = await mount();
    expect(el(f).textContent).toContain('The vendors of both products are told');
    expect(q(f, '[data-testid="sync-create-form"]')).toBeNull();
    await open(f);
    expect(q(f, '[data-testid="sync-create-form"]')).not.toBeNull();
    // No type field: the table has no column for it.
    expect(q(f, '#vendor-sync-create-mechanism_kind')).toBeNull();
    expect(q(f, '#vendor-sync-create-name')).not.toBeNull();
  });

  it('closes on Escape as Cancel does and returns focus to the opener (AECI-2133)', async () => {
    const f = await mount();
    await open(f);
    q<HTMLInputElement>(f, '#vendor-sync-create-name')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle(f);
    expect(q(f, '[data-testid="sync-create-form"]')).toBeNull();
    expect(document.activeElement).toBe(q(f, '[data-testid="sync-create-open"]'));
  });

  it('never offers the Sync Service itself, or the product already picked', async () => {
    const f = await mount();
    await open(f);
    await pick(f, 'first', 'Procore');
    const input = q<HTMLInputElement>(f, '#vendor-sync-second')!;
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.value = 'riv';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await settle(f);
    await new Promise((resolve) => setTimeout(resolve, PRODUCT_COMBOBOX_DEBOUNCE_MS + 30));
    await settle(f);
    const names = options().map((o) => o.textContent ?? '');
    expect(names.some((n) => n.includes('Rivets Sync'))).toBe(false);
    expect(names.some((n) => n.includes('Procore'))).toBe(false);
    expect(names.some((n) => n.includes('Acumatica'))).toBe(true);
  });

  it('checks both products and the required fields before sending', async () => {
    const f = await mount();
    await open(f);
    await submit(f);
    expect(api['createSyncServicePair']).not.toHaveBeenCalled();
    expect(el(f).textContent).toContain('Choose a product from the list.');
    expect(el(f).textContent).toContain('This field is required.');
  });

  it('sends the connector, both products and the fields, then shows the receipt', async () => {
    const f = await mount();
    await open(f);
    await pick(f, 'first', 'Procore');
    await pick(f, 'second', 'Acumatica');
    await type(f, '#vendor-sync-create-name', 'Procore and Acumatica');
    await type(f, '#vendor-sync-create-direction', 'both', 'change');
    await submit(f);
    expect(api['createSyncServicePair']).toHaveBeenCalledWith({
      connector_product_id: SYNC.id,
      product_id: PROCORE.id,
      counterpart_product_id: ACUMATICA.id,
      name: 'Procore and Acumatica',
      direction: 'both',
    });
    expect(api['getIntegrations']).toHaveBeenCalled();
    const receipt = q(f, '[data-testid="sync-create-receipt"]');
    expect(receipt?.textContent).toContain('Your integration is live on the public site.');
    expect(
      q<HTMLAnchorElement>(f, '[data-testid="sync-create-public"]')!.getAttribute('href'),
    ).toBe('/products/acumatica/integrations/procore');
    expect(q(f, '[data-testid="sync-create-form"]')).toBeNull();
  });

  it('shows the on-record sentence on a 409', async () => {
    api['createSyncServicePair']!.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'INTEGRATION_ALREADY_ON_RECORD',
            message: 'x',
            details: { existing_id: 'y', anchor: 'evidenced_pair', retired: true },
          },
        },
      }),
    );
    const f = await mount();
    await open(f);
    await pick(f, 'first', 'Procore');
    await pick(f, 'second', 'Acumatica');
    await type(f, '#vendor-sync-create-name', 'Procore and Acumatica');
    await type(f, '#vendor-sync-create-direction', 'outbound', 'change');
    await submit(f);
    expect(q(f, '[data-testid="sync-create-notice"]')?.textContent).toContain('it is retired');
  });
});

describe('syncServicePairErrorMessage', () => {
  const err = (code: string) =>
    new HttpErrorResponse({ status: 400, error: { error: { code, message: code } } });
  it.each([
    ['CONNECTOR_NOT_SYNC_SERVICE', 'Only a Sync Service'],
    ['NOT_FOUND', 'not available to link'],
    ['INTEGRATION_ALREADY_ON_RECORD', 'already on record'],
    ['RATE_LIMITED', 'Wait a minute'],
  ])('%s has its own sentence', (code, text) => {
    expect(syncServicePairErrorMessage(err(code))).toContain(text);
  });

  // AECI-2268: who retired the row decides whether "restore it" is true.
  const onRecord = (details: Record<string, unknown>) =>
    new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'INTEGRATION_ALREADY_ON_RECORD', message: 'x', details } },
    });

  it('sends the owner to Restore when the owner retired the row', () => {
    const msg = syncServicePairErrorMessage(
      onRecord({ retired: true, retired_by_aeci: false, owned_by_caller: true }),
    );
    expect(msg).toContain('Restore it from the list below');
  });

  it('says AEC Integrations retired the row, and how to ask, when an admin retired it', () => {
    const msg = syncServicePairErrorMessage(
      onRecord({ retired: true, retired_by_aeci: true, owned_by_caller: true }),
    );
    expect(msg).toContain('AEC Integrations retired it');
    expect(msg).toContain('Only AEC Integrations can restore it');
    expect(msg).toContain('support@aecintegrations.com');
    expect(msg).not.toContain('Restore it from the list below');
  });
});
