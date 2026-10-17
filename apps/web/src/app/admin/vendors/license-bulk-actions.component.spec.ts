/**
 * `LicenseBulkActions` mounted in `BillingLicensesTable`'s `bulkActions` seam: the
 * checkbox column, select-all, and the bulk Set end date and Revoke.
 *
 * Pinned here:
 *  1. no checkbox column without the seam; a box on live rows only;
 *  2. select-all checks every live row, reads indeterminate on a partial selection,
 *     and the bar shows only while something is checked;
 *  3. Set end date sends one `extend` PATCH per non-Stripe license, skips Stripe and
 *     says so, and floors the date at the latest current end;
 *  4. Revoke needs a reason and sends the same one on every license;
 *  5. a license that changed is unchecked; a failure stays checked with its sentence;
 *     a 429 stops the run;
 *  6. the checkboxes lock and the bar stays up while a run is in flight.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminBillingLicense,
  AdminVendorBillingResponse,
  UpdateLicenseBody,
  UpdateLicenseResponse,
} from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';
import { BillingLicensesTable } from './billing-licenses-table';
import { LicenseBulkActions } from './license-bulk-actions';

function makeLicense(over: Partial<AdminBillingLicense> = {}): AdminBillingLicense {
  return {
    id: 'l1',
    source: 'complimentary',
    starts_at: '2026-09-14T00:00:00.000Z',
    ends_at: null,
    ended_at: null,
    end_reason: null,
    live: true,
    reference: null,
    assigned_product: { id: 'p1', slug: 'plangrid', name: 'PlanGrid' },
    assigned_at: '2026-09-14T00:00:00.000Z',
    release_at_renewal: false,
    cancel_at_term_end: false,
    cancel_reason: null,
    stripe_subscription_id: null,
    terms_version: null,
    granted_by: 'admin-1',
    created_at: '2026-09-14T00:00:00.000Z',
    ...over,
  };
}

const LICENSES: AdminBillingLicense[] = [
  makeLicense({ id: 'l1' }),
  makeLicense({
    id: 'l2',
    source: 'invoice',
    reference: 'PO-1',
    ends_at: '2027-12-31T00:00:00.000Z',
    assigned_product: { id: 'p2', slug: 'civil-3d', name: 'Civil 3D' },
  }),
  makeLicense({
    id: 'l3',
    source: 'stripe',
    assigned_product: { id: 'p3', slug: 'navisworks', name: 'Navisworks' },
  }),
  makeLicense({ id: 'l4', assigned_product: null }),
  makeLicense({
    id: 'ended',
    live: false,
    ended_at: '2026-10-10T00:00:00.000Z',
    end_reason: 'revoked',
  }),
];

function makeBilling(licenses = LICENSES): AdminVendorBillingResponse {
  return {
    vendor_id: 'v1',
    billing_account: {
      id: 'ba1',
      name: 'Autodesk, Inc.',
      billing_email: null,
      stripe_customer_id: null,
      created_at: '2026-10-01T00:00:00.000Z',
      owner_seats: [],
      seat_emails_available: true,
    },
    licenses,
    licenses_truncated: false,
    acceptances: [],
    acceptances_truncated: false,
    release_requests: [],
  };
}

function okFor(id: string, input: UpdateLicenseBody): UpdateLicenseResponse {
  return {
    vendor_id: 'v1',
    billing_account_id: 'ba1',
    action: input.action,
    changed: true,
    license: {
      id,
      source: 'complimentary',
      starts_at: '2026-09-14T00:00:00.000Z',
      ends_at: input.action === 'extend' ? `${input.ends_at}T00:00:00.000Z` : null,
      reference: null,
      assigned_product_id: null,
      ended_at: input.action === 'revoke' ? '2026-10-16T00:00:00.000Z' : null,
      end_reason: input.action === 'revoke' ? 'revoked' : null,
    },
  };
}

@Component({
  selector: 'aec-test-host',
  imports: [BillingLicensesTable, LicenseBulkActions],
  template: `
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <ng-template #bulk let-rows let-deselect="deselect" let-busy="busy">
      <aec-license-bulk-actions
        [rows]="rows"
        idPrefix="t"
        (succeeded)="deselect($event)"
        (pendingChange)="busy($event)"
        (changed)="changes = changes + 1"
        (announce)="announced.set($event)"
      />
    </ng-template>
    <aec-billing-licenses-table
      [billing]="billing()"
      [loading]="false"
      [failed]="false"
      [bulkActions]="withBulk() ? bulk : null"
    />
  `,
})
class TestHost {
  readonly billing = signal(makeBilling());
  readonly withBulk = signal(true);
  readonly announced = signal('');
  changes = 0;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(
  updateLicense = vi.fn(async (id: string, input: UpdateLicenseBody) => okFor(id, input)),
  withBulk = true,
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AdminLicensesApi, useValue: { updateLicense } },
    ],
  });
  const fixture = TestBed.createComponent(TestHost);
  fixture.componentInstance.withBulk.set(withBulk);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();
  };
  return { fixture, host: fixture.componentInstance, el, refresh, updateLicense };
}

/** Text with runs of whitespace collapsed: ICU messages wrap across template lines. */
const text = (node: Element | null | undefined) =>
  (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const rowBoxes = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLInputElement>('[data-testid="billing-select-row"]'),
];
const selectAll = (el: HTMLElement) =>
  el.querySelector<HTMLInputElement>('[data-testid="billing-select-all"]')!;
const bar = (el: HTMLElement) => el.querySelector('[data-testid="billing-bulk-bar"]');
const button = (el: HTMLElement, label: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => text(b) === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found as HTMLButtonElement;
};
function click(box: HTMLInputElement): void {
  box.click();
}
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('LicenseBulkActions in the Billing table', () => {
  it('has no checkbox column without the bulk seam', async () => {
    const { el } = await setup(undefined, false);
    expect(rowBoxes(el)).toHaveLength(0);
    expect(el.querySelector('[data-testid="billing-select-all"]')).toBeNull();
  });

  it('puts a box on every live row and none on an ended one, labelled by product', async () => {
    const { el } = await setup();
    const boxes = rowBoxes(el);
    expect(boxes).toHaveLength(4);
    expect(boxes[0]!.getAttribute('aria-label')).toBe('Select the license on PlanGrid');
    expect(boxes[3]!.getAttribute('aria-label')).toBe(
      'Select this unassigned Complimentary license',
    );
    const rows = el.querySelectorAll('[data-testid="billing-license-row"]');
    expect(rows[4]!.querySelector('[data-testid="billing-select-row"]')).toBeNull();
    expect(selectAll(el).getAttribute('aria-label')).toBe('Select every live license');
    // The box is the first column, ahead of the product.
    expect(el.querySelector('thead tr')!.firstElementChild!.contains(selectAll(el))).toBe(true);
    expect(rows[0]!.firstElementChild!.contains(boxes[0]!)).toBe(true);
  });

  it('shows the bar only while something is checked, and select-all reads indeterminate on a partial set', async () => {
    const { el, refresh } = await setup();
    expect(bar(el)).toBeNull();

    click(rowBoxes(el)[0]!);
    await refresh();
    expect(text(bar(el))).toContain('1 license selected');
    expect(selectAll(el).indeterminate).toBe(true);
    expect(selectAll(el).checked).toBe(false);

    click(selectAll(el));
    await refresh();
    expect(text(bar(el))).toContain('4 licenses selected');
    expect(rowBoxes(el).every((b) => b.checked)).toBe(true);
    expect(selectAll(el).indeterminate).toBe(false);
    expect(selectAll(el).checked).toBe(true);

    click(selectAll(el));
    await refresh();
    expect(bar(el)).toBeNull();
    expect(rowBoxes(el).some((b) => b.checked)).toBe(false);
  });

  it('sets one end date on every non-Stripe license, skips Stripe, then unchecks them', async () => {
    const { el, host, refresh, updateLicense } = await setup();
    click(selectAll(el));
    await refresh();
    button(el, 'Set end date').click();
    await refresh();

    expect(text(el.querySelector('[data-testid="license-bulk-skipped"]'))).toContain(
      '1 selected Stripe license is skipped.',
    );
    const date = el.querySelector<HTMLInputElement>('#t-bulk-end')!;
    // The invoice license ends 2027-12-31, the latest current end of the three.
    expect(date.getAttribute('min')).toBe('2028-01-01');
    expect(document.activeElement).toBe(date);

    type(date, '2027-06-30');
    await refresh();
    expect(el.textContent).toContain(
      "Pick a date after every selected license's current end date.",
    );
    expect(button(el, 'Save end date').disabled).toBe(true);

    type(date, '2028-06-30');
    await refresh();
    button(el, 'Save end date').click();
    await refresh();

    expect(updateLicense.mock.calls).toEqual([
      ['l1', { action: 'extend', ends_at: '2028-06-30' }],
      ['l2', { action: 'extend', ends_at: '2028-06-30' }],
      ['l4', { action: 'extend', ends_at: '2028-06-30' }],
    ]);
    expect(host.changes).toBe(1);
    expect(host.announced()).toBe('Set the end date on 3 of the selected licenses.');
    // The Stripe license was not touched, so it stays checked.
    expect(rowBoxes(el).map((b) => b.checked)).toEqual([false, false, true, false]);
    expect(el.querySelector('[data-testid="license-bulk-form"]')).toBeNull();
  });

  it('needs a reason to revoke, then sends the same reason and note on every license', async () => {
    const { el, host, refresh, updateLicense } = await setup();
    click(rowBoxes(el)[0]!);
    click(rowBoxes(el)[2]!);
    click(rowBoxes(el)[3]!);
    await refresh();
    button(el, 'Revoke').click();
    await refresh();

    expect(text(el)).toContain('Revoke 3 licenses? Each ends now.');
    // Paid Tiers §5.2: a license revoke is not a seat revoke and not a ban.
    expect(text(el.querySelector('[data-testid="license-bulk-revoke-not-seat"]'))).toBe(
      'Seats and logins stay. This is not a seat revoke or a ban.',
    );
    expect(text(el.querySelector('[data-testid="license-bulk-revoke-products"]'))).toContain(
      '2 are on products. Each of those products drops to the Free plan.',
    );

    button(el, 'Revoke 3 licenses').click();
    await refresh();
    expect(updateLicense).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Enter a reason for the vendor.');

    type(el.querySelector<HTMLTextAreaElement>('#t-bulk-reason')!, ' Contract ended ');
    type(el.querySelector<HTMLTextAreaElement>('#t-bulk-note')!, 'Per Chris');
    await refresh();
    button(el, 'Revoke 3 licenses').click();
    await refresh();

    const body = { action: 'revoke', reason: 'Contract ended', internalNote: 'Per Chris' };
    expect(updateLicense.mock.calls).toEqual([
      ['l1', body],
      ['l3', body],
      ['l4', body],
    ]);
    expect(host.announced()).toBe('Revoked 3 of the selected licenses.');
    expect(bar(el)).toBeNull();
  });

  it('keeps a failed license checked with its sentence, and a 429 stops the run', async () => {
    const updateLicense = vi.fn(async (id: string, input: UpdateLicenseBody) => {
      if (id === 'l2') throw new HttpErrorResponse({ status: 422 });
      if (id === 'l3') throw new HttpErrorResponse({ status: 429 });
      return okFor(id, input);
    });
    const { el, host, refresh } = await setup(updateLicense);
    click(selectAll(el));
    await refresh();
    button(el, 'Revoke').click();
    await refresh();
    type(el.querySelector<HTMLTextAreaElement>('#t-bulk-reason')!, 'Contract ended');
    await refresh();
    button(el, 'Revoke 4 licenses').click();
    await refresh();

    // l1 revoked; l2 refused; l3 hit the rate limit, so l3 and l4 were not tried.
    expect(updateLicense.mock.calls.map((c) => c[0])).toEqual(['l1', 'l2', 'l3']);
    expect(rowBoxes(el).map((b) => b.checked)).toEqual([false, true, true, true]);
    const failures = el.querySelector('[data-testid="license-bulk-failures"]')!;
    expect(failures.getAttribute('role')).toBe('alert');
    expect(text(failures)).toContain('1 license was not changed and is still selected:');
    expect(text(failures)).toContain('Civil 3D');
    expect(text(failures)).toContain('This license changed or ended since you opened it');
    expect(text(failures)).toContain('The rate limit stopped the run with 2 licenses not tried.');
    expect(host.changes).toBe(1);
    expect(host.announced()).toBe(
      'Revoked 1 of the selected licenses. 1 could not be changed. They are still selected. ' +
        'Stopped by the rate limit with 2 not tried. Wait a minute, then run it again.',
    );
  });

  it('gives a 409 CONTEST_INTEGRATION_CHANGED its own sentence and keeps that license checked (AECI-1375)', async () => {
    const updateLicense = vi.fn(async (id: string, input: UpdateLicenseBody) => {
      if (id === 'l1') {
        throw new HttpErrorResponse({
          status: 409,
          error: { error: { code: 'CONTEST_INTEGRATION_CHANGED', message: 'x' } },
        });
      }
      return okFor(id, input);
    });
    const { el, refresh } = await setup(updateLicense);
    click(rowBoxes(el)[0]!);
    await refresh();
    button(el, 'Revoke').click();
    await refresh();
    type(el.querySelector<HTMLTextAreaElement>('#t-bulk-reason')!, 'Contract ended');
    await refresh();
    button(el, 'Revoke 1 license').click();
    await refresh();

    expect(rowBoxes(el)[0]!.checked).toBe(true);
    const failures = el.querySelector('[data-testid="license-bulk-failures"]')!;
    expect(text(failures)).toContain(
      "Field contests on this vendor's integrations changed while the license was being revoked. Nothing was saved. Try again.",
    );
    expect(text(failures)).not.toContain('Stripe manages this license.');
  });

  it('locks the checkboxes and keeps the bar while a run is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const updateLicense = vi.fn(async (id: string, input: UpdateLicenseBody) => {
      await gate;
      return okFor(id, input);
    });
    const { el, host, refresh } = await setup(updateLicense);
    click(rowBoxes(el)[0]!);
    await refresh();
    button(el, 'Revoke').click();
    await refresh();
    type(el.querySelector<HTMLTextAreaElement>('#t-bulk-reason')!, 'Contract ended');
    await refresh();
    button(el, 'Revoke 1 license').click();
    await refresh();

    expect(rowBoxes(el).every((b) => b.disabled)).toBe(true);
    expect(selectAll(el).disabled).toBe(true);
    expect(bar(el)).not.toBeNull();

    release();
    await refresh();
    expect(host.changes).toBe(1);
    expect(host.announced()).toBe('Revoked 1 of the selected licenses.');
    expect(rowBoxes(el).some((b) => b.disabled)).toBe(false);
    expect(bar(el)).toBeNull();
  });

  it('disables Set end date when every checked license is Stripe', async () => {
    const { el, refresh } = await setup();
    click(rowBoxes(el)[2]!);
    await refresh();
    expect(button(el, 'Set end date').disabled).toBe(true);
    expect(button(el, 'Revoke').disabled).toBe(false);
  });
});
