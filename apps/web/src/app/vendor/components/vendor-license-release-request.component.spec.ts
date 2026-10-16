import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorBillingLicense } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ACCEPTANCES_FIXTURE, VENDOR_BILLING_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorLicenseReleaseRequest } from './vendor-license-release-request';

/**
 * The early-unassign request (AECI-1391, E5.5). The dialog opens from the click
 * (never an `effect()`, NG0602), needs a reason, sends it, closes, re-reads billing
 * and announces. A license with an open request shows "Early unassign requested"
 * instead of the button.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

const ASSIGNED: VendorBillingLicense = VENDOR_BILLING_FIXTURE.licenses[0]!;

describe('VendorLicenseReleaseRequest', () => {
  let requestLicenseRelease: ReturnType<typeof vi.fn>;
  let getBilling: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
    const fixture = TestBed.createComponent(VendorLicenseReleaseRequest);
    fixture.componentRef.setInput('license', license);
    fixture.detectChanges();
    return fixture;
  }

  const overlay = () => document.querySelector('.cdk-overlay-container');

  async function open(fixture: ComponentFixture<VendorLicenseReleaseRequest>): Promise<void> {
    (
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="license-release-request-trigger"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    fixture.detectChanges();
  }

  async function submit(
    fixture: ComponentFixture<VendorLicenseReleaseRequest>,
    reason: string,
  ): Promise<void> {
    const textarea = overlay()!.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = reason;
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    overlay()!.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    fixture.detectChanges();
  }

  it('keeps the form behind the button until it is clicked', async () => {
    const fixture = render();
    expect(document.querySelector('textarea')).toBeNull();

    await open(fixture);

    expect(overlay()?.textContent).toContain('Request early unassign');
    expect(overlay()?.textContent).toContain(
      `AEC Integrations reviews the request. If it is approved, the license comes off ${ASSIGNED.assigned_product!.name} and goes back to your pool`,
    );
    const textarea = overlay()!.querySelector('textarea')!;
    expect(overlay()!.querySelector(`label[for="${textarea.id}"]`)?.textContent?.trim()).toBe(
      'Reason',
    );
  });

  it('requires a reason', async () => {
    const fixture = render();
    await open(fixture);

    await submit(fixture, '   ');

    expect(requestLicenseRelease).not.toHaveBeenCalled();
    expect(overlay()!.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Give a reason. AEC Integrations decides on it.',
    );
    expect(overlay()!.querySelector('textarea')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('sends the trimmed reason, re-reads billing and announces', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = render();
    await open(fixture);

    await submit(fixture, '  We are retiring this product early.  ');

    expect(requestLicenseRelease).toHaveBeenCalledWith(
      ASSIGNED.id,
      'We are retiring this product early.',
    );
    expect(getBilling).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      'Early unassign requested. AEC Integrations will review it.',
    );
  });

  it('keeps a refusal in the dialog and re-reads billing on a 409', async () => {
    requestLicenseRelease.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'RELEASE_REQUEST_OPEN', message: 'x' } },
      }),
    );
    const fixture = render();
    await open(fixture);

    await submit(fixture, 'Retiring it.');

    expect(overlay()!.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'An early unassign request for this license is already open. AEC Integrations will answer it.',
    );
    expect(getBilling).toHaveBeenCalledTimes(1);
  });

  it('shows the requested state, with its date, instead of the button', () => {
    const fixture = render({
      ...ASSIGNED,
      open_release_request: { id: 'req-1', created_at: '2026-10-14T09:30:00.000Z' },
    });
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="license-release-request-trigger"]')).toBeNull();
    expect(el.querySelector('[data-testid="license-release-requested"]')?.textContent?.trim()).toBe(
      'Early unassign requested Oct 14, 2026',
    );
  });
});
