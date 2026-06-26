import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SubscribeSubmit } from '@aeci/shared';

import { HomeClosingCta } from './home-closing-cta';

/** Macrotask boundary — drains the async `validateStandardSchema` validation
 *  resource + the awaited subscribe promise (mirrors the login-form harness). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function setup() {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(HomeClosingCta);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, httpMock, el: fixture.nativeElement as HTMLElement };
}

function typeEmail(fixture: ComponentFixture<unknown>, value: string) {
  const input = (fixture.nativeElement as HTMLElement).querySelector(
    '#home-cta-email',
  ) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
}

async function submitForm(fixture: ComponentFixture<unknown>) {
  const form = (fixture.nativeElement as HTMLElement).querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  await settle();
  fixture.detectChanges();
}

describe('HomeClosingCta', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    // Reset the URL so a prior test's UTM params don't leak into `buildAttribution`.
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders a real labelled email input, subscribe button, no-spam copy, and the suggest-a-tool entry', () => {
    const { el } = setup();
    expect(el.querySelector('label[for="home-cta-email"]')).not.toBeNull();
    expect(el.querySelector('#home-cta-email')).not.toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Subscribe');
    expect(el.textContent).toContain('No spam, just progress');
    const suggest = [...el.querySelectorAll('button[type="button"]')].find((b) =>
      b.textContent?.includes('Suggest a tool'),
    );
    expect(suggest).toBeTruthy();
  });

  it('disables submit while the email is invalid and never POSTs', async () => {
    const { fixture, el, httpMock } = setup();
    typeEmail(fixture, 'not-an-email');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    await submitForm(fixture);
    httpMock.expectNone('/api/subscribe');
  });

  it('surfaces the inline email error once touched', async () => {
    const { fixture, el } = setup();
    typeEmail(fixture, 'nope');
    await settle();
    fixture.detectChanges();
    const error = el.querySelector('#home-cta-email-error');
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('POSTs /api/subscribe with the email + UTM + referrer from the live page, then confirms', async () => {
    window.history.replaceState(
      {},
      '',
      '/?utm_source=newsletter&utm_medium=email&utm_campaign=launch',
    );
    Object.defineProperty(document, 'referrer', {
      value: 'https://news.ycombinator.com/',
      configurable: true,
    });

    const { fixture, el, httpMock } = setup();
    typeEmail(fixture, 'pm@example.com');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    const req = httpMock.expectOne('/api/subscribe');
    expect(req.request.method).toBe('POST');
    const body = req.request.body as SubscribeSubmit;
    expect(body.email).toBe('pm@example.com');
    expect(body.utm_source).toBe('newsletter');
    expect(body.utm_medium).toBe('email');
    expect(body.utm_campaign).toBe('launch');
    expect(body.referrer).toBe('https://news.ycombinator.com/');

    req.flush({ created: true }, { status: 201, statusText: 'Created' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')?.textContent).toContain("You're on the list");
  });

  it('reports an already-listed email (created: false) distinctly', async () => {
    const { fixture, el, httpMock } = setup();
    typeEmail(fixture, 'dupe@example.com');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    httpMock
      .expectOne('/api/subscribe')
      .flush({ created: false }, { status: 200, statusText: 'OK' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already on the list');
  });

  it('shows a retryable error notice and keeps submit enabled when the POST fails', async () => {
    const { fixture, el, httpMock } = setup();
    typeEmail(fixture, 'pm@example.com');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    httpMock
      .expectOne('/api/subscribe')
      .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[role="status"]')?.textContent).toContain('Something went wrong');
    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
