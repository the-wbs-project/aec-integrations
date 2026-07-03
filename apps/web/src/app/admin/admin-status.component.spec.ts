import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStatus } from '../auth/session-status';

import { AdminStatus } from './admin-status';
import { AdminSummaryStore } from './admin-summary.store';

/**
 * `AdminStatus` (AECI-259) is the header's cache-neutral admin probe. The
 * load-bearing guarantees: it stays the neutral default (`isAdmin() === false`,
 * no network) until `SessionStatus.signedIn()` flips true, it detects admin via
 * the cheap `GET /api/account` `role`, and it touches the admin-only
 * `GET /api/admin/summary` ONLY for an actual admin (a reviewer never 403s it).
 */
@Component({ selector: 'aec-host', template: '' })
class Host {
  readonly status = inject(AdminStatus);
}

/** Macrotask boundary — lets the async `reconcile()` chain settle between flushes. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('AdminStatus', () => {
  let signedIn: ReturnType<typeof signal<boolean>>;
  let http: HttpTestingController;

  beforeEach(() => {
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
    expect(fixture.componentInstance.status.isAdmin()).toBe(false);
  });

  it('probes /api/account then /api/admin/summary and goes admin when role is "admin"', async () => {
    const fixture = create();
    const store = TestBed.inject(AdminSummaryStore);

    signedIn.set(true);
    fixture.detectChanges(); // re-runs the effect → dispatches reconcile()

    http.expectOne('/api/account').flush({
      user_id: 'u1',
      email: 'admin@example.com',
      display_name: 'Ada',
      role: 'admin',
    });
    await settle();

    // Admin confirmed → the badge count is fetched and seeded.
    http.expectOne('/api/admin/summary').flush({ pending_reviews: 3 });
    await settle();

    expect(fixture.componentInstance.status.isAdmin()).toBe(true);
    expect(store.pendingReviews()).toBe(3);
  });

  it('stays non-admin and never calls the admin endpoint for a reviewer', async () => {
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

    http.expectNone('/api/admin/summary');
    expect(fixture.componentInstance.status.isAdmin()).toBe(false);
  });

  it('probes at most once even if signedIn re-emits', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush({
      user_id: 'u3',
      email: 'rev@example.com',
      display_name: null,
      role: 'reviewer',
    });
    await settle();

    // A second emission must not trigger a second probe.
    signedIn.set(false);
    fixture.detectChanges();
    signedIn.set(true);
    fixture.detectChanges();
    await settle();
    http.expectNone('/api/account');
  });
});
