import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorBillingLicense } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ACCEPTANCES_FIXTURE, VENDOR_BILLING_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorLicenseReleaseSwitch } from './vendor-license-release-switch';

/**
 * The release-at-renewal switch (AECI-1391, E5.5). A `role="switch"` whose
 * `aria-checked` follows the license, shows the asked-for state while the PATCH
 * runs, and goes back on a failure with a visible reason.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** The fixture's assigned license, flag cleared. */
const ASSIGNED: VendorBillingLicense = {
  ...VENDOR_BILLING_FIXTURE.licenses[0]!,
  release_at_renewal: false,
};

describe('VendorLicenseReleaseSwitch', () => {
  let setReleaseAtRenewal: ReturnType<typeof vi.fn>;
  let getBilling: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setReleaseAtRenewal = vi.fn().mockResolvedValue({ license: ASSIGNED });
    getBilling = vi.fn().mockResolvedValue(VENDOR_BILLING_FIXTURE);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        {
          provide: VendorApi,
          useValue: {
            setReleaseAtRenewal,
            getBilling,
            getAcceptances: vi.fn().mockResolvedValue({ acceptances: VENDOR_ACCEPTANCES_FIXTURE }),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function render(license: VendorBillingLicense = ASSIGNED) {
    const fixture = TestBed.createComponent(VendorLicenseReleaseSwitch);
    fixture.componentRef.setInput('license', license);
    fixture.detectChanges();
    return fixture;
  }

  const sw = (fixture: ComponentFixture<VendorLicenseReleaseSwitch>) =>
    (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="license-release-switch"]',
    ) as HTMLButtonElement;

  it('is a labelled switch whose aria-checked follows the license', () => {
    const off = render();
    const button = sw(off);
    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-checked')).toBe('false');
    const labelId = button.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)?.textContent?.trim()).toBe('Release at renewal');
    const helpId = button.getAttribute('aria-describedby')!;
    expect(document.getElementById(helpId)?.textContent).toContain('goes back to Free');

    const on = render({ ...ASSIGNED, release_at_renewal: true });
    expect(sw(on).getAttribute('aria-checked')).toBe('true');
  });

  it('turns the flag on, shows it pending, re-reads billing and announces', async () => {
    let resolve!: (v: unknown) => void;
    setReleaseAtRenewal.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = render();

    sw(fixture).click();
    fixture.detectChanges();
    expect(setReleaseAtRenewal).toHaveBeenCalledWith(ASSIGNED.id, true);
    expect(sw(fixture).getAttribute('aria-checked')).toBe('true');
    expect(sw(fixture).getAttribute('aria-busy')).toBe('true');

    resolve({ license: { ...ASSIGNED, release_at_renewal: true } });
    await flush();
    fixture.detectChanges();

    expect(getBilling).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('This license will come off its product at renewal.');
    expect(sw(fixture).getAttribute('aria-busy')).toBeNull();
  });

  it('turns the flag off', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = render({ ...ASSIGNED, release_at_renewal: true });

    sw(fixture).click();
    await flush();

    expect(setReleaseAtRenewal).toHaveBeenCalledWith(ASSIGNED.id, false);
    expect(announce).toHaveBeenCalledWith('This license will renew on its product.');
  });

  it('reverts and explains on a failure', async () => {
    setReleaseAtRenewal.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const fixture = render();

    sw(fixture).click();
    await flush();
    fixture.detectChanges();

    expect(sw(fixture).getAttribute('aria-checked')).toBe('false');
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="license-release-error"]')
        ?.textContent?.trim(),
    ).toBe('Could not save the setting. It has not changed. Try again.');
    expect(getBilling).not.toHaveBeenCalled();
  });

  it('re-reads billing on a 409 LICENSE_NOT_ASSIGNED', async () => {
    setReleaseAtRenewal.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'LICENSE_NOT_ASSIGNED', message: 'x' } },
      }),
    );
    const fixture = render();

    sw(fixture).click();
    await flush();
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="license-release-error"]')
        ?.textContent?.trim(),
    ).toBe('This license is no longer on a product, or it has ended.');
    expect(getBilling).toHaveBeenCalledTimes(1);
  });
});
