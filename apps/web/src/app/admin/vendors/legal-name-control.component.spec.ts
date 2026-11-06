/**
 * `LegalNameControl`: the company legal name on the admin Billing tab (AECI-1625).
 *
 * Pinned here:
 *  1. it shows the name, or Not set, with a Change button;
 *  2. a save sends the trimmed name for this vendor, emits the STORED value and
 *     returns focus to Change;
 *  3. an empty field sends `null`;
 *  4. a name over 200 characters is refused client-side, before any request;
 *  5. a refused write keeps the form open with copy that says what to do.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminLicensesApi } from './admin-licenses-api';
import { LegalNameControl } from './legal-name-control';

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('LegalNameControl', () => {
  let updateLegalName: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateLegalName = vi.fn(async (_vendorId: string, name: string | null) => ({
      legal_name: name?.replace(/\s+/g, ' ').trim() || null,
    }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: AdminLicensesApi,
          useValue: { updateLegalName } as Partial<AdminLicensesApi>,
        },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function render(current: string | null): {
    fixture: ComponentFixture<LegalNameControl>;
    emitted: (string | null)[];
  } {
    const fixture = TestBed.createComponent(LegalNameControl);
    fixture.componentRef.setInput('vendorId', VENDOR_ID);
    fixture.componentRef.setInput('current', current);
    const emitted: (string | null)[] = [];
    fixture.componentInstance.changed.subscribe((value) => emitted.push(value));
    fixture.detectChanges();
    return { fixture, emitted };
  }

  const el = (fixture: ComponentFixture<LegalNameControl>) => fixture.nativeElement as HTMLElement;

  function openForm(fixture: ComponentFixture<LegalNameControl>): HTMLInputElement {
    (el(fixture).querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    return el(fixture).querySelector('input') as HTMLInputElement;
  }

  async function submit(fixture: ComponentFixture<LegalNameControl>, value: string) {
    const input = openForm(fixture);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el(fixture).querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('shows the name, or Not set, with a Change button', () => {
    const set = el(render('Acme, Inc.').fixture);
    expect(set.querySelector('[data-testid="legal-name-value"]')?.textContent?.trim()).toBe(
      'Acme, Inc.',
    );
    expect(set.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Change company legal name',
    );

    const unset = el(render(null).fixture);
    expect(unset.querySelector('[data-testid="legal-name-value"]')?.textContent?.trim()).toBe(
      'Not set',
    );
    expect(unset.querySelector('form')).toBeNull();
  });

  it('opens a novalidate form prefilled with the name, with the hint', () => {
    const { fixture } = render('Acme, Inc.');
    const input = openForm(fixture);
    expect(input.value).toBe('Acme, Inc.');
    expect(input.getAttribute('maxlength')).toBe('200');
    expect(el(fixture).querySelector('form')!.hasAttribute('novalidate')).toBe(true);
    expect(el(fixture).textContent).toContain('The name a checkout acceptance records.');
  });

  it('saves for this vendor, emits the stored name and returns focus to Change', async () => {
    const { fixture, emitted } = render(null);

    await submit(fixture, '  Acme   Software, Inc. ');

    expect(updateLegalName).toHaveBeenCalledWith(VENDOR_ID, 'Acme   Software, Inc.');
    expect(emitted).toEqual(['Acme Software, Inc.']);
    expect(el(fixture).querySelector('form')).toBeNull();
    const change = el(fixture).querySelector('button') as HTMLButtonElement;
    expect(document.activeElement).toBe(change);
  });

  it('clears the name when the field is left empty', async () => {
    const { fixture, emitted } = render('Acme, Inc.');

    await submit(fixture, '   ');

    expect(updateLegalName).toHaveBeenCalledWith(VENDOR_ID, null);
    expect(emitted).toEqual([null]);
  });

  it.each([
    [400, 'Enter a name of 200 characters or fewer.'],
    [404, 'This vendor no longer exists. Reload the page.'],
    [429, 'Too many changes in a short time. Try again in a minute.'],
    [500, 'Could not save the company legal name. Try again.'],
  ])('maps a %i to its copy and keeps the form open', async (status, copy) => {
    updateLegalName.mockRejectedValueOnce(new HttpErrorResponse({ status }));
    const { fixture, emitted } = render(null);

    await submit(fixture, 'Acme, Inc.');

    expect(el(fixture).querySelector('[role="alert"]')?.textContent?.trim()).toBe(copy);
    expect(el(fixture).querySelector('form')).not.toBeNull();
    expect(emitted).toEqual([]);
  });

  it('cancel closes the form without a request', () => {
    const { fixture } = render('Acme, Inc.');
    openForm(fixture);
    const cancel = Array.from(el(fixture).querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cancel'),
    ) as HTMLButtonElement;
    cancel.click();
    fixture.detectChanges();
    expect(el(fixture).querySelector('form')).toBeNull();
    expect(updateLegalName).not.toHaveBeenCalled();
  });
});
