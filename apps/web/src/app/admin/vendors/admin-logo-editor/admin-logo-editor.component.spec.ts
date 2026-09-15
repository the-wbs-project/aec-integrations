import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminLogoEditor } from './admin-logo-editor';

/**
 * AECI-955 — the admin half of the logo control. `LogoInput` owns the upload
 * and is covered by its own spec; what is only true here is the SAVE step: the
 * admin editor is the one place an upload becomes a catalog write, and it is a
 * separate deliberate click (`ADMIN_PANEL_SPEC.md` §2's seventh exception).
 */
@Component({
  imports: [AdminLogoEditor],
  template: `<aec-admin-logo-editor
    [kind]="kind()"
    [recordId]="recordId()"
    [logoUrl]="logoUrl()"
    (logoSaved)="saved.set($event)"
  />`,
})
class Host {
  kind = signal<'vendor' | 'product'>('vendor');
  recordId = signal('00000000-0000-4000-8000-000000000001');
  logoUrl = signal<string | null>('https://example.com/old.png');
  saved = signal<string | null | undefined>(undefined);
}

const UPLOADED = `/api/logos/${'a'.repeat(64)}`;

describe('AdminLogoEditor', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  function mount() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
  }
  function saveButton(fixture: ReturnType<typeof mount>): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button[type=submit]') as HTMLButtonElement;
  }
  function typeUrl(fixture: ReturnType<typeof mount>, value: string): void {
    const input = fixture.nativeElement.querySelector('input[type=text]') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('disables Save until the draft differs from the seeded logo', () => {
    const fixture = mount();
    expect(saveButton(fixture).disabled).toBe(true);
    typeUrl(fixture, 'https://example.com/new.png');
    expect(saveButton(fixture).disabled).toBe(false);
  });

  it('PATCHes the vendor logo route and reports the saved value', async () => {
    const fixture = mount();
    typeUrl(fixture, UPLOADED);
    saveButton(fixture).click();

    const request = http.expectOne(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ logo_url: UPLOADED });
    request.flush({ logo_url: UPLOADED });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.saved()).toBe(UPLOADED);
    expect(fixture.nativeElement.textContent).toContain('Logo saved');
    // Baseline moved, so a second Save is not offered for the same value.
    expect(saveButton(fixture).disabled).toBe(true);
  });

  it('PATCHes the product route when kind is product', async () => {
    const fixture = mount();
    fixture.componentInstance.kind.set('product');
    fixture.detectChanges();
    typeUrl(fixture, UPLOADED);
    saveButton(fixture).click();

    http
      .expectOne(`/api/admin/products/00000000-0000-4000-8000-000000000001/logo`)
      .flush({ logo_url: UPLOADED });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.saved()).toBe(UPLOADED);
  });

  it('sends null to clear a logo', async () => {
    const fixture = mount();
    typeUrl(fixture, '');
    saveButton(fixture).click();

    const request = http.expectOne(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`);
    expect(request.request.body).toEqual({ logo_url: null });
    request.flush({ logo_url: null });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.saved()).toBeNull();
  });

  it('refuses to send a value the write schema rejects', () => {
    const fixture = mount();
    typeUrl(fixture, 'http://example.com/insecure.png');
    expect(saveButton(fixture).disabled).toBe(true);
    saveButton(fixture).click();
    http.expectNone(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`);
  });

  it('surfaces a failed save and keeps the draft editable', async () => {
    const fixture = mount();
    typeUrl(fixture, UPLOADED);
    saveButton(fixture).click();
    http
      .expectOne(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`)
      .flush({}, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role=alert]')).toBeTruthy();
    expect(fixture.componentInstance.saved()).toBeUndefined();
    expect(saveButton(fixture).disabled).toBe(false);
  });

  it('re-seeds from the input when the record changes', () => {
    const fixture = mount();
    typeUrl(fixture, UPLOADED);
    fixture.componentInstance.recordId.set('00000000-0000-4000-8000-000000000002');
    fixture.componentInstance.logoUrl.set('https://example.com/other.png');
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('input[type=text]') as HTMLInputElement;
    expect(input.value).toBe('https://example.com/other.png');
    expect(saveButton(fixture).disabled).toBe(true);
  });
});
