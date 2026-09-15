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
  it('uploads multipart and updates only the draft after success', () => {
    const fixture = mount();
    choose(fixture);
    expect(fixture.componentInstance.pending()).toBe(true);
    expect(fixture.componentInstance.value()).toContain('old.png');
    const request = http.expectOne('/api/vendor/logo');
    expect(request.request.body).toBeInstanceOf(FormData);
    const path = `/api/logos/${'a'.repeat(64)}`;
    request.flush({ logo_url: path });
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(path);
    expect(fixture.componentInstance.pending()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Save your changes');
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
  it('allows copying in read-only mode and hides upload actions', () => {
    const fixture = mount();
    fixture.componentInstance.readonly.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#test-logo').readOnly).toBe(true);
    expect(fixture.nativeElement.querySelector('input[type=file]')).toBeNull();
  });
  it('clears the draft and prevents unsafe preview URLs', () => {
    const fixture = mount();
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('');
    fixture.componentInstance.value.set('javascript:alert(1)');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
  });
  it('accepts a drop and rejects a multi-file drop', () => {
    const fixture = mount();
    const dropZone = fixture.nativeElement.querySelector('div.border-dashed') as HTMLElement;
    const event = new Event('drop', { cancelable: true });
    const file = new File(['abc'], 'logo.png');
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: { length: 1, item: () => file } },
    });
    dropZone.dispatchEvent(event);
    fixture.detectChanges();
    http.expectOne('/api/vendor/logo').flush({ logo_url: `/api/logos/${'b'.repeat(64)}` });
    fixture.detectChanges();
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
