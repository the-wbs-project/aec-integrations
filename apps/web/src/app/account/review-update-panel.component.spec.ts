import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountReview, AccountReviewUpdate } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { AccountApi } from './account-api';
import { ReviewUpdatePanel } from './review-update-panel';

/**
 * AECI-1613: the "Add an update" panel on one `/account` review row. Covers when
 * the button shows, the client validation (body bounds, both ratings or
 * neither), the submit payload and analytics, and the error mapping.
 */

const REVIEW_ID = '00000000-0000-4000-8000-000000000101';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000201';
const LONG_BODY = 'The vendor shipped the fix for the export. It works on every model we tried.';

function makeUpdate(over: Partial<AccountReviewUpdate> = {}): AccountReviewUpdate {
  return {
    id: '00000000-0000-4000-8000-000000000301',
    status: 'pending',
    body: LONG_BODY,
    rating_overall: null,
    rating_onboarding: null,
    rejection_reason: null,
    published_at: null,
    moderated_at: null,
    created_at: '2026-10-05T10:00:00.000Z',
    ...over,
  };
}

function makeReview(over: Partial<AccountReview> = {}): AccountReview {
  return {
    id: REVIEW_ID,
    product: { id: PRODUCT_ID, name: 'Dynamo for Revit', slug: 'dynamo-for-revit' },
    rating_overall: 3,
    rating_onboarding: 3,
    title: 'Good, with gaps',
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-09-01T10:00:00.000Z',
    updates: [],
    ...over,
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

let submitSpy: ReturnType<typeof vi.fn>;
let analyticsSpy: ReturnType<typeof vi.fn>;

async function setup(review: AccountReview) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AccountApi, useValue: { submitReviewUpdate: submitSpy } },
      { provide: Analytics, useValue: { reviewUpdateSubmitted: analyticsSpy } },
    ],
  });
  const fixture = TestBed.createComponent(ReviewUpdatePanel);
  fixture.componentRef.setInput('review', review);
  const emitted: AccountReviewUpdate[] = [];
  fixture.componentInstance.submitted.subscribe((u) => emitted.push(u));
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, emitted };
}

async function render(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
}

function button(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

async function openForm(fixture: ComponentFixture<unknown>, el: HTMLElement): Promise<void> {
  button(el, 'Add an update')!.click();
  await render(fixture);
}

async function typeBody(fixture: ComponentFixture<unknown>, el: HTMLElement, value: string) {
  const textarea = el.querySelector('textarea')!;
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
  await render(fixture);
}

async function toggleRerate(fixture: ComponentFixture<unknown>, el: HTMLElement) {
  const box = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
  await render(fixture);
}

function clickStar(el: HTMLElement, which: 'overall' | 'onboarding', n: number) {
  const listbox = el.querySelector(`[id="review-${REVIEW_ID}-update-${which}"]`)!;
  const option = listbox.querySelectorAll('[role="option"]')[n - 1] as HTMLElement;
  option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function submit(fixture: ComponentFixture<unknown>, el: HTMLElement) {
  el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await render(fixture);
}

function apiError(status: number, code?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: code ? { error: { code, message: 'x' } } : null,
  });
}

describe('ReviewUpdatePanel', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    submitSpy = vi.fn(async () => ({ update: makeUpdate() }));
    analyticsSpy = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('offers "Add an update" on an approved review only', async () => {
    const approved = await setup(makeReview());
    expect(button(approved.el, 'Add an update')).toBeDefined();

    for (const status of ['pending', 'rejected'] as const) {
      TestBed.resetTestingModule();
      const { el } = await setup(makeReview({ status }));
      expect(button(el, 'Add an update')).toBeUndefined();
    }
  });

  it('hides "Add an update" while an update is pending, and lists it with its badge', async () => {
    const { el } = await setup(makeReview({ updates: [makeUpdate()] }));

    expect(button(el, 'Add an update')).toBeUndefined();
    const rows = el.querySelectorAll('[data-testid="account-review-update"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Pending review');
    expect(rows[0]!.textContent).toContain(LONG_BODY);
  });

  it('shows a rejected update with its reason, and offers a new update', async () => {
    const { el } = await setup(
      makeReview({
        updates: [makeUpdate({ status: 'rejected', rejection_reason: 'Names a person.' })],
      }),
    );

    const row = el.querySelector('[data-testid="account-review-update"]')!;
    expect(row.textContent).toContain('Not published');
    expect(row.textContent).toContain('Names a person.');
    expect(button(el, 'Add an update')).toBeDefined();
  });

  it('refuses a body under 50 characters without calling the API', async () => {
    const { fixture, el } = await setup(makeReview());
    await openForm(fixture, el);
    await typeBody(fixture, el, 'Too short.');
    await submit(fixture, el);

    expect(submitSpy).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Write at least 50 characters.');
    expect(el.querySelector('textarea')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('counts the trimmed characters', async () => {
    const { fixture, el } = await setup(makeReview());
    await openForm(fixture, el);
    await typeBody(fixture, el, '  hello  ');

    expect(el.querySelector('[data-testid="review-update-counter"]')!.textContent).toContain(
      '5 of 2000 characters',
    );
  });

  it('sends a body-only update with no ratings, then fires analytics without text', async () => {
    const { fixture, el, emitted } = await setup(makeReview());
    await openForm(fixture, el);
    await typeBody(fixture, el, `  ${LONG_BODY}  `);
    await submit(fixture, el);

    expect(submitSpy).toHaveBeenCalledWith(REVIEW_ID, { body: LONG_BODY });
    expect(analyticsSpy).toHaveBeenCalledWith({ product_id: PRODUCT_ID, rerated: false });
    expect(emitted).toHaveLength(1);
    expect(el.querySelector('[data-testid="review-update-form"]')).toBeNull();
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Update sent.');
  });

  it('reveals both star inputs behind "Update my ratings" and needs both', async () => {
    const { fixture, el } = await setup(makeReview());
    await openForm(fixture, el);
    expect(el.querySelector('[data-testid="review-update-ratings"]')).toBeNull();

    await toggleRerate(fixture, el);
    expect(el.querySelector('[data-testid="review-update-ratings"]')).not.toBeNull();
    await typeBody(fixture, el, LONG_BODY);
    clickStar(el, 'overall', 5);
    await render(fixture);
    await submit(fixture, el);

    expect(submitSpy).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Select a new onboarding rating');
    expect(el.textContent).not.toContain('Select a new overall rating');
  });

  it('asks for both ratings when re-rate is ticked and neither is chosen', async () => {
    const { fixture, el } = await setup(makeReview());
    await openForm(fixture, el);
    await toggleRerate(fixture, el);
    await typeBody(fixture, el, LONG_BODY);
    await submit(fixture, el);

    expect(submitSpy).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Select a new overall rating');
    expect(el.textContent).toContain('Select a new onboarding rating');
  });

  it('sends both ratings when re-rated', async () => {
    const { fixture, el } = await setup(makeReview());
    await openForm(fixture, el);
    await toggleRerate(fixture, el);
    await typeBody(fixture, el, LONG_BODY);
    clickStar(el, 'overall', 5);
    clickStar(el, 'onboarding', 4);
    await render(fixture);
    await submit(fixture, el);

    expect(submitSpy).toHaveBeenCalledWith(REVIEW_ID, {
      body: LONG_BODY,
      rating_overall: 5,
      rating_onboarding: 4,
    });
    expect(analyticsSpy).toHaveBeenCalledWith({ product_id: PRODUCT_ID, rerated: true });
  });

  it.each([
    [apiError(409, 'REVIEW_UPDATE_PENDING'), 'You already have an update waiting'],
    [apiError(403, 'REVIEW_BANNED'), 'can no longer post reviews or updates'],
    [apiError(403, 'VENDOR_SUSPENDED'), 'vendor account is suspended'],
    [apiError(429, 'RATE_LIMITED'), 'too many submissions'],
    [apiError(404, 'NOT_FOUND'), "couldn't find this review"],
    [apiError(400, 'VALIDATION_FAILED'), 'Check your update and try again.'],
    [apiError(500), 'Something went wrong sending your update.'],
  ])('maps a failed submit to friendly copy (%#)', async (err, copy) => {
    submitSpy.mockRejectedValueOnce(err);
    const { fixture, el, emitted } = await setup(makeReview());
    await openForm(fixture, el);
    await typeBody(fixture, el, LONG_BODY);
    await submit(fixture, el);

    const alert = el.querySelector('[data-testid="review-update-error"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain(copy);
    // The form stays open with the text kept, and nothing was emitted or tracked.
    expect(el.querySelector('textarea')!.value).toBe(LONG_BODY);
    expect(emitted).toHaveLength(0);
    expect(analyticsSpy).not.toHaveBeenCalled();
  });
});
