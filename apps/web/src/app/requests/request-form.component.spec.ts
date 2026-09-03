import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestSubmitResponse } from '@aeci/shared';

import { SessionStatus } from '../auth/session-status';

import { RequestForm } from './request-form';
import { RequestsApi } from './requests-api';

type Entity = 'product' | 'vendor';
type Kind = 'claim' | 'correction';

function mockRoute(entity: Entity, kind: Kind, slug: string): ActivatedRoute {
  return {
    snapshot: { data: { entity, kind }, paramMap: convertToParamMap({ slug }) },
  } as unknown as ActivatedRoute;
}

/** Macrotask boundary — drains the async `validateStandardSchema` validation
 *  resource (mirrors the index-page harness `settle()`). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

interface ApiMock {
  submitCorrection: ReturnType<typeof vi.fn>;
  submitClaim: ReturnType<typeof vi.fn>;
}

function makeApiMock(): ApiMock {
  const ok: RequestSubmitResponse = { request_id: 'req-1', message: 'ok' };
  return {
    submitCorrection: vi.fn(async () => ok),
    submitClaim: vi.fn(async () => ok),
  };
}

/** Stands in for the real post-hydration session probe: `email` is `null` for an
 *  anonymous visitor (and pre-hydration), the session's address once signed in. */
function makeSessionStub(email: string | null) {
  const emailSignal = signal(email);
  return {
    stub: {
      signedIn: signal(email !== null).asReadonly(),
      email: emailSignal.asReadonly(),
    } as unknown as SessionStatus,
    emailSignal,
  };
}

function setup(entity: Entity, kind: Kind, slug = 'acme', sessionEmail: string | null = null) {
  const api = makeApiMock();
  const session = makeSessionStub(sessionEmail);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: mockRoute(entity, kind, slug) },
      { provide: RequestsApi, useValue: api },
      { provide: SessionStatus, useValue: session.stub },
    ],
  });
  const fixture = TestBed.createComponent(RequestForm);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return {
    fixture,
    api,
    httpMock,
    session,
    el: fixture.nativeElement as HTMLElement,
  };
}

function type(el: ComponentFixture<unknown>, selector: string, value: string) {
  const input = (el.nativeElement as HTMLElement).querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
}

describe('RequestForm', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the correction field set + submit, not the claim fields', () => {
    const { el, httpMock } = setup('product', 'correction');
    expect(el.querySelector('#correction-body')).not.toBeNull();
    expect(el.querySelector('#correction-email')).not.toBeNull();
    expect(el.querySelector('#correction-source')).not.toBeNull();
    expect(el.querySelector('#claim-name')).toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Send correction');
    httpMock.verify();
  });

  it('renders the claim field set + submit, not the correction fields', () => {
    const { el, httpMock } = setup('vendor', 'claim');
    expect(el.querySelector('#claim-name')).not.toBeNull();
    expect(el.querySelector('#claim-role')).not.toBeNull();
    expect(el.querySelector('#claim-email')).not.toBeNull();
    expect(el.querySelector('#claim-body')).not.toBeNull();
    expect(el.querySelector('#correction-body')).toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Send claim');
    httpMock.verify();
  });

  it('disables submit while the form is invalid', async () => {
    const { fixture, el, httpMock } = setup('product', 'correction');
    await settle();
    fixture.detectChanges();
    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    httpMock.verify();
  });

  it('discloses the 20-character floor as persistent hint text, described before any error', () => {
    const { el, httpMock } = setup('vendor', 'claim');

    // The hint is present from first render (not gated on touched/invalid) and is
    // the only thing describing the field until an error joins it.
    const hint = el.querySelector('#claim-body-hint');
    expect(hint?.textContent).toContain('Minimum 20 characters');
    expect(el.querySelector('#claim-body')?.getAttribute('aria-describedby')).toBe(
      'claim-body-hint',
    );
    httpMock.verify();
  });

  it('keeps the hint in aria-describedby alongside the error once the field is touched', async () => {
    const { fixture, el, httpMock } = setup('product', 'correction');
    const body = el.querySelector('#correction-body') as HTMLTextAreaElement;
    body.dispatchEvent(new Event('blur'));
    await settle();
    fixture.detectChanges();

    expect(body.getAttribute('aria-describedby')).toBe(
      'correction-body-hint correction-body-error',
    );
    expect(el.querySelector('#correction-body-hint')).not.toBeNull();
    httpMock.verify();
  });

  it('surfaces a per-field error via get() once a field is touched', async () => {
    const { fixture, el, httpMock } = setup('product', 'correction');
    // Blur the empty body field → touched + invalid → standardSchema error shows.
    // validateStandardSchema is async, so settle before asserting.
    const body = el.querySelector('#correction-body') as HTMLTextAreaElement;
    body.dispatchEvent(new Event('blur'));
    await settle();
    fixture.detectChanges();

    const error = el.querySelector('#correction-body-error');
    expect(error).not.toBeNull();
    expect(error?.getAttribute('role')).toBe('alert');
    httpMock.verify();
  });

  it('submits a valid correction and shows the confirmation panel', async () => {
    const { fixture, el, api, httpMock } = setup('product', 'correction', 'acme-build');

    type(
      fixture,
      '#correction-body',
      'The founding year is wrong — it should read 2009, not 2019.',
    );
    type(fixture, '#correction-email', 'reporter@example.com');
    // Let validateStandardSchema resolve so the form is valid before submit.
    await settle();
    fixture.detectChanges();

    const form = el.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitCorrection).toHaveBeenCalledTimes(1);
    const [, formValue] = api.submitCorrection.mock.calls[0];
    expect(formValue).toMatchObject({ submitter_email: 'reporter@example.com' });
    expect(el.textContent).toContain('Submission received');
    httpMock.verify();
  });

  it('prefills the claim email from the signed-in session', async () => {
    const { fixture, el, httpMock } = setup('vendor', 'claim', 'acme', 'dana@acme.example');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('#claim-email') as HTMLInputElement).value).toBe('dana@acme.example');
    httpMock.verify();
  });

  it('prefills the correction email from the signed-in session', async () => {
    const { fixture, el, httpMock } = setup('product', 'correction', 'acme', 'dana@acme.example');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('#correction-email') as HTMLInputElement).value).toBe(
      'dana@acme.example',
    );
    httpMock.verify();
  });

  it('leaves the email empty for an anonymous visitor', async () => {
    const { fixture, el, httpMock } = setup('vendor', 'claim');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('#claim-email') as HTMLInputElement).value).toBe('');
    httpMock.verify();
  });

  it('does not overwrite an email the visitor already typed', async () => {
    const { fixture, el, httpMock, session } = setup('vendor', 'claim');
    type(fixture, '#claim-email', 'work@other.example');
    await settle();

    // The probe resolves late (slow SDK chunk) — the typed value must win.
    session.emailSignal.set('dana@acme.example');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('#claim-email') as HTMLInputElement).value).toBe('work@other.example');
    httpMock.verify();
  });

  it('submits the prefilled email when the visitor leaves it alone', async () => {
    const { fixture, el, api, httpMock } = setup('vendor', 'claim', 'acme-co', 'dana@acme.example');

    type(fixture, '#claim-name', 'Dana Reyes');
    type(fixture, '#claim-role', 'Head of Partnerships');
    type(fixture, '#claim-body', 'I run the integrations program at Acme and own this listing.');
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitClaim).toHaveBeenCalledTimes(1);
    const [, formValue] = api.submitClaim.mock.calls[0];
    expect(formValue).toMatchObject({ submitter_email: 'dana@acme.example' });
    httpMock.verify();
  });
});
