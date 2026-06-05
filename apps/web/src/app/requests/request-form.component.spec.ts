import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestSubmitResponse } from '@aeci/shared';

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

function setup(entity: Entity, kind: Kind, slug = 'acme') {
  const api = makeApiMock();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: mockRoute(entity, kind, slug) },
      { provide: RequestsApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(RequestForm);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, api, httpMock, el: fixture.nativeElement as HTMLElement };
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
});
