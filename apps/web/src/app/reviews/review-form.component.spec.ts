import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail, SubmitReviewResponse } from '@aeci/shared';

import { ReviewForm } from './review-form';
import { ReviewsApi } from './reviews-api';

/** Minimal product stub — the form only reads `id`, `name`, `slug`. */
function product(): ProductDetail {
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    name: 'Acme Build',
    slug: 'acme-build',
  } as unknown as ProductDetail;
}

function mockRoute(p: ProductDetail | null): ActivatedRoute {
  return { snapshot: { data: { product: p } } } as unknown as ActivatedRoute;
}

/** Macrotask boundary — drains the async `validateStandardSchema` resource
 *  (mirrors the request-form harness `settle()`). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

interface ApiMock {
  submitReview: ReturnType<typeof vi.fn>;
}

function makeApiMock(impl?: () => Promise<SubmitReviewResponse>): ApiMock {
  const ok: SubmitReviewResponse = { id: 'rev-1', status: 'pending', message: 'ok' };
  return { submitReview: vi.fn(impl ?? (async () => ok)) };
}

function setup(p: ProductDetail | null = product(), api: ApiMock = makeApiMock()) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: mockRoute(p) },
      { provide: ReviewsApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(ReviewForm);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, api, httpMock, el: fixture.nativeElement as HTMLElement };
}

function setValue(fixture: ComponentFixture<unknown>, selector: string, value: string) {
  const input = (fixture.nativeElement as HTMLElement).querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
}

/** Click the nth (1-based) option inside the given listbox — drives the Aria
 *  listbox click manager exactly as a pointer would. */
function clickStar(el: HTMLElement, listboxLabelId: string, n: number) {
  const listbox = el.querySelector(`ul[aria-labelledby="${listboxLabelId}"]`) as HTMLElement;
  const option = listbox.querySelectorAll('[role="option"]')[n - 1] as HTMLElement;
  option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('ReviewForm', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders two 5-star listboxes, the text fields, and a disabled submit', async () => {
    const { fixture, el, httpMock } = setup();
    await settle();
    fixture.detectChanges();

    const listboxes = el.querySelectorAll('ul[role="listbox"]');
    // overall + onboarding + would-recommend
    expect(listboxes.length).toBeGreaterThanOrEqual(2);
    const overall = el.querySelector('ul[aria-labelledby="overall-label"]') as HTMLElement;
    const onboarding = el.querySelector('ul[aria-labelledby="onboarding-label"]') as HTMLElement;
    expect(overall.querySelectorAll('[role="option"]').length).toBe(5);
    expect(onboarding.querySelectorAll('[role="option"]').length).toBe(5);
    expect(el.querySelector('#review-title-input')).not.toBeNull();
    expect(el.querySelector('#review-body')).not.toBeNull();

    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    httpMock.verify();
  });

  it('renders the 404 shell when the product is missing', () => {
    const { el, httpMock } = setup(null);
    expect(el.querySelector('aec-not-found')).not.toBeNull();
    expect(el.querySelector('form')).toBeNull();
    httpMock.verify();
  });

  it('surfaces a per-field error once the body is touched', async () => {
    const { fixture, el, httpMock } = setup();
    const body = el.querySelector('#review-body') as HTMLTextAreaElement;
    body.dispatchEvent(new Event('blur'));
    await settle();
    fixture.detectChanges();

    const error = el.querySelector('#review-body-error');
    expect(error).not.toBeNull();
    expect(error?.getAttribute('role')).toBe('alert');
    httpMock.verify();
  });

  it('selecting stars updates the rating and enables a valid submit', async () => {
    const { fixture, el, httpMock } = setup();
    clickStar(el, 'overall-label', 4);
    clickStar(el, 'onboarding-label', 5);
    setValue(fixture, '#review-title-input', 'Solid revit connector');
    setValue(
      fixture,
      '#review-body',
      'We rolled this out across three offices and the sync held up under heavy model loads.',
    );
    await settle();
    fixture.detectChanges();

    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    httpMock.verify();
  });

  it('submits a valid review and shows the confirmation panel', async () => {
    const api = makeApiMock();
    const { fixture, el, httpMock } = setup(product(), api);
    clickStar(el, 'overall-label', 4);
    clickStar(el, 'onboarding-label', 5);
    setValue(fixture, '#review-title-input', 'Solid revit connector');
    setValue(
      fixture,
      '#review-body',
      'We rolled this out across three offices and the sync held up under heavy model loads.',
    );
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitReview).toHaveBeenCalledTimes(1);
    expect(api.submitReview.mock.calls[0][0]).toMatchObject({
      product_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      rating_overall: 4,
      rating_onboarding: 5,
      title: 'Solid revit connector',
    });
    expect(el.textContent).toContain('Review received');
    httpMock.verify();
  });

  it('shows a retryable notice when the API call fails', async () => {
    const api = makeApiMock(async () => {
      throw new Error('boom');
    });
    const { fixture, el, httpMock } = setup(product(), api);
    clickStar(el, 'overall-label', 3);
    clickStar(el, 'onboarding-label', 3);
    setValue(fixture, '#review-title-input', 'Decent but rough');
    setValue(
      fixture,
      '#review-body',
      'The integration works but the onboarding docs were thin and we needed support twice.',
    );
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitReview).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[i18n="@@reviews.submitFailed"], p[role="alert"]')).not.toBeNull();
    expect(el.textContent).toContain('Please try again');
    httpMock.verify();
  });
});
