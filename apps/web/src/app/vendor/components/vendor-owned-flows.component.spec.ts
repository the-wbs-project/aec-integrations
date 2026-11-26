/**
 * AECI-2039 — the owner of a Sync Service pair maintains its data flows, on the
 * owned card (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.15.3).
 *
 * What these pin:
 *   1. A claimed Sync Service row shows its flows with Yes and No toggles, framed
 *      against product_a, and says what each row shows on the public page.
 *   2. Yes and No call the answer route. Pressing the pressed answer clears it, as on
 *      "Data that's shared" (the Same-Behavior Rule). Every write revalidates.
 *   3. Add sends the data type and the product_a-framed direction.
 *   4. An unclaimed row lists its flows read-only and says to claim first.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnedFlow, OwnedIntegration } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_OWNED_INTEGRATIONS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorOwnedFlows } from './vendor-owned-flows';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const CONFIRMED: OwnedFlow = {
  id: '00000000-0000-4000-8000-0000000061a1',
  data_object_slug: 'invoices',
  data_object_name: 'Invoices',
  direction: 'outbound',
  agreement: 'owner_confirmed',
  origin: 'aeci',
  answer: 'yes',
};
const UNANSWERED: OwnedFlow = {
  ...CONFIRMED,
  id: '00000000-0000-4000-8000-0000000061a2',
  data_object_slug: 'vendors',
  data_object_name: 'Vendors',
  direction: 'inbound',
  agreement: 'unverified',
  answer: null,
};

const SYNCED: OwnedIntegration = {
  ...VENDOR_OWNED_INTEGRATIONS_FIXTURE[1]!,
  sync_service: true,
  flows_editable: true,
  flows: [CONFIRMED, UNANSWERED],
};

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    setOwnerFlowAnswer: vi.fn().mockResolvedValue({ integration_id: SYNCED.id, flows: [] }),
    clearOwnerFlowAnswer: vi.fn().mockResolvedValue(undefined),
    addOwnerFlow: vi.fn().mockResolvedValue({ integration_id: SYNCED.id, flows: [] }),
    changeOwnerFlow: vi.fn().mockResolvedValue({ integration_id: SYNCED.id, flows: [] }),
    getDataObjects: vi.fn().mockResolvedValue({
      data_objects: [{ slug: 'rfis', name: 'RFIs', description: null }],
    }),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [], owned: [SYNCED] }),
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
afterEach(() => vi.restoreAllMocks());

async function render(row: OwnedIntegration): Promise<ComponentFixture<VendorOwnedFlows>> {
  const fixture = TestBed.createComponent(VendorOwnedFlows);
  fixture.componentRef.setInput('row', row);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await flush();
  }
}

const q = (fixture: ComponentFixture<unknown>, testId: string) =>
  (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe('VendorOwnedFlows', () => {
  it('lists each flow framed against product_a, with its public line', async () => {
    const fixture = await render(SYNCED);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    const a = SYNCED.product_a.name;
    const b = SYNCED.product_b.name;
    expect(text).toContain(`From ${a} to ${b}`);
    expect(text).toContain(`From ${b} to ${a}`);
    expect(q(fixture, `owned-flow-public-${CONFIRMED.id}`)?.textContent).toContain(
      'Confirmed by your company',
    );
    expect(q(fixture, `owned-flow-public-${UNANSWERED.id}`)?.textContent).toContain(
      'Listed by AEC Integrations',
    );
    expect(q(fixture, `owned-flow-yes-${CONFIRMED.id}`)?.getAttribute('aria-pressed')).toBe('true');
  });

  it('No removes a flow, and pressing the pressed Yes clears the answer', async () => {
    const fixture = await render(SYNCED);
    q(fixture, `owned-flow-no-${UNANSWERED.id}`)!.click();
    await settle(fixture);
    expect(api['setOwnerFlowAnswer']).toHaveBeenCalledWith(UNANSWERED.id, false);
    q(fixture, `owned-flow-yes-${CONFIRMED.id}`)!.click();
    await settle(fixture);
    expect(api['clearOwnerFlowAnswer']).toHaveBeenCalledWith(CONFIRMED.id);
    // Every write refetches the owned rows.
    expect(api['getIntegrations']).toHaveBeenCalled();
  });

  it('adds a row with the data type and the direction', async () => {
    const fixture = await render(SYNCED);
    q(fixture, 'owned-flow-add-toggle')!.click();
    await settle(fixture);
    const form = q(fixture, 'owned-flow-add-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(fixture);
    expect(api['addOwnerFlow']).toHaveBeenCalledWith(SYNCED.id, {
      data_object: 'rfis',
      direction: 'outbound',
    });
  });

  it('closes the add form on Escape as Cancel does (AECI-2133)', async () => {
    const fixture = await render(SYNCED);
    q(fixture, 'owned-flow-add-toggle')!.click();
    await settle(fixture);
    q(fixture, 'owned-flow-add-form')!
      .querySelector('select')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await settle(fixture);
    expect(q(fixture, 'owned-flow-add-form')).toBeNull();
    expect(api['addOwnerFlow']).not.toHaveBeenCalled();
  });

  it('closes the direction change on Escape from any of its controls (AECI-2133)', async () => {
    const fixture = await render(SYNCED);
    const host = fixture.nativeElement as HTMLElement;
    q(fixture, `owned-flow-change-${CONFIRMED.id}`)!.click();
    await settle(fixture);
    const save = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Save',
    )!;
    save.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle(fixture);
    expect(q(fixture, `owned-flow-change-${CONFIRMED.id}`)).not.toBeNull();
    expect(api['changeOwnerFlow']).not.toHaveBeenCalled();
  });

  it('shows an unclaimed row read-only and says to claim first', async () => {
    const fixture = await render({ ...SYNCED, claimed_at: null, flows_editable: false });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Claim this integration to confirm, change or remove them');
    expect(q(fixture, `owned-flow-yes-${CONFIRMED.id}`)).toBeNull();
    expect(q(fixture, 'owned-flow-add-toggle')).toBeNull();
  });
});
