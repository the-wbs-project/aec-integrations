import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorApi } from '../vendor-api';
import { VENDOR_SEATS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorSeatInviteDialog } from './vendor-seat-invite-dialog';

/**
 * `VendorSeatInviteDialog` (AECI-664) is the Seats section's one primary action.
 * Two things have to hold: a **member** seat sees no trigger at all (the server's
 * `can_manage_seats` is the only source for that — the API would 403 the write),
 * and the form is genuinely behind the trigger rather than merely visually
 * hidden, so an owner who never clicks it renders no form.
 *
 * The overlay opens imperatively from the click handler — not from an `effect()`,
 * which is what throws NG0602 and makes a Spartan dialog untestable here (see the
 * `request-drawer.ts` note). That is precisely why these cases can exist.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorSeatInviteDialog', () => {
  let getSeats: ReturnType<typeof vi.fn>;
  let inviteSeat: ReturnType<typeof vi.fn>;

  function setup(canManage: boolean) {
    getSeats = vi.fn().mockResolvedValue({
      seats: VENDOR_SEATS_FIXTURE,
      pending_invites: [],
      can_manage_seats: canManage,
    });
    inviteSeat = vi.fn().mockResolvedValue({ invite: {} });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        {
          provide: VendorApi,
          useValue: { getSeats, inviteSeat } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  }

  /** The trigger renders off `can_manage_seats`, which only arrives with
   *  `GET /api/vendor/seats` — so the store has to be primed the way the roster
   *  primes it on the real surface. */
  async function render(): Promise<ComponentFixture<VendorSeatInviteDialog>> {
    await TestBed.inject(VendorPortalStore).ensure('seats');
    const fixture = TestBed.createComponent(VendorSeatInviteDialog);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  beforeEach(() => setup(true));

  it('renders nothing at all for a member seat', async () => {
    setup(false);
    const fixture = await render();

    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    expect((fixture.nativeElement.textContent as string).trim()).toBe('');
  });

  it('offers an owner a trigger, and keeps the form behind it', async () => {
    const fixture = await render();
    const trigger = fixture.nativeElement.querySelector('button') as HTMLButtonElement;

    expect(trigger.textContent).toContain('Invite');
    // The dialog body is a `ng-template` until opened — no form in the document.
    expect(document.querySelector('form')).toBeNull();
  });

  it('opens the invite form on click', async () => {
    const fixture = await render();
    const trigger = fixture.nativeElement.querySelector('button') as HTMLButtonElement;

    trigger.click();
    await flush();
    fixture.detectChanges();

    const overlay = document.querySelector('.cdk-overlay-container');
    expect(overlay?.textContent).toContain('Invite a colleague');
    expect(overlay?.querySelector('input[type="email"]')).not.toBeNull();
  });
});
