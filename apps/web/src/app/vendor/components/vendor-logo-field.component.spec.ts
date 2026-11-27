import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectTitleFirstDialog } from '../../core/testing/title-first-dialog.harness';
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
    (announce)="heard($event)"
  />`,
})
class Host {
  logoUrl = signal<string | null>('https://example.com/old.png');
  canEdit = signal(true);
  save = vi.fn(async (value: string | null) => value);
  /** Each announcement, and whether the page was hidden from screen readers when
   *  it was made: the CDK sets `aria-hidden` on the app root while a dialog is open. */
  said: { text: string; hidden: boolean }[] = [];
  heard(text: string) {
    this.said.push({ text, hidden: !!document.querySelector('body > [aria-hidden="true"]') });
  }
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

  it('opens the logo dialog on its title, as an alert dialog (AECI-1861)', async () => {
    const fixture = await mount();
    await openDialog(fixture);
    await settle(fixture);
    expectTitleFirstDialog('Change logo');
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
    // AECI-2126: nothing is announced while the dialog still hides the page.
    expect(fixture.componentInstance.said).toEqual([]);
    await afterClose(fixture);
    expect(fixture.componentInstance.said).toEqual([
      { text: 'Logo saved. Your listing shows it now.', hidden: false },
    ]);
    // AECI-1810: the confirmation is plain text. The host announces it through the
    // portal's one live region via (announce); the row adds no second region.
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="status"]')).toBeNull();
  });

  it('labels the row with the Label role and its button with aecButton (AECI-1810)', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const label = el.querySelector('#test-logo-label') as HTMLElement;
    expect(label.textContent?.trim()).toBe('Logo');
    expect(label.className).toContain('text-t-13');
    expect(label.className).toContain('font-semibold');
    expect(label.className).not.toContain('uppercase');
    expect(el.querySelector('[data-testid="logo-edit"]')?.className).toContain('aec-btn');
  });

  it('shows a linked logo as its URL with a Copy button', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fixture = await mount();
    await openDialog(fixture);
    expect(document.body.textContent).toContain('Linked from this URL.');
    const field = q<HTMLInputElement>('[data-testid="logo-current-url"] input')!;
    expect(field.value).toBe('https://example.com/old.png');
    expect(field.readOnly).toBe(true);

    q<HTMLButtonElement>('[data-testid="logo-copy-url"]')!.click();
    await settle(fixture);
    expect(writeText).toHaveBeenCalledWith('https://example.com/old.png');
    expect(q('[data-testid="logo-copy-url"]')?.textContent?.trim()).toBe('Copied');
    expect(q('[data-testid="logo-copy-status"]')?.textContent?.trim()).toBe('Logo URL copied.');

    typeUrl('https://example.com/new.png');
    await settle(fixture);
    expect(q('[data-testid="logo-current-url"]')).toBeNull();
  });

  it('labels an uploaded logo as a file and does not show its path', async () => {
    const fixture = await mount();
    fixture.componentInstance.logoUrl.set(PATH);
    await settle(fixture);
    await openDialog(fixture);
    expect(document.body.textContent).toContain('Uploaded file.');
    expect(q('[data-testid="logo-current-url"]')).toBeNull();
    expect(q('[data-testid="logo-copy-url"]')).toBeNull();
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

  it("says the upload's progress in the dialog's own status region (AECI-2126)", async () => {
    const fixture = await mount();
    await openDialog(fixture);
    const status = q<HTMLElement>('[data-testid="logo-upload-status"]')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent?.trim()).toBe('');

    chooseFile();
    await settle(fixture);
    expect(status.textContent?.trim()).toBe('Uploading logo…');
    http.expectOne('/api/vendor/logo').flush({ logo_url: PATH });
    await settle(fixture);
    expect(status.textContent?.trim()).toBe('Image uploaded. Save to use it.');
    // The portal's region is hidden behind the dialog, so nothing goes there.
    expect(fixture.componentInstance.said).toEqual([]);

    typeUrl('https://example.com/new.png');
    await settle(fixture);
    expect(status.textContent?.trim()).toBe('');
  });

  it('removes the logo straight away', async () => {
    const fixture = await mount();
    await openDialog(fixture);
    q<HTMLButtonElement>('[data-testid="logo-remove"]')!.click();
    await afterClose(fixture);
    expect(q('[data-testid="logo-save"]')).toBeNull();
    expect(fixture.componentInstance.save).toHaveBeenCalledWith(null);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Logo removed.');
    expect(fixture.componentInstance.said).toEqual([
      { text: 'Logo removed. Your listing shows the change now.', hidden: false },
    ]);
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

    // AECI-2126: a failed save leaves nothing to announce when the dialog closes.
    const cancel = [
      ...document.querySelectorAll<HTMLButtonElement>('.cdk-overlay-pane button'),
    ].find((button) => button.textContent?.trim() === 'Cancel')!;
    cancel.click();
    await afterClose(fixture);
    expect(q('[data-testid="logo-save"]')).toBeNull();
    expect(fixture.componentInstance.said).toEqual([]);
  });
});
