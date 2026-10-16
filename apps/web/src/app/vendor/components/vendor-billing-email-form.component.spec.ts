import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ACCEPTANCES_FIXTURE, VENDOR_BILLING_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorBillingEmailForm } from './vendor-billing-email-form';

/**
 * The billing email form (AECI-1390, E5.4). Pessimistic: the write, then a fresh
 * billing read, then one announcement. Each refusal gets copy that says what to do.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorBillingEmailForm', () => {
  let setBillingEmail: ReturnType<typeof vi.fn>;
  let getBilling: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setBillingEmail = vi.fn().mockResolvedValue(undefined);
    getBilling = vi.fn().mockResolvedValue(VENDOR_BILLING_FIXTURE);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        {
          provide: VendorApi,
          useValue: {
            setBillingEmail,
            getBilling,
            getAcceptances: vi.fn().mockResolvedValue({ acceptances: VENDOR_ACCEPTANCES_FIXTURE }),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function render(current: string | null): ComponentFixture<VendorBillingEmailForm> {
    const fixture = TestBed.createComponent(VendorBillingEmailForm);
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    return fixture;
  }

  const el = (fixture: ComponentFixture<VendorBillingEmailForm>) =>
    fixture.nativeElement as HTMLElement;

  function openForm(fixture: ComponentFixture<VendorBillingEmailForm>): HTMLInputElement {
    (el(fixture).querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    return el(fixture).querySelector('input') as HTMLInputElement;
  }

  async function submit(
    fixture: ComponentFixture<VendorBillingEmailForm>,
    value: string,
  ): Promise<void> {
    const input = openForm(fixture);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el(fixture).querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    fixture.detectChanges();
  }

  it('shows the address, or Not set, with the helper text', () => {
    expect(el(render('ap@acme.example')).textContent).toContain('ap@acme.example');
    const unset = el(render(null)).textContent;
    expect(unset).toContain('Not set');
    expect(unset).toContain('Receipts and renewal emails go to this address and to every seat.');
  });

  it('saves, re-reads billing, announces and closes', async () => {
    const fixture = render(null);
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');

    await submit(fixture, '  ap@acme.example ');

    expect(setBillingEmail).toHaveBeenCalledWith('ap@acme.example');
    expect(getBilling).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Billing email saved.');
    expect(el(fixture).querySelector('form')).toBeNull();
  });

  it('clears the address when the field is left empty', async () => {
    const fixture = render('ap@acme.example');
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');

    await submit(fixture, '');

    expect(setBillingEmail).toHaveBeenCalledWith(null);
    expect(announce).toHaveBeenCalledWith('Billing email removed.');
  });

  it.each([
    [400, 'Enter a valid email address.'],
    [403, 'Only an account owner can change the billing email.'],
    [404, 'Your company has no billing account yet. Contact AEC Integrations.'],
    [500, 'Could not save the billing email. Try again.'],
  ])('maps a %i to its copy and keeps the form open', async (status, copy) => {
    setBillingEmail.mockRejectedValueOnce(new HttpErrorResponse({ status }));
    const fixture = render(null);

    await submit(fixture, 'ap@acme.example');

    expect(el(fixture).querySelector('[role="alert"]')?.textContent?.trim()).toBe(copy);
    expect(el(fixture).querySelector('form')).not.toBeNull();
    expect(getBilling).not.toHaveBeenCalled();
  });
});
