import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogoInput } from './logo-input';

@Component({
  imports: [LogoInput],
  template: `<aec-logo-input
    inputId="test-logo"
    [value]="value()"
    [readOnly]="readonly()"
    [disabled]="disabled()"
    (valueChange)="value.set($event)"
    (pendingChange)="pending.set($event)"
  />`,
})
class Host {
  value = signal('https://example.com/old.png');
  readonly = signal(false);
  disabled = signal(false);
  pending = signal(false);
}

describe('LogoInput', () => {
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
  function choose(fixture: ReturnType<typeof mount>, size = 3) {
    const file = new File([new Uint8Array(size)], 'logo.png', { type: 'image/png' });
    const input = fixture.nativeElement.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: { length: 1, item: () => file },
    });
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }
  it('uploads multipart and switches the draft to a protected uploaded-image state', async () => {
    const fixture = mount();
    choose(fixture);
    expect(fixture.componentInstance.pending()).toBe(true);
    expect(fixture.componentInstance.value()).toContain('old.png');
    const request = http.expectOne('/api/vendor/logo');
    expect(request.request.body).toBeInstanceOf(FormData);
    const path = `/api/logos/${'a'.repeat(64)}`;
    request.flush({ logo_url: path });
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe(path);
    expect(fixture.componentInstance.pending()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Save your changes');
    expect(fixture.nativeElement.textContent).toContain('Uploaded image');
    expect(fixture.nativeElement.textContent).not.toContain(path);
    expect(fixture.nativeElement.querySelector('#test-logo')).toBeNull();
    expect(fixture.nativeElement.querySelector('input[type=file]')).toBeNull();

    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('');
    expect(fixture.nativeElement.querySelector('#test-logo')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('input[type=file]')).toBeTruthy();
  });
  it('keeps the original value after an upload error', () => {
    const fixture = mount();
    choose(fixture);
    http.expectOne('/api/vendor/logo').flush({}, { status: 400, statusText: 'Invalid image' });
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toContain('old.png');
    expect(fixture.componentInstance.pending()).toBe(false);
    expect(fixture.nativeElement.querySelector('[role=alert]')).toBeTruthy();
  });
  it('cancels an upload when the URL is changed', () => {
    const fixture = mount();
    choose(fixture);
    const request = http.expectOne('/api/vendor/logo');
    const input = fixture.nativeElement.querySelector('#test-logo') as HTMLInputElement;
    input.value = 'https://example.com/new.png';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(request.cancelled).toBe(true);
    expect(fixture.componentInstance.value()).toContain('new.png');
    expect(fixture.componentInstance.pending()).toBe(false);
  });
  it('cancels an upload when destroyed', () => {
    const fixture = mount();
    choose(fixture);
    const request = http.expectOne('/api/vendor/logo');
    fixture.destroy();
    expect(request.cancelled).toBe(true);
  });
  it('rejects oversized files locally', () => {
    const fixture = mount();
    choose(fixture, 2 * 1024 * 1024 + 1);
    http.expectNone('/api/vendor/logo');
    expect(fixture.nativeElement.querySelector('[role=alert]').textContent).toContain('2 MiB');
  });
  it('allows copying in read-only mode and hides upload actions', async () => {
    const fixture = mount();
    fixture.componentInstance.readonly.set(true);
    fixture.componentInstance.value.set(`/api/logos/${'c'.repeat(64)}`);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('#test-logo').readOnly).toBe(true);
    expect(fixture.nativeElement.querySelector('#test-logo').disabled).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Uploaded image reference');
    expect(fixture.nativeElement.querySelector('input[type=file]')).toBeNull();
  });
  it('uses native disabled semantics', async () => {
    const fixture = mount();
    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('#test-logo').disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('#test-logo').readOnly).toBe(false);
  });
  it('clears the draft and describes invalid preview URLs', async () => {
    const fixture = mount();
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('');
    fixture.componentInstance.value.set('javascript:alert(1)');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.querySelector('#test-logo').getAttribute('aria-describedby')).toBe(
      'test-logo-help test-logo-error',
    );
    expect(fixture.nativeElement.querySelector('#test-logo-error').getAttribute('role')).toBe(
      'alert',
    );
  });
  it('accepts a drop and rejects a multi-file drop after returning to upload mode', async () => {
    const fixture = mount();
    let dropZone = fixture.nativeElement.querySelector('div.border-dashed') as HTMLElement;
    const event = new Event('drop', { cancelable: true });
    const file = new File(['abc'], 'logo.png');
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: { length: 1, item: () => file } },
    });
    dropZone.dispatchEvent(event);
    fixture.detectChanges();
    http.expectOne('/api/vendor/logo').flush({ logo_url: `/api/logos/${'b'.repeat(64)}` });
    await fixture.whenStable();
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    await fixture.whenStable();
    dropZone = fixture.nativeElement.querySelector('div.border-dashed') as HTMLElement;
    const many = new Event('drop', { cancelable: true });
    Object.defineProperty(many, 'dataTransfer', {
      value: { files: { length: 2, item: () => file } },
    });
    dropZone.dispatchEvent(many);
    fixture.detectChanges();
    http.expectNone('/api/vendor/logo');
    expect(fixture.nativeElement.textContent).toContain('one image');
  });
});
