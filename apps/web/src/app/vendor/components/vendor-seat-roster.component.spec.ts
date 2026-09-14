import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorApi } from '../vendor-api';
import { VENDOR_SEATS_FIXTURE, VENDOR_SEAT_INVITES_FIXTURE } from '../vendor-fixtures';
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
    const status = fixture.nativeElement.querySelector('[role="status"]') as HTMLElement | null;
    expect(status?.textContent).toContain('Invite sent again');
    expect(status?.textContent).toContain('jordan@summitbim.example.com');
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

    expect(resendBtn!.textContent).toContain('Resend');
    expect(resendBtn!.textContent).not.toContain('Sending');

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
});
