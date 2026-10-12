/**
 * The plan inquiry form and dialog (AECI-1279).
 *
 * `*.component.spec.ts`: the form reads `$localize` and Signal Forms' async schema
 * validation, which only the Angular `ng test` tier sets up. The CTA side (which link
 * opens the dialog, with which placement) is pinned in
 * `docs/docs-plans-cta.component.spec.ts` and `docs-plans-comparison.component.spec.ts`.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanInquirySubmit } from '@aeci/shared';

import { Analytics } from '../../analytics/analytics';
import { SessionStatus } from '../../auth/session-status';
import { PlanInquiryDialog } from './plan-inquiry-dialog';
import { PlanInquiryForm } from './plan-inquiry-form';
import { PlanInquiryService } from './plan-inquiry.service';

/** Macrotask boundary: drains the async schema validation and the awaited submit. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function setup(sessionEmail: string | null = null) {
  const email = signal<string | null>(sessionEmail);
  const planInquirySubmitted = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: SessionStatus, useValue: { email: email.asReadonly() } },
      { provide: Analytics, useValue: { planInquirySubmitted } },
    ],
  });
  const fixture = TestBed.createComponent(PlanInquiryForm);
  fixture.componentRef.setInput('placement', 'rail');
  fixture.detectChanges();
  return {
    fixture,
    email,
    planInquirySubmitted,
    http: TestBed.inject(HttpTestingController),
    el: fixture.nativeElement as HTMLElement,
  };
}

function field(fixture: ComponentFixture<unknown>, name: string) {
  return (fixture.nativeElement as HTMLElement).querySelector(`#plan-inquiry-${name}`) as
    | HTMLInputElement
    | HTMLTextAreaElement;
}

function type(fixture: ComponentFixture<unknown>, name: string, value: string) {
  const el = field(fixture, name);
  el.value = value;
  el.dispatchEvent(new Event('input'));
  el.dispatchEvent(new Event('blur'));
}

async function submitForm(fixture: ComponentFixture<unknown>) {
  await settle();
  fixture.detectChanges();
  const form = (fixture.nativeElement as HTMLElement).querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  fixture.detectChanges();
}

describe('PlanInquiryForm', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('labels every visible field and keeps the honeypot out of reach', () => {
    const { el } = setup();
    for (const name of ['email', 'company', 'details']) {
      const control = el.querySelector(`#plan-inquiry-${name}`)!;
      expect(el.querySelector(`label[for="plan-inquiry-${name}"]`), name).not.toBeNull();
      expect(control, name).not.toBeNull();
    }
    expect(el.querySelector('label[for="plan-inquiry-details"]')?.textContent).toContain(
      'Which products, and anything we should know?',
    );
    const trap = el.querySelector<HTMLInputElement>('#plan-inquiry-website')!;
    expect(trap.tabIndex).toBe(-1);
    expect(trap.getAttribute('autocomplete')).toBe('off');
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('prefills the signed-in email once', async () => {
    const { fixture } = setup('dana@acme.example');
    await settle();
    fixture.detectChanges();
    expect(field(fixture, 'email').value).toBe('dana@acme.example');
  });

  it('never overwrites what the visitor typed', async () => {
    const { fixture, email } = setup();
    type(fixture, 'email', 'typed@acme.example');
    email.set('session@acme.example');
    await settle();
    fixture.detectChanges();
    expect(field(fixture, 'email').value).toBe('typed@acme.example');
  });

  it('shows the field errors and sends nothing when email and company are missing', async () => {
    const { fixture, el, http } = setup();
    await submitForm(fixture);
    http.expectNone('/api/plan-inquiries');
    const alerts = [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent?.trim());
    expect(alerts).toEqual(['Enter a valid email address.', 'Enter your company name.']);
    expect(field(fixture, 'email').getAttribute('aria-invalid')).toBe('true');
    expect(field(fixture, 'email').getAttribute('aria-describedby')).toBe(
      'plan-inquiry-email-error',
    );
  });

  it('posts the inquiry, shows the thanks, and fires plan_inquiry_submitted', async () => {
    const { fixture, el, http, planInquirySubmitted } = setup();
    type(fixture, 'email', ' buyer@acme.example ');
    type(fixture, 'company', 'Acme');
    type(fixture, 'details', 'Procore connector');
    await submitForm(fixture);

    const req = http.expectOne('/api/plan-inquiries');
    expect(req.request.method).toBe('POST');
    const body = req.request.body as PlanInquirySubmit;
    expect(body).toMatchObject({
      topic: 'managed',
      email: 'buyer@acme.example',
      company: 'Acme',
      details: 'Procore connector',
    });
    expect(body).not.toHaveProperty('website');
    req.flush({ received: true }, { status: 201, statusText: 'Created' });
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="plan-inquiry-success"]')?.textContent?.trim()).toBe(
      'Thanks. We reply to most messages within a couple of business days.',
    );
    expect(el.querySelector('form')).toBeNull();
    expect(planInquirySubmitted).toHaveBeenCalledWith({ topic: 'managed', placement: 'rail' });
  });

  it('carries a filled honeypot to the server, which decides', async () => {
    const { fixture, http } = setup();
    type(fixture, 'email', 'bot@spam.example');
    type(fixture, 'company', 'Spam');
    type(fixture, 'website', 'https://spam.example');
    await submitForm(fixture);
    const req = http.expectOne('/api/plan-inquiries');
    expect((req.request.body as PlanInquirySubmit).website).toBe('https://spam.example');
    req.flush({ received: true }, { status: 201, statusText: 'Created' });
    await settle();
  });

  it('keeps the answers and offers a retry when the request fails', async () => {
    const { fixture, el, http, planInquirySubmitted } = setup();
    type(fixture, 'email', 'buyer@acme.example');
    type(fixture, 'company', 'Acme');
    await submitForm(fixture);
    http
      .expectOne('/api/plan-inquiries')
      .flush({ error: { code: 'INTERNAL_ERROR' } }, { status: 500, statusText: 'Error' });
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="plan-inquiry-error"]')?.textContent?.trim()).toBe(
      'We could not send that. Check your connection and try again.',
    );
    expect(field(fixture, 'company').value).toBe('Acme');
    expect(el.querySelector('button[type="submit"]')?.textContent?.trim()).toBe('Try again');
    expect(planInquirySubmitted).not.toHaveBeenCalled();

    await submitForm(fixture);
    http
      .expectOne('/api/plan-inquiries')
      .flush({ received: true }, { status: 201, statusText: 'Created' });
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="plan-inquiry-success"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="plan-inquiry-error"]')).toBeNull();
  });
});

describe('PlanInquiryDialog', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  function mount() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SessionStatus, useValue: { email: signal(null) } },
        { provide: Analytics, useValue: { planInquirySubmitted: vi.fn() } },
      ],
    });
    const inquiry = TestBed.inject(PlanInquiryService);
    return { inquiry, create: () => TestBed.createComponent(PlanInquiryDialog) };
  }

  const panel = () => document.querySelector('[data-testid="plan-inquiry-dialog"]');

  // The first click lands before the deferred dialog exists; it opens itself.
  it('opens on its first render when a click already asked for it', async () => {
    const { inquiry, create } = mount();
    inquiry.open('bottom');
    const fixture = create();
    fixture.detectChanges();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(panel()?.querySelector('h2')?.textContent?.trim()).toBe('Talk to us about Managed');
    expect(panel()?.querySelector('aec-plan-inquiry-form form')).not.toBeNull();
  });

  // Later clicks call the registered opener straight from the click handler.
  it('reopens through the opener after a close, and reports the close', async () => {
    const { inquiry, create } = mount();
    const fixture = create();
    fixture.detectChanges();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(panel()).toBeNull();

    inquiry.open('rail');
    await TestBed.inject(ApplicationRef).whenStable();
    expect(panel()).not.toBeNull();

    (panel()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
    // BrnDialog emits (closed) after its close animation delay.
    for (let i = 0; i < 40 && inquiry.isOpen(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await TestBed.inject(ApplicationRef).whenStable();
    }
    expect(inquiry.isOpen()).toBe(false);
  });
});
