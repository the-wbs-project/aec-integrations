import { provideHttpClient } from '@angular/common/http';
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

  function setup(payload: unknown) {
    getSeats = vi.fn().mockResolvedValue(payload);
    removeSeat = vi.fn().mockResolvedValue(undefined);
    revokeInvite = vi.fn().mockResolvedValue(undefined);
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
});
