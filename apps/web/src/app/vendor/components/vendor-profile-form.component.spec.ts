import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateVendorProfileResponse, VendorAccount } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import {
  VENDOR_ME_CONNECTOR_SEAT_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
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
        VendorPortalStore,
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

  // ── AECI-967: the identity hint ───────────────────────────────────────────
  // This form renders NO company-name field, because the name and the slug are
  // AECi-owned. Before this it also said nothing about that, so the absence read
  // as an omission. The hint names the fact and gives the route.
  describe('the identity hint (AECI-967)', () => {
    function identityLink(fixture: ComponentFixture<VendorProfileForm>): HTMLAnchorElement | null {
      return fixture.nativeElement.querySelector('a[href$="/correction"]');
    }

    it('points at the VENDOR correction form, not a product one', () => {
      const link = identityLink(create());
      expect(link?.getAttribute('href')).toBe(`/vendors/${VENDOR.slug}/correction`);
      expect(link?.textContent).toContain('send us a correction request');
    });

    it('opens the fallback in a new tab, with noopener and the disclosure', () => {
      const link = identityLink(create());
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener');
      expect(link?.querySelector('.sr-only')?.textContent).toContain('opens in a new tab');
    });
  });

  it('offers only the links the public vendor page renders', () => {
    const fixture = create();
    const host = fixture.nativeElement as HTMLElement;
    for (const key of ['linkedin-url', 'x-url', 'facebook-url', 'instagram-url', 'youtube-url']) {
      expect(host.querySelector(`#vendor-profile-${key}`)).not.toBeNull();
    }
    for (const key of ['crunchbase-url', 'wiki-url', 'github-org']) {
      expect(host.querySelector(`#vendor-profile-${key}`)).toBeNull();
    }
  });

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
        VendorPortalStore,
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
    expect(fixture.nativeElement.textContent).toContain(
      'This seat cannot edit the company profile right now',
    );
  });

  // AECI-1218: company details are editable on every plan (decision 3), so the
  // old "paused while access is inactive" copy is gone for every seat.
  it.each([
    ['the connector catalogue seat', VENDOR_ME_CONNECTOR_SEAT_FIXTURE],
    ['a never-arranged vendor', VENDOR_ME_UNVERIFIED_FIXTURE],
  ])('never tells %s that editing is paused or to renew', (_name, me) => {
    TestBed.inject(VendorPortalStore).seed(me);
    const text = create(false).nativeElement.textContent as string;
    expect(text).not.toContain('Editing is paused');
    expect(text).not.toContain('renewal');
    expect(text).not.toContain('stays with the AECi team');
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

/**
 * A field AEC Integrations corrected and locked (AECI-1237,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5): read-only, with who set it and why, and a
 * refused save says it was a lock rather than a failure to retry.
 */
describe('VendorProfileForm — a field AECi locked (AECI-1237)', () => {
  const LOCK = {
    field: 'phone_number',
    reason: 'The number on file reaches a different company.',
    set_at: '2026-10-04T00:00:00.000Z',
  };
  let updateProfile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateProfile = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: { updateProfile } as Partial<VendorApi> },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function create(vendor: VendorAccount): ComponentFixture<VendorProfileForm> {
    const fixture = TestBed.createComponent(VendorProfileForm);
    fixture.componentRef.setInput('vendor', vendor);
    fixture.detectChanges();
    return fixture;
  }

  const field = (fixture: ComponentFixture<VendorProfileForm>, id: string): HTMLInputElement =>
    fixture.nativeElement.querySelector(`#${id}`) as HTMLInputElement;

  it('renders the locked field read-only and ties the note to it', () => {
    const fixture = create({ ...VENDOR, locked_fields: [LOCK] });
    const phone = field(fixture, 'vendor-profile-phone-number');
    expect(phone.readOnly).toBe(true);
    expect(phone.disabled).toBe(false);
    const note = fixture.nativeElement.querySelector('#vendor-profile-phone-number-locked');
    expect(note?.textContent).toContain('Set by AEC Integrations.');
    expect(note?.textContent).toContain(LOCK.reason);
    expect(phone.getAttribute('aria-describedby')).toContain('vendor-profile-phone-number-locked');
  });

  it('leaves every other field editable', () => {
    const fixture = create({ ...VENDOR, locked_fields: [LOCK] });
    expect(field(fixture, 'vendor-profile-website').readOnly).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('[data-testid="locked-note"]')).toHaveLength(1);
  });

  it('shows no note when nothing is locked, or the list is absent', () => {
    const fixture = create(VENDOR);
    expect(fixture.nativeElement.querySelector('[data-testid="locked-note"]')).toBeNull();
    expect(field(fixture, 'vendor-profile-phone-number').readOnly).toBe(false);
  });

  it('says a refused save was a lock, not a failure to retry', async () => {
    updateProfile.mockRejectedValue({
      error: { error: { code: 'FIELD_LOCKED_BY_AECI', message: 'locked' } },
    });
    const fixture = create(VENDOR);
    setInputValue(fixture, 'vendor-profile-headquarters', 'San Francisco');
    saveButton(fixture).click();
    await flush();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'AEC Integrations has locked a field you changed',
    );
    expect(fixture.nativeElement.textContent).not.toContain('Something went wrong');
  });
});
