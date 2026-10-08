import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorLogoField } from './vendor-logo-field';

/**
 * The vendor portal's Logo row. What has to hold: the row shows the saved logo
 * and an Edit button; the dialog's URL and upload options never both hold a
 * draft; Save and Remove write through the parent's `save` at once; Cancel
 * writes nothing; and a failed save keeps the dialog open with a reason.
 */
@Component({
  imports: [VendorLogoField],
  template: `<aec-vendor-logo-field
    fieldId="test-logo"
    [logoUrl]="logoUrl()"
    [canEdit]="canEdit()"
    [save]="save"
  />`,
})
class Host {
  logoUrl = signal<string | null>('https://example.com/old.png');
  canEdit = signal(true);
  save = vi.fn(async (value: string | null) => value);
}

const PATH = `/api/logos/${'a'.repeat(64)}`;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorLogoField', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  async function mount() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }
  const q = <T extends Element>(selector: string) => document.querySelector(selector) as T | null;

  async function openDialog(fixture: Awaited<ReturnType<typeof mount>>) {
    (fixture.nativeElement.querySelector('[data-testid="logo-edit"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  }
  async function settle(fixture: Awaited<ReturnType<typeof mount>>) {
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  }
  /** BrnDialog closes after its default 100 ms `closeDelay`. */
  async function afterClose(fixture: Awaited<ReturnType<typeof mount>>) {
    await settle(fixture);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fixture.detectChanges();
  }
  function typeUrl(value: string) {
    const input = q<HTMLInputElement>('#test-logo-url')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  function chooseFile() {
    const input = q<HTMLInputElement>('#test-logo-file')!;
    const file = new File([new Uint8Array(10)], 'brand.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    (input.files as unknown as { item: (i: number) => File }).item = (i: number) =>
      [file][i] as File;
    input.dispatchEvent(new Event('change'));
  }

  it('shows the saved logo and an Edit button, and no form fields inline', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Logo');
    expect(el.querySelector('[data-testid="logo-current"] img')).not.toBeNull();
    expect(el.querySelector('[data-testid="logo-edit"]')?.textContent?.trim()).toBe('Edit logo');
    expect(el.querySelector('input')).toBeNull();
  });

  it('offers "Add logo" when there is none, and no button without edit rights', async () => {
    const fixture = await mount();
    fixture.componentInstance.logoUrl.set(null);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="logo-edit"]')?.textContent?.trim()).toBe('Add logo');
    expect(el.textContent).toContain('No logo');

    fixture.componentInstance.canEdit.set(false);
    await settle(fixture);
    expect(el.querySelector('[data-testid="logo-edit"]')).toBeNull();
  });

  it('saves a pasted URL straight away and closes', async () => {
    const fixture = await mount();
    await openDialog(fixture);
    const save = q<HTMLButtonElement>('[data-testid="logo-save"]')!;
    expect(save.disabled).toBe(true);

    typeUrl('https://example.com/new.png');
    await settle(fixture);
    expect(save.disabled).toBe(false);
    save.click();
    await settle(fixture);

    expect(fixture.componentInstance.save).toHaveBeenCalledWith('https://example.com/new.png');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Logo saved.');
  });

  it('rejects a non-HTTPS URL', async () => {
    const fixture = await mount();
    await openDialog(fixture);
    typeUrl('http://example.com/new.png');
    await settle(fixture);
    expect(q<HTMLButtonElement>('[data-testid="logo-save"]')!.disabled).toBe(true);
    expect(q('#test-logo-url-error')).not.toBeNull();
  });

  it('keeps the two options exclusive: an upload clears the URL, typing drops the upload', async () => {
    const fixture = await mount();
    await openDialog(fixture);
    typeUrl('https://example.com/new.png');
    await settle(fixture);

    chooseFile();
    await settle(fixture);
    expect(q<HTMLInputElement>('#test-logo-url')!.value).toBe('');
    http.expectOne('/api/vendor/logo').flush({ logo_url: PATH });
    await settle(fixture);
    expect(document.body.textContent).toContain('From brand.png');

    typeUrl('https://example.com/other.png');
    await settle(fixture);
    expect(document.body.textContent).not.toContain('From brand.png');
    q<HTMLButtonElement>('[data-testid="logo-save"]')!.click();
    await settle(fixture);
    expect(fixture.componentInstance.save).toHaveBeenCalledWith('https://example.com/other.png');
  });

  it('saves an uploaded file once the upload lands', async () => {
    const fixture = await mount();
    await openDialog(fixture);
    chooseFile();
    await settle(fixture);
    expect(q<HTMLButtonElement>('[data-testid="logo-save"]')!.disabled).toBe(true);
    http.expectOne('/api/vendor/logo').flush({ logo_url: PATH });
    await settle(fixture);
    q<HTMLButtonElement>('[data-testid="logo-save"]')!.click();
    await settle(fixture);
    expect(fixture.componentInstance.save).toHaveBeenCalledWith(PATH);
  });

  it('removes the logo straight away', async () => {
    const fixture = await mount();
    await openDialog(fixture);
    q<HTMLButtonElement>('[data-testid="logo-remove"]')!.click();
    await afterClose(fixture);
    expect(q('[data-testid="logo-save"]')).toBeNull();
    expect(fixture.componentInstance.save).toHaveBeenCalledWith(null);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Logo removed.');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="logo-edit"]')
        ?.textContent,
    ).toContain('Add logo');
  });

  it('cannot be dismissed while a save is in flight, and closes once it is done', async () => {
    const fixture = await mount();
    let finish!: (value: string | null) => void;
    fixture.componentInstance.save.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (finish = resolve)),
    );
    await openDialog(fixture);
    typeUrl('https://example.com/new.png');
    await settle(fixture);
    q<HTMLButtonElement>('[data-testid="logo-save"]')!.click();
    await settle(fixture);

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    q<HTMLElement>('.cdk-overlay-backdrop')?.click();
    await afterClose(fixture);
    expect(q('[data-testid="logo-save"]')).not.toBeNull();

    finish('https://example.com/new.png');
    await afterClose(fixture);
    expect(q('[data-testid="logo-save"]')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Logo saved.');
  });

  it('keeps the dialog open with a reason when the save fails', async () => {
    const fixture = await mount();
    fixture.componentInstance.save.mockRejectedValueOnce(new Error('boom'));
    await openDialog(fixture);
    typeUrl('https://example.com/new.png');
    await settle(fixture);
    q<HTMLButtonElement>('[data-testid="logo-save"]')!.click();
    await settle(fixture);
    expect(q('[role="alert"]')?.textContent).toContain("We couldn't save the logo.");
    expect(q('[data-testid="logo-save"]')).not.toBeNull();
  });
});
