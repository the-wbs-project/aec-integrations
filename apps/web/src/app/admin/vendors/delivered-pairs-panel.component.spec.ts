/**
 * AECI-2045 — the delivered pairs of one connector product on the Products tab of
 * `/admin/vendors/:id`, and the owner write over `PUT /api/admin/integrations/:id/owner`.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminDeliveredPair, AdminDeliveredPairsResponse } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';
import { DeliveredPairsPanel } from './delivered-pairs-panel';

const PRODUCT_ID = '00000000-0000-4000-8000-000000000031';
const RIVETS = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Rivets' };
const PROCORE_CO = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Procore Technologies' };
const ACUMATICA_CO = { id: '00000000-0000-4000-8000-0000000000a3', name: 'Acumatica Inc' };

const link = (id: string, name: string) => ({ id, slug: name.toLowerCase(), name, logo_url: null });

const CLAIMED: AdminDeliveredPair = {
  id: '00000000-0000-4000-8000-0000000000b1',
  anchor: 'evidenced_pair',
  name: null,
  product_a: link('00000000-0000-4000-8000-0000000000c1', 'Procore'),
  product_b: link('00000000-0000-4000-8000-0000000000c2', 'Acumatica'),
  owner: RIVETS,
  claimed_at: '2026-11-20T00:00:00.000Z',
  retired_at: null,
  retired_by: null,
  endpoint_vendors: [PROCORE_CO, ACUMATICA_CO],
};
const RETIRED: AdminDeliveredPair = {
  ...CLAIMED,
  id: '00000000-0000-4000-8000-0000000000b2',
  name: 'Procore and QuickBooks',
  owner: null,
  claimed_at: null,
  retired_at: '2026-11-21T00:00:00.000Z',
  retired_by: 'aeci',
};

const RESPONSE: AdminDeliveredPairsResponse = {
  connector: {
    id: PRODUCT_ID,
    name: 'Rivets Sync',
    slug: 'rivets-sync',
    connector_kind: 'sync_service',
  },
  connector_vendors: [RIVETS],
  pairs: [CLAIMED, RETIRED],
};

let api: {
  getDeliveredPairs: ReturnType<typeof vi.fn>;
  setIntegrationOwner: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getDeliveredPairs: vi.fn(async () => structuredClone(RESPONSE)),
    setIntegrationOwner: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminVendorsApi, useValue: api }],
  });
});
afterEach(() => vi.restoreAllMocks());

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

async function settle(f: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    f.detectChanges();
    await flush();
  }
  f.detectChanges();
}

async function setup() {
  const fixture = TestBed.createComponent(DeliveredPairsPanel);
  fixture.componentRef.setInput('productId', PRODUCT_ID);
  fixture.componentRef.setInput('productName', 'Rivets Sync');
  const announce = vi.fn();
  fixture.componentInstance.announce.subscribe(announce);
  await settle(fixture);
  const el = fixture.nativeElement as HTMLElement;
  const row = (id: string) => el.querySelector(`[data-delivered-pair="${id}"]`) as HTMLElement;
  return { fixture, el, row, announce };
}

function openForm(row: HTMLElement): void {
  (
    [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Change owner') as
      | HTMLButtonElement
      | undefined
  )?.click();
}

describe('DeliveredPairsPanel', () => {
  it('lists every pair with owner, claim and retired state', async () => {
    const { el, row } = await setup();
    expect(api.getDeliveredPairs).toHaveBeenCalledWith(PRODUCT_ID);
    expect(el.querySelector('h3')?.textContent).toContain('Pairs Rivets Sync delivers');
    const claimed = row(CLAIMED.id).textContent ?? '';
    expect(claimed).toContain('Procore and Acumatica');
    expect(claimed).toContain('Owner: Rivets');
    expect(claimed).toContain('Claimed');
    expect(claimed).toContain('Live');
    const retired = row(RETIRED.id).textContent ?? '';
    expect(retired).toContain('No owner on file');
    expect(retired).toContain('Not claimed');
    expect(retired).toContain('Retired by AEC Integrations');
  });

  it('says so when the product delivers nothing', async () => {
    api.getDeliveredPairs.mockResolvedValue({ ...RESPONSE, pairs: [] });
    const { el } = await setup();
    expect(el.textContent).toContain('No pairs are recorded as delivered through this product.');
  });

  it('offers the connector and endpoint vendors, once each, A to Z, plus No owner', async () => {
    const { fixture, row } = await setup();
    openForm(row(CLAIMED.id));
    await settle(fixture);
    const options = [...row(CLAIMED.id).querySelectorAll('option')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['No owner', 'Acumatica Inc', 'Procore Technologies', 'Rivets']);
    expect(row(CLAIMED.id).textContent).toContain('clears its claim');
  });

  it('requires a reason before it sends', async () => {
    const { fixture, row } = await setup();
    openForm(row(CLAIMED.id));
    await settle(fixture);
    row(CLAIMED.id).querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.setIntegrationOwner).not.toHaveBeenCalled();
    expect(row(CLAIMED.id).querySelector('[role="alert"]')?.textContent).toContain('Add a reason');
  });

  it('saves the picked owner with the reason, splices the row and announces', async () => {
    api.setIntegrationOwner.mockResolvedValue({
      changed: true,
      pair: { ...CLAIMED, owner: PROCORE_CO, claimed_at: null },
    });
    const { fixture, row, announce } = await setup();
    openForm(row(CLAIMED.id));
    await settle(fixture);
    const select = row(CLAIMED.id).querySelector('select')!;
    select.value = PROCORE_CO.id;
    select.dispatchEvent(new Event('change'));
    const area = row(CLAIMED.id).querySelector('textarea')!;
    area.value = 'Procore sells this sync, per its marketplace page.';
    area.dispatchEvent(new Event('input'));
    row(CLAIMED.id).querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.setIntegrationOwner).toHaveBeenCalledWith(CLAIMED.id, {
      owner_vendor_id: PROCORE_CO.id,
      reason: 'Procore sells this sync, per its marketplace page.',
    });
    expect(row(CLAIMED.id).textContent).toContain('Owner: Procore Technologies');
    expect(row(CLAIMED.id).textContent).toContain('Not claimed');
    expect(announce).toHaveBeenCalledWith(
      'Owner of Procore and Acumatica saved: Procore Technologies.',
    );
  });

  it('sends null for No owner', async () => {
    api.setIntegrationOwner.mockResolvedValue({
      changed: true,
      pair: { ...CLAIMED, owner: null, claimed_at: null },
    });
    const { fixture, row } = await setup();
    openForm(row(CLAIMED.id));
    await settle(fixture);
    const select = row(CLAIMED.id).querySelector('select')!;
    select.value = '__none__';
    select.dispatchEvent(new Event('change'));
    const area = row(CLAIMED.id).querySelector('textarea')!;
    area.value = 'Nobody offers it.';
    area.dispatchEvent(new Event('input'));
    row(CLAIMED.id).querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.setIntegrationOwner.mock.calls[0]![1].owner_vendor_id).toBeNull();
  });

  it('reloads on a race and names a refusal', async () => {
    api.setIntegrationOwner.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'INTEGRATION_CHANGED_WHILE_SAVING' } },
      }),
    );
    const { fixture, row } = await setup();
    openForm(row(CLAIMED.id));
    await settle(fixture);
    const area = row(CLAIMED.id).querySelector('textarea')!;
    area.value = 'Because.';
    area.dispatchEvent(new Event('input'));
    row(CLAIMED.id).querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.getDeliveredPairs).toHaveBeenCalledTimes(2);
  });

  it('offers a retry when the read fails', async () => {
    api.getDeliveredPairs.mockRejectedValueOnce(new Error('down'));
    const { fixture, el } = await setup();
    expect(el.textContent).toContain('Could not load the pairs this product delivers.');
    (el.querySelector('button') as HTMLButtonElement).click();
    await settle(fixture);
    expect(el.querySelector('[data-delivered-pair]')).not.toBeNull();
  });
});
