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
 *  - **The audit trail (AECI-693).** Headed "Audit trail", never "Activity". Its
 *    scope toggle refetches at page 1, and a ban or reinstate reloads it.
 */

import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAuditRow, AdminUserAuditResponse, AdminUserDetail } from '@aeci/shared';

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
      reviews: { pending: 0, approved: 3, rejected: 1, archived: 0, removed: 0 },
      seat_invites_sent: 0,
      licenses_granted: 0,
      requests_by_email: 2,
      dmca_takedowns: 0,
      dmca_counter_notices: 0,
      pending_moderation: { review_updates: 0, review_responses: 0 },
    },
    repeat_offender: false,
    about: {
      company_type: null,
      company_size: null,
      primary_role: null,
      firm_name: null,
      linkedin_url: null,
      audiences: [],
      onboarding: 'pending',
      found_via: null,
      found_via_detail: null,
    },
    ...over,
  };
}

interface ApiMock {
  getUser: ReturnType<typeof vi.fn>;
  listAudit: ReturnType<typeof vi.fn>;
}
interface BansMock {
  listBanned: ReturnType<typeof vi.fn>;
  ban: ReturnType<typeof vi.fn>;
}

const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';

function makeAuditRow(over: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    action: 'profile.updated',
    actor: { id: ADMIN_ID, display_name: 'Ops Admin', email: null },
    actor_type: 'admin',
    entity_type: 'profile',
    entity_id: USER_ID,
    created_at: '2026-06-01T00:00:00.000Z',
    before_state: { display_name: 'Rita' },
    after_state: { display_name: 'Rita Reviewer' },
    ...over,
  };
}

function makeAudit(
  rows: AdminAuditRow[] = [makeAuditRow()],
  over: Partial<AdminUserAuditResponse> = {},
): AdminUserAuditResponse {
  return {
    data: rows,
    page: 1,
    perPage: 25,
    total: rows.length,
    actor_emails_available: true,
    ...over,
  };
}

function makeApiMock(
  user: AdminUserDetail = makeUser(),
  audit: AdminUserAuditResponse = makeAudit(),
): ApiMock {
  return {
    getUser: vi.fn(async () => structuredClone(user)),
    listAudit: vi.fn(async () => structuredClone(audit)),
  };
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
  describe('the heading names the entity (AECI-777)', () => {
    it('shows the display name once loaded, not the word "Account"', async () => {
      const { el } = await setup();
      expect(el.querySelector('#admin-user-heading')?.textContent?.trim()).toBe('Rita Reviewer');
    });

    it('no longer renders a bespoke back link', async () => {
      const { el } = await setup();
      const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).not.toContain('/admin/users');
    });
  });

  it('renders the account, contributions and vendor access', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('Rita Reviewer');
    expect(el.textContent).toContain('rita@acme.com');
    expect(el.textContent).toContain('This account holds no vendor seat');
  });

  it('shows the copyright takedown count, linked to the account on the log (AECI-1665)', async () => {
    const { el } = await setup(
      makeApiMock(
        makeUser({ counts: { ...makeUser().counts, dmca_takedowns: 2, dmca_counter_notices: 1 } }),
      ),
    );
    const block = el.querySelector('[data-testid="user-dmca-count"]')!;
    const text = block.textContent?.replace(/\s+/g, ' ');
    expect(text).toContain('Copyright takedowns');
    expect(text).toContain('2 takedowns. Open the copyright notice log.');
    expect(text).toContain('(1 counter-notice)');
    const link = block.querySelector('a')!;
    // AECI-2130: a space separates the count from "(1 counter-notice)". The check reads
    // the raw node, since whitespace normalisation above would hide a missing space.
    expect(link.nextSibling?.textContent).toBe(' ');
    expect(link.getAttribute('href')).toBe(`/admin/dmca?account=${USER_ID}`);
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

    it('says a last seat cannot be banned here, for a seat holder only (AECI-1623)', async () => {
      const normalise = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ');
      const seated = await setup(
        makeApiMock(
          makeUser({
            role: 'vendor_admin',
            seat: { vendor_id: VENDOR_ID, company_name: 'Procore', slug: 'procore', owner: true },
          }),
        ),
      );
      expect(normalise(seated.el.textContent)).toContain(
        "A vendor's last unbanned seat cannot be banned here. To end a vendor, use Suspend on its vendor page.",
      );
      expect(normalise(seated.el.textContent)).not.toContain('ends every subscription');
      const reviewer = await setup(makeApiMock(makeUser()));
      expect(normalise(reviewer.el.textContent)).not.toContain('last unbanned seat');
    });

    it('distinguishes unknown pending invites from none', async () => {
      const none = await setup(makeApiMock(makeUser({ pending_invites: [] })));
      expect(none.el.textContent).not.toContain("Pending invites can't be checked");

      const unknown = await setup(makeApiMock(makeUser({ pending_invites: null })));
      expect(unknown.el.textContent).toContain("Pending invites can't be checked");
    });
  });

  describe('pending invites table (AECI-1243)', () => {
    const invite = (
      n: number,
      vendor: string,
      invitedBy: string | null,
      createdAt: string,
      expiresAt: string,
    ) => ({
      id: `00000000-0000-4000-8000-00000000090${n}`,
      email: 'rita@acme.com',
      invited_by: invitedBy,
      expires_at: expiresAt,
      created_at: createdAt,
      vendor_id: VENDOR_ID,
      vendor_name: vendor,
    });
    const invites = [
      invite(1, 'Procore', 'Sam Seat', '2026-08-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'),
      invite(2, 'acme', null, '2026-09-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
      invite(3, 'Zeta', 'ann', '2026-07-01T00:00:00.000Z', '2026-10-15T00:00:00.000Z'),
    ];

    // The audit trail (AECI-693) is a second table on the page, so skip its cells.
    const inviteCells = <T extends Element>(el: HTMLElement, selector: string) =>
      [...el.querySelectorAll<T>(selector)].filter((cell) => !cell.closest('aec-audit-trail'));
    const vendorColumn = (el: HTMLElement) =>
      inviteCells(el, 'tbody th[scope="row"]').map((th) => th.textContent?.trim());
    const inviteHeader = (el: HTMLElement, label: string) =>
      inviteCells<HTMLTableCellElement>(el, 'thead th').find((th) =>
        th.textContent?.trim().startsWith(label),
      );

    it('defaults to newest invite first, and says so through aria-sort', async () => {
      const { el } = await setup(makeApiMock(makeUser({ pending_invites: invites })));
      expect(vendorColumn(el)).toEqual(['acme', 'Procore', 'Zeta']);
      expect(inviteHeader(el, 'Invited on')?.getAttribute('aria-sort')).toBe('descending');
      expect(inviteHeader(el, 'Vendor')?.getAttribute('aria-sort')).toBe('none');
    });

    it('sorts by vendor A to Z ignoring case, and flips on a second click', async () => {
      const { el, fixture } = await setup(makeApiMock(makeUser({ pending_invites: invites })));
      const button = inviteHeader(el, 'Vendor')!.querySelector('button')!;
      await click(fixture, button);
      expect(vendorColumn(el)).toEqual(['acme', 'Procore', 'Zeta']);
      expect(inviteHeader(el, 'Vendor')?.getAttribute('aria-sort')).toBe('ascending');
      await click(fixture, button);
      expect(vendorColumn(el)).toEqual(['Zeta', 'Procore', 'acme']);
    });

    it('puts a missing sender last in both directions', async () => {
      const { el, fixture } = await setup(makeApiMock(makeUser({ pending_invites: invites })));
      const button = inviteHeader(el, 'Invited by')!.querySelector('button')!;
      await click(fixture, button);
      expect(vendorColumn(el)).toEqual(['Zeta', 'Procore', 'acme']);
      await click(fixture, button);
      expect(vendorColumn(el)).toEqual(['Procore', 'Zeta', 'acme']);
    });

    it('treats an empty sender name as missing: a dash, sorted last', async () => {
      const withBlank = [
        ...invites,
        invite(4, 'Beta', '', '2026-06-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
      ];
      const { el, fixture } = await setup(makeApiMock(makeUser({ pending_invites: withBlank })));
      const button = inviteHeader(el, 'Invited by')!.querySelector('button')!;
      await click(fixture, button);
      expect(vendorColumn(el).slice(0, 2)).toEqual(['Zeta', 'Procore']);
      expect(el.textContent).toContain('No sender name');
      expect(el.textContent).not.toContain('no longer exists');
    });

    it('sorts by expiry, soonest first', async () => {
      const { el, fixture } = await setup(makeApiMock(makeUser({ pending_invites: invites })));
      await click(fixture, inviteHeader(el, 'Expires')!.querySelector('button')!);
      expect(vendorColumn(el)).toEqual(['Zeta', 'acme', 'Procore']);
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
    it('shows the last-seat refusal with a link to the vendor it names (AECI-1623)', async () => {
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce({
        status: 409,
        error: {
          error: { code: 'VENDOR_LAST_SEAT_USE_SUSPEND', details: { vendor_id: VENDOR_ID } },
        },
      });
      const { el, fixture } = await setup(makeApiMock(), bans);
      await click(fixture, buttonByText(el, 'Ban this account')!);
      const textarea = el.querySelector<HTMLTextAreaElement>('#admin-user-ban-reason')!;
      textarea.value = 'Spam';
      textarea.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await click(fixture, buttonByText(el, 'Confirm ban')!);

      const alert = el.querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain("This is the vendor's last unbanned seat");
      expect(alert.querySelector('a')?.getAttribute('href')).toBe(`/admin/vendors/${VENDOR_ID}`);
    });

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

  // AECI-1949: the ban can reject the person's pending items.
  describe('reject pending items on a ban (AECI-1949)', () => {
    const withPending = () =>
      makeUser({
        counts: {
          ...makeUser().counts,
          reviews: { pending: 2, approved: 3, rejected: 1, archived: 0, removed: 0 },
          pending_moderation: { review_updates: 1, review_responses: 0 },
        },
      });

    async function openAndType(fixture: { detectChanges: () => void }, el: HTMLElement) {
      await click(fixture, buttonByText(el, 'Ban this account')!);
      const textarea = el.querySelector<HTMLTextAreaElement>('#admin-user-ban-reason')!;
      textarea.value = 'Spam';
      textarea.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    it('links each pending count to its queue filtered to this person', async () => {
      const { el } = await setup(makeApiMock(withPending()));
      const href = (id: string) =>
        el.querySelector(`[data-testid="${id}"] a`)?.getAttribute('href');
      expect(href('user-pending-reviews')).toBe(`/admin/reviews?account=${USER_ID}`);
      expect(href('user-pending-updates')).toBe(`/admin/review-updates?account=${USER_ID}`);
      expect(href('user-pending-replies')).toBe(`/admin/review-responses?account=${USER_ID}`);
      expect(el.querySelector('[data-testid="user-pending-updates"] a')?.textContent).toContain(
        '1',
      );
    });

    it('offers the checkbox, checked, with the total, and sends reject_pending', async () => {
      const { el, fixture, bans } = await setup(makeApiMock(withPending()));
      await openAndType(fixture, el);
      const box = el.querySelector<HTMLInputElement>('[data-testid="ban-reject-pending"]')!;
      expect(box.checked).toBe(true);
      expect(el.querySelector('[data-testid="ban-pending-choice"]')?.textContent).toContain(
        'Also reject 3 pending items',
      );
      await click(fixture, buttonByText(el, 'Confirm ban')!);
      expect(bans.ban).toHaveBeenCalledWith(USER_ID, {
        action: 'ban',
        reason: 'Spam',
        reject_pending: true,
      });
    });

    it('an unticked box bans without rejecting', async () => {
      const { el, fixture, bans } = await setup(makeApiMock(withPending()));
      await openAndType(fixture, el);
      const box = el.querySelector<HTMLInputElement>('[data-testid="ban-reject-pending"]')!;
      box.click();
      fixture.detectChanges();
      await click(fixture, buttonByText(el, 'Confirm ban')!);
      expect(bans.ban).toHaveBeenCalledWith(USER_ID, { action: 'ban', reason: 'Spam' });
    });

    it('shows no checkbox when nothing is pending', async () => {
      const { el, fixture } = await setup();
      await click(fixture, buttonByText(el, 'Ban this account')!);
      expect(el.querySelector('[data-testid="ban-reject-pending"]')).toBeNull();
    });

    it('on BAN_PENDING_CHANGED refetches the counts and keeps the form open', async () => {
      const api = makeApiMock(withPending());
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce({
        status: 409,
        error: { error: { code: 'BAN_PENDING_CHANGED' } },
      });
      const { el, fixture } = await setup(api, bans);
      await openAndType(fixture, el);
      const fresh = withPending();
      fresh.counts.reviews.pending = 5;
      api.getUser.mockResolvedValueOnce(fresh);
      await click(fixture, buttonByText(el, 'Confirm ban')!);
      await settle();
      fixture.detectChanges();

      expect(api.getUser).toHaveBeenCalledTimes(2);
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        'Their pending items changed',
      );
      expect(el.querySelector('#admin-user-ban-reason')).not.toBeNull();
      expect(el.querySelector('[data-testid="ban-pending-choice"]')?.textContent).toContain(
        'Also reject 6 pending items',
      );
    });

    it('says how many were rejected', async () => {
      const bans = makeBansMock();
      bans.ban.mockResolvedValueOnce({
        reviewer_id: USER_ID,
        banned_at: '2026-08-28T00:00:00.000Z',
        ban_reason: 'Spam',
        rejected: { reviews: 2, review_updates: 1, review_responses: 0 },
      });
      const { el, fixture } = await setup(makeApiMock(withPending()), bans);
      await openAndType(fixture, el);
      await click(fixture, buttonByText(el, 'Confirm ban')!);
      expect(el.querySelector('[role="status"]')?.textContent).toContain(
        '3 pending items rejected',
      );
    });
  });

  // AECI-1989: every ban step removes or disables the button the operator
  // pressed. Each test asserts where focus lands, so it never falls to <body>.
  describe('focus after each ban step (AECI-1989)', () => {
    const active = () => document.activeElement as HTMLElement | null;

    async function typeReason(fixture: { detectChanges: () => void }, el: HTMLElement) {
      const textarea = el.querySelector<HTMLTextAreaElement>('#admin-user-ban-reason')!;
      textarea.value = 'Coordinated spam.';
      textarea.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    it('opening the form focuses the reason, and Cancel returns to the ban button', async () => {
      const { el, fixture } = await setup();
      await click(fixture, buttonByText(el, 'Ban this account')!);
      expect(active()?.id).toBe('admin-user-ban-reason');

      await click(fixture, buttonByText(el, 'Cancel')!);
      expect(active()).toBe(buttonByText(el, 'Ban this account'));
    });

    // AECI-2128: the console's inline-form rule.
    const escape = (target: EventTarget) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    it('Escape closes the ban form and returns focus to the ban button', async () => {
      const { el, fixture, bans } = await setup();
      await click(fixture, buttonByText(el, 'Ban this account')!);
      escape(el.querySelector('#admin-user-ban-reason')!);
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();
      expect(el.querySelector('#admin-user-ban-reason')).toBeNull();
      expect(active()).toBe(buttonByText(el, 'Ban this account'));
      expect(bans.ban).not.toHaveBeenCalled();
    });

    it('Escape does nothing while the ban is in flight', async () => {
      const bans = makeBansMock();
      let resolve!: (v: { banned_at: string; ban_reason: string }) => void;
      bans.ban.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      const { el, fixture } = await setup(makeApiMock(), bans);
      await click(fixture, buttonByText(el, 'Ban this account')!);
      await typeReason(fixture, el);
      buttonByText(el, 'Confirm ban')!.click();
      fixture.detectChanges();
      escape(el.querySelector('#admin-user-ban-reason')!);
      fixture.detectChanges();
      expect(el.querySelector('#admin-user-ban-reason')).not.toBeNull();
      expect(el.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
      resolve({ banned_at: '2026-11-20T00:00:00.000Z', ban_reason: 'Coordinated spam.' });
      await settle();
      fixture.detectChanges();
    });

    it('the ban confirm is the danger button and its opener is secondary', async () => {
      const { el, fixture } = await setup();
      const opener = buttonByText(el, 'Ban this account')!;
      expect(opener.classList).toContain('aec-btn-secondary');
      await click(fixture, opener);
      expect(buttonByText(el, 'Confirm ban')!.classList).toContain('bg-(--status-error)');
    });

    it('an empty reason keeps focus on the reason', async () => {
      const { el, fixture } = await setup();
      await click(fixture, buttonByText(el, 'Ban this account')!);
      await click(fixture, buttonByText(el, 'Confirm ban')!);
      expect(active()?.id).toBe('admin-user-ban-reason');
    });

    it('a last-seat refusal focuses its message', async () => {
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce({
        status: 409,
        error: {
          error: { code: 'VENDOR_LAST_SEAT_USE_SUSPEND', details: { vendor_id: VENDOR_ID } },
        },
      });
      const { el, fixture } = await setup(makeApiMock(), bans);
      await click(fixture, buttonByText(el, 'Ban this account')!);
      await typeReason(fixture, el);
      await click(fixture, buttonByText(el, 'Confirm ban')!);

      expect(active()?.getAttribute('role')).toBe('alert');
      expect(active()?.textContent).toContain("This is the vendor's last unbanned seat");
    });

    it('a generic refusal focuses its message', async () => {
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce({ status: 403 });
      const { el, fixture } = await setup(makeApiMock(), bans);
      await click(fixture, buttonByText(el, 'Ban this account')!);
      await typeReason(fixture, el);
      await click(fixture, buttonByText(el, 'Confirm ban')!);

      expect(active()?.getAttribute('role')).toBe('alert');
      expect(active()?.textContent).toContain("Admin accounts can't be banned");
    });

    it('a ban focuses the "Banned since" status, and a reinstate returns to the ban button', async () => {
      const { el, fixture } = await setup();
      await click(fixture, buttonByText(el, 'Ban this account')!);
      await typeReason(fixture, el);
      await click(fixture, buttonByText(el, 'Confirm ban')!);
      expect(active()?.textContent).toContain('Banned since');

      await click(fixture, buttonByText(el, 'Reinstate')!);
      expect(active()).toBe(buttonByText(el, 'Ban this account'));
    });

    it('a 422 focuses its message once the page has reloaded', async () => {
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce({ status: 422 });
      const banned = makeUser({ banned_at: '2026-08-01T00:00:00.000Z', ban_reason: 'Spam.' });
      const { el, fixture } = await setup(makeApiMock(banned), bans);
      await click(fixture, buttonByText(el, 'Reinstate')!);
      await settle();
      fixture.detectChanges();

      expect(active()?.getAttribute('role')).toBe('alert');
      expect(active()?.textContent).toContain('was not banned');
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

    it('says a reinstate re-owns the records and restores no license (AECI-1589)', async () => {
      const { el } = await setup(makeApiMock(banned()));
      const text = (el.textContent ?? '').replace(/\s+/g, ' ');
      expect(text).toContain(
        "Reinstating a seat on a terminated vendor makes the company the owner of its records again. It restores no subscription: Terminate ended those, so grant complimentary subscriptions for the term from the vendor's Billing section.",
      );
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

  // AECI-1296: the onboarding answers, LinkedIn included, on the detail only.
  it('renders the About them answers as labels with the LinkedIn link', async () => {
    const { el } = await setup(
      makeApiMock(
        makeUser({
          about: {
            company_type: 'general_contractor',
            company_size: '201-1000',
            primary_role: 'practitioner',
            firm_name: 'Turner Build',
            linkedin_url: 'https://www.linkedin.com/in/rita',
            audiences: [{ id: USER_ID, name: 'Estimator', slug: 'estimator' }],
            onboarding: 'completed',
            found_via: 'ai_tool',
            found_via_detail: 'best estimating integrations',
          },
        }),
      ),
    );
    const about = el.querySelector('[data-testid="admin-user-about"]') as HTMLElement;
    expect(about.textContent).toContain('General contractor');
    expect(about.textContent).toContain('201 to 1,000 people');
    expect(about.textContent).toContain('Hands-on user');
    expect(about.textContent).toContain('Turner Build');
    expect(about.textContent).toContain('Estimator');
    expect(about.textContent).toContain('Answered');
    // AECI-2208: the About you answer, labelled as the claim detail labels it.
    const found = about.querySelector('[data-testid="admin-user-found-via"]') as HTMLElement;
    expect(found.textContent).toContain('Found us via');
    expect(found.textContent).toContain('ChatGPT, Claude, Perplexity or another AI tool');
    expect(found.textContent).toContain('best estimating integrations');
    const link = about.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.linkedin.com/in/rita');
    expect(link.getAttribute('rel')).toBe('noopener nofollow');
  });

  it('shows "Not answered" for a user who left the found-via question blank', async () => {
    const { el } = await setup();
    const found = el.querySelector('[data-testid="admin-user-found-via"]') as HTMLElement;
    expect(found.textContent).toContain('Not answered');
    expect(found.textContent).not.toContain('·');
  });

  describe('audit trail (AECI-693)', () => {
    const section = (el: HTMLElement) =>
      el.querySelector('section[aria-labelledby="admin-user-audit"]') as HTMLElement;
    const scopeButton = (el: HTMLElement, label: string) =>
      buttonByText(section(el).querySelector('[role="group"]') as HTMLElement, label)!;

    it('is headed "Audit trail" and never says "Activity"', async () => {
      const { el } = await setup();
      const heading = el.querySelector('#admin-user-audit');
      expect(heading?.tagName).toBe('H3');
      expect(heading?.textContent?.trim()).toBe('Audit trail');
      expect(el.textContent).not.toMatch(/activity/i);
    });

    it('loads page 1 of everything once the account resolves, and renders the rows', async () => {
      const { el, api } = await setup();
      expect(api.listAudit).toHaveBeenCalledTimes(1);
      expect(api.listAudit).toHaveBeenCalledWith(USER_ID, { page: 1, perPage: 25, scope: 'all' });
      const trail = el.querySelector('aec-audit-trail') as HTMLElement;
      expect(trail.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
      expect(trail.textContent).toContain('Ops Admin');
    });

    it('does not fetch a trail for an unknown account', async () => {
      const api = makeApiMock();
      api.getUser.mockRejectedValueOnce({ status: 404 });
      await setup(api);
      expect(api.listAudit).not.toHaveBeenCalled();
    });

    it('marks the selected scope with aria-pressed, refetches, and resets to page 1', async () => {
      const api = makeApiMock(makeUser(), makeAudit([makeAuditRow()], { total: 60 }));
      const { el, fixture } = await setup(api);
      expect(scopeButton(el, 'Everything').getAttribute('aria-pressed')).toBe('true');
      expect(scopeButton(el, 'Done to this person').getAttribute('aria-pressed')).toBe('false');

      await click(
        fixture,
        buttonByText(el.querySelector('aec-audit-trail') as HTMLElement, 'Next')!,
      );
      expect(api.listAudit).toHaveBeenLastCalledWith(USER_ID, {
        page: 2,
        perPage: 25,
        scope: 'all',
      });

      await click(fixture, scopeButton(el, 'Done by this person'));
      expect(api.listAudit).toHaveBeenLastCalledWith(USER_ID, {
        page: 1,
        perPage: 25,
        scope: 'actor',
      });
      expect(scopeButton(el, 'Done by this person').getAttribute('aria-pressed')).toBe('true');
      expect(scopeButton(el, 'Everything').getAttribute('aria-pressed')).toBe('false');

      await click(fixture, scopeButton(el, 'Done to this person'));
      expect(api.listAudit).toHaveBeenLastCalledWith(USER_ID, {
        page: 1,
        perPage: 25,
        scope: 'entity',
      });

      // Pressing the selected scope again does not refetch.
      const calls = api.listAudit.mock.calls.length;
      await click(fixture, scopeButton(el, 'Done to this person'));
      expect(api.listAudit).toHaveBeenCalledTimes(calls);
    });

    it('drops a superseded response that resolves after the newer one', async () => {
      const api = makeApiMock();
      const { el, fixture } = await setup(api);

      // Two quick scope presses. The first request (actor) resolves LAST.
      let resolveActor!: (r: AdminUserAuditResponse) => void;
      let resolveEntity!: (r: AdminUserAuditResponse) => void;
      api.listAudit
        .mockImplementationOnce(() => new Promise((r) => (resolveActor = r)))
        .mockImplementationOnce(() => new Promise((r) => (resolveEntity = r)));
      scopeButton(el, 'Done by this person').click();
      scopeButton(el, 'Done to this person').click();

      resolveEntity(
        makeAudit([
          makeAuditRow({ actor: { id: ADMIN_ID, display_name: 'Entity Row', email: null } }),
        ]),
      );
      await settle();
      resolveActor(
        makeAudit([
          makeAuditRow({ actor: { id: ADMIN_ID, display_name: 'Stale Row', email: null } }),
        ]),
      );
      await settle();
      fixture.detectChanges();

      const trail = el.querySelector('aec-audit-trail') as HTMLElement;
      expect(scopeButton(el, 'Done to this person').getAttribute('aria-pressed')).toBe('true');
      expect(trail.textContent).toContain('Entity Row');
      expect(trail.textContent).not.toContain('Stale Row');
      expect(trail.getAttribute('aria-busy')).not.toBe('true');
    });

    it('fails soft with a retry that refetches the trail alone', async () => {
      const api = makeApiMock();
      api.listAudit.mockRejectedValueOnce({ status: 500 });
      const { el, fixture } = await setup(api);
      expect(el.textContent).toContain('Rita Reviewer');
      const trail = el.querySelector('aec-audit-trail') as HTMLElement;
      expect(trail.querySelector('[role="alert"]')).not.toBeNull();

      await click(fixture, buttonByText(trail, 'Try again')!);
      expect(api.listAudit).toHaveBeenCalledTimes(2);
      expect(api.getUser).toHaveBeenCalledTimes(1);
      expect(el.querySelector('aec-audit-trail [role="alert"]')).toBeNull();
    });

    it('reloads the trail at page 1 after a ban', async () => {
      const api = makeApiMock(makeUser(), makeAudit([makeAuditRow()], { total: 60 }));
      const { el, fixture } = await setup(api);
      await click(
        fixture,
        buttonByText(el.querySelector('aec-audit-trail') as HTMLElement, 'Next')!,
      );
      expect(api.listAudit).toHaveBeenLastCalledWith(USER_ID, expect.objectContaining({ page: 2 }));

      await click(fixture, buttonByText(el, 'Ban this account')!);
      const textarea = el.querySelector('textarea')!;
      textarea.value = 'Coordinated spam.';
      textarea.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await click(fixture, buttonByText(el, 'Confirm ban')!);

      expect(api.listAudit).toHaveBeenCalledTimes(3);
      expect(api.listAudit).toHaveBeenLastCalledWith(USER_ID, {
        page: 1,
        perPage: 25,
        scope: 'all',
      });
    });

    it('reloads the trail after a reinstate', async () => {
      const api = makeApiMock(
        makeUser({ banned_at: '2026-08-01T00:00:00.000Z', ban_reason: 'Spam.' }),
      );
      const { el, fixture } = await setup(api);
      await click(fixture, buttonByText(el, 'Reinstate')!);
      expect(api.listAudit).toHaveBeenCalledTimes(2);
    });

    it('does not reload the trail when the ban fails', async () => {
      const bans = makeBansMock();
      bans.ban.mockRejectedValueOnce({ status: 500 });
      const api = makeApiMock(
        makeUser({ banned_at: '2026-08-01T00:00:00.000Z', ban_reason: 'Spam.' }),
      );
      const { el, fixture } = await setup(api, bans);
      await click(fixture, buttonByText(el, 'Reinstate')!);
      expect(api.listAudit).toHaveBeenCalledTimes(1);
    });

    it('links into the global audit log by actor and by profile entity', async () => {
      const { el } = await setup();
      const hrefs = [...section(el).querySelectorAll(':scope > p a')].map((a) =>
        a.getAttribute('href'),
      );
      expect(hrefs).toEqual([
        `/admin/audit?actor_id=${USER_ID}`,
        `/admin/audit?entity_type=profile&entity_id=${USER_ID}`,
      ]);
    });
  });
});
