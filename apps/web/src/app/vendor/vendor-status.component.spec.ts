import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStatus } from '../auth/session-status';

import { VendorStatus } from './vendor-status';

/**
 * `VendorStatus` (AECI-522) is the header's cache-neutral vendor probe. The
 * load-bearing guarantees: it stays the neutral default (`isVendor() === false`,
 * no network) until `SessionStatus.signedIn()` flips true, and it goes vendor
 * ONLY when the cheap `GET /api/account` reports `role === 'vendor_admin'` — it
 * never touches the vendor-gated `/api/vendor/*` (a non-vendor never 403s it).
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

  it('probes at most once even if signedIn re-emits', async () => {
    const fixture = create();

    signedIn.set(true);
    fixture.detectChanges();
    http.expectOne('/api/account').flush({
      user_id: 'u3',
      email: 'v@example.com',
      display_name: null,
      role: 'vendor_admin',
    });
    await settle();

    signedIn.set(false);
    fixture.detectChanges();
    signedIn.set(true);
    fixture.detectChanges();
    await settle();
    http.expectNone('/api/account');
  });
});
