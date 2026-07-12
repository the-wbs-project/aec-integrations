import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscribeSubmit } from '@aeci/shared';

import { Analytics } from '../../analytics/analytics';
import { MailingListSignup } from './mailing-list-signup';

/** Macrotask boundary — drains the async `validateStandardSchema` validation
 *  resource + the awaited subscribe promise (mirrors the login-form harness). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function setup() {
  // Fake Analytics: spy on the AECI-326 signup event and avoid the real service's
  // Router/consent dependencies (it's `providedIn: 'root'`).
  const analytics = { mailingListSignup: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: analytics },
    ],
  });
  const fixture = TestBed.createComponent(MailingListSignup);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, httpMock, analytics, el: fixture.nativeElement as HTMLElement };
}

function typeEmail(fixture: ComponentFixture<unknown>, value: string) {
  const input = (fixture.nativeElement as HTMLElement).querySelector(
    '#mailing-list-email',
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

describe('MailingListSignup', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    // Reset the URL so a prior test's UTM params don't leak into `buildAttribution`.
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders a real labelled email input, subscribe button, and the directory-updates copy', () => {
    const { el } = setup();
    expect(el.querySelector('label[for="mailing-list-email"]')).not.toBeNull();
    expect(el.querySelector('#mailing-list-email')).not.toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Subscribe');
    expect(el.textContent).toContain('Know when new tools and reviews land');
    expect(el.textContent).toContain('occasional updates');
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
    const error = el.querySelector('#mailing-list-email-error');
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

    const { fixture, el, httpMock, analytics } = setup();
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
    // AECI-326: a genuine new signup fires the tracked PostHog event with the
    // default band source (the home wrapper overrides it to `home_closing_cta`).
    expect(analytics.mailingListSignup).toHaveBeenCalledWith({ source: 'mailing_list_band' });

    // Confirmed state: the button flips to "Subscribed" and is disabled, and the
    // inline "enter a valid email" error must NOT reappear. Regression guard:
    // clearing the input to '' used to leave the touched field invalid and re-fire
    // that error right beside the success message.
    const btn = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(btn.textContent).toContain('Subscribed');
    expect(btn.disabled).toBe(true);
    expect(el.querySelector('#mailing-list-email-error')).toBeNull();
  });

  it('resets the confirmed button and clears the notice when the address is edited', async () => {
    const { fixture, el, httpMock } = setup();
    typeEmail(fixture, 'pm@example.com');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);
    httpMock
      .expectOne('/api/subscribe')
      .flush({ created: true }, { status: 201, statusText: 'Created' });
    await settle();
    fixture.detectChanges();

    const btn = () => el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(btn().textContent).toContain('Subscribed');

    typeEmail(fixture, 'someone-else@example.com');
    await settle();
    fixture.detectChanges();

    expect(btn().textContent).not.toContain('Subscribed');
    expect(btn().disabled).toBe(false);
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
  });

  it('reports an already-listed email (created: false) distinctly and fires no signup event', async () => {
    const { fixture, el, httpMock, analytics } = setup();
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
    // AECI-326: re-submitting an existing email is not a new signup.
    expect(analytics.mailingListSignup).not.toHaveBeenCalled();
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
