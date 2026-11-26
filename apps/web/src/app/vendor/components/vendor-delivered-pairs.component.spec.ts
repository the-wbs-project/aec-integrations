/**
 * AECI-2045 — "Pairs recorded under another company" on a Sync Service product's
 * Integrations tab (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13a).
 *
 * What these pin: nothing renders when the read is empty; each pair names its owner
 * on record; the one action sends an `owner` contest naming the caller, with a
 * required reason, and re-reads the list; a pair with an open request offers no second
 * one; each refusal is its own sentence; a failed read offers a retry; a product
 * switch never shows the previous product's pairs.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListVendorDeliveredPairsResponse } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  SYNC_SERVICE_PRODUCT,
  VENDOR_DELIVERED_PAIRS_FIXTURE,
  VENDOR_ME_SYNC_SERVICE_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorDeliveredPairs, sendErrorMessage } from './vendor-delivered-pairs';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const [UNOWNED, OTHER] = VENDOR_DELIVERED_PAIRS_FIXTURE.pairs;

let api: {
  listDeliveredPairs: ReturnType<typeof vi.fn>;
  submitContest: ReturnType<typeof vi.fn>;
  getContests: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    listDeliveredPairs: vi.fn(
      async (): Promise<ListVendorDeliveredPairsResponse> =>
        structuredClone(VENDOR_DELIVERED_PAIRS_FIXTURE),
    ),
    submitContest: vi.fn().mockResolvedValue({ contest: {} }),
    getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_SYNC_SERVICE_FIXTURE);
});

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function create(productId = SYNC_SERVICE_PRODUCT.id) {
  const fixture = TestBed.createComponent(VendorDeliveredPairs);
  fixture.componentRef.setInput('productId', productId);
  await settle(fixture);
  return fixture;
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const row = (f: ComponentFixture<unknown>, id: string) =>
  el(f).querySelector(`[data-delivered-pair="${id}"]`) as HTMLElement;

function typeReason(f: ComponentFixture<unknown>, value: string): void {
  const area = el(f).querySelector('textarea')!;
  area.value = value;
  area.dispatchEvent(new Event('input'));
  f.detectChanges();
}

describe('VendorDeliveredPairs', () => {
  it('renders nothing when the product delivers no pair under another owner', async () => {
    api.listDeliveredPairs.mockResolvedValue({ pairs: [] });
    const f = await create();
    expect(el(f).querySelector('section')).toBeNull();
  });

  it('lists each pair read-only with its owner on record', async () => {
    const f = await create();
    expect(el(f).querySelector('#vendor-delivered-pairs-heading')?.textContent).toContain(
      'Pairs recorded under another company',
    );
    expect(row(f, UNOWNED!.id).textContent).toContain('Autodesk Build and Acumatica');
    expect(row(f, UNOWNED!.id).textContent).toContain('No owner is recorded.');
    expect(row(f, OTHER!.id).textContent).toContain('Recorded owner: Ledgerline');
    expect(el(f).querySelectorAll('[data-testid="delivered-ask"]')).toHaveLength(2);
  });

  it('asks for a reason before it sends', async () => {
    const f = await create();
    (row(f, OTHER!.id).querySelector('[data-testid="delivered-ask"]') as HTMLElement).click();
    await settle(f);
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    (el(f).querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle(f);
    expect(api.submitContest).not.toHaveBeenCalled();
    expect(el(f).textContent).toContain('Say why your company offers this pair.');
  });

  it('closes on Escape as Cancel does and returns focus to the opener (AECI-2133)', async () => {
    const f = await create();
    (row(f, OTHER!.id).querySelector('[data-testid="delivered-ask"]') as HTMLElement).click();
    await settle(f);
    typeReason(f, 'A draft.');
    el(f)
      .querySelector('textarea')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await settle(f);
    expect(el(f).querySelector('form')).toBeNull();
    expect(api.submitContest).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      row(f, OTHER!.id).querySelector('[data-testid="delivered-ask"]'),
    );
  });

  it('ignores Escape while the request sends (AECI-2133)', async () => {
    api.submitContest.mockReturnValue(new Promise(() => undefined));
    const f = await create();
    (row(f, OTHER!.id).querySelector('[data-testid="delivered-ask"]') as HTMLElement).click();
    await settle(f);
    typeReason(f, 'We sell and run this sync.');
    (el(f).querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle(f);
    expect(api.submitContest).toHaveBeenCalled();
    el(f)
      .querySelector('textarea')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await settle(f);
    expect(el(f).querySelector('form')).not.toBeNull();
  });

  it('sends an owner contest naming the caller, announces and re-reads the list', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const f = await create();
    (row(f, OTHER!.id).querySelector('[data-testid="delivered-ask"]') as HTMLElement).click();
    await settle(f);
    typeReason(f, 'We sell and run this sync. See our pair page.');
    api.listDeliveredPairs.mockResolvedValue({
      pairs: [UNOWNED, { ...OTHER!, open_request_id: '00000000-0000-4000-8000-00000000c111' }],
    });
    (el(f).querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle(f);
    expect(api.submitContest).toHaveBeenCalledWith(
      OTHER!.id,
      {
        field: 'owner',
        proposed_value: VENDOR_ME_SYNC_SERVICE_FIXTURE.vendor.id,
        reason: 'We sell and run this sync. See our pair page.',
      },
      'evidenced_pair',
    );
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('Your request is with'));
    expect(row(f, OTHER!.id).querySelector('[data-testid="delivered-pending"]')).not.toBeNull();
    expect(row(f, OTHER!.id).querySelector('[data-testid="delivered-ask"]')).toBeNull();
  });

  it('offers no second request on a pair with an open one', async () => {
    api.listDeliveredPairs.mockResolvedValue({
      pairs: [{ ...UNOWNED!, open_request_id: '00000000-0000-4000-8000-00000000c112' }],
    });
    const f = await create();
    expect(el(f).querySelector('[data-testid="delivered-ask"]')).toBeNull();
    expect(el(f).querySelector('[data-testid="delivered-pending"]')).not.toBeNull();
  });

  it('shows a refusal in an alert', async () => {
    api.submitContest.mockRejectedValue(apiError(403, 'CONTEST_CONNECTOR_OWNER_ONLY'));
    const f = await create();
    (row(f, UNOWNED!.id).querySelector('[data-testid="delivered-ask"]') as HTMLElement).click();
    await settle(f);
    typeReason(f, 'Ours.');
    (el(f).querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle(f);
    expect(el(f).querySelector('[role="alert"]')?.textContent).toContain(
      'You can only ask to be recorded as the company that offers this pair.',
    );
  });

  it('maps each refusal to its own sentence', () => {
    expect(sendErrorMessage(apiError(409, 'CONTEST_DUPLICATE'))).toContain('already asked');
    expect(sendErrorMessage(apiError(429, 'RATE_LIMITED'))).toContain('Too many requests');
    expect(sendErrorMessage(apiError(404, 'NOT_FOUND'))).toContain('no longer listed');
    expect(sendErrorMessage(new Error('x'))).toContain('Could not send your request');
  });

  it('offers a retry when the read fails', async () => {
    api.listDeliveredPairs.mockRejectedValueOnce(new Error('down'));
    const f = await create();
    const retry = el(f).querySelector('[data-delivered-pairs-failed] button') as HTMLElement;
    expect(retry).not.toBeNull();
    retry.click();
    await settle(f);
    expect(el(f).querySelector('[data-delivered-pairs]')).not.toBeNull();
  });

  it('re-reads on a product switch and never shows the previous pairs', async () => {
    const f = await create();
    api.listDeliveredPairs.mockResolvedValue({ pairs: [] });
    f.componentRef.setInput('productId', '00000000-0000-4000-8000-000000005201');
    await settle(f);
    expect(api.listDeliveredPairs).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000005201');
    expect(el(f).querySelector('[data-delivered-pairs]')).toBeNull();
  });
});
