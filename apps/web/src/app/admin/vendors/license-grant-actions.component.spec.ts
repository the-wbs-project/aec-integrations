/**
 * AECI-1615: the Withdraw action on a pending grant row of the admin Billing tab,
 * mounted through `BillingLicensesTable`'s `grantActions` seam as `VendorDetail` mounts
 * it. Pinned here: only a pending grant offers it, the confirm is inline, a reason is
 * required, and a withdraw tells the host to refetch.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, TemplateRef, provideZonelessChangeDetection, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { AdminLicenseGrant, AdminVendorBillingResponse } from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';
import { BillingLicensesTable, type BillingGrantRowContext } from './billing-licenses-table';
import { LicenseGrantActions } from './license-grant-actions';

function makeGrant(over: Partial<AdminLicenseGrant> = {}): AdminLicenseGrant {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    kind: 'grant',
    status: 'pending_acceptance',
    source: 'complimentary',
    quantity: 2,
    starts_at: null,
    ends_at: '2027-06-30T00:00:00.000Z',
    reference: null,
    notes: null,
    terms_version: '1.1',
    items: [],
    granted_by: 'admin-1',
    acceptance_id: null,
    acceptance_method: null,
    decided_at: null,
    decided_by: null,
    withdraw_reason: null,
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
    ...over,
  };
}

function makeBilling(grants: AdminLicenseGrant[]): AdminVendorBillingResponse {
  return {
    vendor_id: 'v1',
    legal_name: null,
    billing_account: {
      id: 'ba1',
      name: 'Autodesk, Inc.',
      billing_email: null,
      stripe_customer_id: null,
      created_at: '2026-10-01T00:00:00.000Z',
      owner_seats: [],
      seat_emails_available: true,
    },
    licenses: [],
    licenses_truncated: false,
    acceptances: [],
    acceptances_truncated: false,
    release_requests: [],
    grants,
    grants_truncated: false,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function mount(grants: AdminLicenseGrant[], withdraw = vi.fn()) {
  @Component({
    imports: [BillingLicensesTable, LicenseGrantActions],
    template: `
      <ng-template #grantActions let-row>
        <aec-license-grant-actions
          [grant]="row.grant"
          [idPrefix]="'grant-' + row.grant.id"
          (changed)="changed = changed + 1"
          (announce)="announced = $event"
        />
      </ng-template>
      <aec-billing-licenses-table
        [billing]="billing"
        [loading]="false"
        [failed]="false"
        [grantActions]="grantActions"
      />
    `,
  })
  class Host {
    billing = makeBilling(grants);
    changed = 0;
    announced = '';
    readonly grantActions = viewChild<TemplateRef<BillingGrantRowContext>>('grantActions');
  }
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AdminLicensesApi, useValue: { withdrawLicenseGrant: withdraw } },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();
  };
  return { fixture, el, host: fixture.componentInstance, refresh, withdraw };
}

const q = <T extends Element>(el: HTMLElement, id: string) =>
  el.querySelector<T>(`[data-testid="${id}"]`);

describe('LicenseGrantActions (AECI-1615)', () => {
  it('renders each grant with its columns, and offers Withdraw on a pending one only', async () => {
    const { el } = await mount([
      makeGrant(),
      makeGrant({
        id: 'g-accepted',
        status: 'accepted',
        acceptance_method: 'signed_deal',
        decided_at: '2026-11-11T00:00:00.000Z',
      }),
    ]);
    const table = q<HTMLTableElement>(el, 'billing-grants')!;
    const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(headers).toEqual([
      'Status',
      'Kind',
      'Quantity',
      'Source',
      'Created',
      'Ends',
      'Pinned version',
      'Acceptance method',
      'Decided',
      'Actions',
    ]);
    const rows = el.querySelectorAll('[data-testid="billing-grant-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Waiting for acceptance');
    expect(rows[0]!.querySelector('[data-testid="grant-withdraw-open"]')).not.toBeNull();
    expect(rows[1]!.textContent).toContain('Accepted');
    expect(rows[1]!.textContent).toContain('Signed deal');
    expect(rows[1]!.querySelector('[data-testid="grant-withdraw-open"]')).toBeNull();
  });

  it('confirms inline and needs a reason before it withdraws', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const withdraw = vi.fn().mockResolvedValue({ vendor_id: 'v1', grant: makeGrant() });
    const { el, host, refresh } = await mount([makeGrant()], withdraw);

    q<HTMLButtonElement>(el, 'grant-withdraw-open')!.click();
    await refresh();
    const reason = q<HTMLTextAreaElement>(el, 'grant-withdraw-reason')!;
    expect(reason).not.toBeNull();
    expect(reason.required).toBe(true);
    expect(document.activeElement === reason || el.contains(document.activeElement)).toBe(true);

    // No reason: refused on the form, nothing sent.
    q<HTMLButtonElement>(el, 'grant-withdraw-confirm')!.click();
    await refresh();
    expect(withdraw).not.toHaveBeenCalled();
    expect(q(el, 'grant-withdraw-reason-error')?.textContent).toContain('Enter a reason');
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(reason.getAttribute('aria-describedby')).toContain('grant-reason-error');

    // Whitespace only is still no reason.
    reason.value = '   ';
    reason.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(el, 'grant-withdraw-confirm')!.click();
    await refresh();
    expect(withdraw).not.toHaveBeenCalled();

    reason.value = '  Deal fell through  ';
    reason.dispatchEvent(new Event('input'));
    await refresh();
    expect(q(el, 'grant-withdraw-reason-error')).toBeNull();
    q<HTMLButtonElement>(el, 'grant-withdraw-confirm')!.click();
    await refresh();
    expect(withdraw).toHaveBeenCalledWith(makeGrant().id, 'Deal fell through');
    expect(host.changed).toBe(1);
    expect(host.announced).toBe('Grant withdrawn. The owner can no longer accept it.');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('says to reload when the grant is no longer pending (422)', async () => {
    const withdraw = vi.fn().mockRejectedValue(new HttpErrorResponse({ status: 422 }));
    const { el, host, refresh } = await mount([makeGrant()], withdraw);
    q<HTMLButtonElement>(el, 'grant-withdraw-open')!.click();
    await refresh();
    const reason = q<HTMLTextAreaElement>(el, 'grant-withdraw-reason')!;
    reason.value = 'Duplicate';
    reason.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(el, 'grant-withdraw-confirm')!.click();
    await refresh();
    expect(el.textContent).toContain('This grant is no longer waiting.');
    expect(el.textContent).toContain('Reload the page.');
    expect(host.changed).toBe(0);
  });
});
