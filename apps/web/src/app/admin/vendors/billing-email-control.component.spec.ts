/**
 * `BillingEmailControl`: the billing email on the admin Billing tab (AECI-1381).
 *
 * Pinned here:
 *  1. it shows the address, or Not set, with a Change button;
 *  2. a save sends the trimmed address for this vendor, emits the STORED value and
 *     returns focus to Change;
 *  3. an empty field sends `null`;
 *  4. a bad address is refused client-side with the form's own alert, before any
 *     request;
 *  5. a refused write keeps the form open with copy that says what to do.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminLicensesApi } from './admin-licenses-api';
import { BillingEmailControl } from './billing-email-control';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('BillingEmailControl', () => {
  let updateBillingEmail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateBillingEmail = vi.fn(async (_vendorId: string, email: string | null) => ({
      billing_account: { id: 'acct-1', billing_email: email?.toLowerCase() ?? null },
    }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: AdminLicensesApi,
          useValue: { updateBillingEmail } as Partial<AdminLicensesApi>,
        },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function render(current: string | null): {
    fixture: ComponentFixture<BillingEmailControl>;
    emitted: (string | null)[];
  } {
    const fixture = TestBed.createComponent(BillingEmailControl);
    fixture.componentRef.setInput('vendorId', VENDOR_ID);
    fixture.componentRef.setInput('current', current);
    const emitted: (string | null)[] = [];
    fixture.componentInstance.changed.subscribe((value) => emitted.push(value));
    fixture.detectChanges();
    return { fixture, emitted };
  }

  const el = (fixture: ComponentFixture<BillingEmailControl>) =>
    fixture.nativeElement as HTMLElement;

  function openForm(fixture: ComponentFixture<BillingEmailControl>): HTMLInputElement {
    (el(fixture).querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    return el(fixture).querySelector('input') as HTMLInputElement;
  }

  async function submit(fixture: ComponentFixture<BillingEmailControl>, value: string) {
    const input = openForm(fixture);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el(fixture).querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('shows the address, or Not set, with a Change button', () => {
    const set = el(render('ap@acme.example').fixture);
    expect(set.querySelector('[data-testid="billing-email-value"]')?.textContent?.trim()).toBe(
      'ap@acme.example',
    );
    expect(set.querySelector('button')?.textContent).toContain('Change');

    const unset = el(render(null).fixture);
    expect(unset.querySelector('[data-testid="billing-email-value"]')?.textContent?.trim()).toBe(
      'Not set',
    );
    expect(unset.querySelector('form')).toBeNull();
  });

  it('opens a novalidate form prefilled with the address, with the hint', () => {
    const { fixture } = render('ap@acme.example');
    const input = openForm(fixture);
    expect(input.value).toBe('ap@acme.example');
    expect(el(fixture).querySelector('form')!.hasAttribute('novalidate')).toBe(true);
    expect(el(fixture).textContent).toContain(
      'License grant, renewal notice and plan-end emails go to this address and to every',
    );
  });

  it('saves for this vendor, emits the stored address and returns focus to Change', async () => {
    const { fixture, emitted } = render(null);

    await submit(fixture, '  AP@Acme.example ');

    expect(updateBillingEmail).toHaveBeenCalledWith(VENDOR_ID, 'AP@Acme.example');
    expect(emitted).toEqual(['ap@acme.example']);
    expect(el(fixture).querySelector('form')).toBeNull();
    const change = el(fixture).querySelector('button') as HTMLButtonElement;
    expect(change.textContent).toContain('Change');
    expect(document.activeElement).toBe(change);
  });

  it('clears the address when the field is left empty', async () => {
    const { fixture, emitted } = render('ap@acme.example');

    await submit(fixture, '   ');

    expect(updateBillingEmail).toHaveBeenCalledWith(VENDOR_ID, null);
    expect(emitted).toEqual([null]);
  });

  it('refuses a bad address with its own alert, before any request', async () => {
    const { fixture, emitted } = render(null);

    await submit(fixture, 'not-an-address');

    expect(el(fixture).querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Enter a valid email address.',
    );
    const input = el(fixture).querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('admin-billing-email-error');
    expect(document.activeElement).toBe(input);
    expect(updateBillingEmail).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it.each([
    [400, 'Enter a valid email address.'],
    [404, 'This vendor has no billing account any more. Reload the page.'],
    [429, 'Too many changes in a short time. Try again in a minute.'],
    [500, 'Could not save the billing email. Try again.'],
  ])('maps a %i to its copy and keeps the form open', async (status, copy) => {
    updateBillingEmail.mockRejectedValueOnce(new HttpErrorResponse({ status }));
    const { fixture, emitted } = render(null);

    await submit(fixture, 'ap@acme.example');

    expect(el(fixture).querySelector('[role="alert"]')?.textContent?.trim()).toBe(copy);
    expect(el(fixture).querySelector('form')).not.toBeNull();
    expect(emitted).toEqual([]);
  });

  it('cancel closes the form without a request', () => {
    const { fixture } = render('ap@acme.example');
    openForm(fixture);
    const cancel = Array.from(el(fixture).querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cancel'),
    ) as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();
    expect(el(fixture).querySelector('form')).toBeNull();
    expect(updateBillingEmail).not.toHaveBeenCalled();
  });
});
