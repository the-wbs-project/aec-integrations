/**
 * `LicenseRowActions`: the per-license Extend, Change reference and Revoke actions on
 * the admin Billing tab (AECI-1371, E4.2).
 *
 * Pinned here:
 *  1. which actions a license offers: none when ended, Revoke only on Stripe,
 *     Change reference only on invoice, "Set end date" on an open-ended license;
 *  2. each form sends the PATCH body the API expects, emits `changed` and announces;
 *  3. a revoke needs a reason, and its confirm copy says what happens to the product;
 *  4. errors read as sentences, and the form stays open;
 *  5. no heading and no live region of its own.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminBillingLicense, UpdateLicenseBody, UpdateLicenseResponse } from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';
import { toBillingLicenseRow, type BillingLicenseRow } from './billing-licenses-table';
import { LicenseRowActions, licenseRowActions } from './license-row-actions';

const LICENSE_ID = '00000000-0000-4000-8000-000000000001';

function makeLicense(over: Partial<AdminBillingLicense> = {}): AdminBillingLicense {
  return {
    id: LICENSE_ID,
    source: 'invoice',
    starts_at: '2026-10-01T00:00:00.000Z',
    ends_at: '2027-09-30T00:00:00.000Z',
    ended_at: null,
    end_reason: null,
    live: true,
    reference: 'PO-77',
    assigned_product: { id: 'p1', slug: 'revit', name: 'Revit' },
    assigned_at: '2026-10-02T00:00:00.000Z',
    release_at_renewal: false,
    cancel_at_term_end: false,
    cancel_reason: null,
    stripe_subscription_id: null,
    terms_version: null,
    granted_by: 'admin-1',
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function responseFor(input: UpdateLicenseBody, changed = true): UpdateLicenseResponse {
  const license = makeLicense();
  return {
    vendor_id: 'v1',
    billing_account_id: 'ba1',
    action: input.action,
    changed,
    license: {
      id: license.id,
      source: 'invoice',
      starts_at: license.starts_at,
      ends_at: input.action === 'extend' ? `${input.ends_at}T00:00:00.000Z` : license.ends_at,
      reference: input.action === 'reference' ? input.reference : license.reference,
      assigned_product_id: 'p1',
      ended_at: input.action === 'revoke' ? '2026-10-15T00:00:00.000Z' : null,
      end_reason: input.action === 'revoke' ? 'revoked' : null,
    },
  };
}

@Component({
  selector: 'aec-test-host',
  imports: [LicenseRowActions],
  template: `
    <p role="status" aria-live="polite">{{ announced() }}</p>
    <aec-license-row-actions
      [row]="row()"
      idPrefix="host-1"
      (changed)="changes.push($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly row = signal<BillingLicenseRow>(toBillingLicenseRow(makeLicense(), 'en-US'));
  readonly announced = signal('');
  readonly changes: UpdateLicenseResponse[] = [];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(license: AdminBillingLicense, updateLicense = vi.fn()) {
  updateLicense.mockImplementation(
    updateLicense.getMockImplementation() ??
      (async (_id: string, input: UpdateLicenseBody) => responseFor(input)),
  );
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AdminLicensesApi, useValue: { updateLicense } },
    ],
  });
  const fixture = TestBed.createComponent(TestHost);
  fixture.componentInstance.row.set(toBillingLicenseRow(license, 'en-US'));
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

const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll('aec-license-row-actions button')].map((b) => b.textContent?.trim());
const button = (el: HTMLElement, text: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found as HTMLButtonElement;
};
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('licenseRowActions', () => {
  it('offers everything on a live invoice license', () => {
    expect(licenseRowActions(makeLicense())).toEqual({
      extend: true,
      reference: true,
      revoke: true,
    });
  });

  it('offers no reference on complimentary, only Revoke on Stripe, nothing when ended', () => {
    expect(licenseRowActions(makeLicense({ source: 'complimentary' }))).toEqual({
      extend: true,
      reference: false,
      revoke: true,
    });
    expect(licenseRowActions(makeLicense({ source: 'stripe' }))).toEqual({
      extend: false,
      reference: false,
      revoke: true,
    });
    expect(licenseRowActions(makeLicense({ live: false, ended_at: '2026-10-01' }))).toEqual({
      extend: false,
      reference: false,
      revoke: false,
    });
  });
});

describe('LicenseRowActions', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('shows the three actions on a live invoice license, and no heading or live region', async () => {
    const { el } = await setup(makeLicense());
    expect(buttons(el)).toEqual(['Extend', 'Change reference', 'Revoke']);
    const control = el.querySelector('aec-license-row-actions')!;
    expect(control.querySelector('h1, h2, h3, h4, [role="status"]')).toBeNull();
  });

  it('shows only Revoke on a Stripe license', async () => {
    const { el } = await setup(makeLicense({ source: 'stripe', reference: null }));
    expect(buttons(el)).toEqual(['Revoke']);
  });

  it('shows no action on an ended license, and says so to a screen reader', async () => {
    const { el } = await setup(
      makeLicense({ live: false, ended_at: '2026-10-01T00:00:00.000Z', end_reason: 'lapsed' }),
    );
    expect(buttons(el)).toEqual([]);
    expect(el.textContent).toContain('No actions on an ended license');
  });

  it('reads "Set end date" on an open-ended license', async () => {
    const { el } = await setup(makeLicense({ source: 'complimentary', ends_at: null }));
    expect(buttons(el)).toEqual(['Set end date', 'Revoke']);
  });

  it('extends: refuses an earlier date, sends the new one, announces and emits', async () => {
    const { el, host, refresh, updateLicense } = await setup(makeLicense());
    button(el, 'Extend').click();
    await refresh();
    const input = el.querySelector<HTMLInputElement>('#host-1-license-end')!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('min')).toBe('2027-10-01');

    type(input, '2027-09-01');
    await refresh();
    expect(el.textContent).toContain('Pick a date after the current end date.');
    expect(button(el, 'Save end date').disabled).toBe(true);

    type(input, '2028-09-30');
    await refresh();
    button(el, 'Save end date').click();
    await refresh();
    expect(updateLicense).toHaveBeenCalledWith(LICENSE_ID, {
      action: 'extend',
      ends_at: '2028-09-30',
    });
    expect(host.changes).toHaveLength(1);
    expect(host.announced()).toBe('License now ends on Sep 30, 2028.');
    expect(buttons(el)).toEqual(['Extend', 'Change reference', 'Revoke']);
  });

  it('changes the reference, trimmed, and disables Save until it differs', async () => {
    const { el, host, refresh, updateLicense } = await setup(makeLicense());
    button(el, 'Change reference').click();
    await refresh();
    const input = el.querySelector<HTMLInputElement>('#host-1-license-reference')!;
    expect(input.value).toBe('PO-77');
    expect(button(el, 'Save reference').disabled).toBe(true);
    type(input, ' INV-2 ');
    await refresh();
    button(el, 'Save reference').click();
    await refresh();
    expect(updateLicense).toHaveBeenCalledWith(LICENSE_ID, {
      action: 'reference',
      reference: 'INV-2',
    });
    expect(host.announced()).toBe('License reference changed to INV-2.');
  });

  it('revoke: names the product in the confirm copy, and needs a reason', async () => {
    const { el, refresh, updateLicense } = await setup(makeLicense());
    button(el, 'Revoke').click();
    await refresh();
    expect(el.textContent).toContain('Revit drops to the Free plan');
    expect(el.textContent).toContain('Nothing is refunded or deleted');
    const reason = el.querySelector<HTMLTextAreaElement>('#host-1-license-reason')!;
    expect(document.activeElement).toBe(reason);

    button(el, 'Confirm revoke').click();
    await refresh();
    expect(updateLicense).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Enter a reason for the vendor.');
    expect(reason.getAttribute('aria-invalid')).toBe('true');
  });

  it('revoke: sends the reason and the internal note, then announces the product on Free', async () => {
    const { el, host, refresh, updateLicense } = await setup(makeLicense());
    button(el, 'Revoke').click();
    await refresh();
    type(el.querySelector<HTMLTextAreaElement>('#host-1-license-reason')!, ' Not paid. ');
    type(el.querySelector<HTMLTextAreaElement>('#host-1-license-note')!, 'Ticket 42');
    await refresh();
    button(el, 'Confirm revoke').click();
    await refresh();
    expect(updateLicense).toHaveBeenCalledWith(LICENSE_ID, {
      action: 'revoke',
      reason: 'Not paid.',
      internalNote: 'Ticket 42',
    });
    expect(host.changes).toHaveLength(1);
    expect(host.announced()).toBe(
      'License revoked. Revit is on the Free plan now, and the vendor was told why.',
    );
  });

  it('revoke of an unassigned license says no plan changes and sends no note when blank', async () => {
    const { el, host, refresh, updateLicense } = await setup(
      makeLicense({ assigned_product: null, assigned_at: null }),
    );
    button(el, 'Revoke').click();
    await refresh();
    expect(el.textContent).toContain('It is not on a product, so no product changes plan');
    type(el.querySelector<HTMLTextAreaElement>('#host-1-license-reason')!, 'Mistake.');
    await refresh();
    button(el, 'Confirm revoke').click();
    await refresh();
    expect(updateLicense).toHaveBeenCalledWith(LICENSE_ID, {
      action: 'revoke',
      reason: 'Mistake.',
    });
    expect(host.announced()).toContain('It was not on a product, so no plan changed.');
  });

  it('keeps the form open with a sentence on a 409 from Stripe', async () => {
    const updateLicense = vi.fn(async () => {
      throw new HttpErrorResponse({ status: 409 });
    });
    const { el, host, refresh } = await setup(makeLicense(), updateLicense);
    button(el, 'Extend').click();
    await refresh();
    type(el.querySelector<HTMLInputElement>('#host-1-license-end')!, '2028-01-01');
    await refresh();
    button(el, 'Save end date').click();
    await refresh();
    expect(el.textContent).toContain('Stripe manages this license.');
    expect(el.querySelector('#host-1-license-end')).not.toBeNull();
    expect(host.changes).toHaveLength(0);
  });

  it('Cancel closes the form and returns focus to its button', async () => {
    const { el, refresh } = await setup(makeLicense());
    button(el, 'Revoke').click();
    await refresh();
    button(el, 'Cancel').click();
    await refresh();
    expect(el.querySelector('#host-1-license-reason')).toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe('Revoke');
  });
});
