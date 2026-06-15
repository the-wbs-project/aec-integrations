/**
 * AECI-218 / Phase 6.11 — `ReviewerBans` (the `/admin/reviewers` page) logic +
 * structural a11y. Asserts the list load, the unban action (calls the API, drops
 * the row, announces), the 422 race + generic-failure handling, and the
 * retry/empty states.
 *
 * Harness mirrors `review-queue.component.spec.ts`: browser platform + a macrotask
 * `settle()` drains `afterNextRender`'s async load.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BannedReviewer, ListBannedReviewersResponse } from '@aeci/shared';

import { ReviewerBans } from './reviewer-bans';
import { ReviewerBansApi } from './reviewer-bans-api';

function makeBanned(over: Partial<BannedReviewer> & { reviewer_id: string }): BannedReviewer {
  return {
    reviewer_id: over.reviewer_id,
    reviewer_email: over.reviewer_email ?? `${over.reviewer_id}@example.test`,
    banned_at: over.banned_at ?? '2026-06-10T00:00:00.000Z',
    ban_reason: over.ban_reason ?? 'Coordinated spam.',
  };
}

const ROWS = [
  makeBanned({ reviewer_id: 'rev-1', reviewer_email: 'amy@example.test' }),
  makeBanned({ reviewer_id: 'rev-2', reviewer_email: 'mike@example.test', ban_reason: null }),
];

interface BansApiMock {
  listBanned: ReturnType<typeof vi.fn>;
  ban: ReturnType<typeof vi.fn>;
}

function makeBansApiMock(rows: BannedReviewer[] = ROWS, total = rows.length): BansApiMock {
  const page: ListBannedReviewersResponse = { data: rows, page: 1, perPage: 100, total };
  return {
    listBanned: vi.fn(async () => structuredClone(page)),
    ban: vi.fn(async (id: string) => ({ reviewer_id: id, banned_at: null, ban_reason: null })),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: BansApiMock = makeBansApiMock()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: ReviewerBansApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(ReviewerBans);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function cardFor(el: HTMLElement, email: string): HTMLElement {
  const article = [...el.querySelectorAll('article')].find((a) => a.textContent?.includes(email));
  if (!article) throw new Error(`No card containing "${email}"`);
  return article as HTMLElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

describe('ReviewerBans', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('loads and renders each banned reviewer (email, reason)', async () => {
    const { el, api } = await setup();
    expect(api.listBanned).toHaveBeenCalledWith({ page: 1, perPage: 100 });
    expect(el.textContent).toContain('amy@example.test');
    expect(el.textContent).toContain('Coordinated spam.');
    expect(el.querySelectorAll('article')).toHaveLength(2);
  });

  it('unbans a reviewer: calls the API and drops the row', async () => {
    const { el, fixture, api } = await setup();
    buttonByText(cardFor(el, 'amy@example.test'), 'Unban').click();
    await settle();
    fixture.detectChanges();

    expect(api.ban).toHaveBeenCalledWith('rev-1', { action: 'unban' });
    expect(el.textContent).not.toContain('amy@example.test');
    expect(el.querySelectorAll('article')).toHaveLength(1);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('unbanned');
  });

  it('handles a 422 (already unbanned) by dropping the row quietly', async () => {
    const api = makeBansApiMock();
    api.ban.mockRejectedValueOnce(new HttpErrorResponse({ status: 422 }));
    const { el, fixture } = await setup(api);

    buttonByText(cardFor(el, 'amy@example.test'), 'Unban').click();
    await settle();
    fixture.detectChanges();

    expect(el.querySelectorAll('article')).toHaveLength(1);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already unbanned');
  });

  it('keeps the row and shows a retryable alert on a generic failure', async () => {
    const api = makeBansApiMock();
    api.ban.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const { el, fixture } = await setup(api);

    buttonByText(cardFor(el, 'amy@example.test'), 'Unban').click();
    await settle();
    fixture.detectChanges();

    expect(el.textContent).toContain('amy@example.test'); // still present
    expect(cardFor(el, 'amy@example.test').querySelector('[role="alert"]')?.textContent).toContain(
      'Something went wrong',
    );
  });

  it('shows a retryable state when the load fails, then recovers', async () => {
    const api = makeBansApiMock();
    api.listBanned.mockRejectedValueOnce(new Error('boom'));
    const { el, fixture } = await setup(api);

    expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
    buttonByText(el, 'Try again').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelectorAll('article')).toHaveLength(2);
  });

  it('renders the empty state when nobody is banned', async () => {
    const { el } = await setup(makeBansApiMock([], 0));
    expect(el.textContent).toContain('No reviewers are currently banned');
    expect(el.querySelector('article')).toBeNull();
  });
});
