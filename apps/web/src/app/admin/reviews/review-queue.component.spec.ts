/**
 * AECI-205 / Phase 5.14 — `ReviewQueue` logic + structural a11y.
 *
 * The live axe pass runs in Playwright e2e on rendered routes (the repo's
 * component-level a11y convention — cf. `admin-shell.component.spec.ts`). Here we
 * assert the moderation logic (load, client-side sort incl. toxicity-first,
 * approve/reject, the required reject reason, the live badge decrement) and the
 * structural invariants axe relies on (heading order, the sort group's
 * accessible name, the reject field's `aria-invalid`/`aria-describedby` wiring).
 *
 * Harness mirrors `account.component.spec.ts`: browser platform + a macrotask
 * `settle()` drains `afterNextRender`'s async load and the async
 * `validateStandardSchema` resource.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminReview,
  ListPendingReviewsResponse,
  ModerateReviewResponse,
  RepeatOffenderPrompt,
} from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { ReviewerBansApi } from '../reviewers/reviewer-bans-api';
import { AdminReviewsApi } from './admin-reviews-api';
import { ReviewQueue } from './review-queue';

function makeReview(over: Partial<AdminReview> & { id: string }): AdminReview {
  return {
    id: over.id,
    product: over.product ?? { id: `p-${over.id}`, name: 'Product', slug: 'product' },
    reviewer_email: over.reviewer_email ?? 'reviewer@example.test',
    rating_overall: over.rating_overall ?? 4,
    rating_onboarding: over.rating_onboarding ?? 5,
    title: over.title ?? 'Solid add-in',
    body: over.body ?? 'We rolled this out across two studios and it has been stable since.',
    role_at_company: over.role_at_company ?? 'practitioner',
    years_using: over.years_using ?? 3,
    would_recommend: over.would_recommend ?? 'yes',
    verified_work_email: over.verified_work_email ?? true,
    locale: over.locale ?? 'en-US',
    status: over.status ?? 'pending',
    toxicity_score: over.toxicity_score ?? null,
    rejection_reason: over.rejection_reason ?? null,
    moderated_at: over.moderated_at ?? null,
    created_at: over.created_at ?? '2026-06-01T00:00:00.000Z',
  };
}

// Three rows whose four sort keys all produce DISTINCT orderings, so each sort
// assertion is unambiguous (product names are the stable label we read back).
const ALPHA = makeReview({
  id: 'a',
  product: { id: 'p-a', name: 'Alpha', slug: 'alpha' },
  toxicity_score: 20,
  created_at: '2026-06-02T00:00:00.000Z',
  reviewer_email: 'amy@example.test',
});
const CHARLIE = makeReview({
  id: 'b',
  product: { id: 'p-b', name: 'Charlie', slug: 'charlie' },
  toxicity_score: null,
  created_at: '2026-06-01T00:00:00.000Z',
  reviewer_email: 'mike@example.test',
});
const BRAVO = makeReview({
  id: 'c',
  product: { id: 'p-c', name: 'Bravo', slug: 'bravo' },
  toxicity_score: 80,
  created_at: '2026-06-03T00:00:00.000Z',
  reviewer_email: null,
});
const ROWS = [ALPHA, CHARLIE, BRAVO];

interface ApiMock {
  listPending: ReturnType<typeof vi.fn>;
  moderate: ReturnType<typeof vi.fn>;
}

interface BansApiMock {
  listBanned: ReturnType<typeof vi.fn>;
  ban: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: AdminReview[] = ROWS, total = rows.length): ApiMock {
  const page: ListPendingReviewsResponse = { data: rows, page: 1, perPage: 100, total };
  return {
    listPending: vi.fn(async () => structuredClone(page)),
    // AECI-218: the moderate response is the envelope `{ review, repeat_offender }`.
    // Default: no repeat-offender prompt (override per-test with mockResolvedValueOnce).
    moderate: vi.fn(
      async (id: string, input: { action: string }): Promise<ModerateReviewResponse> => ({
        review: {
          ...makeReview({ id }),
          status: input.action === 'approve' ? 'approved' : 'rejected',
        },
        repeat_offender: null,
      }),
    ),
  };
}

function makeBansApiMock(): BansApiMock {
  return {
    listBanned: vi.fn(async () => ({ data: [], page: 1, perPage: 100, total: 0 })),
    ban: vi.fn(async (id: string) => ({ reviewer_id: id, banned_at: null, ban_reason: null })),
  };
}

/** A reject response that triggers the repeat-offender prompt. */
function repeatOffenderEnvelope(id: string, prompt: RepeatOffenderPrompt): ModerateReviewResponse {
  return { review: { ...makeReview({ id }), status: 'rejected' }, repeat_offender: prompt };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock = makeApiMock(), bansApi: BansApiMock = makeBansApiMock()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminReviewsApi, useValue: api },
      { provide: ReviewerBansApi, useValue: bansApi },
    ],
  });
  const store = TestBed.inject(AdminSummaryStore);
  const fixture = TestBed.createComponent(ReviewQueue);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, bansApi, store, el: fixture.nativeElement as HTMLElement };
}

/** Product names of the rendered cards, in DOM order (the sort outcome). */
function productOrder(el: HTMLElement): string[] {
  return [...el.querySelectorAll('article h3 a')].map((a) => a.textContent?.trim() ?? '');
}

function cardFor(el: HTMLElement, productName: string): HTMLElement {
  const article = [...el.querySelectorAll('article')].find((a) =>
    a.querySelector('h3')?.textContent?.includes(productName),
  );
  if (!article) throw new Error(`No card for "${productName}"`);
  return article as HTMLElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

function clickSort(el: HTMLElement, label: string): void {
  const group = el.querySelector('[role="group"]') as HTMLElement;
  buttonByText(group, label).click();
}

describe('ReviewQueue', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('loads the pending queue and renders each review in full', async () => {
    const { el, api } = await setup();
    expect(api.listPending).toHaveBeenCalledWith({
      status: 'pending',
      sort: 'queue_age',
      page: 1,
      perPage: 100,
    });
    // Product, reviewer email, body, ratings, and a toxicity badge all render.
    expect(el.textContent).toContain('Alpha');
    expect(el.textContent).toContain('amy@example.test');
    expect(el.textContent).toContain('stable since');
    expect(el.textContent).toContain('Overall 4/5');
    // The product links to its detail page.
    expect(el.querySelector('article h3 a')?.getAttribute('href')).toContain('/products/');
  });

  it('defaults to toxicity high→low with null scores last', async () => {
    const { el } = await setup();
    // BRAVO(80) → ALPHA(20) → CHARLIE(null)
    expect(productOrder(el)).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('flags a high-toxicity review and labels an unscored one', async () => {
    const { el } = await setup();
    const bravo = cardFor(el, 'Bravo'); // toxicity 80 → High
    expect(bravo.textContent).toContain('High');
    expect(bravo.textContent).toContain('80');
    const charlie = cardFor(el, 'Charlie'); // toxicity null
    expect(charlie.textContent).toContain('Not scored');
  });

  it('re-sorts by queue age (oldest first)', async () => {
    const { el, fixture } = await setup();
    clickSort(el, 'Queue age');
    fixture.detectChanges();
    expect(productOrder(el)).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('re-sorts by product name', async () => {
    const { el, fixture } = await setup();
    clickSort(el, 'Product');
    fixture.detectChanges();
    expect(productOrder(el)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('re-sorts by reviewer with anonymized (null) reviewers last', async () => {
    const { el, fixture } = await setup();
    clickSort(el, 'Reviewer');
    fixture.detectChanges();
    // amy(Alpha) → mike(Charlie) → null(Bravo)
    expect(productOrder(el)).toEqual(['Alpha', 'Charlie', 'Bravo']);
  });

  it('marks the active sort with aria-pressed', async () => {
    const { el, fixture } = await setup();
    const group = el.querySelector('[role="group"]') as HTMLElement;
    expect(buttonByText(group, 'Toxicity').getAttribute('aria-pressed')).toBe('true');
    clickSort(el, 'Product');
    fixture.detectChanges();
    expect(buttonByText(group, 'Product').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText(group, 'Toxicity').getAttribute('aria-pressed')).toBe('false');
  });

  it('approves a review: calls the API, drops the row, decrements the badge', async () => {
    const { el, fixture, api, store } = await setup();
    store.seed(3);
    buttonByText(cardFor(el, 'Bravo'), 'Approve').click();
    await settle();
    fixture.detectChanges();

    expect(api.moderate).toHaveBeenCalledWith('c', { action: 'approve' });
    expect(productOrder(el)).toEqual(['Alpha', 'Charlie']);
    expect(store.pendingReviews()).toBe(2);
  });

  it('blocks reject with an empty reason and shows the wired error', async () => {
    const { el, fixture, api } = await setup();
    buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
    fixture.detectChanges();
    // Confirm without typing a reason.
    buttonByText(cardFor(el, 'Alpha'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();

    expect(api.moderate).not.toHaveBeenCalled();
    const card = cardFor(el, 'Alpha');
    const textarea = card.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    const errorId = textarea.getAttribute('aria-describedby');
    expect(errorId).toBeTruthy();
    const error = card.querySelector(`#${errorId}`);
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('clears stale validation state when the reject form is reopened on another row', async () => {
    const { el, fixture, api } = await setup();
    // Trip the error on Alpha (confirm with an empty reason marks the field touched).
    buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Alpha'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(cardFor(el, 'Alpha').querySelector('textarea')?.getAttribute('aria-invalid')).toBe(
      'true',
    );

    // Cancel, then open reject on a different row: the empty form must not carry
    // the prior row's touched/invalid state.
    buttonByText(cardFor(el, 'Alpha'), 'Cancel').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Charlie'), 'Reject').click();
    fixture.detectChanges();

    const textarea = cardFor(el, 'Charlie').querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.getAttribute('aria-invalid')).toBeNull();
    expect(textarea.getAttribute('aria-describedby')).toBeNull();
    expect(cardFor(el, 'Charlie').querySelector('[role="alert"]')).toBeNull();
    expect(api.moderate).not.toHaveBeenCalled();
  });

  it('rejects with a reason: calls the API, drops the row, decrements the badge', async () => {
    const { el, fixture, api, store } = await setup();
    store.seed(3);
    buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
    fixture.detectChanges();

    const textarea = cardFor(el, 'Alpha').querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '  Off-topic and promotional.  ';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new Event('blur'));
    await settle();
    fixture.detectChanges();

    buttonByText(cardFor(el, 'Alpha'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();

    expect(api.moderate).toHaveBeenCalledWith('a', {
      action: 'reject',
      rejection_reason: 'Off-topic and promotional.',
    });
    expect(productOrder(el)).toEqual(['Bravo', 'Charlie']);
    expect(store.pendingReviews()).toBe(2);
  });

  it('handles a 422 (already moderated) by dropping the row without decrementing', async () => {
    const api = makeApiMock();
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 422 }));
    const { el, fixture, store } = await setup(api);
    store.seed(3);

    buttonByText(cardFor(el, 'Bravo'), 'Approve').click();
    await settle();
    fixture.detectChanges();

    expect(productOrder(el)).toEqual(['Alpha', 'Charlie']);
    // The server already counted it — don't double-decrement.
    expect(store.pendingReviews()).toBe(3);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already moderated');
  });

  it('keeps the row and shows a retryable alert on a generic action failure', async () => {
    const api = makeApiMock();
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const { el, fixture } = await setup(api);

    buttonByText(cardFor(el, 'Bravo'), 'Approve').click();
    await settle();
    fixture.detectChanges();

    expect(productOrder(el)).toContain('Bravo'); // still present
    const card = cardFor(el, 'Bravo');
    expect(card.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong');
  });

  it('shows a retryable state when the initial load fails, then recovers', async () => {
    const api = makeApiMock();
    api.listPending.mockRejectedValueOnce(new Error('boom'));
    const { el, fixture } = await setup(api);

    expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
    buttonByText(el, 'Try again').click();
    await settle();
    fixture.detectChanges();
    expect(productOrder(el).length).toBe(3);
  });

  it('renders the empty state when nothing is pending', async () => {
    const { el } = await setup(makeApiMock([], 0));
    expect(el.textContent).toContain('No reviews are waiting');
    expect(el.querySelector('article')).toBeNull();
  });

  describe('AECI-218 repeat-offender prompt + ban', () => {
    const PROMPT: RepeatOffenderPrompt = {
      reviewer_id: 'rev-1',
      reviewer_email: 'amy@example.test',
      rejected_count: 3,
    };

    async function rejectWithReason(
      el: HTMLElement,
      fixture: Awaited<ReturnType<typeof setup>>['fixture'],
      productName: string,
      reason: string,
    ): Promise<void> {
      buttonByText(cardFor(el, productName), 'Reject').click();
      fixture.detectChanges();
      const textarea = cardFor(el, productName).querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = reason;
      textarea.dispatchEvent(new Event('input'));
      textarea.dispatchEvent(new Event('blur'));
      await settle();
      fixture.detectChanges();
      buttonByText(cardFor(el, productName), 'Confirm rejection').click();
      await settle();
      fixture.detectChanges();
    }

    function findButton(root: HTMLElement, text: string): HTMLButtonElement | undefined {
      return [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
        | HTMLButtonElement
        | undefined;
    }

    it('surfaces the "consider a ban" banner when a reject returns a repeat-offender', async () => {
      const api = makeApiMock();
      api.moderate.mockResolvedValueOnce(repeatOffenderEnvelope('a', PROMPT));
      const { el, fixture } = await setup(api);

      await rejectWithReason(el, fixture, 'Alpha', 'Coordinated spam.');

      expect(el.textContent).toContain('Consider a ban');
      expect(el.textContent).toContain('amy@example.test');
      expect(el.textContent).toContain('3');
      expect(findButton(el, 'Ban reviewer')).toBeTruthy();
    });

    it('does not surface the banner on an ordinary rejection', async () => {
      const { el, fixture } = await setup(); // default moderate → repeat_offender: null
      await rejectWithReason(el, fixture, 'Alpha', 'Off-topic.');
      expect(findButton(el, 'Ban reviewer')).toBeUndefined();
    });

    it('dismisses the banner without banning', async () => {
      const api = makeApiMock();
      api.moderate.mockResolvedValueOnce(repeatOffenderEnvelope('a', PROMPT));
      const { el, fixture, bansApi } = await setup(api);

      await rejectWithReason(el, fixture, 'Alpha', 'Coordinated spam.');
      findButton(el, 'Dismiss')!.click();
      fixture.detectChanges();

      expect(findButton(el, 'Ban reviewer')).toBeUndefined();
      expect(bansApi.ban).not.toHaveBeenCalled();
    });

    it('bans the reviewer from the prompt: opens the dialog and calls the API', async () => {
      const api = makeApiMock();
      api.moderate.mockResolvedValueOnce(repeatOffenderEnvelope('a', PROMPT));
      const { el, fixture, bansApi } = await setup(api);

      await rejectWithReason(el, fixture, 'Alpha', 'Coordinated spam.');

      // Click "Ban reviewer" → opens the dialog (sets the ban target).
      findButton(el, 'Ban reviewer')!.click();
      fixture.detectChanges();
      const instance = fixture.componentInstance as unknown as {
        banTarget: () => RepeatOffenderPrompt | null;
        banReasonModel: { set: (v: { reason: string }) => void };
        confirmBan: () => Promise<void>;
      };
      expect(instance.banTarget()).toEqual(PROMPT);

      // Provide the required reason and confirm.
      instance.banReasonModel.set({ reason: 'Coordinated spam ring.' });
      await settle();
      await instance.confirmBan();
      await settle();
      fixture.detectChanges();

      expect(bansApi.ban).toHaveBeenCalledWith('rev-1', {
        action: 'ban',
        reason: 'Coordinated spam ring.',
      });
      // Dialog closed + banner cleared after a successful ban.
      expect(instance.banTarget()).toBeNull();
      expect(findButton(el, 'Ban reviewer')).toBeUndefined();
    });
  });

  describe('accessibility (structural)', () => {
    it('uses a single h2 then h3 cards (no skipped levels, shell owns the h1)', async () => {
      const { el } = await setup();
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelectorAll('h3').length).toBe(ROWS.length);
      // Card titles sit at h4 (under each h3) — no jump past h3.
      expect(el.querySelector('h5, h6')).toBeNull();
    });

    it('gives the sort control an accessible group name', async () => {
      const { el } = await setup();
      const group = el.querySelector('[role="group"]');
      const labelId = group?.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      expect(el.querySelector(`#${labelId}`)?.textContent).toContain('Sort by');
    });

    it('exposes a polite live region for action outcomes', async () => {
      const { el } = await setup();
      const live = el.querySelector('[role="status"]');
      expect(live?.getAttribute('aria-live')).toBe('polite');
    });
  });
});
