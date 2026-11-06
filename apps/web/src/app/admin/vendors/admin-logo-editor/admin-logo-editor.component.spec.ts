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
  const REASON = 'The vendor sent a new brand mark.';
  function typeReason(fixture: ReturnType<typeof mount>, value = REASON): void {
    const area = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    area.value = value;
    area.dispatchEvent(new Event('input'));
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
    typeReason(fixture);
    saveButton(fixture).click();

    const request = http.expectOne(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ logo_url: UPLOADED, reason: REASON });
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
    typeReason(fixture);
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
    typeReason(fixture);
    saveButton(fixture).click();

    const request = http.expectOne(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`);
    expect(request.request.body).toEqual({ logo_url: null, reason: REASON });
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
    typeReason(fixture);
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

  it('labels the required reason and ties its help text to the field (AECI-1191)', () => {
    const fixture = mount();
    const area = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    const label = fixture.nativeElement.querySelector(
      `label[for="${area.id}"]`,
    ) as HTMLLabelElement;
    expect(label.textContent).toContain('Reason shown to the vendor (required)');
    expect(area.required).toBe(true);
    expect(
      fixture.nativeElement.querySelector(`#${area.getAttribute('aria-describedby')}`),
    ).toBeTruthy();
  });

  it('offers an optional internal note, labelled as never shown, and sends it (AECI-1159)', async () => {
    const fixture = mount();
    const note = fixture.nativeElement.querySelectorAll('textarea')[1] as HTMLTextAreaElement;
    const label = fixture.nativeElement.querySelector(
      `label[for="${note.id}"]`,
    ) as HTMLLabelElement;
    expect(label.textContent).toContain('Internal note (optional, never shown to the vendor)');
    expect(note.required).toBe(false);
    typeUrl(fixture, UPLOADED);
    typeReason(fixture);
    note.value = '  Trademark ticket 9.  ';
    note.dispatchEvent(new Event('input'));
    saveButton(fixture).click();
    const request = http.expectOne(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`);
    expect(request.request.body).toEqual({
      logo_url: UPLOADED,
      reason: REASON,
      internalNote: 'Trademark ticket 9.',
    });
    request.flush({ logo_url: UPLOADED });
    await fixture.whenStable();
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('refuses to save with an %s reason, and moves focus to it (AECI-1191)', (_label, value) => {
    const fixture = mount();
    typeUrl(fixture, UPLOADED);
    typeReason(fixture, value);
    saveButton(fixture).click();
    fixture.detectChanges();
    http.expectNone(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`);
    const area = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.nativeElement.querySelector('[role=alert]')?.textContent).toContain(
      'Enter a reason',
    );
    expect(document.activeElement).toBe(area);
  });

  it('clears the reason after a save', async () => {
    const fixture = mount();
    typeUrl(fixture, UPLOADED);
    typeReason(fixture);
    saveButton(fixture).click();
    http
      .expectOne(`/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo`)
      .flush({ logo_url: UPLOADED });
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
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

  describe('remove on objection (AECI-1618)', () => {
    const q = (f: ReturnType<typeof mount>, id: string) =>
      (f.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    function typeReason(fixture: ReturnType<typeof mount>, value: string): void {
      const box = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
      box.value = value;
      box.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }
    function start(fixture: ReturnType<typeof mount>): void {
      q(fixture, 'logo-objection-open')!.click();
      fixture.detectChanges();
    }

    it('the confirm says it also stops the logo returning', () => {
      const fixture = mount();
      start(fixture);
      expect((fixture.nativeElement as HTMLElement).textContent).toContain(
        'it also stops the logo returning',
      );
    });

    it('needs a reason and sends nothing without one', async () => {
      const fixture = mount();
      start(fixture);
      q(fixture, 'logo-objection-confirm')!.click();
      fixture.detectChanges();
      await fixture.whenStable();
      http.expectNone('/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo');
      expect((fixture.nativeElement as HTMLElement).textContent).toContain(
        'Enter a reason for the vendor.',
      );
    });

    it('sends objection with a null logo, and reports what happened', async () => {
      const fixture = mount();
      typeReason(fixture, 'The company objected in writing.');
      start(fixture);
      q(fixture, 'logo-objection-confirm')!.click();
      const req = http.expectOne('/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({
        logo_url: null,
        objection: true,
        reason: 'The company objected in writing.',
      });
      req.flush({ logo_url: null, object_removed: false });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(fixture.componentInstance.saved()).toBeNull();
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('The stored file stays');
    });

    it('a failed write keeps the confirm open with a reason', async () => {
      const fixture = mount();
      typeReason(fixture, 'The company objected in writing.');
      start(fixture);
      q(fixture, 'logo-objection-confirm')!.click();
      http
        .expectOne('/api/admin/vendors/00000000-0000-4000-8000-000000000001/logo')
        .flush({}, { status: 500, statusText: 'Server Error' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="logo-objection"] [role="alert"]',
        )?.textContent,
      ).toContain("We couldn't remove this logo.");
      expect(q(fixture, 'logo-objection-confirm')).not.toBeNull();
    });
  });
});
