/**
 * AECI-1177 — `ReviewResponseQueue` logic and structural a11y.
 *
 * Asserts the load and the status tabs, how a card renders (product link, the
 * review in full, the reply, the vendor and author, the two warnings), which
 * buttons each status carries, the required reason on reject and remove, the
 * final confirm before a remove sends anything, the pessimistic decision calls
 * with their badge decrement, and the 409 reload.
 * Harness mirrors `contest-queue.component.spec.ts`.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminReviewResponse,
  DecideReviewResponseInput,
  ListAdminReviewResponsesResponse,
} from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminReviewResponsesApi } from './admin-review-responses-api';
import { ReviewResponseQueue } from './review-response-queue';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function makeReply(over: Partial<AdminReviewResponse> & { id: string }): AdminReviewResponse {
  return {
    status: 'pending',
    body: 'Thanks for the review. The sync bug was fixed in 2026.3.',
    rejection_reason: null,
    vendor: { id: uuid(1), slug: 'autodesk', name: 'Autodesk' },
    vendor_owns_product: true,
    author_email: 'seat@autodesk.example',
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
  listReplies: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: AdminReviewResponse[], total = rows.length): ApiMock {
  const page: ListAdminReviewResponsesResponse = { data: rows, page: 1, perPage: 100, total };
  return {
    listReplies: vi.fn(async () => structuredClone(page)),
    decide: vi.fn(async (id: string, input: DecideReviewResponseInput) =>
      makeReply({
        id,
        status:
          input.decision === 'approve'
            ? 'published'
            : input.decision === 'reject'
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
      { provide: AdminReviewResponsesApi, useValue: api },
    ],
  });
  const store = TestBed.inject(AdminSummaryStore);
  if (seed !== null) store.seed({ reviewResponses: seed });
  const fixture = TestBed.createComponent(ReviewResponseQueue);
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

describe('ReviewResponseQueue', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('loads the pending tab by default and renders a card in full', async () => {
    const { el, api } = await setup(makeApiMock([makeReply({ id: 'r1' })]));
    expect(api.listReplies).toHaveBeenCalledWith({ status: 'pending', page: 1, perPage: 100 });

    const card = el.querySelector('article') as HTMLElement;
    const heading = card.querySelector('h3')!;
    expect(card.getAttribute('aria-labelledby')).toBe(heading.id);
    const link = heading.querySelector('a');
    expect(link?.textContent?.trim()).toBe('Dynamo for Revit');
    expect(link?.getAttribute('href')).toBe('/products/dynamo-for-revit');
    expect(heading.textContent).toContain('Autodesk');

    expect(card.textContent).toContain('Powerful but the sync drops rows');
    expect(card.textContent).toContain('We lost rows on every large sync.');
    expect(card.textContent).toContain('3 of 5');
    expect(card.textContent).toContain('2 of 5');
    expect(card.textContent).toContain('Approved');
    expect(card.querySelector('[data-testid="reply-body"]')?.textContent).toContain(
      'The sync bug was fixed in 2026.3.',
    );
    expect(card.textContent).toContain('seat@autodesk.example');
    expect(card.querySelector('[data-testid="reply-warning"]')).toBeNull();
  });

  it('marks the active status tab with aria-pressed and reloads on a change', async () => {
    const { fixture, el, api } = await setup(makeApiMock([]));
    expect(buttonByText(el, 'Pending').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText(el, 'Published').getAttribute('aria-pressed')).toBe('false');
    buttonByText(el, 'Published').click();
    await flush(fixture);
    expect(api.listReplies).toHaveBeenLastCalledWith({
      status: 'published',
      page: 1,
      perPage: 100,
    });
    expect(buttonByText(el, 'Published').getAttribute('aria-pressed')).toBe('true');
    expect(el.textContent).toContain('No replies have this status.');
  });

  it('offers Approve and Reject on pending, Remove on published, and nothing otherwise', async () => {
    const { el } = await setup(
      makeApiMock([
        makeReply({ id: 'p' }),
        makeReply({ id: 'pub', status: 'published', published_at: '2026-09-02T00:00:00.000Z' }),
        makeReply({ id: 'rej', status: 'rejected', rejection_reason: 'Names the reviewer.' }),
        makeReply({ id: 'w', status: 'withdrawn' }),
        makeReply({ id: 'rm', status: 'removed', rejection_reason: 'A sales pitch.' }),
      ]),
    );
    const cards = [...el.querySelectorAll('article')] as HTMLElement[];
    const buttons = (card: HTMLElement) =>
      [...card.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons(cards[0]!)).toEqual(['Approve', 'Reject']);
    expect(buttons(cards[1]!)).toEqual(['Remove from the page']);
    expect(buttons(cards[2]!)).toEqual([]);
    expect(buttons(cards[3]!)).toEqual([]);
    expect(buttons(cards[4]!)).toEqual([]);
    // A decided row shows the reason the vendor sees.
    expect(cards[2]!.textContent).toContain('Names the reviewer.');
    expect(cards[4]!.textContent).toContain('A sales pitch.');
  });

  it('warns when the review left approved or the vendor no longer owns the product, and keeps Approve', async () => {
    const base = makeReply({ id: 'x' });
    const { el } = await setup(
      makeApiMock([
        makeReply({ id: 'a', review: { ...base.review, status: 'archived' } }),
        makeReply({ id: 'b', vendor_owns_product: false }),
      ]),
    );
    const [a, b] = [...el.querySelectorAll('article')] as HTMLElement[];
    const warnA = a!.querySelector('[data-testid="reply-warning"]')!;
    expect(warnA.textContent).toContain('The review is no longer approved');
    expect(b!.querySelector('[data-testid="reply-warning"]')?.textContent).toContain(
      'Autodesk no longer owns Dynamo for Revit',
    );
    const approve = buttonByText(a!, 'Approve');
    expect(approve.disabled).toBe(false);
    expect(approve.getAttribute('aria-describedby')).toContain(warnA.id);
  });

  it('says when the author email is unavailable', async () => {
    const { el } = await setup(makeApiMock([makeReply({ id: 'r1', author_email: null })]));
    expect(el.querySelector('article')?.textContent).toContain('Not available');
  });

  it('approves in one click, drops the row, decrements the badge and announces it', async () => {
    const { fixture, el, api, store } = await setup(makeApiMock([makeReply({ id: 'r1' })]));
    buttonByText(el, 'Approve').click();
    await flush(fixture);
    expect(api.decide).toHaveBeenCalledWith('r1', {
      decision: 'approve',
      expected_updated_at: '2026-09-01T00:00:00.000Z',
    });
    expect(el.querySelector('article')).toBeNull();
    expect(store.pendingReviewResponses()).toBe(2);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Reply approved');
  });

  it('requires a reason before it rejects, then sends the trimmed reason', async () => {
    const { fixture, el, api, store } = await setup(makeApiMock([makeReply({ id: 'r1' })]));
    buttonByText(el, 'Reject').click();
    fixture.detectChanges();

    const textarea = el.querySelector('textarea') as HTMLTextAreaElement;
    const label = el.querySelector(`label[for="${textarea.id}"]`);
    expect(label?.textContent).toContain('(required)');
    expect(textarea.required).toBe(true);

    submitForm(el);
    await flush(fixture);
    expect(api.decide).not.toHaveBeenCalled();
    const error = el.querySelector('[role="alert"]');
    expect(error?.textContent).toContain('Write a reason');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toContain(error!.id);

    typeReason(fixture, el, '  It names the reviewer.  ');
    expect(el.querySelector('[role="alert"]')).toBeNull();
    submitForm(el);
    await flush(fixture);
    expect(api.decide).toHaveBeenCalledWith('r1', {
      decision: 'reject',
      reason: 'It names the reviewer.',
      expected_updated_at: '2026-09-01T00:00:00.000Z',
    });
    expect(el.querySelector('article')).toBeNull();
    expect(store.pendingReviewResponses()).toBe(2);
  });

  it('removes a published reply only after the final confirm, without touching the pending badge', async () => {
    const api = makeApiMock([makeReply({ id: 'r1', status: 'published' })]);
    const { fixture, el, store } = await setup(api);
    buttonByText(el, 'Remove from the page').click();
    fixture.detectChanges();
    typeReason(fixture, el, '  A sales pitch.  ');
    submitForm(el);
    await flush(fixture);

    // The first submit sends nothing. It shows the confirm and locks the reason.
    expect(api.decide).not.toHaveBeenCalled();
    const confirm = el.querySelector('[data-testid="remove-confirm"]') as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(confirm.getAttribute('role')).toBe('group');
    const title = el.querySelector(`#${confirm.getAttribute('aria-labelledby')}`);
    const body = el.querySelector(`#${confirm.getAttribute('aria-describedby')}`);
    expect(title?.textContent).toContain('Remove this reply permanently?');
    expect(body?.textContent).toContain('Removal is final.');
    expect(body?.textContent).toContain('comes off the product page');
    expect(body?.textContent).toContain('Autodesk can never reply to this review again');
    expect(document.activeElement).toBe(confirm);
    expect((el.querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(hasButton(el, 'Continue to removal')).toBe(false);

    buttonByText(el, 'Remove permanently').click();
    await flush(fixture);
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledWith('r1', {
      decision: 'remove',
      reason: 'A sales pitch.',
      expected_updated_at: '2026-09-01T00:00:00.000Z',
    });
    expect(el.querySelector('article')).toBeNull();
    expect(store.pendingReviewResponses()).toBe(3);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Reply removed');
  });

  it('asks for a reason before it shows the remove confirm', async () => {
    const api = makeApiMock([makeReply({ id: 'r1', status: 'published' })]);
    const { fixture, el } = await setup(api);
    buttonByText(el, 'Remove from the page').click();
    fixture.detectChanges();
    submitForm(el);
    await flush(fixture);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Write a reason');
    expect(el.querySelector('[data-testid="remove-confirm"]')).toBeNull();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('cancels the remove confirm without a call', async () => {
    const api = makeApiMock([makeReply({ id: 'r1', status: 'published' })]);
    const { fixture, el } = await setup(api);
    buttonByText(el, 'Remove from the page').click();
    fixture.detectChanges();
    typeReason(fixture, el, 'A sales pitch.');
    submitForm(el);
    await flush(fixture);
    buttonByText(el, 'Cancel').click();
    await flush(fixture);
    expect(el.querySelector('form')).toBeNull();
    expect(el.querySelector('[data-testid="remove-confirm"]')).toBeNull();
    expect(api.decide).not.toHaveBeenCalled();
    // Reopening starts at the reason step again, not at the confirm.
    buttonByText(el, 'Remove from the page').click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="remove-confirm"]')).toBeNull();
    expect(hasButton(el, 'Continue to removal')).toBe(true);
  });

  it('goes back from the remove confirm to an editable reason without a call', async () => {
    const api = makeApiMock([makeReply({ id: 'r1', status: 'published' })]);
    const { fixture, el } = await setup(api);
    buttonByText(el, 'Remove from the page').click();
    fixture.detectChanges();
    typeReason(fixture, el, 'A sales pitch.');
    submitForm(el);
    await flush(fixture);
    buttonByText(el, 'Edit the reason').click();
    await flush(fixture);
    const textarea = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(el.querySelector('[data-testid="remove-confirm"]')).toBeNull();
    expect(textarea.readOnly).toBe(false);
    expect(document.activeElement).toBe(textarea);
    expect(api.decide).not.toHaveBeenCalled();

    typeReason(fixture, el, 'It is a sales pitch.');
    submitForm(el);
    await flush(fixture);
    expect(api.decide).not.toHaveBeenCalled();
    buttonByText(el, 'Remove permanently').click();
    await flush(fixture);
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledWith('r1', {
      decision: 'remove',
      reason: 'It is a sales pitch.',
      expected_updated_at: '2026-09-01T00:00:00.000Z',
    });
  });

  it('cancels the reason form without a call', async () => {
    const { fixture, el, api } = await setup(makeApiMock([makeReply({ id: 'r1' })]));
    buttonByText(el, 'Reject').click();
    fixture.detectChanges();
    buttonByText(el, 'Cancel').click();
    fixture.detectChanges();
    expect(el.querySelector('form')).toBeNull();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('on 409 REVIEW_RESPONSE_WRONG_STATE says "Already changed" and reloads, without decrementing', async () => {
    const api = makeApiMock([makeReply({ id: 'r1' })]);
    api.decide.mockRejectedValueOnce(apiError(409, 'REVIEW_RESPONSE_WRONG_STATE'));
    const { fixture, el, store } = await setup(api);
    buttonByText(el, 'Approve').click();
    await flush(fixture);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Already changed');
    expect(api.listReplies).toHaveBeenCalledTimes(2);
    expect(store.pendingReviewResponses()).toBe(3);
  });

  it('sends the version of the card it decided, not a stale one (§11c.7)', async () => {
    const api = makeApiMock([makeReply({ id: 'r1', updated_at: '2026-09-05T12:34:56.789Z' })]);
    const { fixture, el } = await setup(api);
    buttonByText(el, 'Approve').click();
    await flush(fixture);
    expect(api.decide).toHaveBeenCalledWith('r1', {
      decision: 'approve',
      expected_updated_at: '2026-09-05T12:34:56.789Z',
    });
  });

  it('on 409 REVIEW_RESPONSE_CHANGED says the vendor changed it and reloads the new version', async () => {
    const api = makeApiMock([makeReply({ id: 'r1' })]);
    api.decide.mockRejectedValueOnce(apiError(409, 'REVIEW_RESPONSE_CHANGED'));
    const { fixture, el, store } = await setup(api);
    // The reload returns the vendor's edited reply, still pending.
    api.listReplies.mockResolvedValueOnce({
      data: [
        makeReply({
          id: 'r1',
          body: 'The vendor rewrote this reply.',
          updated_at: '2026-09-02T00:00:00.000Z',
        }),
      ],
      page: 1,
      perPage: 100,
      total: 1,
    });
    buttonByText(el, 'Reject').click();
    fixture.detectChanges();
    typeReason(fixture, el, 'It names the reviewer.');
    submitForm(el);
    await flush(fixture);

    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'The vendor changed this reply. Read the new version before deciding.',
    );
    expect(api.listReplies).toHaveBeenCalledTimes(2);
    expect(el.querySelector('form')).toBeNull();
    const card = el.querySelector('article')!;
    expect(card.textContent).toContain('The vendor rewrote this reply.');
    expect(card.querySelector('[role="alert"]')).toBeNull();
    expect(store.pendingReviewResponses()).toBe(3);

    // The next decision names the new version.
    buttonByText(el, 'Approve').click();
    await flush(fixture);
    expect(api.decide).toHaveBeenLastCalledWith('r1', {
      decision: 'approve',
      expected_updated_at: '2026-09-02T00:00:00.000Z',
    });
  });

  it('keeps the row with an inline alert on any other failure', async () => {
    const api = makeApiMock([makeReply({ id: 'r1' })]);
    api.decide.mockRejectedValueOnce(apiError(500, 'INTERNAL'));
    const { fixture, el, store } = await setup(api);
    buttonByText(el, 'Approve').click();
    await flush(fixture);
    const card = el.querySelector('article')!;
    expect(card.querySelector('[role="alert"]')?.textContent).toContain('Nothing was changed');
    expect(store.pendingReviewResponses()).toBe(3);
  });

  it('shows the load failure with a retry', async () => {
    const api = makeApiMock([]);
    api.listReplies.mockRejectedValueOnce(new Error('offline'));
    const { fixture, el } = await setup(api);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
    buttonByText(el, 'Try again').click();
    await flush(fixture);
    expect(api.listReplies).toHaveBeenCalledTimes(2);
    expect(hasButton(el, 'Try again')).toBe(false);
  });

  it('says when the server holds more rows than were loaded', async () => {
    const { el } = await setup(makeApiMock([makeReply({ id: 'r1' })], 140));
    expect(el.textContent).toContain('Showing the first 1 of 140 replies');
  });
});
