import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscribeSubmit } from '@aeci/shared';

import { By } from '@angular/platform-browser';

import { Analytics } from '../../analytics/analytics';
import { FoundViaField } from '../found-via/found-via-field';
import { MailingListSignup } from './mailing-list-signup';

/** The form's own result region. The "How did you find us?" field has its own
 *  polite region (AECI-1063), so a bare `[role="status"]` would find that one. */
const FORM_STATUS = '[role="status"]:not([data-testid="found-via-status"])';

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

  it('is one shared card on the page wrap; the ground input only changes the band (AECI-1799)', () => {
    const bone = setup().fixture.nativeElement as HTMLElement;
    const boneBand = bone.querySelector('section')!;
    expect(boneBand.classList).toContain('bg-(--accent-warm)');
    // The unlayered class that keeps an edge under forced colours.
    expect(boneBand.classList).toContain('aec-bone-band');
    expect(boneBand.firstElementChild?.classList).toContain('max-w-[1328px]');
    const card = boneBand.querySelector('.aec-card')!;
    expect(card.classList).toContain('rounded-card');
    expect(card.classList).toContain('shadow-card');
    // The headline size is on an inner span (the unlayered h2 rule beats the element).
    expect(card.querySelector('h2 > span.text-t-36')).not.toBeNull();

    TestBed.resetTestingModule();
    const whiteFixture = setup().fixture;
    whiteFixture.componentRef.setInput('ground', 'white');
    whiteFixture.detectChanges();
    const white = (whiteFixture.nativeElement as HTMLElement).querySelector('section')!;
    expect(white.classList).toContain('bg-(--surface-base)');
    expect(white.classList).not.toContain('bg-(--accent-warm)');
    expect(white.classList).not.toContain('aec-bone-band');
    // Same card, same form, on either ground.
    expect(white.querySelector('.aec-card form #mailing-list-email')).not.toBeNull();
    // The field keeps its 3:1 edge class.
    expect(white.querySelector('#mailing-list-email')?.classList).toContain('aec-field-control');
  });

  it('keeps submit enabled while the email is invalid, shows the error on submit and never POSTs', async () => {
    const { fixture, el, httpMock } = setup();
    typeEmail(fixture, 'not-an-email');
    await settle();
    fixture.detectChanges();

    // AECI-1720 restore: a disabled pale button read as broken, so it stays enabled.
    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    await submitForm(fixture);
    await settle();
    fixture.detectChanges();
    httpMock.expectNone('/api/subscribe');
    expect(el.querySelector('#mailing-list-email-error')?.getAttribute('role')).toBe('alert');
  });

  it('shows the error when an empty email is submitted, and never POSTs', async () => {
    const { fixture, el, httpMock } = setup();
    await submitForm(fixture);
    await settle();
    fixture.detectChanges();
    httpMock.expectNone('/api/subscribe');
    expect(el.querySelector('#mailing-list-email-error')).not.toBeNull();
  });

  it('splits the card into words and form from lg, so the right half is never blank', () => {
    const { el } = setup();
    const card = el.querySelector('[data-testid="mailing-list-card"]')!;
    expect(card.classList).toContain('lg:grid');
    expect(card.classList).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]');
    // Two columns: the words, then the form.
    expect(card.children[0]!.querySelector('h2')).not.toBeNull();
    expect(card.children[1]!.tagName).toBe('FORM');
  });

  it('surfaces the inline email error once touched', async () => {
    const { fixture, el } = setup();
    typeEmail(fixture, 'nope');
    await settle();
    fixture.detectChanges();
    const error = el.querySelector('#mailing-list-email-error');
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('does NOT show the email error when an empty field is touched (focus then blur, no text)', async () => {
    const { fixture, el } = setup();
    const input = el.querySelector('#mailing-list-email') as HTMLInputElement;
    // Focus then blur without typing — marks the field touched but it holds no text.
    input.dispatchEvent(new Event('focus'));
    input.dispatchEvent(new Event('blur'));
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('#mailing-list-email-error')).toBeNull();
    // aria-invalid must not be asserted on an empty field either.
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('hides the email error again if an invalid value is cleared back to empty', async () => {
    const { fixture, el } = setup();
    typeEmail(fixture, 'nope');
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('#mailing-list-email-error')).not.toBeNull();

    // Clear the field — the touched-but-empty box should stop nagging.
    typeEmail(fixture, '');
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('#mailing-list-email-error')).toBeNull();
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
    expect(el.querySelector(FORM_STATUS)?.textContent).toContain("You're on the list");
    // AECI-326: a genuine new signup fires the tracked PostHog event with the
    // default band source (the home no longer mounts the band).
    expect(analytics.mailingListSignup).toHaveBeenCalledWith({
      source: 'mailing_list_band',
      found_via: null,
    });
    // AECI-1063: the unanswered question still rides the body, as ''.
    expect(body.found_via).toBe('');
    expect(body.found_via_detail).toBe('');

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
    expect(el.querySelector(FORM_STATUS)?.textContent?.trim()).toBe('');
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
    expect(el.querySelector(FORM_STATUS)?.textContent).toContain('already on the list');
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

    expect(el.querySelector(FORM_STATUS)?.textContent).toContain('Something went wrong');
    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the "How did you find us?" answer and follow-up in the same POST (AECI-1063)', async () => {
    const { fixture, httpMock, analytics } = setup();
    typeEmail(fixture, 'pm@example.com');
    const field = fixture.debugElement.query(By.directive(FoundViaField))
      .componentInstance as FoundViaField;
    field.value.set('ai_tool');
    field.detail.set('  best AEC integration directory  ');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    const req = httpMock.expectOne('/api/subscribe');
    const body = req.request.body as SubscribeSubmit;
    expect(body.found_via).toBe('ai_tool');
    expect(body.found_via_detail).toBe('best AEC integration directory');
    req.flush({ created: true }, { status: 201, statusText: 'Created' });
    await settle();
    // The event carries the channel only, never the free text.
    expect(analytics.mailingListSignup).toHaveBeenCalledWith({
      source: 'mailing_list_band',
      found_via: 'ai_tool',
    });
  });
});
