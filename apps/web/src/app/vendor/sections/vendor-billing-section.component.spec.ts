import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorBillingResponse, VendorMeResponse } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import {
  VENDOR_ACCEPTANCES_FIXTURE,
  VENDOR_BILLING_FIXTURE,
  VENDOR_ME_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorBillingSection } from './vendor-billing-section';

/**
 * The owner-only Billing tab (AECI-1390, E5.4; row actions AECI-1391, E5.5). An
 * owner sees the email, the licenses with their actions, and the agreements. A member
 * who types the URL sees a note, and the section never calls the owner-only reads.
 * After an assign, focus lands on the row's new release switch. A stale refusal is
 * shown above the table and takes focus, because the re-read swaps out the control
 * that was refused.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorBillingSection', () => {
  let getBilling: ReturnType<typeof vi.fn>;
  let getAcceptances: ReturnType<typeof vi.fn>;
  let assignLicense: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getBilling = vi.fn().mockResolvedValue(VENDOR_BILLING_FIXTURE);
    getAcceptances = vi.fn().mockResolvedValue({ acceptances: VENDOR_ACCEPTANCES_FIXTURE });
    assignLicense = vi.fn().mockResolvedValue({ license: VENDOR_BILLING_FIXTURE.licenses[1] });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideRouter([]),
        {
          provide: VendorApi,
          useValue: {
            getBilling,
            getAcceptances,
            assignLicense,
            getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function create(
    me: VendorMeResponse = VENDOR_ME_FIXTURE,
  ): Promise<ComponentFixture<VendorBillingSection>> {
    TestBed.inject(VendorPortalStore).seed(me);
    const fixture = TestBed.createComponent(VendorBillingSection);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  it('renders the email, the licenses and the agreements for an owner', async () => {
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;

    expect(getBilling).toHaveBeenCalledTimes(1);
    expect(getAcceptances).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('accounts@summitbim.example.com');
    expect(el.querySelectorAll('[data-testid="license-row"]')).toHaveLength(3);

    const acceptances = el.querySelectorAll('[data-testid="acceptance-row"]');
    expect(acceptances).toHaveLength(1);
    expect(acceptances[0]!.textContent).toContain('Vendor terms');
    expect(acceptances[0]!.textContent).toContain('dana@summitbim.example.com');
    // 1.0 is the current version, so it links to the live page, not an archive.
    expect(acceptances[0]!.querySelector('a')?.getAttribute('href')).toBe('/legal/vendor-terms');
    expect(el.querySelector('[data-testid="billing-owners-only"]')).toBeNull();
  });

  it('gives each license the actions its state allows (AECI-1391)', async () => {
    const fixture = await create();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid="license-row"]',
    );
    const has = (row: Element, id: string) => row.querySelector(`[data-testid="${id}"]`) !== null;

    // Live and assigned: the switch and the request, no assign control.
    expect(has(rows[0]!, 'license-release-switch')).toBe(true);
    expect(has(rows[0]!, 'license-release-request-trigger')).toBe(true);
    expect(has(rows[0]!, 'license-assign-select')).toBe(false);
    // Live, in the pool: the assign control only.
    expect(has(rows[1]!, 'license-assign-select')).toBe(true);
    expect(has(rows[1]!, 'license-release-switch')).toBe(false);
    // Ended: nothing.
    expect(rows[2]!.querySelectorAll('button, select')).toHaveLength(0);
  });

  it("moves focus to the new row's release switch after an assign (AECI-1391)", async () => {
    const pool = VENDOR_BILLING_FIXTURE.licenses[1]!;
    const product = VENDOR_BILLING_FIXTURE.assignable_products[0]!;
    const assignedBilling: VendorBillingResponse = {
      ...VENDOR_BILLING_FIXTURE,
      licenses: VENDOR_BILLING_FIXTURE.licenses.map((l) =>
        l.id === pool.id
          ? { ...l, assigned_product: product, assigned_at: '2026-10-16T10:00:00.000Z' }
          : l,
      ),
      assignable_products: [],
    };
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    const rows = () => el.querySelectorAll('[data-testid="license-row"]');

    (rows()[1]!.querySelector('[data-testid="license-assign-trigger"]') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    const submit = rows()[1]!.querySelector(
      '[data-testid="license-assign-submit"]',
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(submit);

    getBilling.mockResolvedValue(assignedBilling);
    submit.click();
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(assignLicense).toHaveBeenCalledWith(pool.id, product.id);
    const newSwitch = rows()[1]!.querySelector('[data-testid="license-release-switch"]');
    expect(newSwitch).not.toBeNull();
    expect(document.activeElement).toBe(newSwitch);
  });

  it('keeps a stale refusal and focus when the re-read swaps the row (AECI-1391)', async () => {
    const pool = VENDOR_BILLING_FIXTURE.licenses[1]!;
    const product = VENDOR_BILLING_FIXTURE.assignable_products[0]!;
    // Another owner assigned it first: the re-read shows it on a product.
    const assignedElsewhere: VendorBillingResponse = {
      ...VENDOR_BILLING_FIXTURE,
      licenses: VENDOR_BILLING_FIXTURE.licenses.map((l) =>
        l.id === pool.id
          ? { ...l, assigned_product: product, assigned_at: '2026-10-16T10:00:00.000Z' }
          : l,
      ),
      assignable_products: [],
    };
    assignLicense.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'LICENSE_ALREADY_ASSIGNED', message: 'x' } },
      }),
    );
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    const rows = () => el.querySelectorAll('[data-testid="license-row"]');

    (rows()[1]!.querySelector('[data-testid="license-assign-trigger"]') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    getBilling.mockResolvedValue(assignedElsewhere);
    (rows()[1]!.querySelector('[data-testid="license-assign-submit"]') as HTMLElement).click();
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
    await flush();
    fixture.detectChanges();

    // The row flipped: the assign control is gone, the switch is there.
    expect(rows()[1]!.querySelector('[data-testid="license-assign-select"]')).toBeNull();
    expect(rows()[1]!.querySelector('[data-testid="license-release-switch"]')).not.toBeNull();
    const notice = el.querySelector('[data-testid="billing-stale-notice"]');
    expect(notice?.textContent?.trim()).toBe(
      'This license is already on a product. The table now shows where.',
    );
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(notice);
  });

  it('shows a member the owners-only note and calls nothing', async () => {
    const fixture = await create({ ...VENDOR_ME_FIXTURE, seat_owner: false });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="billing-owners-only"]')).not.toBeNull();
    expect(el.querySelector('table')).toBeNull();
    expect(getBilling).not.toHaveBeenCalled();
    expect(getAcceptances).not.toHaveBeenCalled();
  });

  it('offers a retry when the read fails', async () => {
    getBilling.mockRejectedValueOnce(new Error('boom'));
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('Could not load billing.');
    (el.querySelector('button') as HTMLButtonElement).click();
    await flush();
    fixture.detectChanges();

    expect(getBilling).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll('[data-testid="license-row"]')).toHaveLength(3);
  });
});
