/**
 * AECI-1008 — `ContestQueue` logic and structural a11y.
 *
 * Asserts the load and both filters (status tabs, "Decided by"), how a row renders
 * (pair link, field label, value display per field, the owner vendor names, the
 * Linear link or "Linear issue pending"), the owner-routed read-only rows, the
 * pessimistic accept and decline calls with their badge decrement, and the two
 * 409s. Harness mirrors `claim-queue.component.spec.ts`: a macrotask `settle()`
 * drains `afterNextRender`'s async load.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminContest, DecideContestInput, ListAdminContestsResponse } from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminContestsApi } from './admin-contests-api';
import { ContestQueue } from './contest-queue';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUMMIT = { id: uuid(101), name: 'Summit Estimating' };
const PROCORE_CO = { id: uuid(102), name: 'Procore Technologies' };

function makeContest(over: Partial<AdminContest> & { id: string }): AdminContest {
  return {
    id: over.id,
    integration: over.integration ?? {
      id: uuid(1),
      name: 'Procore Sync',
      source_product: { id: uuid(11), name: 'Procore', slug: 'procore', logo_url: null },
      target_product: { id: uuid(12), name: 'Summit', slug: 'summit', logo_url: null },
      pair_path: '/products/procore/integrations/summit',
    },
    field: over.field ?? 'docs_url',
    current_value: 'current_value' in over ? over.current_value! : 'https://old.example.com',
    proposed_value: 'proposed_value' in over ? over.proposed_value! : 'https://new.example.com',
    current_label: over.current_label ?? null,
    proposed_label: over.proposed_label ?? null,
    reason: over.reason ?? 'The old link 404s.',
    routed_to: over.routed_to ?? 'aeci',
    status: over.status ?? 'open',
    submitter_vendor: over.submitter_vendor ?? SUMMIT,
    owner_vendor: 'owner_vendor' in over ? over.owner_vendor! : PROCORE_CO,
    decision_note: over.decision_note ?? null,
    decided_at: over.decided_at ?? null,
    upstream_linear_issue_id: over.upstream_linear_issue_id ?? null,
    upstream_linear_issue_url: over.upstream_linear_issue_url ?? null,
    created_at: over.created_at ?? '2026-09-18T00:00:00.000Z',
    updated_at: over.updated_at ?? '2026-09-18T00:00:00.000Z',
  };
}

interface ApiMock {
  listContests: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: AdminContest[], total = rows.length): ApiMock {
  const page: ListAdminContestsResponse = { data: rows, page: 1, perPage: 100, total };
  return {
    listContests: vi.fn(async () => structuredClone(page)),
    decide: vi.fn(async (id: string, input: DecideContestInput) =>
      makeContest({ id, status: input.decision === 'accept' ? 'accepted' : 'declined' }),
    ),
  };
}

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
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
      { provide: AdminContestsApi, useValue: api },
    ],
  });
  const store = TestBed.inject(AdminSummaryStore);
  const fixture = TestBed.createComponent(ContestQueue);
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

function typeNote(fixture: { detectChanges(): void }, root: HTMLElement, note: string): void {
  const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = note;
  textarea.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function submitForm(root: HTMLElement): void {
  (root.querySelector('form') as HTMLFormElement).dispatchEvent(
    new Event('submit', { cancelable: true }),
  );
}

describe('ContestQueue', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('loads the open AECi-routed queue by default and renders a row in full', async () => {
    const { el, api } = await setup(makeApiMock([makeContest({ id: 'k1' })]));
    expect(api.listContests).toHaveBeenCalledWith({
      status: 'open',
      routed_to: 'aeci',
      page: 1,
      perPage: 100,
    });
    const card = el.querySelector('article') as HTMLElement;
    const link = card.querySelector('h3 a');
    expect(link?.textContent?.trim()).toBe('Procore and Summit');
    expect(link?.getAttribute('href')).toBe('/products/procore/integrations/summit');
    expect(card.textContent).toContain('Procore Sync');
    expect(card.textContent).toContain('Documentation link');
    expect(card.textContent).toContain('https://old.example.com');
    expect(card.textContent).toContain('https://new.example.com');
    expect(card.textContent).toContain('The old link 404s.');
    expect(card.textContent).toContain('Summit Estimating');
    expect(card.textContent).toContain('Offered by');
    expect(card.textContent).toContain('Procore Technologies');
  });

  it('renders the pair unlinked when the payload has no pair path', async () => {
    const base = makeContest({ id: 'k1' });
    const { el } = await setup(
      makeApiMock([makeContest({ id: 'k1', integration: { ...base.integration, pair_path: '' } })]),
    );
    expect(el.querySelector('article h3 a')).toBeNull();
    expect(el.querySelector('article h3')?.textContent).toContain('Procore and Summit');
  });

  it('labels the owner field "Owner" and shows vendor names, not ids', async () => {
    const { el } = await setup(
      makeApiMock([
        makeContest({
          id: 'k1',
          field: 'owner',
          current_value: PROCORE_CO.id,
          current_label: PROCORE_CO.name,
          proposed_value: SUMMIT.id,
          proposed_label: SUMMIT.name,
        }),
        makeContest({
          id: 'k2',
          field: 'owner',
          current_value: null,
          proposed_value: null,
          owner_vendor: null,
        }),
      ]),
    );
    const [named, empty] = [...el.querySelectorAll('article')] as HTMLElement[];
    expect(named.textContent).toContain('Owner');
    expect(named.textContent).not.toContain('Builder');
    expect(named.textContent).not.toContain(SUMMIT.id);
    expect(named.querySelectorAll('dd')[1]?.textContent?.trim()).toBe('Summit Estimating');
    expect(empty.textContent).toContain('No owner on record');
    expect(empty.textContent).toContain('Neither endpoint vendor');
  });

  it('renders a stored direction against the two product names', async () => {
    const { el } = await setup(
      makeApiMock([
        makeContest({
          id: 'k1',
          field: 'direction',
          current_value: 'a_to_b',
          proposed_value: 'both',
        }),
      ]),
    );
    const card = el.querySelector('article') as HTMLElement;
    expect(card.textContent).toContain('Procore sends to Summit');
    expect(card.textContent).toContain('Syncs both ways');
    expect(card.textContent).not.toContain('a_to_b');
  });

  it('re-fetches when the status tab changes', async () => {
    const { fixture, el, api } = await setup(makeApiMock([]));
    buttonByText(el, 'Accepted').click();
    await flush(fixture);
    expect(api.listContests).toHaveBeenLastCalledWith({
      status: 'accepted',
      routed_to: 'aeci',
      page: 1,
      perPage: 100,
    });
    expect(buttonByText(el, 'Accepted').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText(el, 'Open').getAttribute('aria-pressed')).toBe('false');
  });

  it('re-fetches owner-routed rows from the "Decided by" filter', async () => {
    const { fixture, el, api } = await setup(makeApiMock([]));
    buttonByText(el, 'The owner').click();
    await flush(fixture);
    expect(api.listContests).toHaveBeenLastCalledWith({
      status: 'open',
      routed_to: 'owner',
      page: 1,
      perPage: 100,
    });
  });

  it('shows owner-routed rows read-only: "With the owner", no decision buttons', async () => {
    const { el } = await setup(makeApiMock([makeContest({ id: 'k1', routed_to: 'owner' })]));
    const card = el.querySelector('article') as HTMLElement;
    expect(card.textContent).toContain('With the owner');
    expect(card.textContent).toContain('cannot decide it');
    const labels = [...card.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).not.toContain('Accept');
    expect(labels).not.toContain('Decline');
  });

  it('explains on Accept that the live listing does not change', async () => {
    const { el } = await setup(makeApiMock([makeContest({ id: 'k1' })]));
    const accept = buttonByText(el, 'Accept');
    const helpId = accept.getAttribute('aria-describedby');
    const help = el.querySelector(`#${helpId}`);
    expect(help?.textContent).toContain('does not change the live listing');
    expect(help?.textContent).toContain('AECI-1025');
  });

  it('accepts with a note, drops the row, decrements the badge and announces', async () => {
    const { fixture, el, api, store } = await setup(makeApiMock([makeContest({ id: 'k1' })]));
    store.seed({ contests: 3 });
    buttonByText(el, 'Accept').click();
    fixture.detectChanges();
    typeNote(fixture, el, 'Confirmed on their docs site.');
    submitForm(el);
    await flush(fixture);

    expect(api.decide).toHaveBeenCalledWith('k1', {
      decision: 'accept',
      note: 'Confirmed on their docs site.',
    });
    expect(el.querySelector('article')).toBeNull();
    expect(store.pendingContests()).toBe(2);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Contest accepted');
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'The live listing has not changed',
    );
  });

  it('declines without a note (the note is optional) and sends no note key', async () => {
    const { fixture, el, api, store } = await setup(makeApiMock([makeContest({ id: 'k1' })]));
    store.seed({ contests: 1 });
    buttonByText(el, 'Decline').click();
    fixture.detectChanges();
    expect(el.textContent).toContain('Shown to the vendor that filed the contest');
    submitForm(el);
    await flush(fixture);

    expect(api.decide).toHaveBeenCalledWith('k1', { decision: 'decline' });
    expect(el.querySelector('article')).toBeNull();
    expect(store.pendingContests()).toBe(0);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Contest declined');
  });

  it('on 409 CONTEST_NOT_OPEN says "Already decided" and reloads, without decrementing', async () => {
    const api = makeApiMock([makeContest({ id: 'k1' })]);
    const { fixture, el, store } = await setup(api);
    store.seed({ contests: 4 });
    api.decide.mockRejectedValueOnce(apiError(409, 'CONTEST_NOT_OPEN'));
    api.listContests.mockResolvedValueOnce({ data: [], page: 1, perPage: 100, total: 0 });

    buttonByText(el, 'Decline').click();
    fixture.detectChanges();
    submitForm(el);
    await flush(fixture);

    expect(el.querySelector('[role="status"]')?.textContent).toContain('Already decided');
    expect(api.listContests).toHaveBeenCalledTimes(2);
    expect(el.querySelector('article')).toBeNull();
    expect(store.pendingContests()).toBe(4);
  });

  it('on 409 CONTEST_ROUTED_TO_OWNER keeps the row and says the owner decides', async () => {
    const api = makeApiMock([makeContest({ id: 'k1' })]);
    const { fixture, el } = await setup(api);
    api.decide.mockRejectedValueOnce(apiError(409, 'CONTEST_ROUTED_TO_OWNER'));

    buttonByText(el, 'Accept').click();
    fixture.detectChanges();
    submitForm(el);
    await flush(fixture);

    const alert = el.querySelector('article [role="alert"]');
    expect(alert?.textContent).toContain("The integration's owner decides this contest");
    expect(el.querySelector('article')).not.toBeNull();
  });

  it('shows a generic retryable error on any other failure', async () => {
    const api = makeApiMock([makeContest({ id: 'k1' })]);
    const { fixture, el } = await setup(api);
    api.decide.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    buttonByText(el, 'Decline').click();
    fixture.detectChanges();
    submitForm(el);
    await flush(fixture);
    expect(el.querySelector('article [role="alert"]')?.textContent).toContain('try again');
  });

  it('links the Linear issue on an accepted row, or says it is pending', async () => {
    const { el } = await setup(
      makeApiMock([
        makeContest({
          id: 'k1',
          status: 'accepted',
          decided_at: '2026-09-18T01:00:00.000Z',
          decision_note: 'Checked.',
          upstream_linear_issue_id: 'AECI-2000',
          upstream_linear_issue_url: 'https://linear.app/aeci/issue/AECI-2000',
        }),
        makeContest({ id: 'k2', status: 'accepted', decided_at: '2026-09-18T01:00:00.000Z' }),
      ]),
    );
    const [filed, pending] = [...el.querySelectorAll('article')] as HTMLElement[];
    const link = filed.querySelector('a[target="_blank"]');
    expect(link?.getAttribute('href')).toBe('https://linear.app/aeci/issue/AECI-2000');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(filed.textContent).toContain('Checked.');
    expect(pending.textContent).toContain('Linear issue pending');
    // A decided row carries no decision buttons.
    expect([...filed.querySelectorAll('button')]).toHaveLength(0);
  });

  it('shows the load-failure state with a retry', async () => {
    const api = makeApiMock([]);
    api.listContests.mockRejectedValueOnce(new Error('network'));
    const { fixture, el } = await setup(api);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
    buttonByText(el, 'Try again').click();
    await flush(fixture);
    expect(api.listContests).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('No contests match these filters.');
  });

  it('notes a capped list when the server reports more rows than were loaded', async () => {
    const { el } = await setup(makeApiMock([makeContest({ id: 'k1' })], 140));
    expect(el.textContent).toContain('Showing the first 1 of 140 contests');
  });

  it('keeps the structure axe relies on: one h2, named groups, one live region', async () => {
    const { el } = await setup(makeApiMock([makeContest({ id: 'k1' })]));
    expect(el.querySelectorAll('h2')).toHaveLength(1);
    expect(el.querySelector('h1')).toBeNull();
    const groups = [...el.querySelectorAll('[role="group"]')];
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      const label = el.querySelector(`#${g.getAttribute('aria-labelledby')}`);
      expect(label?.textContent?.trim()).toBeTruthy();
    }
    expect(el.querySelectorAll('[aria-live]')).toHaveLength(1);
    const article = el.querySelector('article')!;
    expect(el.querySelector(`#${article.getAttribute('aria-labelledby')}`)?.tagName).toBe('H3');
  });
});
