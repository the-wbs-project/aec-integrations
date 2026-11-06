import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ACCEPTANCES_FIXTURE, VENDOR_BILLING_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorBillingLegalNameForm } from './vendor-billing-legal-name-form';

/**
 * The company legal name form (AECI-1625). The billing email form's pattern: the write,
 * then a fresh billing read, then one announcement. Each refusal gets copy that says
 * what to do.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorBillingLegalNameForm', () => {
  let setLegalName: ReturnType<typeof vi.fn>;
  let getBilling: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLegalName = vi.fn().mockResolvedValue(undefined);
    getBilling = vi.fn().mockResolvedValue(VENDOR_BILLING_FIXTURE);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        {
          provide: VendorApi,
          useValue: {
            setLegalName,
            getBilling,
            getAcceptances: vi.fn().mockResolvedValue({ acceptances: VENDOR_ACCEPTANCES_FIXTURE }),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function render(current: string | null): ComponentFixture<VendorBillingLegalNameForm> {
    const fixture = TestBed.createComponent(VendorBillingLegalNameForm);
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    return fixture;
  }

  const el = (fixture: ComponentFixture<VendorBillingLegalNameForm>) =>
    fixture.nativeElement as HTMLElement;

  function openForm(fixture: ComponentFixture<VendorBillingLegalNameForm>): HTMLInputElement {
    (el(fixture).querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    return el(fixture).querySelector('input') as HTMLInputElement;
  }

  async function submit(
    fixture: ComponentFixture<VendorBillingLegalNameForm>,
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

  it('shows the name, or Not set, with the helper text', () => {
    expect(el(render('Acme, Inc.')).textContent).toContain('Acme, Inc.');
    const unset = el(render(null)).textContent;
    expect(unset).toContain('Not set');
    expect(unset).toContain(
      "Your company's full legal name. We record it when an owner accepts the Managed plan agreement.",
    );
  });

  it('names the Change button "Change company legal name"', () => {
    const button = el(render('Acme, Inc.')).querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('Change company legal name');
  });

  it('opens on the stored name, with a labelled, length-capped input', () => {
    const fixture = render('Acme, Inc.');
    const input = openForm(fixture);
    expect(input.value).toBe('Acme, Inc.');
    expect(input.getAttribute('maxlength')).toBe('200');
    expect(el(fixture).querySelector(`label[for="${input.id}"]`)?.textContent?.trim()).toBe(
      'Company legal name',
    );
  });

  it('saves, re-reads billing, announces and closes', async () => {
    const fixture = render(null);
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');

    await submit(fixture, '  Acme, Inc. ');

    expect(setLegalName).toHaveBeenCalledWith('Acme, Inc.');
    expect(getBilling).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Company legal name saved.');
    expect(el(fixture).querySelector('form')).toBeNull();
  });

  it('clears the name when the field is left empty', async () => {
    const fixture = render('Acme, Inc.');
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');

    await submit(fixture, '');

    expect(setLegalName).toHaveBeenCalledWith(null);
    expect(announce).toHaveBeenCalledWith('Company legal name removed.');
  });

  it.each([
    [400, 'Enter a name of 200 characters or fewer.'],
    [403, 'Only an account owner can change the company legal name.'],
    [500, 'Could not save the company legal name. Try again.'],
  ])('maps a %i to its copy and keeps the form open', async (status, copy) => {
    setLegalName.mockRejectedValueOnce(new HttpErrorResponse({ status }));
    const fixture = render(null);

    await submit(fixture, 'Acme, Inc.');

    expect(el(fixture).querySelector('[role="alert"]')?.textContent?.trim()).toBe(copy);
    expect(el(fixture).querySelector('form')).not.toBeNull();
    expect(getBilling).not.toHaveBeenCalled();
  });
});
