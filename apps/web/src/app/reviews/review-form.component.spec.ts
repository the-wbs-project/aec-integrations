import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountReview, ProductDetail, SubmitReviewResponse } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import { AuthService } from '../auth/auth.service';

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

/** Macrotask boundary — drains the async `validateStandardSchema` resource AND
 *  the `afterNextRender` already-reviewed lookup (mirrors request-form). */
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

interface AccountMock {
  findMyReviewForProduct: ReturnType<typeof vi.fn>;
}

/** Mock `AccountApi` — the already-reviewed guard resolves to `review`
 *  (default `null` → the form renders normally). */
function makeAccountMock(review: AccountReview | null = null): AccountMock {
  return { findMyReviewForProduct: vi.fn(async () => review) };
}

interface AuthMock {
  isConfigured: ReturnType<typeof vi.fn>;
  hasSessionCookie: ReturnType<typeof vi.fn>;
}

/** Mock `AuthService` for the post-hydration sign-in gate. Defaults to
 *  `configured: false` so the auth probe is a no-op and the existing suites
 *  behave exactly as before (straight to the already-reviewed check). */
function makeAuthMock(opts: { configured?: boolean; hasCookie?: boolean } = {}): AuthMock {
  return {
    isConfigured: vi.fn(() => opts.configured ?? false),
    hasSessionCookie: vi.fn(() => opts.hasCookie ?? false),
  };
}

const existingReview: AccountReview = {
  id: '00000000-0000-4000-8000-0000000000aa',
  product: { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', name: 'Acme Build', slug: 'acme-build' },
  rating_overall: 5,
  rating_onboarding: 4,
  title: 'Solid',
  status: 'approved',
  rejection_reason: null,
  created_at: '2026-06-01T00:00:00.000Z',
};

/** A `HttpErrorResponse` matching the API's `REVIEW_DUPLICATE` 409 envelope. */
function duplicate409(): HttpErrorResponse {
  return new HttpErrorResponse({
    status: 409,
    error: { error: { code: 'REVIEW_DUPLICATE', message: 'dup' }, trace_id: 't' },
  });
}

function setup(
  p: ProductDetail | null = product(),
  api: ApiMock = makeApiMock(),
  account: AccountMock = makeAccountMock(),
  auth: AuthMock = makeAuthMock(),
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: mockRoute(p) },
      { provide: ReviewsApi, useValue: api },
      { provide: AccountApi, useValue: account },
      { provide: AuthService, useValue: auth },
    ],
  });
  const fixture = TestBed.createComponent(ReviewForm);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, api, account, auth, httpMock, el: fixture.nativeElement as HTMLElement };
}

/** Settle the `afterNextRender` already-reviewed check + re-render, so the form
 *  (gated behind `checkingExisting`) is in the DOM before interacting. */
async function showForm(fixture: ComponentFixture<unknown>): Promise<void> {
  await settle();
  fixture.detectChanges();
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

  it('wires the role-at-company trigger as a closed Aria combobox', async () => {
    // AECI-232: the role popup is positioned via cdkConnectedOverlay (Aria supplies
    // behavior, not the floating layer). We assert the always-rendered trigger's
    // wiring, NOT the opened overlay — matching the repo convention of not opening
    // CDK overlays in unit tests (see user-menu/nav-menu specs). The open→select
    // flow runs manually + in e2e.
    const { fixture, el, httpMock } = setup();
    await settle();
    fixture.detectChanges();

    const trigger = el.querySelector('#role-trigger') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('type')).toBe('button');
    // Aria's ngCombobox applies the combobox role + the collapsed state.
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-labelledby')).toBe('role-label role-trigger');
    // An empty selection shows the placeholder label.
    expect(trigger.textContent).toContain('Select a role');
    // The role listbox is deferred behind the (closed) overlay — absent from the DOM,
    // and distinct from the inline star-rating listboxes (which use aria-labelledby).
    expect(el.querySelector('ul[aria-label="Roles"]')).toBeNull();
    expect(document.querySelector('ul[aria-label="Roles"]')).toBeNull();
    httpMock.verify();
  });

  it('renders the 404 shell when the product is missing (no guard check)', async () => {
    const { fixture, el, account, httpMock } = setup(null);
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('aec-not-found')).not.toBeNull();
    expect(el.querySelector('form')).toBeNull();
    expect(account.findMyReviewForProduct).not.toHaveBeenCalled();
    httpMock.verify();
  });

  it('discloses the length floors as persistent hint text on the title + body fields', async () => {
    const { fixture, el, httpMock } = setup();
    await showForm(fixture);

    // Both floors are stated before the user can trip them, and each field is
    // described by its hint from first render (the error id joins it on touch).
    expect(el.querySelector('#review-title-hint')?.textContent).toContain(
      'Between 5 and 100 characters',
    );
    expect(el.querySelector('#review-body-hint')?.textContent).toContain('Minimum 50 characters');
    expect(el.querySelector('#review-title-input')?.getAttribute('aria-describedby')).toBe(
      'review-title-hint',
    );
    expect(el.querySelector('#review-body')?.getAttribute('aria-describedby')).toBe(
      'review-body-hint',
    );
    httpMock.verify();
  });

  it('surfaces a per-field error once the body is touched', async () => {
    const { fixture, el, httpMock } = setup();
    await showForm(fixture);
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
    await showForm(fixture);
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
    await showForm(fixture);
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

  it('includes a trimmed reviewer_firm when the optional field is filled (AECI-284)', async () => {
    const api = makeApiMock();
    const { fixture, el, httpMock } = setup(product(), api);
    await showForm(fixture);
    clickStar(el, 'overall-label', 4);
    clickStar(el, 'onboarding-label', 5);
    setValue(fixture, '#review-title-input', 'Solid revit connector');
    setValue(
      fixture,
      '#review-body',
      'We rolled this out across three offices and the sync held up under heavy model loads.',
    );
    setValue(fixture, '#reviewer-firm', '  Acme Architects  ');
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitReview).toHaveBeenCalledTimes(1);
    expect(api.submitReview.mock.calls[0][0]).toMatchObject({ reviewer_firm: 'Acme Architects' });
    httpMock.verify();
  });

  it('omits reviewer_firm when the optional firm field is left blank', async () => {
    const api = makeApiMock();
    const { fixture, el, httpMock } = setup(product(), api);
    await showForm(fixture);
    clickStar(el, 'overall-label', 4);
    clickStar(el, 'onboarding-label', 5);
    setValue(fixture, '#review-title-input', 'Solid revit connector');
    setValue(
      fixture,
      '#review-body',
      'We rolled this out across three offices and the sync held up under heavy model loads.',
    );
    setValue(fixture, '#reviewer-firm', '   ');
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitReview).toHaveBeenCalledTimes(1);
    expect(api.submitReview.mock.calls[0][0]).not.toHaveProperty('reviewer_firm');
    httpMock.verify();
  });

  it('shows the generic retryable notice when the API call fails (non-409)', async () => {
    const api = makeApiMock(async () => {
      throw new Error('boom');
    });
    const { fixture, el, httpMock } = setup(product(), api);
    await showForm(fixture);
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
    expect(el.textContent).toContain('Please try again');
    // The generic failure must NOT be mistaken for the duplicate case.
    expect(el.textContent).not.toContain("You've already reviewed this product");
    httpMock.verify();
  });

  it('shows the specific "already reviewed" notice on a REVIEW_DUPLICATE 409', async () => {
    const api = makeApiMock(async () => {
      throw duplicate409();
    });
    const { fixture, el, httpMock } = setup(product(), api);
    await showForm(fixture);
    clickStar(el, 'overall-label', 4);
    clickStar(el, 'onboarding-label', 4);
    setValue(fixture, '#review-title-input', 'Tried to review twice');
    setValue(
      fixture,
      '#review-body',
      'I already submitted a review for this product a while ago, this is a second attempt.',
    );
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitReview).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("You've already reviewed this product");
    // Specific, not the generic retry notice.
    expect(el.textContent).not.toContain('Please try again');
    // It is a notice, not a ValidationError — the submit button stays enabled.
    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // It links the user to their existing review on /account.
    const link = [...el.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/account');
    expect(link).toBeTruthy();
    httpMock.verify();
  });

  // ── Already-reviewed guard (AECI-260) ───────────────────────────────────
  it('shows a placeholder, not the form, while the already-reviewed check runs', () => {
    // Synchronous: the async `afterNextRender` lookup has not resolved yet.
    const { el } = setup();
    // The visitor-neutral header is painted, but the form fields are gated.
    expect(el.querySelector('#review-title')).not.toBeNull();
    expect(el.querySelector('form')).toBeNull();
  });

  it('renders an already-reviewed panel (with an /account link) instead of the form', async () => {
    const account = makeAccountMock(existingReview);
    const { fixture, el, account: acc } = setup(product(), makeApiMock(), account);
    await showForm(fixture);

    expect(acc.findMyReviewForProduct).toHaveBeenCalledWith('f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(el.querySelector('form')).toBeNull();
    expect(el.textContent).toContain("You've already reviewed this product");
    const link = [...el.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/account');
    expect(link).toBeTruthy();
  });

  it('renders the form when the caller has no existing review', async () => {
    const { fixture, el } = setup(
      product(),
      makeApiMock(),
      makeAccountMock(null),
      makeAuthMock({ configured: true, hasCookie: true }),
    );
    await showForm(fixture);

    expect(el.querySelector('form')).not.toBeNull();
    expect(el.textContent).not.toContain("You've already reviewed this product");
  });

  // ── Sign-in gate ────────────────────────────────────────────────────────
  it('shows the sign-in notice (not the form) when no session cookie is present', async () => {
    const account = makeAccountMock(null);
    const {
      fixture,
      el,
      account: acc,
    } = setup(
      product(),
      makeApiMock(),
      account,
      makeAuthMock({ configured: true, hasCookie: false }),
    );
    await showForm(fixture);

    // No fillable form for a visitor with no session cookie.
    expect(el.querySelector('form')).toBeNull();
    expect(el.textContent).toContain('Sign in to leave a review');
    // The authenticated already-reviewed lookup is never reached.
    expect(acc.findMyReviewForProduct).not.toHaveBeenCalled();
    // The inline sign-in link routes to login carrying the (encoded) return path.
    const signIn = [...el.querySelectorAll('a')].find(
      (a) => a.getAttribute('href') === '/auth/login?return=%2Fproducts%2Facme-build%2Freview',
    );
    expect(signIn).toBeTruthy();
  });

  it('falls through to the form when a session cookie is present (API stays the backstop)', async () => {
    const account = makeAccountMock(null);
    const {
      fixture,
      el,
      account: acc,
    } = setup(
      product(),
      makeApiMock(),
      account,
      makeAuthMock({ configured: true, hasCookie: true }),
    );
    await showForm(fixture);

    // Cookie present → no sign-in gate; the already-reviewed lookup runs and,
    // finding none, the form renders. A stale cookie is the API's 401 to reject.
    expect(acc.findMyReviewForProduct).toHaveBeenCalledTimes(1);
    expect(el.querySelector('form')).not.toBeNull();
    expect(el.textContent).not.toContain('Sign in to leave a review');
  });

  it('falls through to the form when auth is unconfigured (graceful degradation)', async () => {
    const { fixture, el, auth } = setup(
      product(),
      makeApiMock(),
      makeAccountMock(null),
      makeAuthMock({ configured: false }),
    );
    await showForm(fixture);

    // Unconfigured env → never probes the cookie, shows the form (the API's
    // requireAuth 401 stays the backstop).
    expect(auth.hasSessionCookie).not.toHaveBeenCalled();
    expect(el.querySelector('form')).not.toBeNull();
    expect(el.textContent).not.toContain('Sign in to leave a review');
  });
});
