/**
 * `UserList` (`/admin/users`) — AECI-692.
 *
 * Five groups earn their keep:
 *
 *  1. **The tri-state renders as three different sentences.** "Unavailable",
 *     "No account" and "No email on file" mean different things, and the day a
 *     misconfigured service-role key read as ordinary missing data (2026-08-24)
 *     is why they are asserted separately rather than as "not blank".
 *  2. **The URL is the state (AECI-1935).** Filters, search, sort, order and
 *     page are read from the query string and written back by a push, so reload,
 *     Back and a shared link restore the list. `/admin/reviewers` redirects here
 *     with `?banned=true`, so that link must still arrive filtered. The list is
 *     mounted at a real route so the params travel through the router.
 *  3. **No ban control on the list.** Asserted so a later PR cannot quietly add
 *     one — ban needs a reason, and its home is the detail page.
 *  4. **The last sign-in sort says when it did not run.** The API ranks through
 *     GoTrue, so with the seam down it orders by `created` instead. The arrow and a
 *     sentence have to follow what the server did, not what was clicked.
 *  5. **A filter or sort change returns to page 1**, and drops `page` from the URL.
 */

import { provideZonelessChangeDetection } from '@angular/core';
import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
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
    company_type: null,
    company_size: null,
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

function bodyRows(el: HTMLElement): HTMLTableRowElement[] {
  return [...el.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

/** The header cell whose text starts with this label. */
function header(el: HTMLElement, label: string): HTMLTableCellElement | undefined {
  return [...el.querySelectorAll<HTMLTableCellElement>('thead th')].find((th) =>
    th.textContent?.trim().startsWith(label),
  );
}

/** The harness of the test in progress, so `settle()` can flush it. */
let current: RouterTestingHarness | undefined;

/**
 * Let a click finish its round trip: the push navigation, the URL signal, the
 * load effect, the mocked fetch and the render. Three passes, because each hop
 * is its own task.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    current?.detectChanges();
    await current?.fixture.whenStable();
  }
}

/** Mounts the list at a real `admin/users` route, with the query string given. */
async function setup(api: ApiMock = makeApiMock(), queryParams: Record<string, string> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: 'admin/users', component: UserList }]),
      // A history stack the test can walk: `Location.back()` pops synchronously.
      provideLocationMocks(),
      { provide: AdminUsersApi, useValue: api },
    ],
  });
  const harness = await RouterTestingHarness.create();
  current = harness;
  // Subscribes the router to location pops, as app bootstrap does, so a
  // `Location.back()` reaches the component the way the browser's Back does.
  TestBed.inject(Router).initialNavigation();
  const query = new URLSearchParams(queryParams).toString();
  await harness.navigateByUrl(query ? `/admin/users?${query}` : '/admin/users');
  await settle();
  const componentInstance = harness.routeDebugElement!.componentInstance as UserList &
    Record<string, never>;
  const fixture = {
    componentInstance,
    detectChanges: () => harness.detectChanges(),
  };
  return { fixture, harness, api, el: harness.routeNativeElement as HTMLElement };
}

function routerUrl(): string {
  return TestBed.inject(Router).url;
}

function lastQuery(api: ApiMock): Record<string, unknown> {
  return api.listUsers.mock.calls.at(-1)![0] as Record<string, unknown>;
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => {
  current = undefined;
  vi.restoreAllMocks();
});

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

  // AECI-2128: the console table recipe and the shared chip tones.
  it('draws the state as a dense chip on the console tones', async () => {
    const { el } = await setup(
      makeApiMock(
        makePage({
          data: [makeRow({ banned_at: '2026-08-01T00:00:00.000Z' }), makeRow({ id: 'p2' })],
        }),
      ),
    );
    const chips = [...el.querySelectorAll('tbody .aec-chip')];
    expect(chips.map((c) => [c.textContent?.trim(), c.getAttribute('data-tone')])).toEqual([
      ['Banned', 'critical'],
      ['Active', 'positive'],
    ]);
    expect(chips.every((c) => c.getAttribute('data-density') === 'dense')).toBe(true);
  });

  it('labels the scroll region with the table caption', async () => {
    const { el } = await setup();
    const region = el.querySelector('[role="region"]')!;
    expect(region.getAttribute('tabindex')).toBe('0');
    const caption = el.querySelector(`#${region.getAttribute('aria-labelledby')}`);
    expect(caption?.tagName).toBe('CAPTION');
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

    it('reports the default server direction through aria-sort', async () => {
      // Profile created is the default key, newest first. An inactive header
      // reads "none" until it is chosen.
      const { el } = await setup();
      expect(header(el, 'Profile created')?.getAttribute('aria-sort')).toBe('descending');
      expect(header(el, 'Updated')?.getAttribute('aria-sort')).toBe('none');
    });

    it('sorts Person by name, A to Z on the first click (AECI-1243)', async () => {
      const { el, fixture, api } = await setup();
      expect(header(el, 'Person')?.getAttribute('aria-sort')).toBe('none');
      header(el, 'Person')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      const sent = api.listUsers.mock.calls.at(-1)?.[0] ?? {};
      expect(sent.sort).toBe('name');
      expect(sent.order).toBe('asc');
      expect(header(el, 'Person')?.getAttribute('aria-sort')).toBe('ascending');
    });

    it('sorts Last sign-in through the API, most recent first on the first click', async () => {
      const { el, fixture, api } = await setup();
      expect(header(el, 'Last sign-in')?.getAttribute('aria-sort')).toBe('none');
      header(el, 'Last sign-in')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      const sent = api.listUsers.mock.calls.at(-1)?.[0] ?? {};
      expect(sent.sort).toBe('last_sign_in');
      expect(sent.order).toBe('desc');
      expect(sent.page).toBe(1);
      expect(header(el, 'Last sign-in')?.getAttribute('aria-sort')).toBe('descending');
      expect(el.textContent).not.toContain('cannot be sorted');
    });

    it('says so when the seam is down and the API sorted by profile created', async () => {
      const { el, fixture } = await setup(
        makeApiMock(makePage({ auth_available: false, data: [makeRow({ auth: null })] })),
      );
      expect(el.textContent).not.toContain('cannot be sorted');
      header(el, 'Last sign-in')?.querySelector('button')?.click();
      await settle();
      fixture.detectChanges();
      expect(el.textContent).toContain('cannot be sorted');
      expect(header(el, 'Last sign-in')?.getAttribute('aria-sort')).toBe('none');
      expect(header(el, 'Profile created')?.getAttribute('aria-sort')).toBe('descending');
    });

    it('leaves the columns the API cannot order plain', async () => {
      const { el } = await setup();
      for (const label of ['Role', 'Vendor', 'Status']) {
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

  describe('URL state (AECI-1935)', () => {
    it('leaves the bare URL alone on a default load', async () => {
      const { api } = await setup();
      expect(routerUrl()).toBe('/admin/users');
      expect(lastQuery(api)).toMatchObject({ page: 1, sort: 'created', order: 'desc' });
    });

    it('seeds every axis from the URL into the request and the controls', async () => {
      const { api, fixture } = await setup(makeApiMock(makePage({ total: 100 })), {
        role: 'vendor_admin',
        banned: 'false',
        has_seat: 'true',
        search: 'rita',
        sort: 'name',
        order: 'desc',
        page: '3',
      });
      expect(api.listUsers).toHaveBeenCalledTimes(1);
      expect(lastQuery(api)).toEqual({
        page: 3,
        perPage: 24,
        sort: 'name',
        order: 'desc',
        search: 'rita',
        role: 'vendor_admin',
        banned: 'false',
        has_seat: 'true',
      });
      const c = fixture.componentInstance;
      expect(c['role']()).toBe('vendor_admin');
      expect(c['banned']()).toBe('false');
      expect(c['hasSeat']()).toBe('true');
      expect(c['searchDraft']()).toBe('rita');
      expect(c['page']()).toBe(3);
    });

    it('reads junk values as their defaults', async () => {
      for (const page of ['0', '-2', 'abc', '1.5']) {
        const { api } = await setup(makeApiMock(), {
          page,
          sort: 'bogus',
          order: 'up',
          has_seat: 'maybe',
        });
        expect(lastQuery(api)).toEqual({ page: 1, perPage: 24, sort: 'created', order: 'desc' });
      }
    });

    it('writes a filter change to the URL and drops it again at its default', async () => {
      const { fixture, api } = await setup();
      fixture.componentInstance['onRoleChange']('admin');
      await settle();
      expect(routerUrl()).toBe('/admin/users?role=admin');
      expect(lastQuery(api)).toMatchObject({ role: 'admin', page: 1 });

      fixture.componentInstance['onBannedChange']('true');
      await settle();
      fixture.componentInstance['onSeatChange']('false');
      await settle();
      expect(routerUrl()).toBe('/admin/users?role=admin&banned=true&has_seat=false');

      fixture.componentInstance['onRoleChange']('any');
      await settle();
      fixture.componentInstance['onBannedChange']('any');
      await settle();
      fixture.componentInstance['onSeatChange']('any');
      await settle();
      expect(routerUrl()).toBe('/admin/users');
    });

    it('writes the search on submit and drops it on clear', async () => {
      const { fixture } = await setup();
      fixture.componentInstance['searchDraft'].set('  jane@acme.com ');
      fixture.componentInstance['submitSearch']();
      await settle();
      expect(routerUrl()).toBe('/admin/users?search=jane@acme.com');
      fixture.componentInstance['clearSearch']();
      await settle();
      expect(routerUrl()).toBe('/admin/users');
    });

    it('writes a header click as sort, and a second click as order', async () => {
      const { el } = await setup();
      header(el, 'Person')?.querySelector('button')?.click();
      await settle();
      expect(routerUrl()).toBe('/admin/users?sort=name');
      header(el, 'Person')?.querySelector('button')?.click();
      await settle();
      expect(routerUrl()).toBe('/admin/users?sort=name&order=desc');
      // Back to the default key at its natural direction writes nothing.
      header(el, 'Profile created')?.querySelector('button')?.click();
      await settle();
      expect(routerUrl()).toBe('/admin/users');
    });

    it('writes the page, and a filter change on page 3 returns to page 1', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makePage({ total: 100 })));
      const next = [...el.querySelectorAll('button')].find((b) =>
        b.textContent?.trim().startsWith('Next'),
      );
      next?.click();
      await settle();
      expect(routerUrl()).toBe('/admin/users?page=2');
      expect(lastQuery(api)).toMatchObject({ page: 2 });

      fixture.componentInstance['goToPage'](3);
      await settle();
      expect(routerUrl()).toBe('/admin/users?page=3');

      fixture.componentInstance['onBannedChange']('true');
      await settle();
      expect(routerUrl()).toBe('/admin/users?banned=true');
      expect(lastQuery(api)).toMatchObject({ banned: 'true', page: 1 });
    });

    it('restores the previous filter and page on Back, and refetches', async () => {
      const { fixture, api } = await setup(makeApiMock(makePage({ total: 100 })));
      fixture.componentInstance['onRoleChange']('reviewer');
      await settle();
      fixture.componentInstance['goToPage'](2);
      await settle();
      fixture.componentInstance['onRoleChange']('admin');
      await settle();
      expect(routerUrl()).toBe('/admin/users?role=admin');
      const calls = api.listUsers.mock.calls.length;

      TestBed.inject(Location).back();
      await settle();
      expect(routerUrl()).toBe('/admin/users?role=reviewer&page=2');
      expect(fixture.componentInstance['role']()).toBe('reviewer');
      expect(api.listUsers.mock.calls.length).toBe(calls + 1);
      expect(lastQuery(api)).toMatchObject({ role: 'reviewer', page: 2 });
    });

    it('keeps sort=last_sign_in in the URL when the seam is down', async () => {
      // The URL records what was asked; only the arrow follows what the server did.
      const { el } = await setup(
        makeApiMock(makePage({ auth_available: false, data: [makeRow({ auth: null })] })),
        { sort: 'last_sign_in' },
      );
      expect(routerUrl()).toBe('/admin/users?sort=last_sign_in');
      expect(header(el, 'Profile created')?.getAttribute('aria-sort')).toBe('descending');
      expect(header(el, 'Last sign-in')?.getAttribute('aria-sort')).toBe('none');
    });
  });
});
