import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorBillingLicense } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ACCEPTANCES_FIXTURE, VENDOR_BILLING_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorLicenseActions } from './vendor-license-actions';

/**
 * The actions menu on a live, assigned license (AECI-1391, E5.5). An icon button
 * opens a menu; "Release license" opens a dialog with two timings. At renewal sets
 * the flag. Now sends a reason to AECi. "Keep at renewal" undoes the flag. The
 * dialog leaves out what is already in effect.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

const ASSIGNED: VendorBillingLicense = {
  ...VENDOR_BILLING_FIXTURE.licenses[0]!,
  release_at_renewal: false,
  open_release_request: null,
};
const OPEN_REQUEST = { id: 'req-1', created_at: '2026-10-14T09:30:00.000Z' };

describe('VendorLicenseActions', () => {
  let setReleaseAtRenewal: ReturnType<typeof vi.fn>;
  let requestLicenseRelease: ReturnType<typeof vi.fn>;
  let getBilling: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setReleaseAtRenewal = vi.fn().mockResolvedValue({ license: {} });
    requestLicenseRelease = vi.fn().mockResolvedValue({ request: {} });
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
            requestLicenseRelease,
            getBilling,
            getAcceptances: vi.fn().mockResolvedValue({ acceptances: VENDOR_ACCEPTANCES_FIXTURE }),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  function render(license: VendorBillingLicense = ASSIGNED) {
    const fixture = TestBed.createComponent(VendorLicenseActions);
    fixture.componentRef.setInput('license', license);
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    return fixture;
  }

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const dialog = () => document.querySelector<HTMLElement>('.cdk-overlay-container form');

  async function settle(fixture: ComponentFixture<VendorLicenseActions>): Promise<void> {
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function openMenu(fixture: ComponentFixture<VendorLicenseActions>): Promise<void> {
    q('license-actions-trigger')!.click();
    await settle(fixture);
  }

  async function choose(
    fixture: ComponentFixture<VendorLicenseActions>,
    item: 'license-actions-release' | 'license-actions-keep',
  ): Promise<void> {
    await openMenu(fixture);
    q(item)!.click();
    await settle(fixture);
  }

  async function submit(fixture: ComponentFixture<VendorLicenseActions>): Promise<void> {
    dialog()!.dispatchEvent(new Event('submit'));
    await settle(fixture);
  }

  function typeReason(fixture: ComponentFixture<VendorLicenseActions>, reason: string): void {
    const textarea = q('license-release-reason') as HTMLTextAreaElement;
    textarea.value = reason;
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('is one labelled icon button that opens a menu', async () => {
    const fixture = render();
    const trigger = q('license-actions-trigger')!;

    expect(trigger.getAttribute('aria-label')).toBe(
      `Actions for the ${ASSIGNED.assigned_product!.name} license`,
    );
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.textContent?.trim()).toBe('');
    expect(q('license-actions-release')).toBeNull();

    await openMenu(fixture);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(q('license-actions-release')?.textContent?.trim()).toBe('Release license');
    expect(q('license-actions-keep')).toBeNull();
  });

  it('offers both timings and releases at renewal by default', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = render();
    await choose(fixture, 'license-actions-release');

    expect(q('license-release-option-renewal')).not.toBeNull();
    expect(q('license-release-option-now')).not.toBeNull();
    expect(q('license-release-description')?.textContent).toContain(
      `The license comes off ${ASSIGNED.assigned_product!.name} and goes back to your pool`,
    );
    expect(q('license-release-reason')).toBeNull();
    expect(q('license-release-submit')?.textContent?.trim()).toBe('Release at renewal');

    await submit(fixture);

    expect(setReleaseAtRenewal).toHaveBeenCalledWith(ASSIGNED.id, true);
    expect(requestLicenseRelease).not.toHaveBeenCalled();
    expect(getBilling).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('This license will come off its product at renewal.');
  });

  it('asks for a reason when the license should come off now', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = render();
    await choose(fixture, 'license-actions-release');

    const now = q('license-release-option-now')!.querySelector('input')!;
    now.click();
    await settle(fixture);
    expect(q('license-release-submit')?.textContent?.trim()).toBe('Send request');

    typeReason(fixture, '   ');
    await submit(fixture);
    expect(requestLicenseRelease).not.toHaveBeenCalled();
    expect(q('license-release-error')?.textContent?.trim()).toBe(
      'Give a reason. AEC Integrations decides on it.',
    );
    expect(q('license-release-reason')!.getAttribute('aria-invalid')).toBe('true');

    typeReason(fixture, '  We are retiring this product early.  ');
    await submit(fixture);

    expect(requestLicenseRelease).toHaveBeenCalledWith(
      ASSIGNED.id,
      'We are retiring this product early.',
    );
    expect(setReleaseAtRenewal).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith(
      'Early unassign requested. AEC Integrations will review it.',
    );
  });

  it('leaves release at renewal out of the dialog once it is set', async () => {
    const fixture = render({ ...ASSIGNED, release_at_renewal: true });

    await choose(fixture, 'license-actions-release');
    expect(q('license-release-option-renewal')).toBeNull();
    expect(q('license-release-option-now')).not.toBeNull();
    expect(q('license-release-reason')).not.toBeNull();
  });

  it('undoes release at renewal from the menu, without a dialog', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = render({ ...ASSIGNED, release_at_renewal: true });

    await choose(fixture, 'license-actions-keep');

    expect(dialog()).toBeNull();
    expect(setReleaseAtRenewal).toHaveBeenCalledWith(ASSIGNED.id, false);
    expect(announce).toHaveBeenCalledWith('This license will renew on its product.');
  });

  it('drops Release from the menu when both timings are in effect', async () => {
    const fixture = render({
      ...ASSIGNED,
      release_at_renewal: true,
      open_release_request: OPEN_REQUEST,
    });

    await openMenu(fixture);
    expect(q('license-actions-release')).toBeNull();
    expect(q('license-actions-keep')).not.toBeNull();
  });

  it('shows a failed Keep at renewal beside the trigger', async () => {
    setReleaseAtRenewal.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const fixture = render({ ...ASSIGNED, release_at_renewal: true });

    await choose(fixture, 'license-actions-keep');

    const notice = q('license-actions-error');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent?.trim()).toBe(
      'Could not save the setting. It has not changed. Try again.',
    );
  });

  it('moves focus to the trigger before the menu item goes', async () => {
    const fixture = render();
    const focus = vi.spyOn(q('license-actions-trigger')!, 'focus');

    // The dialog saves the focused element at open and returns focus to it on close.
    await choose(fixture, 'license-actions-release');

    expect(focus).toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it('closes the dialog and hands a 409 to the section', async () => {
    setReleaseAtRenewal.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'LICENSE_NOT_ASSIGNED', message: 'x' } },
      }),
    );
    const fixture = render();
    const stale: string[] = [];
    fixture.componentInstance.stale.subscribe((m) => stale.push(m));
    await choose(fixture, 'license-actions-release');

    await submit(fixture);

    expect(stale).toEqual(['This license is no longer on a product, or it has ended.']);
    expect(getBilling).not.toHaveBeenCalled();
  });

  it('keeps a non-stale failure in the dialog', async () => {
    setReleaseAtRenewal.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const fixture = render();
    await choose(fixture, 'license-actions-release');

    await submit(fixture);

    expect(q('license-release-error')?.textContent?.trim()).toBe(
      'Could not save the setting. It has not changed. Try again.',
    );
    expect(dialog()).not.toBeNull();
  });
});
