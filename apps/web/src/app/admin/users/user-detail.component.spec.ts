/**
 * `UserDetail` (`/admin/users/:id`) — AECI-692.
 *
 * This file also carries forward the coverage that left with
 * `reviewer-bans.component.spec.ts` when `/admin/reviewers` folded: reinstate
 * succeeds, a 422 is treated as "already in that state" rather than an error,
 * and a generic failure leaves the page usable. Folding a screen without moving
 * its tests would have been a silent coverage regression.
 *
 * What the rest earns its keep for:
 *
 *  - **The scope boundary, mirrored.** `vendor-detail.component.spec.ts` asserts
 *    that screen can revoke a seat and cannot ban. This asserts the inverse. The
 *    pair is what stops the two surfaces converging into one confusing page.
 *  - **403 names both refusals.** The endpoint throws one status for "cannot ban
 *    an admin" and "cannot ban yourself" and only the message differs, so the
 *    copy has to cover both — naming the wrong one is worse than naming neither.
 *  - **`null` ≠ `[]` ≠ `0`.** Pending invites and request counts are keyed by an
 *    address the GoTrue seam supplies; without it they are unknowable.
 */

import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminUserDetail } from '@aeci/shared';

import { ReviewerBansApi } from '../reviewers/reviewer-bans-api';
import { AdminUsersApi } from './admin-users-api';
import { UserDetail } from './user-detail';

const USER_ID = '00000000-0000-4000-8000-000000000700';
const VENDOR_ID = '00000000-0000-4000-8000-000000000061';

function makeUser(over: Partial<AdminUserDetail> = {}): AdminUserDetail {
  return {
    id: USER_ID,
    display_name: 'Rita Reviewer',
    role: 'reviewer',
    trust_tier: 'standard',
    work_email_verified: false,
    seat_owner: false,
    banned_at: null,
    ban_reason: null,
    created_at: '2026-01-05T12:00:00.000Z',
    updated_at: '2026-01-05T12:00:00.000Z',
    auth: {
      email: 'rita@acme.com',
      last_sign_in_at: '2026-08-20T09:00:00.000Z',
      created_at: '2026-01-05T12:00:00.000Z',
      email_confirmed_at: '2026-01-05T12:04:00.000Z',
    },
    auth_available: true,
    seat: null,
    pending_invites: [],
    counts: {
      reviews: { pending: 0, approved: 3, rejected: 1, archived: 0 },
      seat_invites_sent: 0,
      entitlements_granted: 0,
      requests_by_email: 2,
    },
    repeat_offender: false,
    ...over,
  };
}

interface ApiMock {
  getUser: ReturnType<typeof vi.fn>;
}
interface BansMock {
  listBanned: ReturnType<typeof vi.fn>;
  ban: ReturnType<typeof vi.fn>;
}

function makeApiMock(user: AdminUserDetail = makeUser()): ApiMock {
  return { getUser: vi.fn(async () => structuredClone(user)) };
}

function makeBansMock(): BansMock {
  return {
    listBanned: vi.fn(),
    ban: vi.fn(async (id: string, input: { action: string; reason?: string }) => ({
      reviewer_id: id,
      banned_at: input.action === 'ban' ? '2026-08-28T00:00:00.000Z' : null,
      ban_reason: input.action === 'ban' ? (input.reason ?? null) : null,
    })),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock = makeApiMock(), bans: BansMock = makeBansMock()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminUsersApi, useValue: api },
      { provide: ReviewerBansApi, useValue: bans },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => USER_ID } } },
      },
    ],
  });
  const fixture = TestBed.createComponent(UserDetail);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, bans, el: fixture.nativeElement as HTMLElement };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

async function click(fixture: { detectChanges: () => void }, button: HTMLButtonElement) {
  button.click();
  await settle();
  fixture.detectChanges();
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => vi.restoreAllMocks());

describe('UserDetail', () => {
  it('renders the account, contributions and vendor access', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('Rita Reviewer');
    expect(el.textContent).toContain('rita@acme.com');
    expect(el.textContent).toContain('This account holds no vendor seat');
  });

  it('404s into a "we couldn\'t find that account" message, not a generic error', async () => {
    const api = makeApiMock();
    api.getUser.mockRejectedValueOnce({ status: 404 });
    const { el } = await setup(api);
    expect(el.textContent).toContain("couldn't find that account");
    expect(el.textContent).not.toContain('session may have expired');
  });

  it('distinguishes a generic load failure and offers a retry', async () => {
    const api = makeApiMock();
    api.getUser.mockRejectedValueOnce({ status: 500 });
    const { el } = await setup(api);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('session may have expired');
    expect(buttonByText(el, 'Try again')).toBeTruthy();
  });

  describe('the GoTrue tri-state', () => {
    it('seam down → Unavailable everywhere, plus a banner, page still works', async () => {
      const { el } = await setup(
        makeApiMock(
          makeUser({
            auth: null,
            auth_available: false,
            pending_invites: null,
            counts: { ...makeUser().counts, requests_by_email: null },
          }),
        ),
      );
      expect(el.textContent).toContain('Unavailable');
      expect(el.textContent).toContain('the account service could not be reached');
      expect(el.textContent).toContain("Pending invites can't be checked");
      // Everything that needs no address still renders.
      expect(el.textContent).toContain('Rita Reviewer');
    });

    it('seam up with no auth row → "No account", not "Unavailable"', async () => {
      const { el } = await setup(makeApiMock(makeUser({ auth: null, auth_available: true })));
      expect(el.textContent).toContain('No account');
      expect(el.textContent).not.toContain('Unavailable');
    });

    it('never signed in and never confirmed render as their own sentences', async () => {
      const { el } = await setup(
        makeApiMock(
          makeUser({
            auth: { ...makeUser().auth!, last_sign_in_at: null, email_confirmed_at: null },
          }),
        ),
      );
      expect(el.textContent).toContain('Never signed in');
      expect(el.textContent).toContain('Not confirmed');
    });
  });

  describe('vendor access', () => {
    it('shows the seat and links OUT to the vendor page for seat management', async () => {
      const { el } = await setup(
        makeApiMock(
          makeUser({
            role: 'vendor_admin',
            seat: {
              vendor_id: VENDOR_ID,
              company_name: 'Procore',
              slug: 'procore',
              owner: true,
            },
          }),
        ),
      );
      expect(el.textContent).toContain('Procore');
      expect(el.textContent).toContain('account owner');
      const link = [...el.querySelectorAll('a')].find(
        (a) => a.textContent?.trim() === 'Manage seats on the vendor page',
      );
      expect(link?.getAttribute('href')).toBe(`/admin/vendors/${VENDOR_ID}`);
    });

    it("carries NO seat-revoke control — the mirror of vendor-detail's boundary", async () => {
      // `vendor-detail.component.spec.ts` asserts that screen can revoke and
      // cannot ban. This is the inverse, asserted so a later PR cannot quietly
      // collapse the two into one page where the wrong button is one slip away.
      const { el } = await setup(
        makeApiMock(
          makeUser({
            role: 'vendor_admin',
            seat: { vendor_id: VENDOR_ID, company_name: 'Procore', slug: 'procore', owner: true },
          }),
        ),
      );
      const labels = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
      expect(labels).not.toContain('Remove seat');
      expect(labels).not.toContain('Revoke');
    });

    it('distinguishes unknown pending invites from none', async () => {
      const none = await setup(makeApiMock(makeUser({ pending_invites: [] })));
      expect(none.el.textContent).not.toContain("Pending invites can't be checked");

      const unknown = await setup(makeApiMock(makeUser({ pending_invites: null })));
      expect(unknown.el.textContent).toContain("Pending invites can't be checked");
    });
  });

  describe('contributions', () => {
    it('labels the request count as an email match, not an account link', async () => {
      const { el } = await setup();
      expect(el.textContent).toContain('Requests filed (email match)');
      expect(el.textContent).toContain('matched by email address only');
    });

    it('renders an uncomputable request count as Unavailable, not 0', async () => {
      const { el } = await setup(
        makeApiMock(makeUser({ counts: { ...makeUser().counts, requests_by_email: null } })),
      );
      const dl = el.textContent ?? '';
      expect(dl).toContain('Unavailable');
    });

    it('badges a repeat offender', async () => {
      const { el } = await setup(makeApiMock(makeUser({ repeat_offender: true })));
      expect(el.textContent).toContain('Repeat offender');
    });
  });

  describe('ban', () => {
    it('requires a reason before it will call the endpoint', async () => {
      const { el, fixture, bans } = await setup();
      await click(fixture, buttonByText(el, 'Ban this account')!);
      await click(fixture, buttonByText(el, 'Confirm ban')!);
      expect(bans.ban).not.toHaveBeenCalled();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('A reason is required');
    });

    it('bans with the reason and patches the page in place', async () => {
      const { el, fixture, bans } = await setup();
      await click(fixture, buttonByText(el, 'Ban this account')!);
      const textarea = el.querySelector('textarea')!;
      textarea.value = 'Coordinated spam.';
      textarea.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await click(fixture, buttonByText(el, 'Confirm ban')!);

      expect(bans.ban).toHaveBeenCalledWith(USER_ID, {
        action: 'ban',
        reason: 'Coordinated spam.',
      });
      // Patched from the response, not refetched — no window showing pre-write state.
      expect(el.textContent).toContain('Banned since');
      expect(el.textContent).toContain('Coordinated spam.');
      expect(el.querySelector('[role="status"]')?.textContent).toContain('Account banned');
    });

    it('names BOTH 403 refusals, because the endpoint does not distinguish them', async () => {
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce({ status: 403 });
      const { el, fixture } = await setup(makeApiMock(), bans);
      await click(fixture, buttonByText(el, 'Ban this account')!);
      const textarea = el.querySelector('textarea')!;
      textarea.value = 'x';
      textarea.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await click(fixture, buttonByText(el, 'Confirm ban')!);

      const alert = el.querySelector('[role="alert"]')?.textContent ?? '';
      expect(alert).toContain("Admin accounts can't be banned");
      expect(alert).toContain("you can't ban yourself");
    });
  });

  describe('reinstate (carried over from the folded /admin/reviewers spec)', () => {
    const banned = () =>
      makeUser({ banned_at: '2026-08-01T00:00:00.000Z', ban_reason: 'Coordinated spam.' });

    it('reinstates without a confirm step and announces it', async () => {
      const { el, fixture, bans } = await setup(makeApiMock(banned()));
      expect(el.textContent).toContain('Banned since');
      await click(fixture, buttonByText(el, 'Reinstate')!);

      expect(bans.ban).toHaveBeenCalledWith(USER_ID, { action: 'unban' });
      expect(el.textContent).toContain('Ban this account');
      expect(el.querySelector('[role="status"]')?.textContent).toContain('reinstated');
    });

    it('treats a 422 as already-in-that-state and refetches rather than erroring', async () => {
      // The race: someone else reinstated them between the page load and the
      // click. The operator got the outcome they wanted, so the page shows the
      // truth instead of a failure.
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce({ status: 422 });
      const api = makeApiMock(banned());
      const { el, fixture } = await setup(api, bans);
      await click(fixture, buttonByText(el, 'Reinstate')!);

      expect(el.querySelector('[role="alert"]')?.textContent).toContain('was not banned');
      expect(api.getUser).toHaveBeenCalledTimes(2);
    });

    it('leaves the page usable on a generic failure', async () => {
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce(new Error('network'));
      const { el, fixture } = await setup(makeApiMock(banned()), bans);
      await click(fixture, buttonByText(el, 'Reinstate')!);

      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong');
      // Still banned, and the button is still there to try again.
      expect(buttonByText(el, 'Reinstate')).toBeTruthy();
    });
  });

  it('renders no browsing history — impossible by design (AECI-585 / §9.7)', async () => {
    // `page_views` holds no user linkage at all: the columns were dropped and
    // §9 item 7 forbids reconstructing the correlation. A section here would be
    // promising something the schema cannot deliver.
    const { el } = await setup();
    const text = el.textContent ?? '';
    expect(text).not.toContain('Page views');
    expect(text).not.toContain('Pages viewed');
  });
});
