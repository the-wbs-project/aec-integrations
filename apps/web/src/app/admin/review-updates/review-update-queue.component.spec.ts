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
import { Router, provideRouter } from '@angular/router';
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

async function setup(api: ApiMock, seed: number | null = 3, url = '/') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminReviewUpdatesApi, useValue: api },
    ],
  });
  if (url !== '/') await TestBed.inject(Router).navigateByUrl(url);
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
  const btn = [...root.querySelectorAll('button')]
    .filter((b) => !b.closest('form[hidden]'))
    .find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

function hasButton(root: HTMLElement, text: string): boolean {
  return [...root.querySelectorAll('button')]
    .filter((b) => !b.closest('form[hidden]'))
    .some((b) => b.textContent?.trim() === text);
}

function typeReason(fixture: { detectChanges(): void }, root: HTMLElement, text: string): void {
  const textarea = root.querySelector('form:not([hidden]) textarea') as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function submitForm(root: HTMLElement): void {
  (root.querySelector('form:not([hidden])') as HTMLFormElement).dispatchEvent(
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
    // AECI-2102: the section names are the Label role, not headings.
    expect(original.firstElementChild!.textContent?.trim()).toBe('The original review');
    expect(update.firstElementChild!.textContent?.trim()).toBe('The update');
    expect(
      original.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(original.textContent).toContain('Powerful but the sync drops rows');
    expect(original.textContent).toContain('3 of 5');
    expect(update.textContent).toContain('5 of 5');
    expect(update.textContent).toContain('The sync bug was fixed');
    expect(card.querySelector('a[href="/products/dynamo-for-revit"]')).not.toBeNull();
    // Reviewer and submitted date are columns of the summary row.
    const row = el.querySelector('[data-testid="review-update-row"]') as HTMLElement;
    expect(row.textContent).toContain('reviewer@firm.example');
    expect(row.querySelector('a[href="/products/dynamo-for-revit"]')).not.toBeNull();
  });

  it('is one table row per update, its detail opened by a named disclosure (AECI-2102)', async () => {
    const { el, fixture } = await setup(makeApiMock([makeUpdate({ id: 'u1' })]));
    const headers = [...el.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Details', 'Product', 'Reviewer', 'Toxicity', 'Submitted', 'Status']);
    const detail = el.querySelector('[data-testid="review-update-card"]') as HTMLElement;
    expect(detail.querySelector('td')?.getAttribute('colspan')).toBe(String(headers.length));
    const button = el.querySelector('button[aria-controls="update-u1-detail"]') as HTMLElement;
    expect(detail.id).toBe('update-u1-detail');
    expect(detail.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent?.trim()).toMatch(
      /^Update to a review of .+ by reviewer@firm\.example$/,
    );
    button.click();
    fixture.detectChanges();
    expect(detail.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // The status chip carries the console tone for Pending.
    const chip = el.querySelector('[data-testid="review-update-row"] .aec-chip[data-tone]');
    expect(chip?.getAttribute('data-tone')).toBe('waiting');
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

  it('labels a removed review Removed and warns (AECI-1643)', async () => {
    const { el } = await setup(
      makeApiMock([
        makeUpdate({ id: 'u1', review: { ...makeUpdate({ id: 'x' }).review, status: 'removed' } }),
      ]),
    );
    expect(el.querySelector('[data-testid="update-warning"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="update-original"]')?.textContent).toContain('Removed');
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
    const confirm = el.querySelector('form:not([hidden]) [role="group"]') as HTMLElement;
    expect(confirm.getAttribute('role')).toBe('group');
    expect(confirm.textContent).toContain('Removal is final.');
    expect(document.activeElement).toBe(confirm);
    expect((el.querySelector('form:not([hidden]) textarea') as HTMLTextAreaElement).readOnly).toBe(
      true,
    );

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

    expect(el.querySelector('form:not([hidden]) [role="group"]')).toBeNull();
    expect((el.querySelector('form:not([hidden]) textarea') as HTMLTextAreaElement).readOnly).toBe(
      false,
    );
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
  describe('AECI-2102 focus after a decision, and Escape in the reason form', () => {
    const disclosure = (el: HTMLElement, id: string) =>
      el.querySelector(`button[aria-controls="update-${id}-detail"]`) as HTMLButtonElement;
    const detail = (el: HTMLElement, id: string) =>
      el.querySelector(`[id="update-${id}-detail"]`) as HTMLElement;

    it('moves focus to the next row after a decision, then to the heading', async () => {
      const { fixture, el } = await setup(
        makeApiMock([makeUpdate({ id: 'u1' }), makeUpdate({ id: 'u2' })]),
      );
      buttonByText(detail(el, 'u1'), 'Approve').click();
      await flush(fixture);
      expect(document.activeElement).toBe(disclosure(el, 'u2'));
      buttonByText(detail(el, 'u2'), 'Approve').click();
      await flush(fixture);
      expect(document.activeElement?.id).toBe('admin-review-updates-heading');
    });

    it('moves focus to the alert after a failed decision', async () => {
      const api = makeApiMock([makeUpdate({ id: 'u1' })]);
      api.decide.mockRejectedValueOnce(apiError(500, 'INTERNAL'));
      const { fixture, el } = await setup(api);
      buttonByText(detail(el, 'u1'), 'Approve').click();
      await flush(fixture);
      const alert = el.querySelector('[id="update-u1-failed"]');
      expect(alert?.getAttribute('role')).toBe('alert');
      expect(document.activeElement).toBe(alert);
    });

    it('Escape in the reason form closes it and returns focus to its opener', async () => {
      const { fixture, el, api } = await setup(makeApiMock([makeUpdate({ id: 'u1' })]));
      buttonByText(detail(el, 'u1'), 'Reject').click();
      await flush(fixture);
      const textarea = detail(el, 'u1').querySelector(
        'form:not([hidden]) textarea',
      ) as HTMLTextAreaElement;
      expect(document.activeElement).toBe(textarea);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flush(fixture);
      expect(detail(el, 'u1').querySelector('form:not([hidden])')).toBeNull();
      expect(document.activeElement).toBe(buttonByText(detail(el, 'u1'), 'Reject'));
      expect(api.decide).not.toHaveBeenCalled();
    });

    it('Cancel at the remove confirm returns focus to Remove from the page', async () => {
      const { fixture, el } = await setup(
        makeApiMock([makeUpdate({ id: 'u1', status: 'approved' })]),
      );
      buttonByText(detail(el, 'u1'), 'Remove from the page').click();
      await flush(fixture);
      typeReason(fixture, detail(el, 'u1'), 'Breach.');
      submitForm(detail(el, 'u1'));
      await flush(fixture);
      buttonByText(detail(el, 'u1'), 'Cancel').click();
      await flush(fixture);
      expect(document.activeElement).toBe(buttonByText(detail(el, 'u1'), 'Remove from the page'));
    });
  });
});

// AECI-1949: the per-person filter and the link to the account page.
describe('ReviewUpdateQueue per-person filter (AECI-1949)', () => {
  const PERSON = '00000000-0000-4000-8000-000000000999';

  it('sends ?account= as account_id and shows the filter bar', async () => {
    const api = makeApiMock([makeUpdate({ id: 'x1', reviewer_id: PERSON })]);
    const { el } = await setup(api, 3, `/?account=${PERSON}`);
    expect(api.listUpdates).toHaveBeenCalledWith(expect.objectContaining({ account_id: PERSON }));
    const bar = el.querySelector('[data-testid="queue-account-filter"]');
    expect(bar?.textContent).toContain('Showing items by reviewer@firm.example.');
    expect(bar?.querySelector('a')?.getAttribute('href')).toBe(`/admin/users/${PERSON}`);
  });

  it('Clear filter drops the param and reloads every account', async () => {
    const api = makeApiMock([makeUpdate({ id: 'x1', reviewer_id: PERSON })]);
    const { el, fixture } = await setup(api, 3, `/?account=${PERSON}`);
    el.querySelector<HTMLButtonElement>('[data-testid="queue-account-clear"]')!.click();
    await flush(fixture);
    await flush(fixture);
    expect(api.listUpdates).toHaveBeenCalledTimes(2);
    expect(api.listUpdates.mock.calls[1]![0]).not.toHaveProperty('account_id');
    expect(el.querySelector('[data-testid="queue-account-filter"]')).toBeNull();
  });

  it('links the address to /admin/users/:id', async () => {
    const api = makeApiMock([makeUpdate({ id: 'x1', reviewer_id: PERSON })]);
    const { el } = await setup(api);
    const link = [...el.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === 'reviewer@firm.example',
    );
    expect(link?.getAttribute('href')).toBe(`/admin/users/${PERSON}`);
  });
});
