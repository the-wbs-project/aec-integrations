import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FeedbackSubmit, SubscribeSubmit } from '@aeci/shared';

import { HomeFeedbackForm } from './home-feedback-form';

/** Macrotask boundary — drains the async `validateStandardSchema` resource + the
 *  awaited submit promise. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function setup() {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(HomeFeedbackForm);
  const doneEvents: number[] = [];
  fixture.componentInstance.done.subscribe(() => doneEvents.push(1));
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, httpMock, doneEvents, el: fixture.nativeElement as HTMLElement };
}

function type(fixture: ComponentFixture<unknown>, selector: string, value: string) {
  const field = (fixture.nativeElement as HTMLElement).querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new Event('input'));
  field.dispatchEvent(new Event('blur'));
}

function setOptIn(fixture: ComponentFixture<unknown>, checked: boolean) {
  const cb = (fixture.nativeElement as HTMLElement).querySelector(
    'input[type="checkbox"]',
  ) as HTMLInputElement;
  cb.checked = checked;
  cb.dispatchEvent(new Event('change'));
}

async function submitForm(fixture: ComponentFixture<unknown>) {
  const form = (fixture.nativeElement as HTMLElement).querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  await settle();
  fixture.detectChanges();
}

describe('HomeFeedbackForm', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders both suggestion fields, an optional email, an opt-in, and the submit', () => {
    const { el } = setup();
    expect(el.querySelector('#home-feedback-features')).not.toBeNull();
    expect(el.querySelector('#home-feedback-tools')).not.toBeNull();
    expect(el.querySelector('#home-feedback-email')).not.toBeNull();
    expect(el.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Send feedback');
  });

  it('blocks submit (the .refine guard) until at least one of features/tools is given', async () => {
    const { fixture, el, httpMock } = setup();
    // Pristine: nothing entered → disabled, no POST.
    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    await submitForm(fixture);
    httpMock.expectNone('/api/feedback');

    // One field is enough.
    type(fixture, '#home-feedback-tools', 'Procore');
    await settle();
    fixture.detectChanges();
    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('surfaces the at-least-one error (and wires aria) once a suggestion field is touched', async () => {
    const { fixture, el } = setup();
    // Blur the empty features field → touched + the .refine error (path: ['features'])
    // → the inline message renders and the textareas are described by it.
    type(fixture, '#home-feedback-features', '');
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('#home-feedback-fields-error')?.getAttribute('role')).toBe('alert');
    const features = el.querySelector('#home-feedback-features') as HTMLTextAreaElement;
    expect(features.getAttribute('aria-invalid')).toBe('true');
    expect(features.getAttribute('aria-describedby')).toBe('home-feedback-fields-error');
  });

  it('POSTs /api/feedback (empty fields omitted), shows the thanks state, and emits done', async () => {
    const { fixture, el, httpMock, doneEvents } = setup();
    type(fixture, '#home-feedback-features', 'Bidirectional Revit sync');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    const req = httpMock.expectOne('/api/feedback');
    expect(req.request.method).toBe('POST');
    const body = req.request.body as FeedbackSubmit;
    expect(body.features).toBe('Bidirectional Revit sync');
    expect(body.tools).toBeUndefined();
    expect(body.subscribed).toBe(false);

    req.flush({ created: true }, { status: 201, statusText: 'Created' });
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[role="status"]')?.textContent).toContain('Thanks');
    expect(doneEvents).toHaveLength(1);
  });

  it('piggybacks a subscribe when opt-in is checked and an email is given', async () => {
    const { fixture, httpMock } = setup();
    type(fixture, '#home-feedback-tools', 'Bluebeam');
    type(fixture, '#home-feedback-email', 'pm@example.com');
    setOptIn(fixture, true);
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    const fb = httpMock.expectOne('/api/feedback');
    expect((fb.request.body as FeedbackSubmit).subscribed).toBe(true);
    fb.flush({ created: true }, { status: 201, statusText: 'Created' });
    await settle();
    fixture.detectChanges();

    // The opt-in lands in mailing_list via the best-effort piggyback.
    const sub = httpMock.expectOne('/api/subscribe');
    expect((sub.request.body as SubscribeSubmit).email).toBe('pm@example.com');
    sub.flush({ created: true }, { status: 201, statusText: 'Created' });
    await settle();
  });

  it('does NOT piggyback a subscribe when the opt-in is unchecked', async () => {
    const { fixture, httpMock } = setup();
    type(fixture, '#home-feedback-tools', 'AutoCAD');
    type(fixture, '#home-feedback-email', 'pm@example.com');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    httpMock.expectOne('/api/feedback').flush({ created: true }, { status: 201, statusText: 'OK' });
    await settle();
    fixture.detectChanges();
    httpMock.expectNone('/api/subscribe');
  });

  it('blocks submit on a present-but-invalid email', async () => {
    const { fixture, el } = setup();
    type(fixture, '#home-feedback-tools', 'Navisworks');
    type(fixture, '#home-feedback-email', 'not-an-email');
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('#home-feedback-email-error')?.getAttribute('role')).toBe('alert');
    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
