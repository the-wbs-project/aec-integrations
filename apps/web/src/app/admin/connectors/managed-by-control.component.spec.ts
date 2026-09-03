/**
 * AECI-722 — `ManagedByControl`, the UI over AECI-720's `managed_by` flip.
 *
 * Four groups earn their keep, and three are about the control saying true things
 * rather than about it working:
 *
 *  1. **The host-owned chrome contract.** No heading and no live region of its
 *     own, matching `EntitlementControl`. A control that owned a `role="status"`
 *     would give a page N live regions the moment a second one appeared — an a11y
 *     regression a `querySelector('[role="status"]')` assertion would not even
 *     catch, since it keeps finding the first.
 *  2. **It says what freezes.** Handing a catalogue over stops the review app's
 *     sync for it. A control whose blast radius is invisible gets pressed by
 *     accident.
 *  3. **It says what it does NOT do.** Recording a vendor grants no account and
 *     no badge (`STAGE_2_SPEC.md` §8.9(2)/(3)). Nothing else on the page corrects
 *     that assumption.
 *  4. **422 and 404 get their own copy.** Both are actionable — someone else moved
 *     the lane, or the vendor id did not resolve — and "something went wrong"
 *     would strand the operator on either.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorCatalogManagementResponse, ConnectorManagedBy } from '@aeci/shared';

import { AdminVendorsApi } from '../vendors/admin-vendors-api';
import { ManagedByApi } from './managed-by-api';
import { ManagedByControl } from './managed-by-control';

const PRODUCT = {
  id: '00000000-0000-4000-8000-000000000010',
  name: 'MindCloud',
  slug: 'mindcloud',
};
const CATALOG = 'cat-mindcloud';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** A host, because the contract under test is the host relationship. */
@Component({
  selector: 'aec-test-host',
  imports: [ManagedByControl],
  template: `
    <h3 id="host-heading">Catalogue</h3>
    <aec-managed-by-control
      [catalogId]="catalogId"
      [managedBy]="managedBy()"
      [connector]="connector"
      idPrefix="test"
      labelledBy="host-heading"
      (changed)="onChanged($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly catalogId = CATALOG;
  readonly connector = PRODUCT;
  readonly managedBy = signal<ConnectorManagedBy>('review');
  readonly announced = signal('');
  readonly changes: ConnectorCatalogManagementResponse[] = [];

  onChanged(result: ConnectorCatalogManagementResponse): void {
    this.changes.push(result);
    this.managedBy.set(result.managed_by);
  }
}

interface ApiMock {
  setManagement: ReturnType<typeof vi.fn>;
}

const okResponse: ConnectorCatalogManagementResponse = {
  id: CATALOG,
  connector_product_id: PRODUCT.id,
  managed_by: 'vendor',
  managed_by_vendor_id: null,
  updated_at: '2026-08-31T00:00:00.000Z',
};

async function setup(api: ApiMock) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ManagedByApi, useValue: api },
      { provide: AdminVendorsApi, useValue: { listVendors: vi.fn(async () => ({ data: [] })) } },
    ],
  });
  const fixture = TestBed.createComponent(TestHost);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
}

function clickByText(el: HTMLElement, text: string): void {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button containing "${text}"`);
  button.click();
}

describe('ManagedByControl', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('states the current lane and offers the other one', async () => {
    const { el } = await setup({ setManagement: vi.fn() });
    expect(el.textContent).toContain('review-managed');
    expect(el.textContent).toContain('Hand the lane to a vendor');
  });

  it('says the review lane freezes, and that no account is granted', async () => {
    const { fixture, el } = await setup({ setManagement: vi.fn() });
    clickByText(el, 'Hand the lane to a vendor');
    fixture.detectChanges();
    expect(el.textContent).toContain('freezes the review lane');
    expect(el.textContent).toContain('does not create an account');
  });

  it('sends the flip and hands the committed readout back to the host', async () => {
    const api = { setManagement: vi.fn(async () => okResponse) };
    const { fixture, host, el } = await setup(api);
    clickByText(el, 'Hand the lane to a vendor');
    fixture.detectChanges();
    clickByText(el, 'Confirm handover');
    await settle();
    fixture.detectChanges();

    expect(api.setManagement).toHaveBeenCalledWith(CATALOG, { managedBy: 'vendor' });
    expect(host.changes).toEqual([okResponse]);
    expect(host.announced()).toContain('review lane is frozen');
  });

  it('reports a 422 as "already in that lane" and emits nothing', async () => {
    const api = {
      setManagement: vi.fn(async () => {
        throw new HttpErrorResponse({ status: 422 });
      }),
    };
    const { fixture, host, el } = await setup(api);
    clickByText(el, 'Hand the lane to a vendor');
    fixture.detectChanges();
    clickByText(el, 'Confirm handover');
    await settle();
    fixture.detectChanges();

    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('already in the lane');
    // Pessimistic: a failed write changes nothing the host renders.
    expect(host.changes).toEqual([]);
    expect(host.managedBy()).toBe('review');
    // The form stays open so the operator can react.
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('reports a 404 as an unresolved vendor, not as a missing catalogue', async () => {
    const api = {
      setManagement: vi.fn(async () => {
        throw new HttpErrorResponse({ status: 404 });
      }),
    };
    const { fixture, el } = await setup(api);
    clickByText(el, 'Hand the lane to a vendor');
    fixture.detectChanges();
    clickByText(el, 'Confirm handover');
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('could not find that vendor');
  });

  describe('host-owned chrome (the extraction contract)', () => {
    it('renders NO live region of its own', async () => {
      const { fixture, el } = await setup({ setManagement: vi.fn() });
      clickByText(el, 'Hand the lane to a vendor');
      fixture.detectChanges();
      const control = el.querySelector('aec-managed-by-control')!;
      expect(control.querySelector('[role="status"]')).toBeNull();
      expect(control.querySelector('[aria-live]')).toBeNull();
    });

    it('renders NO heading of its own', async () => {
      const { el } = await setup({ setManagement: vi.fn() });
      const control = el.querySelector('aec-managed-by-control')!;
      expect(control.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    });

    it('wires aria-labelledby to the host heading', async () => {
      const { el } = await setup({ setManagement: vi.fn() });
      const labelled = el.querySelector('[aria-labelledby="host-heading"]');
      expect(labelled).not.toBeNull();
    });

    it('scopes every form control id by idPrefix', async () => {
      const { fixture, el } = await setup({ setManagement: vi.fn() });
      clickByText(el, 'Hand the lane to a vendor');
      fixture.detectChanges();
      for (const control of el.querySelectorAll('input[id], textarea[id]')) {
        expect(control.id).toContain('test');
        expect(el.querySelector(`label[for="${control.id}"]`)).not.toBeNull();
      }
    });
  });
});
