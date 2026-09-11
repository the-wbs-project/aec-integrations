/**
 * `SubscriberList` (`/admin/subscribers`) — AECI-859.
 *
 * Four groups earn their keep:
 *
 *  1. **Empty and "no matches" are different sentences.** A list nobody has ever
 *     joined is a state of the product; a filter that matched nothing is a state
 *     of the query. Collapsing them would tell an operator who mistyped a search
 *     that the business has no subscribers, so the two branches are asserted
 *     separately rather than as "shows something".
 *  2. **The lifetime stocks do not narrow with the filter.** They come from the
 *     response's `subscribers` block, not from `total`, precisely so selecting
 *     "Unsubscribed" cannot rewrite the count of people who are still on the list.
 *  3. **The two sort keys have different natural directions.** Signup date opens
 *     newest-first, email opens A-to-Z. A shared default would be wrong for one
 *     of them, and the arrow has to match what the server will actually do.
 *  4. **There is no opt-out control, and must never be one.** The only writer of
 *     `unsubscribed_at` is the subscriber via the tokenized endpoint (AECI-537).
 *     Asserted so a later PR cannot quietly add an operator button that suppresses
 *     a consent record nobody asked to suppress.
 */

import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSubscriberRow, AdminSubscribersResponse } from '@aeci/shared';

import { AdminSubscribersApi } from './admin-subscribers-api';
import { SubscriberList } from './subscriber-list';

function makeRow(over: Partial<AdminSubscriberRow> = {}): AdminSubscriberRow {
  return {
    id: 1,
    email: 'dana@acme.com',
    created_at: '2026-08-01T10:00:00.000Z',
    unsubscribed_at: null,
    status: 'active',
    utm_source: 'linkedin',
    utm_medium: 'social',
    utm_campaign: 'launch',
    referrer: 'https://www.linkedin.com/feed',
    country: 'US',
    region: 'California',
    city: 'San Francisco',
    as_organization: 'Comcast Cable',
    ...over,
  };
}

function makePage(over: Partial<AdminSubscribersResponse> = {}): AdminSubscribersResponse {
  return {
    data: [makeRow()],
    page: 1,
    perPage: 24,
    total: 1,
    generated_at: '2026-08-11T05:00:00.000Z',
    source: 'live',
    notes: [],
    subscribers: { active: 1, unsubscribed: 0, total_ever: 1, churn_rate: 0 },
    ...over,
  };
}

interface ApiMock {
  listSubscribers: ReturnType<typeof vi.fn>;
}

function makeApiMock(page: AdminSubscribersResponse = makePage()): ApiMock {
  return { listSubscribers: vi.fn(async () => structuredClone(page)) };
}

/** Drains `afterNextRender`'s async load. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function bodyRows(el: HTMLElement): HTMLTableRowElement[] {
  return [...el.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

/** The header cell whose text starts with this label. */
function header(el: HTMLElement, label: string): HTMLTableCellElement | undefined {
  return [...el.querySelectorAll<HTMLTableCellElement>('thead th')].find((th) =>
    th.textContent?.trim().startsWith(label),
  );
}

async function setup(api: ApiMock = makeApiMock()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminSubscribersApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(SubscriberList);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => vi.restoreAllMocks());

describe('SubscriberList', () => {
  it('lists the address and the day they signed up', async () => {
    const { el } = await setup();

    expect(el.textContent).toContain('dana@acme.com');
    expect(el.textContent).toContain('Aug 1, 2026');
  });

  it('asks for everyone, newest first, on first load', async () => {
    const { api } = await setup();

    expect(api.listSubscribers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, sort: 'created_at', order: 'desc' }),
    );
    // `status` is omitted rather than sent as `all` — the API defaults to it, and
    // sending it would put a redundant parameter on every request.
    expect(api.listSubscribers.mock.calls[0]?.[0]).not.toHaveProperty('status');
  });

  it('marks an unsubscribed person and dates the opt-out', async () => {
    const { el } = await setup(
      makeApiMock(
        makePage({
          data: [makeRow({ status: 'unsubscribed', unsubscribed_at: '2026-08-07T09:00:00.000Z' })],
          subscribers: { active: 0, unsubscribed: 1, total_ever: 1, churn_rate: 1 },
        }),
      ),
    );

    expect(el.textContent).toContain('Unsubscribed');
    expect(el.textContent).toContain('Aug 7, 2026');
  });

  it('labels a signup with no campaign parameters as Direct, not as missing', async () => {
    const { el } = await setup(
      makeApiMock(
        makePage({
          data: [makeRow({ utm_source: null, utm_medium: null, utm_campaign: null })],
        }),
      ),
    );

    expect(el.textContent).toContain('Direct');
  });

  it('prints the referrer as text and never as a link', async () => {
    const { el } = await setup();

    expect(el.textContent).toContain('https://www.linkedin.com/feed');
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.includes('linkedin.com'))).toBe(false);
  });

  it('offers no control that could opt a subscriber out on their behalf', async () => {
    const { el } = await setup();

    const labels = [...el.querySelectorAll('button')].map(
      (b) => b.textContent?.toLowerCase() ?? '',
    );
    expect(labels.some((l) => l.includes('unsubscribe') || l.includes('remove'))).toBe(false);
  });
});

describe('SubscriberList — the two empty states', () => {
  it('says nobody has joined when the list has never had anyone', async () => {
    const { el } = await setup(
      makeApiMock(
        makePage({
          data: [],
          total: 0,
          subscribers: { active: 0, unsubscribed: 0, total_ever: 0, churn_rate: null },
        }),
      ),
    );

    expect(el.textContent).toContain('Nobody has joined the mailing list yet');
    expect(el.textContent).not.toContain('No subscribers match');
    expect(bodyRows(el)).toHaveLength(0);
  });

  it('says the filter matched nothing when subscribers exist but none match', async () => {
    const { el } = await setup(
      makeApiMock(
        makePage({
          data: [],
          total: 0,
          subscribers: { active: 12, unsubscribed: 3, total_ever: 15, churn_rate: 0.2 },
        }),
      ),
    );

    expect(el.textContent).toContain('No subscribers match');
    expect(el.textContent).not.toContain('Nobody has joined the mailing list yet');
  });
});

describe('SubscriberList — filtering and search', () => {
  it('sends the membership filter and returns to page one', async () => {
    const { el, api, fixture } = await setup();

    el.querySelector<HTMLElement>('[id^="admin-subscribers-status"]');
    // Drive the component rather than the Aria control: the filter's wiring is
    // covered by `aec-select`'s own spec, and this asserts what reaches the API.
    (fixture.componentInstance as unknown as { onStatusChange(v: string): void }).onStatusChange(
      'unsubscribed',
    );
    await fixture.whenStable();
    await settle();

    expect(api.listSubscribers).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, status: 'unsubscribed' }),
    );
  });

  it('sends a trimmed search term only once submitted', async () => {
    const { el, api, fixture } = await setup();

    const input = el.querySelector<HTMLInputElement>('#admin-subscribers-search')!;
    input.value = '  @acme.com  ';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    // Typing alone must not fetch — a keystroke-per-request search over a
    // `LIKE '%…%'` scan asks the database a question nobody has finished asking.
    expect(api.listSubscribers).toHaveBeenCalledTimes(1);

    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    await settle();

    expect(api.listSubscribers).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: '@acme.com' }),
    );
  });
});

describe('SubscriberList — sorting', () => {
  it('opens on signup date, descending; the other column reports no order', async () => {
    const { el } = await setup();

    expect(header(el, 'Signed up')?.getAttribute('aria-sort')).toBe('descending');
    // `aria-sort` is `none` on an inactive header by design (`SortHeader`) — it
    // reports the LIVE order, not what a click would produce.
    expect(header(el, 'Email')?.getAttribute('aria-sort')).toBe('none');
  });

  it('gives each column its OWN natural direction on first click, not the previous one', async () => {
    // The property the shared default-order map exists for: these two keys
    // disagree. Coming off "Signed up ↓", clicking Email must give A-to-Z rather
    // than inheriting descending — and going back must give newest-first again.
    const { el, api, fixture } = await setup();

    header(el, 'Email')!.querySelector('button')!.click();
    await fixture.whenStable();
    await settle();
    expect(api.listSubscribers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'email', order: 'asc' }),
    );

    fixture.detectChanges();
    header(el, 'Signed up')!.querySelector('button')!.click();
    await fixture.whenStable();
    await settle();
    expect(api.listSubscribers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'created_at', order: 'desc' }),
    );
  });

  it('flips the active column rather than re-sending the same order', async () => {
    const { el, api, fixture } = await setup();

    header(el, 'Signed up')!.querySelector('button')!.click();
    await fixture.whenStable();
    await settle();

    expect(api.listSubscribers).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'created_at', order: 'asc' }),
    );
  });

  it('offers no sort control on status, source or location', async () => {
    const { el } = await setup();

    for (const label of ['Status', 'Source', 'Location']) {
      expect(header(el, label)?.querySelector('button')).toBeNull();
    }
  });
});

describe('SubscriberList — stocks', () => {
  it('quotes the lifetime figures, which do not narrow with the filter', async () => {
    const { el } = await setup(
      makeApiMock(
        makePage({
          data: [makeRow()],
          total: 1,
          subscribers: { active: 12, unsubscribed: 3, total_ever: 15, churn_rate: 0.2 },
        }),
      ),
    );

    expect(el.textContent).toContain('15 people have joined');
    expect(el.textContent).toContain('12 are still subscribed');
    expect(el.textContent).toContain('3 have opted out');
  });
});

describe('SubscriberList — failure', () => {
  it('offers a retry rather than an empty table when the read fails', async () => {
    const api = { listSubscribers: vi.fn(async () => Promise.reject(new Error('401'))) };
    const { el } = await setup(api);

    expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
    expect(bodyRows(el)).toHaveLength(0);
  });
});
