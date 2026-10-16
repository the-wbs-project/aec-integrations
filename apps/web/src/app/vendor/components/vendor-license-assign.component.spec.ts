import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorBillingProduct } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  VENDOR_ACCEPTANCES_FIXTURE,
  VENDOR_BILLING_FIXTURE,
  VENDOR_ME_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorLicenseAssign } from './vendor-license-assign';

/**
 * The assign control (AECI-1391, E5.5). "Assign" only opens a confirmation that says
 * the license stays put until renewal; its own button writes. Then billing and `/me`
 * are re-read and one announcement goes out. Refusals get plain copy, and a `409`
 * re-reads billing.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

const POOL_LICENSE = VENDOR_BILLING_FIXTURE.licenses[1]!;
const PRODUCTS = VENDOR_BILLING_FIXTURE.assignable_products;

describe('VendorLicenseAssign', () => {
  let assignLicense: ReturnType<typeof vi.fn>;
  let getBilling: ReturnType<typeof vi.fn>;
  let getMe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignLicense = vi.fn().mockResolvedValue({ license: POOL_LICENSE });
    getBilling = vi.fn().mockResolvedValue(VENDOR_BILLING_FIXTURE);
    getMe = vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        {
          provide: VendorApi,
          useValue: {
            assignLicense,
            getBilling,
            getMe,
            getAcceptances: vi.fn().mockResolvedValue({ acceptances: VENDOR_ACCEPTANCES_FIXTURE }),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
  });

  afterEach(() => vi.restoreAllMocks());

  function render(
    products: readonly VendorBillingProduct[] = PRODUCTS,
  ): ComponentFixture<VendorLicenseAssign> {
    const fixture = TestBed.createComponent(VendorLicenseAssign);
    fixture.componentRef.setInput('license', POOL_LICENSE);
    fixture.componentRef.setInput('products', products);
    fixture.detectChanges();
    return fixture;
  }

  const el = (fixture: ComponentFixture<VendorLicenseAssign>) =>
    fixture.nativeElement as HTMLElement;
  const q = (fixture: ComponentFixture<VendorLicenseAssign>, id: string) =>
    el(fixture).querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  async function openConfirm(fixture: ComponentFixture<VendorLicenseAssign>): Promise<void> {
    q(fixture, 'license-assign-trigger')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('says so when every owned product already has a license', () => {
    const fixture = render([]);
    expect(q(fixture, 'license-assign-empty')?.textContent?.trim()).toBe(
      'Every product you own already has a license.',
    );
    expect(el(fixture).querySelector('select')).toBeNull();
  });

  it('labels the select and lists the assignable products', () => {
    const fixture = render();
    const select = el(fixture).querySelector('select') as HTMLSelectElement;
    const label = el(fixture).querySelector(`label[for="${select.id}"]`);
    expect(label?.textContent?.trim()).toBe('Product');
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual(
      PRODUCTS.map((p) => p.name),
    );
  });

  it('confirms first, with the until-renewal sentence, and moves focus to the confirm button', async () => {
    const fixture = render();
    await openConfirm(fixture);

    const confirm = q(fixture, 'license-assign-confirm')!;
    expect(confirm.getAttribute('role')).toBe('group');
    expect(confirm.textContent).toContain(
      `The license stays on ${PRODUCTS[0]!.name} until renewal.`,
    );
    expect(document.activeElement).toBe(q(fixture, 'license-assign-submit'));
    expect(assignLicense).not.toHaveBeenCalled();
  });

  it('cancel closes the confirmation without writing', async () => {
    const fixture = render();
    await openConfirm(fixture);
    (confirmButtons(fixture)[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(q(fixture, 'license-assign-confirm')).toBeNull();
    expect(assignLicense).not.toHaveBeenCalled();
  });

  it('Escape inside the confirmation cancels and returns focus to Assign', async () => {
    const fixture = render();
    await openConfirm(fixture);

    q(fixture, 'license-assign-submit')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();
    await fixture.whenStable();

    expect(q(fixture, 'license-assign-confirm')).toBeNull();
    expect(document.activeElement).toBe(q(fixture, 'license-assign-trigger'));
    expect(assignLicense).not.toHaveBeenCalled();
  });

  it('assigns, re-reads billing and /me, and announces', async () => {
    const fixture = render();
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const assigned: string[] = [];
    fixture.componentInstance.assigned.subscribe((id) => assigned.push(id));
    await openConfirm(fixture);
    q(fixture, 'license-assign-submit')!.click();
    await flush();
    fixture.detectChanges();

    expect(assignLicense).toHaveBeenCalledWith(POOL_LICENSE.id, PRODUCTS[0]!.id);
    expect(getBilling).toHaveBeenCalled();
    expect(getMe).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith(
      `License assigned. ${PRODUCTS[0]!.name} is now on the Managed plan.`,
    );
    expect(q(fixture, 'license-assign-confirm')).toBeNull();
    // The section moves focus off this control once the re-read swaps it out.
    expect(assigned).toEqual([POOL_LICENSE.id]);
  });

  it.each([
    [
      409,
      'PRODUCT_ALREADY_LICENSED',
      'That product already holds a license, possibly from a co-owner. Pick another product.',
      true,
    ],
    [409, 'LICENSE_NOT_LIVE', 'This license has ended, so it cannot go on a product.', true],
    [
      409,
      'LICENSE_ALREADY_ASSIGNED',
      'This license is already on a product. The table now shows where.',
      true,
    ],
    [403, 'FORBIDDEN', 'Only an account owner can manage licenses.', false],
    [500, 'INTERNAL', 'Could not assign the license. Try again.', false],
  ])('maps a %i %s to its copy', async (status, code, copy, reloads) => {
    assignLicense.mockRejectedValueOnce(
      new HttpErrorResponse({ status, error: { error: { code, message: 'x' } } }),
    );
    const fixture = render();
    const assigned: string[] = [];
    fixture.componentInstance.assigned.subscribe((id) => assigned.push(id));
    await openConfirm(fixture);
    q(fixture, 'license-assign-submit')!.click();
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(assigned).toEqual([]);
    expect(q(fixture, 'license-assign-error')?.textContent?.trim()).toBe(copy);
    expect(getBilling).toHaveBeenCalledTimes(reloads ? 1 : 0);
    expect(getMe).not.toHaveBeenCalled();
    // A refusal keeps the control, so focus returns to "Assign", and no `assigned`.
    expect(document.activeElement).toBe(q(fixture, 'license-assign-trigger'));
  });
});

function confirmButtons(fixture: ComponentFixture<VendorLicenseAssign>): NodeListOf<Element> {
  return (fixture.nativeElement as HTMLElement).querySelectorAll(
    '[data-testid="license-assign-confirm"] button',
  );
}
