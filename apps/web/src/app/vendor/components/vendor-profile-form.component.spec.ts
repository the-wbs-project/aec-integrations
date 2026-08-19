import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateVendorProfileResponse, VendorAccount } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorProfileForm } from './vendor-profile-form';

/**
 * `VendorProfileForm` (AECI-522) is the highest-logic vendor component: a
 * dirty-diff editor validated against the shared `UpdateVendorProfileSchema` that
 * PATCHes only changed fields and settles clean on the echo. These specs pin the
 * load-bearing behaviour: Save is gated on a real change, an invalid field blocks
 * the save with an inline error, a successful save sends only the diff + confirms
 * + re-disables, and a failed save surfaces a retryable error.
 */
const VENDOR: VendorAccount = VENDOR_ME_FIXTURE.vendor;

function setInputValue(
  fixture: ComponentFixture<VendorProfileForm>,
  id: string,
  value: string,
): void {
  const el = fixture.nativeElement.querySelector(`#${id}`) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
}

function saveButton(fixture: ComponentFixture<VendorProfileForm>): HTMLButtonElement {
  return fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorProfileForm', () => {
  let updateProfile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateProfile = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: { updateProfile } as Partial<VendorApi> },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function create(): ComponentFixture<VendorProfileForm> {
    const fixture = TestBed.createComponent(VendorProfileForm);
    fixture.componentRef.setInput('vendor', VENDOR);
    fixture.detectChanges();
    return fixture;
  }

  it('disables Save until a field actually changes', () => {
    const fixture = create();
    expect(saveButton(fixture).disabled).toBe(true);

    setInputValue(fixture, 'vendor-profile-website', 'https://new.example.com');
    expect(saveButton(fixture).disabled).toBe(false);
  });

  it('shows an inline error and keeps Save disabled for an invalid URL', () => {
    const fixture = create();
    setInputValue(fixture, 'vendor-profile-website', 'notaurl');

    const error = fixture.nativeElement.querySelector('#vendor-profile-website-error');
    expect(error).not.toBeNull();
    expect(saveButton(fixture).disabled).toBe(true);
  });

  it('sends only the diff, confirms, and re-disables Save on a successful save', async () => {
    const echoed: UpdateVendorProfileResponse = {
      vendor: { ...VENDOR, website: 'https://new.example.com' },
    };
    updateProfile.mockResolvedValue(echoed);

    const fixture = create();
    setInputValue(fixture, 'vendor-profile-website', 'https://new.example.com');
    saveButton(fixture).click();
    await flush();
    fixture.detectChanges();

    // Only the changed field was sent — never a full-object PATCH.
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile).toHaveBeenCalledWith({ website: 'https://new.example.com' });

    // Confirmation shown, and the form settled clean (baseline re-seeded).
    const status = fixture.nativeElement.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Profile updated');
    expect(saveButton(fixture).disabled).toBe(true);
  });

  it('clears a field by sending null in the diff', async () => {
    updateProfile.mockResolvedValue({ vendor: { ...VENDOR, headquarters: null } });

    const fixture = create();
    setInputValue(fixture, 'vendor-profile-headquarters', '');
    saveButton(fixture).click();
    await flush();

    expect(updateProfile).toHaveBeenCalledWith({ headquarters: null });
  });

  it('surfaces a retryable error when the save fails', async () => {
    updateProfile.mockRejectedValue(new Error('boom'));

    const fixture = create();
    setInputValue(fixture, 'vendor-profile-website', 'https://new.example.com');
    saveButton(fixture).click();
    await flush();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Something went wrong');
    // Still enabled so the user can retry.
    expect(saveButton(fixture).disabled).toBe(false);
  });
});

/**
 * The read-only state (AECI-614 / `STAGE_2_PAID_TIERS_SPEC.md` §8). `canEdit` is
 * fed from `me.entitlement.capabilities` holding `profile.edit`, so these cases
 * pin the half of §5.2's promise that lives in the browser: a vendor whose
 * entitlement lapsed still SEES everything, and simply cannot change it.
 */
describe('VendorProfileForm — read-only when the entitlement lapsed', () => {
  let updateProfile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateProfile = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: { updateProfile } as Partial<VendorApi> },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function create(canEdit: boolean): ComponentFixture<VendorProfileForm> {
    const fixture = TestBed.createComponent(VendorProfileForm);
    fixture.componentRef.setInput('vendor', VENDOR);
    fixture.componentRef.setInput('canEdit', canEdit);
    fixture.detectChanges();
    return fixture;
  }

  const inputs = (fixture: ComponentFixture<VendorProfileForm>): HTMLInputElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('input, textarea'));

  it('keeps every value on screen, marked readonly rather than disabled', () => {
    const fixture = create(false);
    const fields = inputs(fixture);

    expect(fields.length).toBeGreaterThan(0);
    // readonly, NOT disabled: the values must stay in the accessibility tree,
    // focusable and copyable. A disabled form reads as broken, not as paused.
    expect(fields.every((f) => f.readOnly)).toBe(true);
    expect(fields.some((f) => f.disabled)).toBe(false);
    expect(
      (fixture.nativeElement.querySelector('#vendor-profile-website') as HTMLInputElement).value,
    ).toBe(VENDOR.website);
  });

  it('withholds Save entirely and explains why', () => {
    const fixture = create(false);

    expect(saveButton(fixture)).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Editing is paused');
  });

  it('does not PATCH even if the form is submitted anyway', async () => {
    // Enter from a focused (still focusable) read-only field submits the form.
    const fixture = create(false);
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('is unchanged when the capability IS held (the launch behaviour)', () => {
    const fixture = create(true);

    expect(inputs(fixture).some((f) => f.readOnly)).toBe(false);
    expect(saveButton(fixture)).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Editing is paused');
  });
});
