import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  VENDOR_PENDING_SEAT_CLAIMS_FIXTURE,
  VENDOR_SEATS_FIXTURE,
  VENDOR_SEAT_INVITES_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorSeatRoster } from './vendor-seat-roster';

/**
 * `VendorSeatRoster` (AECI-522) lazily loads `GET /api/vendor/seats` after paint
 * and must degrade gracefully: a null email → "Email unavailable", a null name →
 * "Unnamed admin", a banned seat → the "Banned" chip (still listed), and a fetch
 * failure → a retryable error, never a crash.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorSeatRoster', () => {
  let getSeats: ReturnType<typeof vi.fn>;
  let inviteSeat: ReturnType<typeof vi.fn>;
  let revokeInvite: ReturnType<typeof vi.fn>;
  let removeSeat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getSeats = vi.fn();
    inviteSeat = vi.fn().mockResolvedValue({ invite: {} });
    revokeInvite = vi.fn().mockResolvedValue(undefined);
    removeSeat = vi.fn().mockResolvedValue(undefined);
    // Reset explicitly: the roster's state now lives in a per-surface
    // `VendorPortalStore`, so a store carried over from a previous test would
    // make `ensure()` a no-op and the next case would assert against stale data.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        {
          provide: VendorApi,
          useValue: { getSeats, inviteSeat, revokeInvite, removeSeat } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function create(): Promise<ComponentFixture<VendorSeatRoster>> {
    const fixture = TestBed.createComponent(VendorSeatRoster);
    fixture.detectChanges(); // triggers afterNextRender -> load()
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  it('renders the roster with graceful fallbacks for null email / name and banned seats', async () => {
    getSeats.mockResolvedValue({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: [],
      can_manage_seats: false,
    });
    const fixture = await create();
    const text = fixture.nativeElement.textContent as string;

    expect(fixture.nativeElement.querySelector('table')).not.toBeNull();
    expect(text).toContain('Dana Ruiz');
    expect(text).toContain('dana@summitbim.example.com');
    // The third fixture seat has a null name + null email + banned=true.
    expect(text).toContain('Unnamed admin');
    expect(text).toContain('Email unavailable');
    expect(text).toContain('Banned');
    expect(text).toContain('Active');
  });

  it('shows a retryable error on a failed fetch, then recovers on retry', async () => {
    getSeats.mockRejectedValueOnce(new Error('boom'));
    const fixture = await create();

    const retry = fixture.nativeElement.querySelector('button');
    expect(retry).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Could not load the seat list');

    // Retry now succeeds → the table renders.
    getSeats.mockResolvedValue({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: [],
      can_manage_seats: false,
    });
    (retry as HTMLButtonElement).click();
    await flush();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('table')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Dana Ruiz');
  });
});

/**
 * The §11a owner controls (AECI-664). The point of these cases is that the
 * surface is driven by the SERVER's `can_manage_seats`, never by anything the
 * browser infers — a control that renders when the API would 403 is worse than
 * no control, because it turns a clear "you can't do that" into a mystery
 * failure.
 */
describe('VendorSeatRoster — seat management (§11a)', () => {
  let getSeats: ReturnType<typeof vi.fn>;
  let removeSeat: ReturnType<typeof vi.fn>;
  let revokeInvite: ReturnType<typeof vi.fn>;
  let resendInvite: ReturnType<typeof vi.fn>;

  function setup(payload: unknown) {
    getSeats = vi.fn().mockResolvedValue(payload);
    removeSeat = vi.fn().mockResolvedValue(undefined);
    revokeInvite = vi.fn().mockResolvedValue(undefined);
    resendInvite = vi.fn().mockResolvedValue({ invite: VENDOR_SEAT_INVITES_FIXTURE[0] });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        {
          provide: VendorApi,
          useValue: {
            getSeats,
            removeSeat,
            revokeInvite,
            resendInvite,
            inviteSeat: vi.fn(),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  }

  /** The first button whose text starts with `label`. */
  const buttonStartingWith = (fixture: ComponentFixture<VendorSeatRoster>, label: string) =>
    ([...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
      b.textContent?.trim().startsWith(label),
    )!;

  /** Every Resend button on screen, in fixture order. */
  const resendButtons = (fixture: ComponentFixture<VendorSeatRoster>) =>
    ([...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[]).filter((b) =>
      b.textContent?.includes('Resend'),
    );

  async function render(): Promise<ComponentFixture<VendorSeatRoster>> {
    const fixture = TestBed.createComponent(VendorSeatRoster);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => vi.restoreAllMocks());

  it('hides every control from a member seat', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: false,
    });
    const fixture = await render();
    const text = fixture.nativeElement.textContent as string;

    expect(text).not.toContain('Remove');
    expect(text).not.toContain('Revoke');
    expect(text).not.toContain('Resend');
    // But it still names who to ask, which is the whole point of showing the
    // owner badge to a non-owner.
    expect(text).toContain('Ask an account owner');
    expect(text).toContain('Owner');
  });

  it('shows pending invites and Remove to an owner', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Pending invites');
    expect(text).toContain('jordan@summitbim.example.com');
    expect(text).toContain('Remove');
    // Creating an invite is NOT here — it moved to `VendorSeatInviteDialog`,
    // triggered from the section heading. The roster carries no form at all now.
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('keeps a space before the sr-only name on Remove, Resend and Revoke (AECI-1469)', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    const revoke = buttons.find((b) => b.textContent?.trim().startsWith('Revoke'))!;
    expect(revoke.textContent?.trim()).toBe('Revoke jordan@summitbim.example.com');
    const named = buttons.filter((b) => b.querySelector('.sr-only'));
    for (const verb of ['Remove', 'Resend', 'Revoke']) {
      expect(named.some((b) => b.textContent?.trim().startsWith(verb))).toBe(true);
    }
    for (const b of named) {
      const name = b.querySelector('.sr-only')!.textContent!.trim();
      expect(b.textContent?.trim().endsWith(` ${name}`)).toBe(true);
    }
  });

  it('never offers Remove on the caller’s OWN row', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: [],
      can_manage_seats: true,
    });
    const fixture = await render();
    const rows = [...fixture.nativeElement.querySelectorAll('tbody tr')] as HTMLElement[];
    // Fixture seat 0 is `is_self: true`; seats 1 and 2 are not.
    expect(rows[0]!.querySelector('button')).toBeNull();
    expect(rows[1]!.querySelector('button')).not.toBeNull();
    expect(rows[0]!.textContent).toContain('(you)');
  });

  it('revokes a pending invite and re-reads the server’s list', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    const revoke = [...fixture.nativeElement.querySelectorAll('button')].find((b) =>
      (b as HTMLElement).textContent?.includes('Revoke'),
    ) as HTMLButtonElement;

    revoke.click();
    fixture.detectChanges();
    // AECI-2129: the row button only opens the confirm.
    expect(revokeInvite).not.toHaveBeenCalled();
    buttonStartingWith(fixture, 'Revoke invite').click();
    await flush();
    fixture.detectChanges();

    expect(revokeInvite).toHaveBeenCalledWith(VENDOR_SEAT_INVITES_FIXTURE[0]!.id);
    // Pessimistic: the list comes back from the server, never spliced locally.
    expect(getSeats).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed removal instead of silently doing nothing', async () => {
    setup({ seats: VENDOR_SEATS_FIXTURE, pending_invites: [], can_manage_seats: true });
    const fixture = await render();
    removeSeat.mockRejectedValueOnce(new Error('nope'));

    const remove = [...fixture.nativeElement.querySelectorAll('button')].find((b) =>
      (b as HTMLElement).textContent?.includes('Remove'),
    ) as HTMLButtonElement;
    remove.click();
    fixture.detectChanges();
    buttonStartingWith(fixture, 'Remove seat').click();
    await flush();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Could not remove that seat');
  });

  it('offers Resend only where the SERVER says the invite may be re-sent', async () => {
    // The fixture carries one invite per state. The UI must never re-derive the
    // cooldown or the send cap — hiding a control the API would refuse and
    // showing one it would accept have to come from the same source.
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    const buttons = resendButtons(fixture);

    expect(buttons).toHaveLength(3);
    expect(buttons[0]!.disabled).toBe(false); // resend_state: 'ok'
    expect(buttons[1]!.disabled).toBe(true); // 'cooling_down'
    expect(buttons[2]!.disabled).toBe(true); // 'send_limit'
  });

  it('explains WHY a disabled Resend is disabled, and differently for each reason', async () => {
    // A dead button with no reason is a dead end, and the two refusals need
    // opposite next steps: one resolves by waiting, the other never does.
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    const buttons = resendButtons(fixture);

    expect(buttons[0]!.getAttribute('title')).toBeNull();
    expect(buttons[1]!.getAttribute('title')).toContain('few minutes');
    expect(buttons[2]!.getAttribute('title')).toContain('Revoke it and invite them again');
    // ...and the reason reaches a screen reader, not just a hover.
    expect(buttons[2]!.textContent).toContain('Revoke it and invite them again');
  });

  it('re-sends, announces it, and re-reads the server’s list', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();

    resendButtons(fixture)[0]!.click();
    await flush();
    fixture.detectChanges();

    expect(resendInvite).toHaveBeenCalledWith(VENDOR_SEAT_INVITES_FIXTURE[0]!.id);
    // A successful re-send moves no row, so without the status line the only
    // feedback would be a button going quiet — which reads like a failure.
    const status = fixture.nativeElement.querySelector('[data-seats-status]') as HTMLElement | null;
    expect(status?.textContent).toContain('Invite sent again');
    expect(status?.textContent).toContain('jordan@summitbim.example.com');
    // AECI-1812: the line is plain text. The portal's one live region says it, once.
    expect(fixture.nativeElement.querySelector('[role="status"], [aria-live]')).toBeNull();
    expect(TestBed.inject(VendorPortalAnnouncer).message().trim()).toBe(
      status?.textContent?.trim(),
    );
    // Pessimistic: the new expiry and the cooldown verdict come from the server.
    expect(getSeats).toHaveBeenCalledTimes(2);
  });

  it('does not label the Resend button "Sending…" while a REVOKE is in flight', async () => {
    // The busy signal names the row AND the action. Keyed on the row alone, a
    // revoke put the neighbouring Resend button into its sending state — on a row
    // where nothing was being sent, and sometimes where nothing COULD be.
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    let release: () => void = () => {};
    revokeInvite.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    // Queried BY POSITION, not by label: a text filter would silently drop the
    // very button under test the moment it changed its label, and pass vacuously.
    const inviteRow = [...fixture.nativeElement.querySelectorAll('li')].at(-3) as HTMLElement;
    const [resendBtn, revokeBtn] = [...inviteRow.querySelectorAll('button')] as HTMLButtonElement[];

    revokeBtn!.click();
    fixture.detectChanges();
    buttonStartingWith(fixture, 'Revoke invite').click();
    fixture.detectChanges();

    expect(resendBtn!.textContent).toContain('Resend');
    expect(resendBtn!.textContent).not.toContain('Sending');
    expect(fixture.nativeElement.textContent).not.toContain('Sending');

    release();
    await flush();
  });

  it('clears a stale re-send confirmation when the next action is a seat removal', async () => {
    // `actionStatus` is a success line, not a log: left standing it would read as
    // if it described the removal.
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();

    resendButtons(fixture)[0]!.click();
    await flush();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Invite sent again');

    ([...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[])
      .filter((b) => b.textContent?.includes('Remove'))
      .at(0)!
      .click();
    fixture.detectChanges();
    buttonStartingWith(fixture, 'Remove seat').click();
    await flush();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Invite sent again');
  });

  it('shows when each invite was last sent, falling back to created_at', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    const items = [...fixture.nativeElement.querySelectorAll('li')] as HTMLElement[];

    // Never re-sent → the creation date, not "never".
    expect(items[0]!.textContent).toContain('Aug 20, 2026');
    // Re-sent → the re-send date, not the creation date.
    expect(items[1]!.textContent).toContain('Aug 26, 2026');
  });

  it('maps the cooldown 429 onto copy that says waiting fixes it', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    resendInvite.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 429, error: { error: { code: 'RATE_LIMITED' } } }),
    );

    resendButtons(fixture)[0]!.click();
    await flush();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Give it a few minutes');
  });

  it('maps the send-cap 422 onto revoke-and-re-invite, not "try again"', async () => {
    // The distinction the two statuses exist to carry: waiting never clears this
    // one, so the copy must not imply that it will.
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    resendInvite.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 422,
        error: { error: { code: 'INVALID_STATE_TRANSITION' } },
      }),
    );

    resendButtons(fixture)[0]!.click();
    await flush();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Revoke it and invite them again');
    expect(text).not.toContain('Give it a few minutes');
  });

  // ─── AECI-2129: Remove and Revoke ask first ────────────────────────────────

  const PRIYA = VENDOR_SEATS_FIXTURE[1]!;
  const BANNED = VENDOR_SEATS_FIXTURE[2]!;
  const SECOND_OWNER = {
    ...PRIYA,
    user_id: '00000000-0000-4000-8000-0000000052b9',
    display_name: 'Sam Okafor',
    email: 'sam@summitbim.example.com',
    owner: true,
  };

  const q = (fixture: ComponentFixture<VendorSeatRoster>, selector: string) =>
    fixture.nativeElement.querySelector(selector) as HTMLElement | null;

  /** Let the write settle, the re-read render and `afterNextRender` run. */
  async function settle(fixture: ComponentFixture<VendorSeatRoster>): Promise<void> {
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** The Seats page heading the roster falls back to. The page owns it. */
  function mountHeading(): HTMLElement {
    const h = document.createElement('h2');
    h.id = 'vendor-seats-heading';
    h.tabIndex = -1;
    document.body.appendChild(h);
    return h;
  }

  it('opens a danger confirm from the secondary Remove and focuses its question', async () => {
    setup({ seats: VENDOR_SEATS_FIXTURE, pending_invites: [], can_manage_seats: true });
    const fixture = await render();
    const opener = q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`)!;
    expect(opener.getAttribute('data-variant')).toBe('secondary');

    opener.click();
    await settle(fixture);

    expect(removeSeat).not.toHaveBeenCalled();
    const confirm = q(fixture, `[data-seat-confirm="${PRIYA.user_id}"]`)!;
    const question = q(fixture, `#vendor-seat-remove-confirm-${PRIYA.user_id}`)!;
    expect(question.textContent?.trim()).toBe(
      "Remove Priya Natarajan's seat? They lose access to the vendor portal straight away. Inviting them again gives them a new seat.",
    );
    expect(document.activeElement).toBe(question);
    const [yes, cancel] = [...confirm.querySelectorAll('button')] as HTMLButtonElement[];
    expect(yes!.textContent?.trim()).toBe('Remove seat Priya Natarajan');
    expect(yes!.getAttribute('data-variant')).toBe('danger');
    expect(cancel!.textContent?.trim()).toBe('Cancel');
    expect(cancel!.getAttribute('data-variant')).toBe('secondary');
    // The row button gives way to the confirm.
    expect(q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`)).toBeNull();
  });

  it('adds the owner sentence on an owner’s row only', async () => {
    setup({
      seats: [...VENDOR_SEATS_FIXTURE, SECOND_OWNER],
      pending_invites: [],
      can_manage_seats: true,
    });
    const fixture = await render();

    q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`)!.click();
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('owner status');

    q(fixture, `#vendor-seat-remove-start-${SECOND_OWNER.user_id}`)!.click();
    await settle(fixture);
    const question = q(fixture, `#vendor-seat-remove-confirm-${SECOND_OWNER.user_id}`)!;
    expect(question.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      "Remove Sam Okafor's seat? They lose access to the vendor portal straight away. Inviting them again gives them a new seat. Their owner status does not come back with a new invite.",
    );
    // One confirm at a time: opening the second closed the first.
    expect(fixture.nativeElement.querySelectorAll('[data-seat-confirm]')).toHaveLength(1);
  });

  it('Cancel closes the confirm, writes nothing and returns focus to Remove', async () => {
    setup({ seats: VENDOR_SEATS_FIXTURE, pending_invites: [], can_manage_seats: true });
    const fixture = await render();
    q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`)!.click();
    await settle(fixture);

    buttonStartingWith(fixture, 'Cancel').click();
    await settle(fixture);

    expect(q(fixture, '[data-seat-confirm]')).toBeNull();
    expect(removeSeat).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`));
  });

  it('Cancel on a Revoke confirm returns focus to Revoke', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    const invite = VENDOR_SEAT_INVITES_FIXTURE[1]!;
    const opener = q(fixture, `#vendor-invite-revoke-start-${invite.id}`)!;
    expect(opener.getAttribute('data-variant')).toBe('secondary');
    opener.click();
    await settle(fixture);

    const question = q(fixture, `#vendor-invite-revoke-confirm-${invite.id}`)!;
    expect(question.textContent?.trim()).toBe(
      "Revoke the invite to agency@example.com? The link stops working. A new invite sends a new email and counts toward today's limit.",
    );
    expect(document.activeElement).toBe(question);
    expect(buttonStartingWith(fixture, 'Revoke invite').getAttribute('data-variant')).toBe(
      'danger',
    );

    buttonStartingWith(fixture, 'Cancel').click();
    await settle(fixture);

    expect(revokeInvite).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q(fixture, `#vendor-invite-revoke-start-${invite.id}`));
  });

  it('after a removal, focuses the next row’s control and announces once', async () => {
    setup({ seats: VENDOR_SEATS_FIXTURE, pending_invites: [], can_manage_seats: true });
    const fixture = await render();
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    getSeats.mockResolvedValue({
      seats: VENDOR_SEATS_FIXTURE.filter((s) => s.user_id !== PRIYA.user_id),
      pending_invites: [],
      can_manage_seats: true,
    });

    q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`)!.click();
    await settle(fixture);
    buttonStartingWith(fixture, 'Remove seat').click();
    await settle(fixture);

    expect(removeSeat).toHaveBeenCalledTimes(1);
    expect(removeSeat).toHaveBeenCalledWith(PRIYA.user_id);
    expect(q(fixture, `[data-seat-row="${PRIYA.user_id}"]`)).toBeNull();
    expect(q(fixture, '[data-seat-confirm]')).toBeNull();
    expect(document.activeElement).toBe(q(fixture, `#vendor-seat-remove-start-${BANNED.user_id}`));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Seat removed for Priya Natarajan.');
    expect(q(fixture, '[data-seats-status]')?.textContent?.trim()).toBe(
      'Seat removed for Priya Natarajan.',
    );
    expect(fixture.nativeElement.querySelector('[role="status"], [aria-live]')).toBeNull();
  });

  it('after removing the last row, focuses the previous row’s control', async () => {
    setup({ seats: VENDOR_SEATS_FIXTURE, pending_invites: [], can_manage_seats: true });
    const fixture = await render();
    getSeats.mockResolvedValue({
      seats: VENDOR_SEATS_FIXTURE.filter((s) => s.user_id !== BANNED.user_id),
      pending_invites: [],
      can_manage_seats: true,
    });

    q(fixture, `#vendor-seat-remove-start-${BANNED.user_id}`)!.click();
    await settle(fixture);
    buttonStartingWith(fixture, 'Remove seat').click();
    await settle(fixture);

    expect(document.activeElement).toBe(q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`));
  });

  it('after a removal leaves no row with a control, focuses the section heading', async () => {
    const heading = mountHeading();
    try {
      const seats = VENDOR_SEATS_FIXTURE.slice(0, 2);
      setup({ seats, pending_invites: [], can_manage_seats: true });
      const fixture = await render();
      getSeats.mockResolvedValue({
        seats: seats.slice(0, 1),
        pending_invites: [],
        can_manage_seats: true,
      });

      q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`)!.click();
      await settle(fixture);
      buttonStartingWith(fixture, 'Remove seat').click();
      await settle(fixture);

      expect(document.activeElement).toBe(heading);
    } finally {
      heading.remove();
    }
  });

  it('revokes from the confirm, announces once and focuses the next invite', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const [first, second] = VENDOR_SEAT_INVITES_FIXTURE;
    getSeats.mockResolvedValue({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE.slice(1),
      can_manage_seats: true,
    });

    q(fixture, `#vendor-invite-revoke-start-${first!.id}`)!.click();
    await settle(fixture);
    buttonStartingWith(fixture, 'Revoke invite').click();
    await settle(fixture);

    expect(revokeInvite).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Invite to jordan@summitbim.example.com revoked.');
    // The next invite's Resend is disabled (cooling down), so its Revoke takes focus.
    expect(document.activeElement).toBe(q(fixture, `#vendor-invite-revoke-start-${second!.id}`));
  });

  it('after revoking the only invite, focuses the section heading', async () => {
    const heading = mountHeading();
    try {
      const only = VENDOR_SEAT_INVITES_FIXTURE[0]!;
      setup({ seats: VENDOR_SEATS_FIXTURE, pending_invites: [only], can_manage_seats: true });
      const fixture = await render();
      getSeats.mockResolvedValue({
        seats: VENDOR_SEATS_FIXTURE,
        pending_invites: [],
        can_manage_seats: true,
      });

      q(fixture, `#vendor-invite-revoke-start-${only.id}`)!.click();
      await settle(fixture);
      buttonStartingWith(fixture, 'Revoke invite').click();
      await settle(fixture);

      expect(fixture.nativeElement.textContent).not.toContain('Pending invites');
      expect(document.activeElement).toBe(heading);
    } finally {
      heading.remove();
    }
  });

  it('a refused removal closes the confirm, shows an alert and moves focus to it', async () => {
    setup({ seats: VENDOR_SEATS_FIXTURE, pending_invites: [], can_manage_seats: true });
    const fixture = await render();
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    removeSeat.mockRejectedValueOnce(new Error('nope'));

    q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`)!.click();
    await settle(fixture);
    buttonStartingWith(fixture, 'Remove seat').click();
    await settle(fixture);

    const alert = q(fixture, '[role="alert"]')!;
    expect(alert.textContent?.trim()).toBe('Could not remove that seat. Try again.');
    expect(document.activeElement).toBe(alert);
    expect(q(fixture, '[data-seat-confirm]')).toBeNull();
    expect(announce).not.toHaveBeenCalled();
    // Not re-read: nothing changed on the server.
    expect(getSeats).toHaveBeenCalledTimes(1);
  });

  it('a refused revoke shows an alert and moves focus to it', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    revokeInvite.mockRejectedValueOnce(new Error('nope'));
    const invite = VENDOR_SEAT_INVITES_FIXTURE[0]!;

    q(fixture, `#vendor-invite-revoke-start-${invite.id}`)!.click();
    await settle(fixture);
    buttonStartingWith(fixture, 'Revoke invite').click();
    await settle(fixture);

    const alert = q(fixture, '[role="alert"]')!;
    expect(alert.textContent?.trim()).toBe('Could not revoke that invite. Try again.');
    expect(document.activeElement).toBe(alert);
    expect(q(fixture, '[data-invite-confirm]')).toBeNull();
  });

  it('marks the Remove confirm busy and blocks a second submit while it runs', async () => {
    setup({ seats: VENDOR_SEATS_FIXTURE, pending_invites: [], can_manage_seats: true });
    const fixture = await render();
    let release: () => void = () => {};
    removeSeat.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    q(fixture, `#vendor-seat-remove-start-${PRIYA.user_id}`)!.click();
    await settle(fixture);
    buttonStartingWith(fixture, 'Remove seat').click();
    fixture.detectChanges();

    const group = q(fixture, `[data-seat-confirm="${PRIYA.user_id}"] [aria-busy]`)!;
    expect(group.getAttribute('aria-busy')).toBe('true');
    const [yes, cancel] = [...group.querySelectorAll('button')] as HTMLButtonElement[];
    expect(yes!.disabled).toBe(true);
    expect(yes!.textContent).toContain('Removing…');
    expect(cancel!.disabled).toBe(true);
    yes!.click();
    expect(removeSeat).toHaveBeenCalledTimes(1);

    release();
    await settle(fixture);
  });

  it('marks the Revoke confirm busy and blocks a second submit while it runs', async () => {
    setup({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: VENDOR_SEAT_INVITES_FIXTURE,
      can_manage_seats: true,
    });
    const fixture = await render();
    let release: () => void = () => {};
    revokeInvite.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const invite = VENDOR_SEAT_INVITES_FIXTURE[0]!;

    q(fixture, `#vendor-invite-revoke-start-${invite.id}`)!.click();
    await settle(fixture);
    buttonStartingWith(fixture, 'Revoke invite').click();
    fixture.detectChanges();

    const group = q(fixture, `[data-invite-confirm="${invite.id}"]`)!;
    expect(group.getAttribute('aria-busy')).toBe('true');
    const [yes, cancel] = [...group.querySelectorAll('button')] as HTMLButtonElement[];
    expect(yes!.disabled).toBe(true);
    expect(yes!.textContent).toContain('Revoking…');
    expect(cancel!.disabled).toBe(true);
    yes!.click();
    expect(revokeInvite).toHaveBeenCalledTimes(1);

    release();
    await settle(fixture);
  });
});

/**
 * "Wants to join" (AECI-1368 / §11a.10): claims routed to the company's owners. The
 * list carries a stranger's contact details, so it renders for an owner only, and
 * every decision is pessimistic and re-read like the rest of the roster.
 */
describe('VendorSeatRoster — wants to join (AECI-1368)', () => {
  let getSeats: ReturnType<typeof vi.fn>;
  let acceptSeatClaim: ReturnType<typeof vi.fn>;
  let declineSeatClaim: ReturnType<typeof vi.fn>;
  const CLAIM = VENDOR_PENDING_SEAT_CLAIMS_FIXTURE[0]!;

  function setup(canManage: boolean) {
    getSeats = vi.fn().mockResolvedValue({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: [],
      can_manage_seats: canManage,
      pending_claims: VENDOR_PENDING_SEAT_CLAIMS_FIXTURE,
    });
    acceptSeatClaim = vi.fn().mockResolvedValue({
      invite: { ...VENDOR_SEAT_INVITES_FIXTURE[0]!, email: CLAIM.submitter_email },
      invite_sent: true,
    });
    declineSeatClaim = vi.fn().mockResolvedValue(undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        {
          provide: VendorApi,
          useValue: {
            getSeats,
            acceptSeatClaim,
            declineSeatClaim,
            removeSeat: vi.fn(),
            revokeInvite: vi.fn(),
            resendInvite: vi.fn(),
            inviteSeat: vi.fn(),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  }

  async function render(): Promise<ComponentFixture<VendorSeatRoster>> {
    const fixture = TestBed.createComponent(VendorSeatRoster);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  const button = (fixture: ComponentFixture<VendorSeatRoster>, label: string) =>
    ([...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
      b.textContent?.trim().startsWith(label),
    );

  afterEach(() => vi.restoreAllMocks());

  it('lists the claimant to an owner with Accept and Decline', async () => {
    setup(true);
    const fixture = await render();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Wants to join');
    expect(text).toContain('Riley Chen');
    expect(text).toContain('riley@summitbim.example.com');
    expect(text).toContain('Summit Coordinate');
    const linkedin = fixture.nativeElement.querySelector(
      'a[href="https://www.linkedin.com/in/riley-chen-example"]',
    ) as HTMLAnchorElement | null;
    expect(linkedin?.rel).toContain('noopener');
    expect(button(fixture, 'Accept')).toBeDefined();
    expect(button(fixture, 'Decline')).toBeDefined();
  });

  it('names Accept and Decline with a space before the claimant (AECI-1469)', async () => {
    setup(true);
    const fixture = await render();
    expect(button(fixture, 'Accept')!.textContent?.trim()).toBe('Accept Riley Chen');
    expect(button(fixture, 'Decline')!.textContent?.trim()).toBe('Decline Riley Chen');
  });

  it('shows nothing to a member seat', async () => {
    setup(false);
    const fixture = await render();
    expect(fixture.nativeElement.textContent).not.toContain('Wants to join');
  });

  it('accepts, announces the invite in the status region and re-reads the list', async () => {
    setup(true);
    const fixture = await render();
    button(fixture, 'Accept')!.click();
    await flush();
    fixture.detectChanges();

    expect(acceptSeatClaim).toHaveBeenCalledWith(CLAIM.id);
    const status = fixture.nativeElement.querySelector('[data-seats-status]') as HTMLElement | null;
    expect(status?.textContent).toContain('A seat invite was sent to riley@summitbim.example.com');
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain(
      'A seat invite was sent to riley@summitbim.example.com',
    );
    expect(getSeats).toHaveBeenCalledTimes(2);
  });

  it('says no email went out when the claimant already held an invite', async () => {
    setup(true);
    acceptSeatClaim.mockResolvedValueOnce({
      invite: { ...VENDOR_SEAT_INVITES_FIXTURE[0]!, email: CLAIM.submitter_email },
      invite_sent: false,
    });
    const fixture = await render();
    button(fixture, 'Accept')!.click();
    await flush();
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('[data-seats-status]') as HTMLElement | null;
    expect(status?.textContent).toContain(
      'riley@summitbim.example.com already has a seat invite, so no new email was sent.',
    );
    expect(status?.textContent).not.toContain('A seat invite was sent');
  });

  it('declines and announces it', async () => {
    setup(true);
    const fixture = await render();
    button(fixture, 'Decline')!.click();
    await flush();
    fixture.detectChanges();

    expect(declineSeatClaim).toHaveBeenCalledWith(CLAIM.id);
    const status = fixture.nativeElement.querySelector('[data-seats-status]') as HTMLElement | null;
    expect(status?.textContent).toContain('Declined the request from Riley Chen');
  });

  it('says the invite cap was hit when an accept is rate limited', async () => {
    setup(true);
    const fixture = await render();
    acceptSeatClaim.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 429, error: { error: { code: 'RATE_LIMITED' } } }),
    );
    button(fixture, 'Accept')!.click();
    await flush();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement | null;
    expect(alert?.textContent).toContain('most invites allowed today');
  });

  it('says the request was already decided when a decline loses the race (409)', async () => {
    setup(true);
    const fixture = await render();
    declineSeatClaim.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 409, error: { error: { code: 'CLAIM_ALREADY_DECIDED' } } }),
    );
    button(fixture, 'Decline')!.click();
    await flush();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement | null;
    expect(alert?.textContent).toContain('already decided');
    // Re-read so the row shows the state that won.
    expect(getSeats).toHaveBeenCalledTimes(2);
  });

  it('re-reads the roster when an accept answers the decided 409 (AECI-1420 Accept guard)', async () => {
    setup(true);
    const fixture = await render();
    expect(getSeats).toHaveBeenCalledTimes(1);
    acceptSeatClaim.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'CLAIM_ALREADY_DECIDED', details: { status: 'rejected' } } },
      }),
    );
    // The re-read no longer lists the claim the system rejected.
    getSeats.mockResolvedValueOnce({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: [],
      can_manage_seats: true,
      pending_claims: [],
    });
    button(fixture, 'Accept')!.click();
    await flush();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement | null;
    expect(alert?.textContent).toContain(
      'That request was already decided. The list now shows where it stands.',
    );
    expect(getSeats).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.textContent).not.toContain('riley@summitbim.example.com');
  });

  it('does not re-read when an accept fails for another reason', async () => {
    setup(true);
    const fixture = await render();
    acceptSeatClaim.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 429, error: { error: { code: 'RATE_LIMITED' } } }),
    );
    button(fixture, 'Accept')!.click();
    await flush();
    fixture.detectChanges();
    expect(getSeats).toHaveBeenCalledTimes(1);
  });
});
