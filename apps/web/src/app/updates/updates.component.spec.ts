import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscribeSubmit } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { UpdatesPage } from './updates';

/** Macrotask boundary — drains the async `validateStandardSchema` validation
 *  resource + the awaited subscribe promise (mirrors the mailing-list harness). */
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
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: analytics },
    ],
  });
  const fixture = TestBed.createComponent(UpdatesPage);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, httpMock, analytics, el: fixture.nativeElement as HTMLElement };
}

function typeEmail(fixture: ComponentFixture<unknown>, value: string) {
  const input = (fixture.nativeElement as HTMLElement).querySelector(
    '#updates-email',
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

describe('UpdatesPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    // Reset the URL so a prior test's UTM params don't leak into `buildAttribution`.
    window.history.replaceState({}, '', '/updates');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders a single h1, a visible labelled email input, and the join button', () => {
    const { el } = setup();
    const h1s = el.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain('Get AEC Integrations updates');

    const label = el.querySelector('label[for="updates-email"]');
    expect(label).not.toBeNull();
    // The label is visible (not sr-only, per the requirement for a proper label).
    expect(label?.classList.contains('sr-only')).toBe(false);
    expect(label?.textContent).toContain('Email address');

    expect(el.querySelector('#updates-email')).not.toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain(
      'Join the mailing list',
    );
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

  it('surfaces the inline email error, associated with the field, once touched', async () => {
    const { fixture, el } = setup();
    typeEmail(fixture, 'nope');
    await settle();
    fixture.detectChanges();

    const error = el.querySelector('#updates-email-error');
    expect(error?.getAttribute('role')).toBe('alert');
    const input = el.querySelector('#updates-email') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('updates-email-error');
  });

  it('POSTs /api/subscribe with email + UTM + referrer, then swaps in the success panel', async () => {
    window.history.replaceState(
      {},
      '',
      '/updates?utm_source=linkedin&utm_medium=social&utm_campaign=launch',
    );
    Object.defineProperty(document, 'referrer', {
      value: 'https://www.linkedin.com/',
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
    expect(body.utm_source).toBe('linkedin');
    expect(body.utm_medium).toBe('social');
    expect(body.utm_campaign).toBe('launch');
    expect(body.referrer).toBe('https://www.linkedin.com/');

    req.flush({ created: true }, { status: 201, statusText: 'Created' });
    await settle();
    fixture.detectChanges();

    // The form is replaced by the confirmation panel + a Browse-integrations CTA.
    expect(el.querySelector('form')).toBeNull();
    const heading = el.querySelector('h2');
    expect(heading?.textContent).toContain("You're on the list");
    const browse = el.querySelector('a[href="/products"]');
    expect(browse?.textContent).toContain('Browse integrations');
    // AECI-326: a genuine new signup fires the tracked event tagged to this page.
    expect(analytics.mailingListSignup).toHaveBeenCalledWith({ source: 'updates_page' });
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

    // Stays on the form (no success swap) with an inline duplicate notice.
    expect(el.querySelector('form')).not.toBeNull();
    expect(el.querySelector('h2')).toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already on the list');
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
