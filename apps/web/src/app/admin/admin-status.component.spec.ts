import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionStatus } from '../auth/session-status';

import { AdminStatus } from './admin-status';
import { AdminSummaryStore } from './admin-summary.store';

/**
 * `AdminStatus` (AECI-259, reworked in AECI-617) is the header's cache-neutral
 * admin probe. The load-bearing guarantees:
 *
 *   - it stays the neutral default (`isAdmin() === false`, no network) until
 *     `SessionStatus.signedIn()` flips true — that's what keeps SSR HTML
 *     visitor-state-neutral for the URL-keyed edge cache (§8);
 *   - one round trip: `GET /api/account` carries `role` AND `pending_reviews`,
 *     and a non-admin never touches `GET /api/admin/summary`;
 *   - the probe is SELF-HEALING — a failure leaves the latch open so
 *     `ensureProbed()` (menu open) or a later `signedIn()` transition retries.
 *     The original latched on dispatch and swallowed errors, so one blip
 *     suppressed the Admin section for the life of the page;
 *   - a resolved role is cached in `sessionStorage` and re-applied with ZERO
 *     network on the next load in the tab, and dropped on sign-out.
 */
@Component({ selector: 'aec-host', template: '' })
class Host {
  readonly status = inject(AdminStatus);
}

/** Macrotask boundary — lets the async `reconcile()` chain settle between flushes. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

const ADMIN = {
  user_id: 'u1',
  email: 'admin@example.com',
  display_name: 'Ada',
  role: 'admin',
  pending_reviews: 3,
};

const REVIEWER = {
  user_id: 'u2',
  email: 'rev@example.com',
  display_name: 'Rey',
  role: 'reviewer',
  pending_reviews: null,
};

describe('AdminStatus', () => {
  let signedIn: ReturnType<typeof signal<boolean>>;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    signedIn = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        AdminSummaryStore,
        { provide: SessionStatus, useValue: { signedIn } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
    vi.useRealTimers();
  });

  function create() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges(); // flushes the effect
    return fixture;
  }

  it('does not probe while signed out', async () => {
    const fixture = create();
    await settle();
    http.expectNone('/api/account');
    expect(fixture.componentInstance.status.isAdmin()).toBe(false);
  });

  it('resolves role AND the badge count from a single /api/account call', async () => {
    const fixture = create();
    const store = TestBed.inject(AdminSummaryStore);

    signedIn.set(true);
    fixture.detectChanges(); // re-runs the effect → dispatches the probe

    http.expectOne('/api/account').flush(ADMIN);
    await settle();

    expect(fixture.componentInstance.status.isAdmin()).toBe(true);
    expect(store.pendingReviews()).toBe(3);
    // The second hop is gone — the count rode along with the role.
    http.expectNone('/api/admin/summary');
  });

  it('stays non-admin and never calls the admin endpoint for a reviewer', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();

    http.expectOne('/api/account').flush(REVIEWER);
    await settle();

    http.expectNone('/api/admin/summary');
    expect(fixture.componentInstance.status.isAdmin()).toBe(false);
  });

  it('probes at most once once resolved, even if signedIn re-emits', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush(REVIEWER);
    await settle();

    // Re-emitting must not trigger a second probe. (signedIn true→false→true
    // also exercises the sign-out reset, which re-opens the latch — so this
    // asserts the RESOLVED path stays quiet on a plain re-emission.)
    signedIn.set(true);
    fixture.detectChanges();
    await settle();
    http.expectNone('/api/account');
  });

  it('coalesces concurrent ensureProbed() calls onto one request', async () => {
    const fixture = create();
    const status = fixture.componentInstance.status;

    signedIn.set(true);
    fixture.detectChanges();

    // Desktop + mobile nav both opening: still exactly one in-flight request.
    void status.ensureProbed();
    void status.ensureProbed();

    http.expectOne('/api/account').flush(ADMIN);
    await settle();
    expect(status.isAdmin()).toBe(true);
  });

  it('leaves the badge unseeded when the API predates pending_reviews', async () => {
    // The SSR and API Workers deploy separately, so a rolling deploy can serve
    // the older shape. `seed(undefined)` would put NaN in the badge.
    const fixture = create();
    const store = TestBed.inject(AdminSummaryStore);

    signedIn.set(true);
    fixture.detectChanges();
    const { pending_reviews: _omitted, ...legacy } = ADMIN;
    http.expectOne('/api/account').flush(legacy);
    await settle();

    expect(fixture.componentInstance.status.isAdmin()).toBe(true);
    expect(store.pendingReviews()).toBeNull();
  });

  it('ensureProbed() fires nothing for an anonymous visitor', async () => {
    const fixture = create();

    await fixture.componentInstance.status.ensureProbed();

    http.expectNone('/api/account');
  });

  // ── Self-healing (the AECI-617 bug) ─────────────────────────────────────────

  it('retries once after a transient failure and then resolves', async () => {
    vi.useFakeTimers();
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();

    http.expectOne('/api/account').error(new ProgressEvent('error'));
    await vi.advanceTimersByTimeAsync(1000); // past RETRY_DELAY_MS

    http.expectOne('/api/account').flush(ADMIN);
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.componentInstance.status.isAdmin()).toBe(true);
  });

  it('leaves the latch OPEN after a total failure so ensureProbed() retries', async () => {
    vi.useFakeTimers();
    const fixture = create();
    const status = fixture.componentInstance.status;

    signedIn.set(true);
    fixture.detectChanges();

    // Both the initial attempt and its retry fail.
    http.expectOne('/api/account').error(new ProgressEvent('error'));
    await vi.advanceTimersByTimeAsync(1000);
    http.expectOne('/api/account').error(new ProgressEvent('error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(status.isAdmin()).toBe(false);

    // Opening the menu re-arms it — the old code latched on dispatch and never
    // retried, which is exactly why the Admin section sometimes never appeared.
    void status.ensureProbed();
    http.expectOne('/api/account').flush(ADMIN);
    await vi.advanceTimersByTimeAsync(0);

    expect(status.isAdmin()).toBe(true);
  });

  // ── Cached hint (instant paint on the next load in the tab) ─────────────────

  it('applies a cached admin role with zero network, then confirms', async () => {
    sessionStorage.setItem('aeci.role', 'admin');
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();

    // Admin affordances are live BEFORE the probe responds.
    expect(fixture.componentInstance.status.isAdmin()).toBe(true);

    http.expectOne('/api/account').flush(ADMIN);
    await settle();
    expect(fixture.componentInstance.status.isAdmin()).toBe(true);
  });

  it('caches the resolved role for the next load in the tab', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush(ADMIN);
    await settle();

    expect(sessionStorage.getItem('aeci.role')).toBe('admin');
  });

  it('corrects a stale cached hint when the probe says otherwise', async () => {
    sessionStorage.setItem('aeci.role', 'admin');
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    expect(fixture.componentInstance.status.isAdmin()).toBe(true);

    http.expectOne('/api/account').flush(REVIEWER);
    await settle();

    expect(fixture.componentInstance.status.isAdmin()).toBe(false);
    expect(sessionStorage.getItem('aeci.role')).toBe('reviewer');
  });

  it('drops the cached role and admin state on sign-out', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush(ADMIN);
    await settle();
    expect(sessionStorage.getItem('aeci.role')).toBe('admin');

    signedIn.set(false);
    fixture.detectChanges();
    await settle();

    expect(fixture.componentInstance.status.isAdmin()).toBe(false);
    expect(sessionStorage.getItem('aeci.role')).toBeNull();
  });

  it('does not clear a cached role on the pre-hydration signedIn default', async () => {
    sessionStorage.setItem('aeci.role', 'admin');
    create(); // effect runs once with signedIn() === false
    await settle();

    // The initial `false` is "not known yet", not "signed out" — clearing here
    // would wipe the hint before it could ever be used.
    expect(sessionStorage.getItem('aeci.role')).toBe('admin');
  });
});
