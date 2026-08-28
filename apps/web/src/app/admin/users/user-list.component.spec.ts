/**
 * `UserList` (`/admin/users`) — AECI-692.
 *
 * Three groups earn their keep:
 *
 *  1. **The tri-state renders as three different sentences.** "Unavailable",
 *     "No account" and "No email on file" mean different things, and the day a
 *     misconfigured service-role key read as ordinary missing data (2026-08-24)
 *     is why they are asserted separately rather than as "not blank".
 *  2. **`?banned=true` arrives filtered.** `/admin/reviewers` now redirects here
 *     with that query, so seeding from the URL is load-bearing, not a nicety.
 *  3. **No ban control on the list.** Asserted so a later PR cannot quietly add
 *     one — ban needs a reason, and its home is the detail page.
 *  4. **Last sign-in has no sort control, and must never get one** (AECI-694).
 *     It is fetched from GoTrue per id AFTER the ORDER BY has chosen the page,
 *     so a control there would reorder 24 arbitrary rows and present it as a
 *     ranking. That is a promise about the seam, not a styling preference, which
 *     is why it is a test.
 */

import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminUserRow, AdminUsersListResponse } from '@aeci/shared';

import { AdminUsersApi } from './admin-users-api';
import { UserList } from './user-list';

const USER_ID = '00000000-0000-4000-8000-000000000700';
const SEAT_ID = '00000000-0000-4000-8000-000000000701';

function makeRow(over: Partial<AdminUserRow> = {}): AdminUserRow {
  return {
    id: USER_ID,
    display_name: 'Rita Reviewer',
    role: 'reviewer',
    seat: null,
    auth: {
      email: 'rita@acme.com',
      last_sign_in_at: '2026-08-20T09:00:00.000Z',
      created_at: '2026-01-05T12:00:00.000Z',
      email_confirmed_at: '2026-01-05T12:04:00.000Z',
    },
    banned_at: null,
    created_at: '2026-01-05T12:00:00.000Z',
    updated_at: '2026-01-05T12:00:00.000Z',
    ...over,
  };
}

function makePage(over: Partial<AdminUsersListResponse> = {}): AdminUsersListResponse {
  return {
    data: [makeRow()],
    page: 1,
    perPage: 24,
    total: 1,
    auth_available: true,
    email_search: null,
    ...over,
  };
}

interface ApiMock {
  listUsers: ReturnType<typeof vi.fn>;
}

function makeApiMock(page: AdminUsersListResponse = makePage()): ApiMock {
  return { listUsers: vi.fn(async () => structuredClone(page)) };
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

async function setup(api: ApiMock = makeApiMock(), queryParams: Record<string, string> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminUsersApi, useValue: api },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: {
              get: (key: string) => queryParams[key] ?? null,
            },
          },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(UserList);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => vi.restoreAllMocks());

describe('UserList', () => {
  it('lists people with their email and role', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('Rita Reviewer');
    expect(el.textContent).toContain('rita@acme.com');
    expect(el.textContent).toContain('Reviewer');
  });

  it('renders an unnamed account rather than an empty heading', async () => {
    const { el } = await setup(makeApiMock(makePage({ data: [makeRow({ display_name: null })] })));
    expect(el.textContent).toContain('Unnamed account');
  });

  it('shows the seat with its owner flag', async () => {
    const { el } = await setup(
      makeApiMock(
        makePage({
          data: [
            makeRow({
              role: 'vendor_admin',
              seat: {
                vendor_id: SEAT_ID,
                company_name: 'Procore',
                slug: 'procore',
                owner: true,
              },
            }),
          ],
        }),
      ),
    );
    expect(el.textContent).toContain('Procore');
    expect(el.textContent).toContain('(owner)');
  });

  it('badges a banned account', async () => {
    const { el } = await setup(
      makeApiMock(makePage({ data: [makeRow({ banned_at: '2026-08-01T00:00:00.000Z' })] })),
    );
    expect(el.textContent).toContain('Banned');
  });

  describe('the GoTrue tri-state — three sentences, not one blank', () => {
    it('seam down → "Unavailable", plus a banner explaining why', async () => {
      const { el } = await setup(
        makeApiMock(makePage({ auth_available: false, data: [makeRow({ auth: null })] })),
      );
      expect(el.textContent).toContain('Unavailable');
      expect(el.textContent).toContain('the account service could not be reached');
      // The rest of the page still works — this is the DEFAULT local-dev state.
      expect(el.textContent).toContain('Rita Reviewer');
    });

    it('seam up, no auth row → "No account", NOT "Unavailable"', async () => {
      // An orphaned profile is a real data defect. Reporting it as a seam
      // failure would hide it.
      const { el } = await setup(
        makeApiMock(makePage({ auth_available: true, data: [makeRow({ auth: null })] })),
      );
      expect(el.textContent).toContain('No account');
      expect(el.textContent).not.toContain('Unavailable');
    });

    it('account present, no email → "No email on file", NOT "No account"', async () => {
      const { el } = await setup(
        makeApiMock(
          makePage({
            auth_available: true,
            data: [makeRow({ auth: { ...makeRow().auth!, email: null } })],
          }),
        ),
      );
      expect(el.textContent).toContain('No email on file');
      expect(el.textContent).not.toContain('No account');
    });

    it('account present, never signed in → "Never signed in"', async () => {
      const { el } = await setup(
        makeApiMock(
          makePage({
            data: [makeRow({ auth: { ...makeRow().auth!, last_sign_in_at: null } })],
          }),
        ),
      );
      expect(el.textContent).toContain('Never signed in');
    });
  });

  describe('email search feedback', () => {
    it('says the search could not run rather than showing a bare empty page', async () => {
      // The false negative this whole surface exists to stop: an empty result
      // from a seam-down email search reads as "no such user".
      const { el } = await setup(
        makeApiMock(makePage({ data: [], total: 0, email_search: 'unavailable' })),
      );
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        'Email search could not run',
      );
    });

    it('explains that email search needs the FULL address on a no-match', async () => {
      const { el } = await setup(
        makeApiMock(makePage({ data: [], total: 0, email_search: 'no_match' })),
      );
      expect(el.textContent).toContain('No account owns that address');
    });
  });

  describe('filters', () => {
    it('seeds banned=true from the query string — the /admin/reviewers redirect', async () => {
      const { api } = await setup(makeApiMock(), { banned: 'true' });
      expect(api.listUsers).toHaveBeenCalledWith(expect.objectContaining({ banned: 'true' }));
    });

    it('seeds role and has_seat too', async () => {
      const { api } = await setup(makeApiMock(), { role: 'vendor_admin', has_seat: 'true' });
      expect(api.listUsers).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'vendor_admin', has_seat: 'true' }),
      );
    });

    it('ignores a junk query value rather than narrowing to nothing', async () => {
      // A hand-edited URL should narrow nothing, not break the screen or 400.
      const { api } = await setup(makeApiMock(), { banned: 'yes', role: 'wizard' });
      const sent = api.listUsers.mock.calls[0]?.[0] ?? {};
      expect(sent.banned).toBeUndefined();
      expect(sent.role).toBeUndefined();
    });

    it('omits a filter left at "any" instead of sending a value', async () => {
      const { api } = await setup();
      const sent = api.listUsers.mock.calls[0]?.[0] ?? {};
      expect(sent.banned).toBeUndefined();
      expect(sent.has_seat).toBeUndefined();
      expect(sent.role).toBeUndefined();
    });
  });

  describe('load failures', () => {
    it('offers a retry and does not strand the operator', async () => {
      const api = makeApiMock();
      api.listUsers.mockRejectedValueOnce(new Error('boom'));
      const { el } = await setup(api);
      expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
      const retry = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Try again',
      );
      expect(retry).toBeTruthy();
    });

    it('says nothing matched when the page is genuinely empty', async () => {
      const { el } = await setup(makeApiMock(makePage({ data: [], total: 0 })));
      expect(el.textContent).toContain('No people match these filters');
    });
  });

  it('carries NO ban control — ban needs a reason and lives on the detail page', async () => {
    // The scope boundary, asserted so a later PR cannot quietly cross it. An
    // inline ban would mean a reason form on every row.
    const { el } = await setup();
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).not.toContain('Ban');
    expect(labels).not.toContain('Ban this account');
    expect(labels).not.toContain('Reinstate');
  });

  describe('sorting (AECI-694)', () => {
    it('sends the API default, newest profiles first', async () => {
      const { api } = await setup();
      expect(api.listUsers.mock.calls[0]?.[0]?.sort).toBe('created');
    });

    it('sends the key to the API rather than reordering the page in place', async () => {
      const { el, fixture, api } = await setup();
      header(el, 'Updated')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      const sent = api.listUsers.mock.calls.at(-1)?.[0] ?? {};
      expect(sent.sort).toBe('updated');
      // A sort is a filter change: staying on page 4 of a reordered set lands on
      // rows the operator did not ask for.
      expect(sent.page).toBe(1);
    });

    it('reports the fixed server direction through aria-sort', async () => {
      // `resolveAdminUserOrderBy` descends on both keys and takes no `order`
      // param, so clicking selects a sort and never flips one.
      const { el } = await setup();
      expect(header(el, 'Profile created')?.getAttribute('aria-sort')).toBe('descending');
      expect(header(el, 'Updated')?.getAttribute('aria-sort')).toBe('none');
    });

    it('gives Last sign-in no sort control, and never will', async () => {
      const { el } = await setup();
      expect(header(el, 'Last sign-in')).toBeTruthy();
      expect(header(el, 'Last sign-in')?.querySelector('button')).toBeFalsy();
      // Email is unsortable for the same reason and is not even its own column.
      for (const label of ['Person', 'Role', 'Vendor', 'Status']) {
        expect(header(el, label)?.querySelector('button')).toBeFalsy();
      }
    });
  });

  describe('table structure (AECI-694)', () => {
    it('renders one row per person, with the person as the row header', async () => {
      const { el } = await setup();
      expect(bodyRows(el)).toHaveLength(1);
      const rowHeader = bodyRows(el)[0]?.querySelector('th[scope="row"]');
      expect(rowHeader?.textContent).toContain('Rita Reviewer');
      expect(rowHeader?.querySelector('a')?.getAttribute('href')).toBe(`/admin/users/${USER_ID}`);
    });

    it('names the table and scopes every header cell', async () => {
      const { el } = await setup();
      expect(el.querySelector('caption')?.textContent?.trim()).toBeTruthy();
      for (const th of el.querySelectorAll('thead th')) {
        expect(th.getAttribute('scope')).toBe('col');
      }
    });

    it('keeps the screen to a single h2 and no per-row headings', async () => {
      // 24 rows as h3s would put 24 headings between the screen's h2 and
      // anything after it, which is what `th[scope=row]` avoids.
      const { el } = await setup();
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelector('h1, h3, h4, h5, h6')).toBeNull();
    });
  });

  it('announces the result count in the polite live region', async () => {
    const { el } = await setup(makeApiMock(makePage({ total: 7 })));
    expect(el.querySelector('[role="status"]')?.textContent).toContain('7');
  });
});
