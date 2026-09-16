/**
 * AECI-217 / Phase 6.10 — `RequestQueue` logic + structural a11y.
 *
 * The live axe pass runs in Playwright / static-serve on rendered routes (the
 * repo's component-level a11y convention — cf. `review-queue.component.spec.ts`).
 * Here we assert the moderation logic (load, status filter re-fetch, target link +
 * fallback, duplicate flag, resolve one-click, reject with/without an optional
 * reason, the badge decrement, the 422 race drop, the retryable error) and the
 * structural invariants axe relies on (heading order, the filter group's accessible
 * name, the polite live region).
 *
 * ── WHAT AECI-922 CHANGED HERE ───────────────────────────────────────────────
 * This screen is CORRECTIONS ONLY now. The kind filter is gone, the request pins
 * `kind: 'correction'`, and with it went the kind chip and the claim-only
 * domain-match hint. The reason is arithmetic, not tidying: the nav badges one
 * count per Operations screen and SUMS them on the category trigger, and
 * corrections and claims are two kinds of one `vendor_requests` table — so a
 * Requests queue that still listed claims would put every open claim into that
 * sum twice. The first test below is what pins the predicate.
 *
 * Harness mirrors `review-queue.component.spec.ts`: browser platform + a macrotask
 * `settle()` drains `afterNextRender`'s async load.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminVendorRequest, ListVendorRequestsResponse } from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminRequestsApi } from './admin-requests-api';
import { RequestQueue } from './request-queue';

function makeRequest(over: Partial<AdminVendorRequest> & { id: string }): AdminVendorRequest {
  return {
    id: over.id,
    // Corrections by default since AECI-922 — this screen asks for nothing else,
    // so a fixture defaulting to `claim` would describe a page that cannot occur.
    kind: over.kind ?? 'correction',
    status: over.status ?? 'open',
    target_type: over.target_type ?? 'product',
    target_id: over.target_id ?? `t-${over.id}`,
    target:
      'target' in over ? over.target! : { id: `t-${over.id}`, name: 'Procore', slug: 'procore' },
    submitter_email: over.submitter_email ?? 'submitter@vendor.test',
    submitter_name: over.submitter_name ?? 'Sam Submitter',
    submitter_role: over.submitter_role ?? 'Product Manager',
    submitter_linkedin_url: over.submitter_linkedin_url ?? null,
    domain_match: over.domain_match ?? 'pending',
    body: over.body ?? 'We build this product and would like to claim the listing.',
    source_url: over.source_url ?? null,
    is_duplicate: over.is_duplicate ?? false,
    // AECI-527 reviewer signal; unrendered here — AECI-521's /admin/claims owns it.
    has_auth_account: over.has_auth_account ?? null,
    linear_issue_id: over.linear_issue_id ?? null,
    linear_issue_url: over.linear_issue_url ?? null,
    created_at: over.created_at ?? '2026-06-01T00:00:00.000Z',
    resolved_at: over.resolved_at ?? null,
    resolved_by: over.resolved_by ?? null,
  };
}

interface ApiMock {
  listRequests: ReturnType<typeof vi.fn>;
  moderate: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: AdminVendorRequest[], total = rows.length): ApiMock {
  const page: ListVendorRequestsResponse = { data: rows, page: 1, perPage: 100, total };
  return {
    listRequests: vi.fn(async () => structuredClone(page)),
    moderate: vi.fn(
      async (id: string, input: { action: string }): Promise<AdminVendorRequest> =>
        makeRequest({ id, status: input.action === 'resolve' ? 'resolved' : 'rejected' }),
    ),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminRequestsApi, useValue: api },
    ],
  });
  const store = TestBed.inject(AdminSummaryStore);
  const fixture = TestBed.createComponent(RequestQueue);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, store, el: fixture.nativeElement as HTMLElement };
}

function cardFor(el: HTMLElement, targetName: string): HTMLElement {
  const article = [...el.querySelectorAll('article')].find((a) =>
    a.querySelector('h3')?.textContent?.includes(targetName),
  );
  if (!article) throw new Error(`No card for "${targetName}"`);
  return article as HTMLElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

function filterButton(el: HTMLElement, labelId: string, text: string): HTMLButtonElement {
  const group = el.querySelector(`[aria-labelledby="${labelId}"]`) as HTMLElement;
  return buttonByText(group, text);
}

describe('RequestQueue', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('loads the open CORRECTIONS queue and renders each request in full', async () => {
    const { el, api } = await setup(
      makeApiMock([makeRequest({ id: 'r1', submitter_email: 'amy@vendor.test' })]),
    );
    // The `kind` predicate is the whole point (AECI-922). Without it this screen
    // is a superset of /admin/claims and the Operations badge double-counts.
    expect(api.listRequests).toHaveBeenCalledWith({
      kind: 'correction',
      status: 'open',
      page: 1,
      perPage: 100,
    });
    expect(el.textContent).toContain('Procore');
    expect(el.textContent).toContain('amy@vendor.test');
    expect(el.textContent).toContain('claim the listing');
    // No kind chip: every row here is a correction, so a chip saying so on all of
    // them labels nothing. Scoped to the CARD — the h2 legitimately says
    // "Correction requests".
    expect(cardFor(el, 'Procore').textContent).not.toContain('Correction');
    // The target links to its product detail page (hydrated slug).
    expect(el.querySelector('article h3 a')?.getAttribute('href')).toContain('/products/procore');
  });

  it('offers no kind filter at all', async () => {
    const { el } = await setup(makeApiMock([makeRequest({ id: 'r1' })]));
    expect(el.querySelector('[aria-labelledby="admin-requests-kind-label"]')).toBeNull();
    expect(el.textContent).not.toContain('All kinds');
    // And the heading says which queue this is, rather than claiming both.
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Correction requests');
  });

  it('links a vendor target to the vendor detail page', async () => {
    const { el } = await setup(
      makeApiMock([
        makeRequest({
          id: 'r1',
          target_type: 'vendor',
          target: { id: 'v1', name: 'Autodesk', slug: 'autodesk' },
        }),
      ]),
    );
    expect(el.querySelector('article h3 a')?.getAttribute('href')).toContain('/vendors/autodesk');
  });

  it('renders a non-linked fallback when the target is missing', async () => {
    const { el } = await setup(makeApiMock([makeRequest({ id: 'r1', target: null })]));
    expect(el.querySelector('article h3 a')).toBeNull();
    expect(cardFor(el, 'Unknown product').textContent).toContain('Unknown product');
  });

  it('flags a likely duplicate', async () => {
    const { el } = await setup(makeApiMock([makeRequest({ id: 'r1', is_duplicate: true })]));
    expect(el.textContent).toContain('Possible duplicate');
  });

  // The domain-match chip left with the kind filter (AECI-922). It compared the
  // CLAIMANT's email domain to the vendor's, and a correction identifies nobody —
  // so on this screen it was always the "pending" variant, a chip that said only
  // that the check does not apply.
  it('renders no domain-match hint', async () => {
    const { el } = await setup(makeApiMock([makeRequest({ id: 'r1', domain_match: 'no_match' })]));
    const card = cardFor(el, 'Procore');
    expect(card.textContent).not.toContain('Domain mismatch');
    expect(card.textContent).not.toContain('Domain check pending');
  });

  it('renders a real Linear link when linear_issue_url is present (AECI-261)', async () => {
    const url = 'https://linear.app/aec-integrations/issue/AECI-901';
    const { el } = await setup(
      makeApiMock([makeRequest({ id: 'r1', linear_issue_id: 'iss_123', linear_issue_url: url })]),
    );
    const link = cardFor(el, 'Procore').querySelector<HTMLAnchorElement>('a[href*="linear.app"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(url);
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toContain('noopener');
    expect(link!.textContent).toContain('Tracked in Linear');
    // AECI-980: the chip carries the shared new-tab cue, so its text now also
    // holds the sr-only disclosure and a drawn arrow beside it.
    expect(link!.textContent).toContain('opens in a new tab');
    expect(link!.querySelector('svg')).not.toBeNull();
  });

  it('falls back to a non-clickable indicator when linear_issue_url is null', async () => {
    const { el } = await setup(
      makeApiMock([makeRequest({ id: 'r1', linear_issue_id: 'iss_123', linear_issue_url: null })]),
    );
    const card = cardFor(el, 'Procore');
    expect(card.querySelector('a[href*="linear.app"]')).toBeNull();
    expect(card.textContent).toContain('Tracked in Linear');
  });

  it('refetches with the status filter, and keeps the kind pinned across it', async () => {
    const { el, fixture, api } = await setup(makeApiMock([makeRequest({ id: 'r1' })]));
    filterButton(el, 'admin-requests-status-label', 'Resolved').click();
    await settle();
    fixture.detectChanges();
    expect(api.listRequests).toHaveBeenLastCalledWith({
      kind: 'correction',
      status: 'resolved',
      page: 1,
      perPage: 100,
    });
    expect(
      filterButton(el, 'admin-requests-status-label', 'Resolved').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('resolves a request one-click: calls the API and drops the row', async () => {
    const api = makeApiMock([
      makeRequest({ id: 'r1' }),
      makeRequest({ id: 'r2', target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' } }),
    ]);
    const { el, fixture, store } = await setup(api);
    store.seed({ requests: 3 });
    buttonByText(cardFor(el, 'Procore'), 'Resolve').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('r1', { action: 'resolve' });
    expect(el.querySelectorAll('article')).toHaveLength(1);
    expect(el.textContent).toContain('Bluebeam');
    // AECI-922: the nav badge ticks down without a round-trip, as the reviews
    // queue has always done.
    expect(store.pendingRequests()).toBe(2);
  });

  it('rejects with an optional reason: passes the reason and drops the row', async () => {
    const api = makeApiMock([makeRequest({ id: 'r1' })]);
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Reject').click();
    fixture.detectChanges();
    const textarea = cardFor(el, 'Procore').querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '  Not a real claim.  ';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('r1', {
      action: 'reject',
      reason: 'Not a real claim.',
    });
    expect(el.querySelector('article')).toBeNull();
  });

  it('rejects without a reason: omits the reason field', async () => {
    const api = makeApiMock([makeRequest({ id: 'r1' })]);
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Reject').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('r1', { action: 'reject' });
  });

  it('hides moderation actions on terminal (resolved/rejected) rows', async () => {
    const { el } = await setup(makeApiMock([makeRequest({ id: 'r1', status: 'resolved' })]));
    const cardButtons = [...cardFor(el, 'Procore').querySelectorAll('button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(cardButtons).not.toContain('Resolve');
    expect(cardButtons).not.toContain('Reject');
  });

  it('handles a 422 (already moderated) by dropping the row without decrementing', async () => {
    const api = makeApiMock([makeRequest({ id: 'r1' })]);
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 422 }));
    const { el, fixture, store } = await setup(api);
    store.seed({ requests: 3 });
    buttonByText(cardFor(el, 'Procore'), 'Resolve').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already moderated');
    // The admin who raced us already decremented; the count resyncs on the next
    // full visit to /admin.
    expect(store.pendingRequests()).toBe(3);
  });

  // `pending_requests` counts `open` corrections. `isActionable` also admits
  // `in_review`, a status this screen's filter cannot select today — but if it
  // ever can, moderating one must not walk the badge below the real backlog.
  it('does not decrement when the moderated row was in_review, not open', async () => {
    const api = makeApiMock([makeRequest({ id: 'r1', status: 'in_review' })]);
    const { el, fixture, store } = await setup(api);
    store.seed({ requests: 3 });
    buttonByText(cardFor(el, 'Procore'), 'Resolve').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('r1', { action: 'resolve' });
    expect(store.pendingRequests()).toBe(3);
  });

  it('keeps the row and shows a retryable alert on a generic failure', async () => {
    const api = makeApiMock([makeRequest({ id: 'r1' })]);
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Resolve').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).not.toBeNull();
    expect(cardFor(el, 'Procore').querySelector('[role="alert"]')?.textContent).toContain(
      'Something went wrong',
    );
  });

  it('renders the empty state when nothing matches', async () => {
    const { el } = await setup(makeApiMock([], 0));
    expect(el.textContent).toContain('No requests match');
    expect(el.querySelector('article')).toBeNull();
  });

  it('shows a retryable state when the initial load fails, then recovers', async () => {
    const api = makeApiMock([makeRequest({ id: 'r1' })]);
    api.listRequests.mockRejectedValueOnce(new Error('boom'));
    const { el, fixture } = await setup(api);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
    buttonByText(el, 'Try again').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelectorAll('article')).toHaveLength(1);
  });

  describe('accessibility (structural)', () => {
    it('uses a single h2 then h3 cards (no skipped levels, shell owns the h1)', async () => {
      const { el } = await setup(
        makeApiMock([
          makeRequest({ id: 'r1' }),
          makeRequest({ id: 'r2', target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' } }),
        ]),
      );
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelectorAll('h3')).toHaveLength(2);
      expect(el.querySelector('h4, h5, h6')).toBeNull();
    });

    it('gives the filter control an accessible group name', async () => {
      const { el } = await setup(makeApiMock([makeRequest({ id: 'r1' })]));
      // ONE group since AECI-922 retired the kind filter.
      const groups = [...el.querySelectorAll('[role="group"]')];
      expect(groups).toHaveLength(1);
      for (const g of groups) {
        const labelId = g.getAttribute('aria-labelledby');
        expect(labelId).toBeTruthy();
        expect(el.querySelector(`#${labelId}`)?.textContent?.trim()).toBeTruthy();
      }
    });

    it('exposes a polite live region for action outcomes', async () => {
      const { el } = await setup(makeApiMock([makeRequest({ id: 'r1' })]));
      const live = el.querySelector('[role="status"]');
      expect(live?.getAttribute('aria-live')).toBe('polite');
    });
  });
});
