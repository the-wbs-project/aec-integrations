import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStatus } from '../auth/session-status';

import { VendorStatus } from './vendor-status';

/**
 * `VendorStatus` (AECI-522) is the header's cache-neutral vendor hint, now a view
 * over the shared `RoleStatus` probe. The load-bearing guarantees: it stays the
 * neutral default (`isVendor() === false`, no network) until
 * `SessionStatus.signedIn()` flips true, and it goes vendor ONLY when the cheap
 * `GET /api/account` reports `role === 'vendor_admin'` — it never touches the
 * vendor-gated `/api/vendor/*` (a non-vendor never 403s it).
 *
 * It also inherits the AECI-617 self-heal it previously lacked: it used to latch
 * `probed` BEFORE awaiting and swallow every error, so a single blip hid the
 * "Vendor portal" link for the life of the page. The latch now closes on SUCCESS
 * only, and `ensureProbed()` (menu open) retries.
 */
@Component({ selector: 'aec-host', template: '' })
class Host {
  readonly status = inject(VendorStatus);
}

/** Macrotask boundary — lets the async `reconcile()` chain settle between flushes. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorStatus', () => {
  let signedIn: ReturnType<typeof signal<boolean>>;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear(); // the shared probe caches the resolved role per tab
    signedIn = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        { provide: SessionStatus, useValue: { signedIn } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function create() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges(); // flushes the effect
    return fixture;
  }

  it('does not probe while signed out', async () => {
    const fixture = create();
    await settle();
    http.expectNone('/api/account');
    expect(fixture.componentInstance.status.isVendor()).toBe(false);
  });

  it('goes vendor when /api/account role is "vendor_admin"', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();

    http.expectOne('/api/account').flush({
      user_id: 'u1',
      email: 'vendor@example.com',
      display_name: 'Ven',
      role: 'vendor_admin',
    });
    await settle();

    expect(fixture.componentInstance.status.isVendor()).toBe(true);
  });

  it('stays non-vendor for a reviewer and never touches /api/vendor/*', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();

    http.expectOne('/api/account').flush({
      user_id: 'u2',
      email: 'rev@example.com',
      display_name: 'Rey',
      role: 'reviewer',
    });
    await settle();

    http.expectNone('/api/vendor/me');
    expect(fixture.componentInstance.status.isVendor()).toBe(false);
  });

  it('probes once per session and no more, however often ensureProbed() is called', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush({
      user_id: 'u3',
      email: 'v@example.com',
      display_name: null,
      role: 'vendor_admin',
      pending_reviews: null,
    });
    await settle();

    // Every menu open re-arms the probe; a resolved answer must not re-fetch.
    await fixture.componentInstance.status.ensureProbed();
    await fixture.componentInstance.status.ensureProbed();
    await settle();
    http.expectNone('/api/account');
    expect(fixture.componentInstance.status.isVendor()).toBe(true);
  });

  it('re-probes after a sign-out / sign-in cycle — the role may have changed', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush({
      user_id: 'u4',
      email: 'v@example.com',
      display_name: null,
      role: 'vendor_admin',
      pending_reviews: null,
    });
    await settle();
    expect(fixture.componentInstance.status.isVendor()).toBe(true);

    // Sign-out drops the cached role, so the next session starts neutral rather
    // than showing the previous user's doors.
    signedIn.set(false);
    fixture.detectChanges();
    await settle();
    expect(fixture.componentInstance.status.isVendor()).toBe(false);

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush({
      user_id: 'u5',
      email: 'rev@example.com',
      display_name: null,
      role: 'reviewer',
      pending_reviews: null,
    });
    await settle();
    expect(fixture.componentInstance.status.isVendor()).toBe(false);
  });

  it('self-heals: a failed probe retries on the next ensureProbed()', async () => {
    // The bug this class used to have — one 401 hid the link for the whole page
    // life, because the latch was set before awaiting and errors were swallowed.
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush(null, { status: 401, statusText: 'Unauthorized' });
    // `reconcile()` backs off once and retries inside the same call.
    await new Promise((r) => setTimeout(r, 900));
    http.expectOne('/api/account').flush(null, { status: 401, statusText: 'Unauthorized' });
    await settle();
    expect(fixture.componentInstance.status.isVendor()).toBe(false);

    // The latch stayed open, so opening the menu tries again — and succeeds.
    const probe = fixture.componentInstance.status.ensureProbed();
    http.expectOne('/api/account').flush({
      user_id: 'u6',
      email: 'v@example.com',
      display_name: null,
      role: 'vendor_admin',
      pending_reviews: null,
    });
    await probe;
    expect(fixture.componentInstance.status.isVendor()).toBe(true);
  });
});
