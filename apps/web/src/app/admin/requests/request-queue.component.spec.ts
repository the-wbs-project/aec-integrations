/**
 * AECI-217 / Phase 6.10 — `RequestQueue` logic + structural a11y.
 *
 * The live axe pass runs in Playwright / static-serve on rendered routes (the
 * repo's component-level a11y convention — cf. `review-queue.component.spec.ts`).
 * Here we assert the moderation logic (load, kind/status filters re-fetch, target
 * link + fallback, domain-match hint, duplicate flag, resolve one-click, reject
 * with/without an optional reason, the 422 race drop, the retryable error) and the
 * structural invariants axe relies on (heading order, the filter groups' accessible
 * names, the polite live region).
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

import { AdminRequestsApi } from './admin-requests-api';
import { RequestQueue } from './request-queue';

function makeRequest(over: Partial<AdminVendorRequest> & { id: string }): AdminVendorRequest {
  return {
    id: over.id,
    kind: over.kind ?? 'claim',
    status: over.status ?? 'open',
    target_type: over.target_type ?? 'product',
    target_id: over.target_id ?? `t-${over.id}`,
    target:
      'target' in over ? over.target! : { id: `t-${over.id}`, name: 'Procore', slug: 'procore' },
    submitter_email: over.submitter_email ?? 'submitter@vendor.test',
    submitter_name: over.submitter_name ?? 'Sam Submitter',
    submitter_role: over.submitter_role ?? 'Product Manager',
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
  const fixture = TestBed.createComponent(RequestQueue);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
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

  it('loads the open queue and renders each request in full', async () => {
    const { el, api } = await setup(
      makeApiMock([makeRequest({ id: 'r1', submitter_email: 'amy@vendor.test' })]),
    );
    expect(api.listRequests).toHaveBeenCalledWith({ status: 'open', page: 1, perPage: 100 });
    expect(el.textContent).toContain('Procore');
    expect(el.textContent).toContain('amy@vendor.test');
    expect(el.textContent).toContain('claim the listing');
    expect(el.textContent).toContain('Claim'); // kind badge
    // The target links to its product detail page (hydrated slug).
    expect(el.querySelector('article h3 a')?.getAttribute('href')).toContain('/products/procore');
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

  it('shows the domain-match hint for claims but not for corrections', async () => {
    const { el } = await setup(
      makeApiMock([
        makeRequest({ id: 'r1', kind: 'claim', domain_match: 'no_match' }),
        makeRequest({
          id: 'r2',
          kind: 'correction',
          domain_match: 'no_match',
          target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' },
        }),
      ]),
    );
    expect(cardFor(el, 'Procore').textContent).toContain('Domain mismatch');
    expect(cardFor(el, 'Bluebeam').textContent).not.toContain('Domain mismatch');
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
    expect(link!.textContent?.trim()).toBe('Tracked in Linear');
  });

  it('falls back to a non-clickable indicator when linear_issue_url is null', async () => {
    const { el } = await setup(
      makeApiMock([makeRequest({ id: 'r1', linear_issue_id: 'iss_123', linear_issue_url: null })]),
    );
    const card = cardFor(el, 'Procore');
    expect(card.querySelector('a[href*="linear.app"]')).toBeNull();
    expect(card.textContent).toContain('Tracked in Linear');
  });

  it('refetches with the kind filter and marks it aria-pressed', async () => {
    const { el, fixture, api } = await setup(makeApiMock([makeRequest({ id: 'r1' })]));
    filterButton(el, 'admin-requests-kind-label', 'Corrections').click();
    await settle();
    fixture.detectChanges();
    expect(api.listRequests).toHaveBeenLastCalledWith({
      status: 'open',
      page: 1,
      perPage: 100,
      kind: 'correction',
    });
    expect(
      filterButton(el, 'admin-requests-kind-label', 'Corrections').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('refetches with the status filter', async () => {
    const { el, fixture, api } = await setup(makeApiMock([makeRequest({ id: 'r1' })]));
    filterButton(el, 'admin-requests-status-label', 'Resolved').click();
    await settle();
    fixture.detectChanges();
    expect(api.listRequests).toHaveBeenLastCalledWith({
      status: 'resolved',
      page: 1,
      perPage: 100,
    });
  });

  it('resolves a request one-click: calls the API and drops the row', async () => {
    const api = makeApiMock([
      makeRequest({ id: 'r1' }),
      makeRequest({ id: 'r2', target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' } }),
    ]);
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Resolve').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('r1', { action: 'resolve' });
    expect(el.querySelectorAll('article')).toHaveLength(1);
    expect(el.textContent).toContain('Bluebeam');
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

  it('handles a 422 (already moderated) by dropping the row and announcing it', async () => {
    const api = makeApiMock([makeRequest({ id: 'r1' })]);
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 422 }));
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Resolve').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already moderated');
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

    it('gives the filter controls accessible group names', async () => {
      const { el } = await setup(makeApiMock([makeRequest({ id: 'r1' })]));
      const groups = [...el.querySelectorAll('[role="group"]')];
      expect(groups).toHaveLength(2);
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
