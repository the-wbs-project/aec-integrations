/**
 * `ProvisionSeatControl`: "Add a seat" on `/admin/vendors/:id` (AECI-740).
 *
 * Pinned here (AECI-1994): opening, cancelling and submitting each remove or disable
 * the button the operator pressed, so each one moves focus on purpose:
 *  1. opening focuses the email field, and Cancel returns focus to "Add a seat";
 *  2. a provision closes back to "Add a seat" (the host's reload, AECI-2001, is not here);
 *  3. a refusal focuses its `role="alert"` message.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { ProvisionVendorSeatResponse } from '@aeci/shared';

import { ProvisionSeatControl } from './provision-seat-control';
import { SeatProvisionApi } from './seat-provision-api';

const VENDOR_ID = '00000000-0000-4000-8000-000000000003';
const ROLES = { application: 0, connector: 1, hybrid: 0, total: 1 };

const RESULT: ProvisionVendorSeatResponse = {
  user_id: 'u1',
  vendor_id: VENDOR_ID,
  email: 'ops@example.com',
  identity_outcome: 'invited',
  seat_created: true,
  seat_owner: false,
  banned: false,
  noop: false,
  entitlement_granted: false,
  verified: false,
  is_pure_connector_vendor: true,
  product_roles: ROLES,
};

@Component({
  selector: 'aec-test-host',
  imports: [ProvisionSeatControl],
  template: `
    <aec-provision-seat-control
      [vendorId]="vendorId"
      [isPureConnectorVendor]="true"
      [productRoles]="roles"
      [ownedIntegrations]="owned"
      idPrefix="host"
      (provisioned)="results.push($event)"
    />
  `,
})
class TestHost {
  readonly vendorId = VENDOR_ID;
  readonly roles = ROLES;
  readonly owned = { integrations: 0, connector_evidenced: 0, total: 0 };
  readonly results: ProvisionVendorSeatResponse[] = [];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(provisionSeat: ReturnType<typeof vi.fn>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SeatProvisionApi, useValue: { provisionSeat } },
    ],
  });
  const fixture = TestBed.createComponent(TestHost);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();
  };
  const button = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined;
  const email = () => el.querySelector<HTMLInputElement>('#host-provision-email');
  return { fixture, el, refresh, button, email };
}

describe('ProvisionSeatControl focus (AECI-1994)', () => {
  const active = () => document.activeElement as HTMLElement | null;

  it('opening focuses the email field, and Cancel returns to "Add a seat"', async () => {
    const { refresh, button, email } = await setup(vi.fn());
    button('Add a seat')!.click();
    await refresh();
    expect(active()).toBe(email());

    button('Cancel')!.click();
    await refresh();
    expect(email()).toBeNull();
    expect(active()).toBe(button('Add a seat'));
  });

  it('a provision returns focus to "Add a seat"', async () => {
    const provisionSeat = vi.fn(async () => RESULT);
    const { fixture, refresh, button, email } = await setup(provisionSeat);
    button('Add a seat')!.click();
    await refresh();
    email()!.value = 'ops@example.com';
    email()!.dispatchEvent(new Event('input'));
    await refresh();
    button('Add the seat')!.click();
    await refresh();
    expect(provisionSeat).toHaveBeenCalledWith(VENDOR_ID, { email: 'ops@example.com' });
    expect(fixture.componentInstance.results).toEqual([RESULT]);
    expect(active()).toBe(button('Add a seat'));
  });

  it('a refusal keeps the form open and focuses its message', async () => {
    const provisionSeat = vi.fn(async () => {
      throw new HttpErrorResponse({ status: 409 });
    });
    const { refresh, button, email } = await setup(provisionSeat);
    button('Add a seat')!.click();
    await refresh();
    email()!.value = 'ops@example.com';
    email()!.dispatchEvent(new Event('input'));
    await refresh();
    button('Add the seat')!.click();
    await refresh();
    expect(email()).not.toBeNull();
    expect(active()?.getAttribute('role')).toBe('alert');
    expect(active()?.textContent).toContain('That account cannot take this seat');
  });
});

describe('ProvisionSeatControl on the console recipe (AECI-2124)', () => {
  const active = () => document.activeElement as HTMLElement | null;
  const escape = (target: HTMLElement) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  it('draws no box of its own; the opener is secondary and the confirm primary', async () => {
    const { el, refresh, button } = await setup(vi.fn());
    const root = el.querySelector('[data-testid="provision-seat"]')!;
    expect(root.className).not.toContain('border');
    expect(root.className).not.toContain('rounded');
    expect(button('Add a seat')!.className).toContain('aec-btn-secondary');
    button('Add a seat')!.click();
    await refresh();
    expect(button('Add the seat')!.className).toContain('bg-(--accent-primary)');
    expect(button('Cancel')!.className).toContain('bg-transparent');
  });

  it('Escape closes the form and returns focus to "Add a seat"', async () => {
    const { refresh, button, email } = await setup(vi.fn());
    button('Add a seat')!.click();
    await refresh();
    escape(email()!);
    await refresh();
    expect(email()).toBeNull();
    expect(active()).toBe(button('Add a seat'));
  });

  it('Escape does nothing while the provision runs', async () => {
    let resolve!: (r: ProvisionVendorSeatResponse) => void;
    const provisionSeat = vi.fn(
      () => new Promise<ProvisionVendorSeatResponse>((done) => (resolve = done)),
    );
    const { refresh, button, email } = await setup(provisionSeat);
    button('Add a seat')!.click();
    await refresh();
    email()!.value = 'ops@example.com';
    email()!.dispatchEvent(new Event('input'));
    await refresh();
    button('Add the seat')!.click();
    await refresh();
    escape(email()!);
    await refresh();
    expect(email()).not.toBeNull();
    expect(email()!.closest('form')?.getAttribute('aria-busy')).toBe('true');
    resolve(RESULT);
    await refresh();
    expect(email()).toBeNull();
  });
});
