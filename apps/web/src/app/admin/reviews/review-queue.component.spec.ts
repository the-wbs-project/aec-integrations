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

import { expectTitleFirstDialog } from '../../core/testing/title-first-dialog.harness';
import { AdminSummaryStore } from '../admin-summary.store';
import { ReviewerBansApi } from '../reviewers/reviewer-bans-api';
import { AdminReviewsApi } from './admin-reviews-api';
import { ReviewQueue } from './review-queue';

function makeReview(over: Partial<AdminReview> & { id: string }): AdminReview {
  return {
    id: over.id,
    product: over.product ?? { id: `p-${over.id}`, name: 'Product', slug: 'product' },
    reviewer_email: over.reviewer_email ?? 'reviewer@example.test',
    reviewer_firm: over.reviewer_firm ?? null,
    rating_overall: over.rating_overall ?? 4,
    rating_onboarding: over.rating_onboarding ?? 5,
    title: over.title ?? 'Solid add-in',
    body: over.body ?? 'We rolled this out across two studios and it has been stable since.',
    role_at_company: over.role_at_company ?? 'practitioner',
    years_using: over.years_using ?? 3,
    would_recommend: over.would_recommend ?? 'yes',
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

/** Product names of the rendered rows, in DOM order (the sort outcome). */
function productOrder(el: HTMLElement): string[] {
  return [...el.querySelectorAll('tr[data-testid="review-row"] th a')].map(
    (a) => a.textContent?.trim() ?? '',
  );
}

/** A review's summary row (AECI-2102): product, reviewer, scores, dates, status. */
function rowFor(el: HTMLElement, productName: string): HTMLElement {
  const row = [...el.querySelectorAll('tr[data-testid="review-row"]')].find((r) =>
    r.querySelector('th')?.textContent?.includes(productName),
  );
  if (!row) throw new Error(`No row for "${productName}"`);
  return row as HTMLElement;
}

/** A review's detail row: its words, its facts and the decision. The disclosure's
 *  `aria-controls` names it, so this also proves the wiring. */
function cardFor(el: HTMLElement, productName: string): HTMLElement {
  const controls = rowFor(el, productName)
    .querySelector('[aria-controls]')
    ?.getAttribute('aria-controls');
  const detail = controls ? el.querySelector<HTMLElement>(`[id="${controls}"]`) : null;
  if (!detail) throw new Error(`No detail row for "${productName}"`);
  return detail;
}

function disclosureFor(el: HTMLElement, productName: string): HTMLButtonElement {
  return rowFor(el, productName).querySelector('button[aria-controls]') as HTMLButtonElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')]
    .filter((b) => !b.closest('form[hidden]'))
    .find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

function clickSort(el: HTMLElement, label: string): void {
  const group = el.querySelector('[aria-labelledby="admin-reviews-sort-label"]') as HTMLElement;
  buttonByText(group, label).click();
}

/** The toxicity badge button within a card (the one whose accessible name names
 *  the toxicity score — distinguishes it from Approve/Reject). */
function toxicityBadge(card: HTMLElement): HTMLButtonElement {
  const btn = [...card.querySelectorAll('button')]
    .filter((b) => !b.closest('form[hidden]'))
    .find((b) => (b.getAttribute('aria-label') ?? '').toLowerCase().includes('toxicity'));
  if (!btn) throw new Error('No toxicity badge button');
  return btn as HTMLButtonElement;
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
    expect(el.querySelector('tr[data-testid="review-row"] th a')?.getAttribute('href')).toContain(
      '/products/',
    );
  });

  it('is one table row per review, its detail opened by a named disclosure (AECI-2102)', async () => {
    const { el, fixture } = await setup();
    const table = el.querySelector('table') as HTMLTableElement;
    const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(headers).toEqual([
      'Details',
      'Product',
      'Reviewer',
      'Overall',
      'Onboarding',
      'Toxicity',
      'Submitted',
      'In queue',
      'Status',
    ]);
    // The region is labelled by the caption, and the detail cell spans every column.
    const region = el.querySelector('[role="region"]') as HTMLElement;
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(el.querySelector(`#${region.getAttribute('aria-labelledby')}`)?.tagName).toBe('CAPTION');
    const detail = cardFor(el, 'Alpha');
    expect(detail.querySelector('td')?.getAttribute('colspan')).toBe(String(headers.length));

    // Closed: hidden but present, so aria-controls always resolves.
    const button = disclosureFor(el, 'Alpha');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(detail.hidden).toBe(true);
    // The name is the same open or closed: aria-expanded carries the state.
    expect(button.textContent?.trim()).toBe('Review of Alpha by amy@example.test');

    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(detail.hidden).toBe(false);
    expect(button.textContent?.trim()).toBe('Review of Alpha by amy@example.test');
    expect(detail.textContent).toContain('stable since');
    expect(detail.textContent).toContain('Overall 4/5');

    button.click();
    fixture.detectChanges();
    expect(detail.hidden).toBe(true);
  });

  it('pages the loaded set with Previous and Next, keeping the cap note (§5.7)', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      makeReview({
        id: `r${String(i).padStart(2, '0')}`,
        product: { id: `p${i}`, name: `Product ${String(i).padStart(2, '0')}`, slug: `p${i}` },
        created_at: `2026-06-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    const { el, fixture } = await setup(makeApiMock(many, 140));
    expect(productOrder(el)).toHaveLength(25);
    // The capped-set note is unchanged: it counts the loaded set against the server total.
    expect(el.textContent).toContain('Showing the first 30 of 140 pending reviews');
    expect(el.querySelector('nav[aria-label="Pagination"]')?.textContent).toContain(
      'Page 1 of 2 · 30 rows',
    );
    buttonByText(el, 'Next').click();
    fixture.detectChanges();
    expect(productOrder(el)).toHaveLength(5);
    expect(el.querySelector('nav[aria-label="Pagination"]')?.textContent).toContain('Page 2 of 2');
    buttonByText(el, 'Previous').click();
    fixture.detectChanges();
    expect(productOrder(el)).toHaveLength(25);
  });

  it('moves focus to the next row after a decision, and to the heading when none is left', async () => {
    const { el, fixture } = await setup(makeApiMock([ALPHA, BRAVO]));
    // Toxicity order: Bravo then Alpha. Approving Bravo hands focus to Alpha's disclosure.
    buttonByText(cardFor(el, 'Bravo'), 'Approve').click();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(disclosureFor(el, 'Alpha'));

    buttonByText(cardFor(el, 'Alpha'), 'Approve').click();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('admin-reviews-heading');
  });

  it('defaults to toxicity high→low with null scores last', async () => {
    const { el } = await setup();
    // BRAVO(80) → ALPHA(20) → CHARLIE(null)
    expect(productOrder(el)).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('flags a high-toxicity review and labels an unscored one', async () => {
    const { el } = await setup();
    const bravo = rowFor(el, 'Bravo'); // toxicity 80 → High
    expect(bravo.textContent).toContain('High');
    expect(bravo.textContent).toContain('80');
    // The high score is the console's attention chip, never colour alone ("High").
    expect(bravo.querySelector('.aec-chip[data-tone="attention"]')?.textContent).toContain('High');
    const charlie = rowFor(el, 'Charlie'); // toxicity null
    expect(charlie.textContent).toContain('Not scored');
  });

  it('exposes each toxicity badge as a button whose label gives the number meaning', async () => {
    const { el } = await setup();
    const bravo = toxicityBadge(rowFor(el, 'Bravo')); // 80
    expect(bravo.tagName).toBe('BUTTON');
    expect(bravo.getAttribute('aria-label')).toContain('80');
    expect(bravo.getAttribute('aria-label')).toContain('of 100');

    const charlie = toxicityBadge(rowFor(el, 'Charlie')); // null
    expect(charlie.getAttribute('aria-label')?.toLowerCase()).toContain('not scored');
  });

  it('reveals the toxicity scale legend when a badge is opened', async () => {
    const { el, fixture } = await setup();
    toxicityBadge(rowFor(el, 'Bravo')).click();
    await settle();
    fixture.detectChanges();
    // The popover content mounts in the CDK overlay container on document.body
    // (jsdom has no Popover API, so the overlay isn't in the host element).
    expect(document.body.textContent).toContain('Toxicity score');
    expect(document.body.textContent).toContain('Normal');
    expect(document.body.textContent).toContain('High (flagged)');
    expect(document.body.textContent).toContain('never auto-rejects');
  });

  it('offers a shared toxicity-scale explainer beside the sort control', async () => {
    const { el } = await setup();
    const sortRow = (el.querySelector('[aria-labelledby="admin-reviews-sort-label"]')
      ?.parentElement ?? el) as HTMLElement;
    const info = [...sortRow.querySelectorAll('button')]
      .filter((b) => !b.closest('form[hidden]'))
      .find((b) => (b.getAttribute('aria-label') ?? '').toLowerCase().includes('toxicity'));
    expect(info).toBeTruthy();
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
    const group = el.querySelector('[aria-labelledby="admin-reviews-sort-label"]') as HTMLElement;
    expect(buttonByText(group, 'Toxicity').getAttribute('aria-pressed')).toBe('true');
    clickSort(el, 'Product');
    fixture.detectChanges();
    expect(buttonByText(group, 'Product').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText(group, 'Toxicity').getAttribute('aria-pressed')).toBe('false');
  });

  it('an Approve pressed while Reject is open is never announced as a rejection (AECI-2104)', async () => {
    const { el, fixture, api } = await setup();
    let release!: (value: ModerateReviewResponse) => void;
    api.moderate.mockImplementationOnce(
      () => new Promise<ModerateReviewResponse>((resolve) => (release = resolve)),
    );
    const card = cardFor(el, 'Alpha');
    buttonByText(card, 'Reject').click();
    fixture.detectChanges();
    buttonByText(card, 'Approve').click();
    await settle();
    fixture.detectChanges();

    // The approve is in flight. The open reject form is not busy: its confirm keeps
    // its label and its hidden status line says nothing.
    expect(api.moderate).toHaveBeenCalledWith('a', { action: 'approve' });
    expect(card.textContent).not.toContain('Rejecting…');
    expect(buttonByText(card, 'Confirm rejection')).toBeTruthy();
    const status = card.querySelector('form:not([hidden]) [role="status"]');
    expect(status?.textContent?.trim()).toBe('');
    expect(card.querySelector('form:not([hidden])')?.getAttribute('aria-busy')).toBeNull();

    release({ review: { ...makeReview({ id: 'a' }), status: 'approved' }, repeat_offender: null });
    await settle();
    fixture.detectChanges();
    expect(productOrder(el)).toEqual(['Bravo', 'Charlie']);
  });

  it('a running reject reads "Rejecting…" in its own form (AECI-2104)', async () => {
    const { el, fixture, api } = await setup();
    api.moderate.mockImplementationOnce(() => new Promise<ModerateReviewResponse>(() => {}));
    const card = cardFor(el, 'Alpha');
    buttonByText(card, 'Reject').click();
    fixture.detectChanges();
    const textarea = card.querySelector('form:not([hidden]) textarea') as HTMLTextAreaElement;
    textarea.value = 'Off-topic.';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    buttonByText(card, 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();

    const status = card.querySelector('form:not([hidden]) [role="status"]');
    expect(status?.textContent?.trim()).toBe('Rejecting…');
    expect(buttonByText(card, 'Rejecting…')).toBeTruthy();
  });

  it('approves a review: calls the API, drops the row, decrements the badge', async () => {
    const { el, fixture, api, store } = await setup();
    store.seed({ reviews: 3 });
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
    const textarea = card.querySelector('form:not([hidden]) textarea') as HTMLTextAreaElement;
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    const errorId = textarea.getAttribute('aria-describedby');
    expect(errorId).toBeTruthy();
    const error = card.querySelector(`#${errorId}`);
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('refuses a reject reason over 500 characters with the same message (AECI-2104)', async () => {
    const { el, fixture, api } = await setup();
    buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
    fixture.detectChanges();
    const card = cardFor(el, 'Alpha');
    const textarea = card.querySelector('form:not([hidden]) textarea') as HTMLTextAreaElement;
    // No native cap: the rule refuses on confirm, as the 1 to 500 schema did.
    expect(textarea.getAttribute('maxlength')).toBeNull();
    textarea.value = `  ${'x'.repeat(501)}  `;
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    buttonByText(card, 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();

    expect(api.moderate).not.toHaveBeenCalled();
    expect(card.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter a reason between 1 and 500 characters so the reviewer understands the decision.',
    );
    expect(document.activeElement).toBe(textarea);

    // Exactly 500 after trimming is accepted.
    textarea.value = `  ${'x'.repeat(500)}  `;
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    buttonByText(card, 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('a', {
      action: 'reject',
      rejection_reason: 'x'.repeat(500),
    });
  });

  it('clears stale validation state when the reject form is reopened on another row', async () => {
    const { el, fixture, api } = await setup();
    // Trip the error on Alpha (confirm with an empty reason marks the field touched).
    buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Alpha'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(
      cardFor(el, 'Alpha')
        .querySelector('form:not([hidden]) textarea')
        ?.getAttribute('aria-invalid'),
    ).toBe('true');

    // Cancel, then open reject on a different row: the empty form must not carry
    // the prior row's touched/invalid state.
    buttonByText(cardFor(el, 'Alpha'), 'Cancel').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Charlie'), 'Reject').click();
    fixture.detectChanges();

    const textarea = cardFor(el, 'Charlie').querySelector(
      'form:not([hidden]) textarea',
    ) as HTMLTextAreaElement;
    expect(textarea.getAttribute('aria-invalid')).toBeNull();
    expect(textarea.getAttribute('aria-describedby')).toBeNull();
    expect(cardFor(el, 'Charlie').querySelector('[role="alert"]')).toBeNull();
    expect(api.moderate).not.toHaveBeenCalled();
  });

  it('rejects with a reason: calls the API, drops the row, decrements the badge', async () => {
    const { el, fixture, api, store } = await setup();
    store.seed({ reviews: 3 });
    buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
    fixture.detectChanges();

    const textarea = cardFor(el, 'Alpha').querySelector(
      'form:not([hidden]) textarea',
    ) as HTMLTextAreaElement;
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
    store.seed({ reviews: 3 });

    buttonByText(cardFor(el, 'Bravo'), 'Approve').click();
    await settle();
    fixture.detectChanges();

    expect(productOrder(el)).toEqual(['Alpha', 'Charlie']);
    // The server already counted it — don't double-decrement.
    expect(store.pendingReviews()).toBe(3);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already moderated');
  });

  it('handles a 409 REVIEW_ALREADY_MODERATED (lost race) like a 422', async () => {
    const api = makeApiMock();
    api.moderate.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'REVIEW_ALREADY_MODERATED', message: 'x' } },
      }),
    );
    const { el, fixture, store } = await setup(api);
    store.seed({ reviews: 3 });

    buttonByText(cardFor(el, 'Bravo'), 'Approve').click();
    await settle();
    fixture.detectChanges();

    expect(productOrder(el)).toEqual(['Alpha', 'Charlie']);
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
    const alert = card.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Something went wrong');
    // The disabled Approve dropped focus, so it moves to the alert.
    await fixture.whenStable();
    expect(document.activeElement).toBe(alert);
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
    // One line, no table (the console recipe's empty state).
    expect(el.querySelector('table')).toBeNull();
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
      const textarea = cardFor(el, productName).querySelector(
        'form:not([hidden]) textarea',
      ) as HTMLTextAreaElement;
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
      return [...root.querySelectorAll('button')]
        .filter((b) => !b.closest('form[hidden]'))
        .find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
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

    it('opens the ban dialog as an alert dialog with focus on its title (AECI-1861)', async () => {
      const api = makeApiMock();
      api.moderate.mockResolvedValueOnce(repeatOffenderEnvelope('a', PROMPT));
      const { el, fixture } = await setup(api);

      await rejectWithReason(el, fixture, 'Alpha', 'Coordinated spam.');
      findButton(el, 'Ban reviewer')!.click();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();
      await settle();
      expectTitleFirstDialog('Ban this reviewer?');
      document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.replaceChildren());
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

    it('points at Suspend when the ban is refused as the last seat (AECI-1623)', async () => {
      const api = makeApiMock();
      api.moderate.mockResolvedValueOnce(repeatOffenderEnvelope('a', PROMPT));
      const bansApi = makeBansApiMock();
      bansApi.ban.mockRejectedValueOnce(
        new HttpErrorResponse({
          status: 409,
          error: {
            error: {
              code: 'VENDOR_LAST_SEAT_USE_SUSPEND',
              message: 'last seat',
              details: { vendor_id: 'vendor-1' },
            },
            trace_id: 't',
          },
        }),
      );
      const { el, fixture } = await setup(api, bansApi);
      await rejectWithReason(el, fixture, 'Alpha', 'Coordinated spam.');
      findButton(el, 'Ban reviewer')!.click();
      fixture.detectChanges();
      const instance = fixture.componentInstance as unknown as {
        banTarget: () => RepeatOffenderPrompt | null;
        banLastSeatVendorId: () => string | null;
        banFailed: () => boolean;
        banReasonModel: { set: (v: { reason: string }) => void };
        confirmBan: () => Promise<void>;
      };
      instance.banReasonModel.set({ reason: 'Coordinated spam ring.' });
      await settle();
      await instance.confirmBan();
      await settle();
      fixture.detectChanges();

      expect(instance.banLastSeatVendorId()).toBe('vendor-1');
      expect(instance.banFailed()).toBe(false);
      expect(instance.banTarget()).toEqual(PROMPT);
    });

    // AECI-2102: the disabled confirm drops focus, so a refused ban moves it to the alert.
    for (const [name, error, alertId] of [
      ['a failed ban', new HttpErrorResponse({ status: 500 }), 'ban-failed'],
      [
        'a last-seat refusal',
        new HttpErrorResponse({
          status: 409,
          error: {
            error: {
              code: 'VENDOR_LAST_SEAT_USE_SUSPEND',
              message: 'last seat',
              details: { vendor_id: 'vendor-1' },
            },
            trace_id: 't',
          },
        }),
        'ban-last-seat',
      ],
    ] as const) {
      it(`moves focus to the dialog's alert after ${name}`, async () => {
        const api = makeApiMock();
        api.moderate.mockResolvedValueOnce(repeatOffenderEnvelope('a', PROMPT));
        const bansApi = makeBansApiMock();
        bansApi.ban.mockRejectedValueOnce(error);
        const { el, fixture } = await setup(api, bansApi);
        await rejectWithReason(el, fixture, 'Alpha', 'Coordinated spam.');
        findButton(el, 'Ban reviewer')!.click();
        fixture.detectChanges();
        await settle();
        fixture.detectChanges();
        await settle();
        const instance = fixture.componentInstance as unknown as {
          banReasonModel: { set: (v: { reason: string }) => void };
          confirmBan: () => Promise<void>;
        };
        instance.banReasonModel.set({ reason: 'Coordinated spam ring.' });
        await settle();
        await instance.confirmBan();
        await settle();
        fixture.detectChanges();
        await fixture.whenStable();
        const alert = document.getElementById(alertId);
        expect(alert?.getAttribute('role')).toBe('alert');
        expect(document.activeElement).toBe(alert);
        document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.replaceChildren());
      });
    }
  });

  it('shows an absent decision date as a hidden-worded en dash (DESIGN.md absent value)', async () => {
    const undated = makeReview({
      id: 'u',
      product: { id: 'p-u', name: 'Undated', slug: 'undated' },
      status: 'approved',
      moderated_at: null,
    });
    const { el } = await setup(makeApiMock([undated]));
    const cells = [...rowFor(el, 'Undated').querySelectorAll('td')];
    const decided = cells.find((td) => td.textContent?.includes('–'))!;
    expect(decided.querySelector('[aria-hidden="true"]')?.textContent).toBe('–');
    expect(decided.querySelector('.sr-only')?.textContent?.trim()).toBe('Not available');
  });

  describe('AECI-2102 focus and Escape in the decision forms', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        makeReview({
          id: `r${String(i).padStart(2, '0')}`,
          product: { id: `p${i}`, name: `Product ${String(i).padStart(2, '0')}`, slug: `p${i}` },
          created_at: `2026-06-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        }),
      );

    async function drain(fixture: Awaited<ReturnType<typeof setup>>['fixture']) {
      await settle();
      fixture.detectChanges();
      await fixture.whenStable();
    }

    it('opening Reject moves focus to the reason field', async () => {
      const { el, fixture } = await setup();
      buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
      await drain(fixture);
      expect(document.activeElement).toBe(
        cardFor(el, 'Alpha').querySelector('form:not([hidden]) textarea'),
      );
    });

    it('Escape in the reject form closes it and returns focus to Reject', async () => {
      const { el, fixture, api } = await setup();
      buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
      await drain(fixture);
      const textarea = cardFor(el, 'Alpha').querySelector(
        'form:not([hidden]) textarea',
      ) as HTMLTextAreaElement;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await drain(fixture);
      expect(cardFor(el, 'Alpha').querySelector('form:not([hidden])')).toBeNull();
      expect(document.activeElement).toBe(buttonByText(cardFor(el, 'Alpha'), 'Reject'));
      expect(api.moderate).not.toHaveBeenCalled();
    });

    it('Cancel in the reject form returns focus to Reject too', async () => {
      const { el, fixture } = await setup();
      buttonByText(cardFor(el, 'Alpha'), 'Reject').click();
      await drain(fixture);
      buttonByText(cardFor(el, 'Alpha'), 'Cancel').click();
      await drain(fixture);
      expect(document.activeElement).toBe(buttonByText(cardFor(el, 'Alpha'), 'Reject'));
    });

    it('Escape in the remove form, at either step, returns focus to its opener', async () => {
      const published = makeReview({
        id: 'pub',
        product: { id: 'p-pub', name: 'Published', slug: 'published' },
        status: 'approved',
        moderated_at: '2026-06-05T00:00:00.000Z',
      });
      const { el, fixture, api } = await setup(makeApiMock([published]));
      const detail = cardFor(el, 'Published');
      buttonByText(detail, 'Remove from the page').click();
      await drain(fixture);
      const ta = detail.querySelector('form:not([hidden]) textarea') as HTMLTextAreaElement;
      expect(document.activeElement).toBe(ta);
      ta.value = 'Breach.';
      ta.dispatchEvent(new Event('input'));
      (detail.querySelector('form:not([hidden])') as HTMLFormElement).dispatchEvent(
        new Event('submit'),
      );
      await drain(fixture);
      const confirm = detail.querySelector('form:not([hidden]) [role="group"]') as HTMLElement;
      expect(document.activeElement).toBe(confirm);
      confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await drain(fixture);
      expect(detail.querySelector('form:not([hidden])')).toBeNull();
      expect(document.activeElement).toBe(buttonByText(detail, 'Remove from the page'));
      expect(api.moderate).not.toHaveBeenCalled();
    });

    it('leaves focus alone when the decided row was paged away while in flight', async () => {
      const api = makeApiMock(many(30));
      let release!: () => void;
      api.moderate.mockImplementationOnce(
        (id: string) =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                review: { ...makeReview({ id }), status: 'approved' },
                repeat_offender: null,
              });
          }),
      );
      const { el, fixture } = await setup(api);
      // Toxicity order keeps the fixture order: Product 00 is on page 1.
      buttonByText(cardFor(el, 'Product 00'), 'Approve').click();
      fixture.detectChanges();
      const next = buttonByText(el, 'Next');
      next.focus();
      next.click();
      fixture.detectChanges();
      expect(productOrder(el)).toHaveLength(5);
      release();
      await drain(fixture);
      expect(document.activeElement).toBe(next);
    });

    it('when the only row on the last page is decided, focus goes to the new last row', async () => {
      const { el, fixture } = await setup(makeApiMock(many(26)));
      buttonByText(el, 'Next').click();
      fixture.detectChanges();
      expect(productOrder(el)).toEqual(['Product 25']);
      buttonByText(cardFor(el, 'Product 25'), 'Approve').click();
      await drain(fixture);
      // Back on page 1, focus is on its LAST row, not its first.
      expect(productOrder(el)).toHaveLength(25);
      expect(document.activeElement).toBe(disclosureFor(el, 'Product 24'));
    });
  });

  describe('AECI-1643 status tabs + remove', () => {
    const PUBLISHED = makeReview({
      id: 'pub',
      product: { id: 'p-pub', name: 'Published', slug: 'published' },
      status: 'approved',
      moderated_at: '2026-06-05T00:00:00.000Z',
    });

    function statusTab(el: HTMLElement, label: string): HTMLButtonElement {
      const group = el.querySelector(
        '[aria-labelledby="admin-reviews-status-label"]',
      ) as HTMLElement;
      return buttonByText(group, label);
    }

    async function onApprovedTab() {
      const api = makeApiMock();
      const ctx = await setup(api);
      api.listPending.mockResolvedValue({ data: [PUBLISHED], page: 1, perPage: 100, total: 1 });
      api.moderate.mockImplementation(async (id: string) => ({
        review: {
          ...PUBLISHED,
          id,
          status: 'removed',
          removed_at: '2026-06-09T00:00:00.000Z',
          removal_reason: 'Breach.',
        },
        repeat_offender: null,
      }));
      statusTab(ctx.el, 'Approved').click();
      await settle();
      ctx.fixture.detectChanges();
      return ctx;
    }

    function typeReason(el: HTMLElement, text: string): void {
      const ta = el.querySelector('[data-testid="remove-form"] textarea') as HTMLTextAreaElement;
      ta.value = text;
      ta.dispatchEvent(new Event('input'));
    }

    async function submitRemove(fixture: { detectChanges(): void }, el: HTMLElement) {
      (el.querySelector('[data-testid="remove-form"] form') as HTMLFormElement).dispatchEvent(
        new Event('submit'),
      );
      await settle();
      fixture.detectChanges();
    }

    it('maps each tab to the status query, Pending first and pressed by default', async () => {
      const { el, api, fixture } = await setup();
      const tabs = [
        ...el.querySelectorAll('[aria-labelledby="admin-reviews-status-label"] button'),
      ];
      expect(tabs.map((b) => b.textContent?.trim())).toEqual([
        'Pending',
        'Approved',
        'Rejected',
        'Removed',
      ]);
      expect(tabs[0]!.getAttribute('aria-pressed')).toBe('true');
      for (const [label, status] of [
        ['Approved', 'approved'],
        ['Rejected', 'rejected'],
        ['Removed', 'removed'],
        ['Pending', 'pending'],
      ] as const) {
        statusTab(el, label).click();
        await settle();
        fixture.detectChanges();
        expect(api.listPending).toHaveBeenLastCalledWith(expect.objectContaining({ status }));
        expect(statusTab(el, label).getAttribute('aria-pressed')).toBe('true');
      }
    });

    it('an approved card carries Remove only; a pending card never does', async () => {
      const { el } = await setup();
      const pendingCard = cardFor(el, 'Alpha');
      expect(() => buttonByText(pendingCard, 'Remove from the page')).toThrow();

      const ctx = await onApprovedTab();
      const card = cardFor(ctx.el, 'Published');
      expect(buttonByText(card, 'Remove from the page')).toBeTruthy();
      expect(() => buttonByText(card, 'Approve')).toThrow();
      expect(() => buttonByText(card, 'Reject')).toThrow();
      const status = rowFor(ctx.el, 'Published').querySelector('[data-testid="review-status"]');
      expect(status?.textContent?.trim()).toBe('Approved');
      // The console tone for Approved, with the word carrying the state.
      expect(status?.querySelector('.aec-chip')?.getAttribute('data-tone')).toBe('positive');
    });

    it('remove needs a reason, then a deliberate confirm, before the PATCH', async () => {
      const { el, api, fixture, store } = await onApprovedTab();
      store.decrement = vi.fn();
      buttonByText(cardFor(el, 'Published'), 'Remove from the page').click();
      fixture.detectChanges();

      // Empty reason: blocked, error wired to the field.
      await submitRemove(fixture, el);
      const ta = el.querySelector('[data-testid="remove-form"] textarea') as HTMLTextAreaElement;
      expect(ta.getAttribute('aria-invalid')).toBe('true');
      const error = el.querySelector('[data-testid="remove-form"] [role="alert"]') as HTMLElement;
      expect(error.textContent).toContain('Write a reason before you confirm.');
      expect(ta.getAttribute('aria-describedby')).toContain(error.id);
      expect(api.moderate).not.toHaveBeenCalled();

      // First submit with a reason only shows the confirm and locks the reason.
      typeReason(el, '  Breaches the conflict-of-interest rule. ');
      fixture.detectChanges();
      await submitRemove(fixture, el);
      expect(el.querySelector('form:not([hidden]) [role="group"]')).not.toBeNull();
      expect(ta.readOnly).toBe(true);
      expect(api.moderate).not.toHaveBeenCalled();

      // "Remove permanently" sends it, trimmed.
      buttonByText(el, 'Remove permanently').click();
      await settle();
      fixture.detectChanges();
      expect(api.moderate).toHaveBeenCalledWith('pub', {
        action: 'remove',
        rejection_reason: 'Breaches the conflict-of-interest rule.',
      });
      // The row leaves the Approved tab; the pending badge does not move.
      expect(productOrder(el)).toEqual([]);
      expect(store.decrement).not.toHaveBeenCalled();
      expect(el.querySelector('[role="status"]')?.textContent).toContain('Review removed');
    });

    it('Edit the reason unlocks the field and sends nothing', async () => {
      const { el, api, fixture } = await onApprovedTab();
      buttonByText(cardFor(el, 'Published'), 'Remove from the page').click();
      fixture.detectChanges();
      typeReason(el, 'Breach.');
      fixture.detectChanges();
      await submitRemove(fixture, el);
      buttonByText(el, 'Edit the reason').click();
      fixture.detectChanges();
      expect(el.querySelector('form:not([hidden]) [role="group"]')).toBeNull();
      const ta = el.querySelector('[data-testid="remove-form"] textarea') as HTMLTextAreaElement;
      expect(ta.readOnly).toBe(false);
      expect(api.moderate).not.toHaveBeenCalled();
    });

    it('a removed card shows its removal date and reason, and no actions', async () => {
      const api = makeApiMock();
      const ctx = await setup(api);
      api.listPending.mockResolvedValue({
        data: [
          {
            ...PUBLISHED,
            status: 'removed',
            removed_at: '2026-06-09T00:00:00.000Z',
            removal_reason: 'Paid placement in disguise.',
          },
        ],
        page: 1,
        perPage: 100,
        total: 1,
      });
      statusTab(ctx.el, 'Removed').click();
      await settle();
      ctx.fixture.detectChanges();
      const card = cardFor(ctx.el, 'Published');
      expect(card.querySelector('[data-testid="review-reason"]')?.textContent).toContain(
        'Paid placement in disguise.',
      );
      expect(card.textContent).toContain('Removed');
      expect(card.textContent).toContain('2026');
      expect(card.querySelectorAll('button').length).toBe(0); // no decision on a removed review
      // On a decided tab the date column reads "Decided".
      expect(
        [...ctx.el.querySelectorAll('thead th')].map((th) => th.textContent?.trim()),
      ).toContain('Decided');
    });
  });

  describe('accessibility (structural)', () => {
    it('uses a single h2 (the shell owns the h1); rows are table rows, not headings', async () => {
      const { el } = await setup();
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelector('h3, h4, h5, h6')).toBeNull();
      // Each row's identity cell is a row header.
      expect(el.querySelectorAll('tbody th[scope="row"]')).toHaveLength(ROWS.length);
    });

    it('gives the status tabs and the sort control accessible group names', async () => {
      const { el } = await setup();
      const groups = [...el.querySelectorAll('[role="group"]')];
      const names = groups.map(
        (g) => el.querySelector(`#${g.getAttribute('aria-labelledby')}`)?.textContent?.trim() ?? '',
      );
      expect(names).toEqual(['Status', 'Sort by']);
    });

    it('exposes a polite live region for action outcomes', async () => {
      const { el } = await setup();
      const live = el.querySelector('[role="status"]');
      expect(live?.getAttribute('aria-live')).toBe('polite');
    });
  });
});
