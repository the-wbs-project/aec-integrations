/**
 * AECI-1613: `ReviewUpdateQueue` logic and structural a11y.
 *
 * Asserts the load and the status tabs, how a card renders (the original review
 * above the update, the toxicity badge, the warning), which buttons each status
 * carries, the required reason on reject and remove, the final confirm before a
 * remove sends anything, the badge decrement, and the 409 reload.
 * Harness mirrors `review-response-queue.component.spec.ts`.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminReviewUpdate,
  DecideReviewUpdateInput,
  ListAdminReviewUpdatesResponse,
} from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminReviewUpdatesApi } from './admin-review-updates-api';
import { ReviewUpdateQueue } from './review-update-queue';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function makeUpdate(over: Partial<AdminReviewUpdate> & { id: string }): AdminReviewUpdate {
  return {
    status: 'pending',
    body: 'The sync bug was fixed in 2026.3. Raising my rating.',
    rating_overall: 5,
    rating_onboarding: 4,
    rejection_reason: null,
    toxicity_score: 5,
    reviewer_email: 'reviewer@firm.example',
    product: { id: uuid(10), slug: 'dynamo-for-revit', name: 'Dynamo for Revit', logo_url: null },
    review: {
      id: uuid(30),
      status: 'approved',
      title: 'Powerful but the sync drops rows',
      body: 'We lost rows on every large sync.',
      rating_overall: 3,
      rating_onboarding: 2,
      created_at: '2026-08-01T00:00:00.000Z',
    },
    moderated_at: null,
    published_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

interface ApiMock {
  listUpdates: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: AdminReviewUpdate[], total = rows.length): ApiMock {
  const page: ListAdminReviewUpdatesResponse = { data: rows, page: 1, perPage: 100, total };
  return {
    listUpdates: vi.fn(async () => structuredClone(page)),
    decide: vi.fn(async (id: string, input: DecideReviewUpdateInput) =>
      makeUpdate({
        id,
        status:
          input.action === 'approve'
            ? 'approved'
            : input.action === 'reject'
              ? 'rejected'
              : 'removed',
      }),
    ),
  };
}

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock, seed: number | null = 3) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminReviewUpdatesApi, useValue: api },
    ],
  });
  const store = TestBed.inject(AdminSummaryStore);
  if (seed !== null) store.seed({ reviewUpdates: seed });
  const fixture = TestBed.createComponent(ReviewUpdateQueue);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, store, el: fixture.nativeElement as HTMLElement };
}

async function flush(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

function hasButton(root: HTMLElement, text: string): boolean {
  return [...root.querySelectorAll('button')].some((b) => b.textContent?.trim() === text);
}

function typeReason(fixture: { detectChanges(): void }, root: HTMLElement, text: string): void {
  const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function submitForm(root: HTMLElement): void {
  (root.querySelector('form') as HTMLFormElement).dispatchEvent(
    new Event('submit', { cancelable: true }),
  );
}

describe('ReviewUpdateQueue', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('loads the pending tab and stacks the original review above the update', async () => {
    const { el, api } = await setup(makeApiMock([makeUpdate({ id: 'u1' })]));

    expect(api.listUpdates).toHaveBeenCalledWith({ status: 'pending', page: 1, perPage: 100 });
    const card = el.querySelector('[data-testid="review-update-card"]') as HTMLElement;
    const original = card.querySelector('[data-testid="update-original"]') as HTMLElement;
    const update = card.querySelector('[data-testid="update-new"]') as HTMLElement;
    expect(original.querySelector('h4')!.textContent?.trim()).toBe('The original review');
    expect(update.querySelector('h4')!.textContent?.trim()).toBe('The update');
    expect(
      original.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(original.textContent).toContain('Powerful but the sync drops rows');
    expect(original.textContent).toContain('3 of 5');
    expect(update.textContent).toContain('5 of 5');
    expect(update.textContent).toContain('The sync bug was fixed');
    expect(card.querySelector('a[href="/products/dynamo-for-revit"]')).not.toBeNull();
    expect(card.textContent).toContain('reviewer@firm.example');
  });

  it('says the ratings are unchanged on a body-only update', async () => {
    const { el } = await setup(
      makeApiMock([makeUpdate({ id: 'u1', rating_overall: null, rating_onboarding: null })]),
    );
    expect(el.querySelector('[data-testid="update-new"]')!.textContent).toContain('Not changed');
  });

  it('flags a high toxicity score and labels an unscored one', async () => {
    const { el } = await setup(
      makeApiMock([
        makeUpdate({ id: 'hi', toxicity_score: 85 }),
        makeUpdate({ id: 'none', toxicity_score: null }),
      ]),
    );
    const badges = [...el.querySelectorAll('[data-testid="update-toxicity"]')];
    expect(badges[0]!.getAttribute('aria-label')).toBe('Toxicity score 85 of 100');
    expect(badges[0]!.textContent).toContain('High');
    expect(badges[1]!.getAttribute('aria-label')).toBe('Toxicity not scored');
  });

  it('warns when the review is no longer approved', async () => {
    const { el } = await setup(
      makeApiMock([
        makeUpdate({ id: 'u1', review: { ...makeUpdate({ id: 'x' }).review, status: 'archived' } }),
      ]),
    );
    expect(el.querySelector('[data-testid="update-warning"]')).not.toBeNull();
  });

  it('switches tabs, reloads with the status, and shows the right buttons', async () => {
    const api = makeApiMock([makeUpdate({ id: 'u1' })]);
    const { fixture, el } = await setup(api);
    expect(hasButton(el, 'Approve')).toBe(true);
    expect(hasButton(el, 'Reject')).toBe(true);
    expect(hasButton(el, 'Remove from the page')).toBe(false);

    const tabs = [...el.querySelectorAll('[aria-pressed]')].map((b) => b.textContent?.trim());
    expect(tabs).toEqual(['Pending', 'Approved', 'Rejected', 'Removed']);

    api.listUpdates.mockResolvedValueOnce({
      data: [makeUpdate({ id: 'u2', status: 'approved' })],
      page: 1,
      perPage: 100,
      total: 1,
    });
    buttonByText(el, 'Approved').click();
    await flush(fixture);
    expect(api.listUpdates).toHaveBeenLastCalledWith({ status: 'approved', page: 1, perPage: 100 });
    expect(buttonByText(el, 'Approved').getAttribute('aria-pressed')).toBe('true');
    expect(hasButton(el, 'Approve')).toBe(false);
    expect(hasButton(el, 'Remove from the page')).toBe(true);

    api.listUpdates.mockResolvedValueOnce({
      data: [makeUpdate({ id: 'u3', status: 'removed', rejection_reason: 'Off topic.' })],
      page: 1,
      perPage: 100,
      total: 1,
    });
    buttonByText(el, 'Removed').click();
    await flush(fixture);
    expect(hasButton(el, 'Remove from the page')).toBe(false);
    expect(hasButton(el, 'Approve')).toBe(false);
    expect(el.textContent).toContain('Off topic.');
  });

  it('approves, removes the row, decrements the badge and announces', async () => {
    const { fixture, el, api, store } = await setup(makeApiMock([makeUpdate({ id: 'u1' })]));
    buttonByText(el, 'Approve').click();
    await flush(fixture);

    expect(api.decide).toHaveBeenCalledWith('u1', { action: 'approve' });
    expect(el.querySelector('[data-testid="review-update-card"]')).toBeNull();
    expect(store.pendingReviewUpdates()).toBe(2);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Update approved.');
  });

  it('requires a reason to reject, then rejects and decrements', async () => {
    const { fixture, el, api, store } = await setup(makeApiMock([makeUpdate({ id: 'u1' })]));
    buttonByText(el, 'Reject').click();
    await flush(fixture);
    submitForm(el);
    await flush(fixture);
    expect(api.decide).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Write a reason before you confirm.');

    typeReason(fixture, el, 'Names a member of staff.');
    submitForm(el);
    await flush(fixture);
    expect(api.decide).toHaveBeenCalledWith('u1', {
      action: 'reject',
      reason: 'Names a member of staff.',
    });
    expect(store.pendingReviewUpdates()).toBe(2);
  });

  it('asks for a final confirm before a remove sends, and does not decrement', async () => {
    const api = makeApiMock([makeUpdate({ id: 'u1', status: 'approved' })]);
    const { fixture, el, store } = await setup(api);
    buttonByText(el, 'Remove from the page').click();
    await flush(fixture);
    typeReason(fixture, el, 'Describes a different product.');
    submitForm(el);
    await flush(fixture);

    expect(api.decide).not.toHaveBeenCalled();
    const confirm = el.querySelector('[data-testid="remove-confirm"]') as HTMLElement;
    expect(confirm.getAttribute('role')).toBe('group');
    expect(confirm.textContent).toContain('Removal is final.');
    expect(document.activeElement).toBe(confirm);
    expect((el.querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(true);

    buttonByText(el, 'Remove permanently').click();
    await flush(fixture);
    expect(api.decide).toHaveBeenCalledWith('u1', {
      action: 'remove',
      reason: 'Describes a different product.',
    });
    expect(store.pendingReviewUpdates()).toBe(3);
  });

  it('"Edit the reason" leaves the confirm without sending', async () => {
    const api = makeApiMock([makeUpdate({ id: 'u1', status: 'approved' })]);
    const { fixture, el } = await setup(api);
    buttonByText(el, 'Remove from the page').click();
    await flush(fixture);
    typeReason(fixture, el, 'Off topic.');
    submitForm(el);
    await flush(fixture);
    buttonByText(el, 'Edit the reason').click();
    await flush(fixture);

    expect(el.querySelector('[data-testid="remove-confirm"]')).toBeNull();
    expect((el.querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(false);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('announces and reloads on 409 REVIEW_UPDATE_WRONG_STATE, without decrementing', async () => {
    const api = makeApiMock([makeUpdate({ id: 'u1' })]);
    api.decide.mockRejectedValueOnce(apiError(409, 'REVIEW_UPDATE_WRONG_STATE'));
    const { fixture, el, store } = await setup(api);
    buttonByText(el, 'Approve').click();
    await flush(fixture);

    expect(api.listUpdates).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Already changed.');
    expect(store.pendingReviewUpdates()).toBe(3);
  });

  it('keeps the card and shows a retryable alert on any other failure', async () => {
    const api = makeApiMock([makeUpdate({ id: 'u1' })]);
    api.decide.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const { fixture, el, store } = await setup(api);
    buttonByText(el, 'Approve').click();
    await flush(fixture);

    expect(el.querySelector('[data-testid="review-update-card"]')).not.toBeNull();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Nothing was changed.');
    expect(store.pendingReviewUpdates()).toBe(3);
  });
});
