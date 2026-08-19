import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorApi } from '../vendor-api';
import { VENDOR_SEATS_FIXTURE } from '../vendor-fixtures';
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

  beforeEach(() => {
    getSeats = vi.fn();
    // Reset explicitly: the roster's state now lives in a per-surface
    // `VendorPortalStore`, so a store carried over from a previous test would
    // make `ensure()` a no-op and the next case would assert against stale data.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: { getSeats } as Partial<VendorApi> },
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
    getSeats.mockResolvedValue({ seats: VENDOR_SEATS_FIXTURE });
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
    getSeats.mockResolvedValue({ seats: VENDOR_SEATS_FIXTURE });
    (retry as HTMLButtonElement).click();
    await flush();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('table')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Dana Ruiz');
  });
});
