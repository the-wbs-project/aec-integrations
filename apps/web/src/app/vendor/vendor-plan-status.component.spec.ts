import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  Component,
  PLATFORM_ID,
  inject,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionStatus } from '../auth/session-status';

import { VendorPlanStatus } from './vendor-plan-status';
import { VendorStatus } from './vendor-status';

/**
 * `VendorPlanStatus` (AECI-1286, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §5). The
 * load-bearing guarantees: no `GET /api/vendor/me` on the server or for a
 * non-vendor, exactly one per session for a vendor however many consumers read
 * it, Free and Managed mapped through `isManaged`, and a failure that leaves
 * every signal `null` with nothing thrown.
 */
@Component({ selector: 'aec-host', template: '' })
class Host {
  readonly status = inject(VendorPlanStatus);
}

/** Macrotask boundary, so the async probe settles between flushes. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function block(tier: 'unclaimed' | 'verified', status: 'active' | 'pending' | null) {
  return {
    tier,
    status,
    period_end: null,
    ended_at: null,
    capabilities: [],
    price: { managed_price_cents: null, message: null },
  };
}

function meBody(entitlement: ReturnType<typeof block>) {
  return {
    vendor: { id: 'v1', slug: 'acme', company_name: 'Acme Software' },
    products: [],
    requests: [],
    seat_count: 1,
    entitlement,
  };
}

describe('VendorPlanStatus', () => {
  let isVendor: ReturnType<typeof signal<boolean>>;
  let email: ReturnType<typeof signal<string | null>>;
  let http: HttpTestingController;

  function setup(platform: 'browser' | 'server' = 'browser') {
    isVendor = signal(false);
    email = signal<string | null>(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: platform },
        { provide: VendorStatus, useValue: { isVendor } },
        { provide: SessionStatus, useValue: { email } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
  }

  function signInAsVendor(fixture: ReturnType<typeof setup>, as = 'v@example.com') {
    email.set(as);
    isVendor.set(true);
    fixture.detectChanges();
  }

  afterEach(() => http.verify());

  it('never calls on the server platform, even for a vendor', async () => {
    const fixture = setup('server');
    signInAsVendor(fixture);
    await fixture.componentInstance.status.ensureProbed();
    await settle();

    http.expectNone('/api/vendor/me');
    expect(fixture.componentInstance.status.vendorSlug()).toBeNull();
    expect(fixture.componentInstance.status.managed()).toBeNull();
  });

  it('never calls for a signed-out visitor or a non-vendor', async () => {
    const fixture = setup();
    email.set('rev@example.com');
    fixture.detectChanges();
    await fixture.componentInstance.status.ensureProbed();
    await settle();

    http.expectNone('/api/vendor/me');
    expect(fixture.componentInstance.status.vendorName()).toBeNull();
  });

  it('calls once for a vendor however often it is read, and maps Free', async () => {
    const fixture = setup();
    const status = fixture.componentInstance.status;
    signInAsVendor(fixture);
    void status.ensureProbed();
    void status.ensureProbed();

    http.expectOne('/api/vendor/me').flush(meBody(block('unclaimed', null)));
    await settle();

    await status.ensureProbed();
    fixture.detectChanges();
    await settle();
    http.expectNone('/api/vendor/me');

    expect(status.vendorSlug()).toBe('acme');
    expect(status.vendorName()).toBe('Acme Software');
    expect(status.managed()).toBe(false);
  });

  it('maps an active Managed entitlement to managed = true', async () => {
    const fixture = setup();
    signInAsVendor(fixture);

    http.expectOne('/api/vendor/me').flush(meBody(block('verified', 'active')));
    await settle();

    expect(fixture.componentInstance.status.managed()).toBe(true);
  });

  it('treats a pending Managed row as Free (fail closed through isManaged)', async () => {
    const fixture = setup();
    signInAsVendor(fixture);

    http.expectOne('/api/vendor/me').flush(meBody(block('verified', 'pending')));
    await settle();

    expect(fixture.componentInstance.status.managed()).toBe(false);
  });

  it('leaves every signal null on a failed call, throws nothing, and does not retry', async () => {
    const fixture = setup();
    const status = fixture.componentInstance.status;
    signInAsVendor(fixture);

    http
      .expectOne('/api/vendor/me')
      .flush({ error: 'forbidden' }, { status: 403, statusText: 'Forbidden' });
    await settle();
    await expect(status.ensureProbed()).resolves.toBeUndefined();
    await settle();

    http.expectNone('/api/vendor/me');
    expect(status.vendorSlug()).toBeNull();
    expect(status.vendorName()).toBeNull();
    expect(status.managed()).toBeNull();
  });

  it('leaves every signal null on a malformed body', async () => {
    const fixture = setup();
    signInAsVendor(fixture);

    http.expectOne('/api/vendor/me').flush({ vendor: null });
    await settle();

    expect(fixture.componentInstance.status.vendorSlug()).toBeNull();
    expect(fixture.componentInstance.status.managed()).toBeNull();
  });

  it('resets on sign-out and probes again for the next vendor session', async () => {
    const fixture = setup();
    const status = fixture.componentInstance.status;
    signInAsVendor(fixture);
    http.expectOne('/api/vendor/me').flush(meBody(block('verified', 'active')));
    await settle();
    expect(status.managed()).toBe(true);

    isVendor.set(false);
    email.set(null);
    fixture.detectChanges();
    await settle();
    expect(status.vendorSlug()).toBeNull();
    expect(status.managed()).toBeNull();

    signInAsVendor(fixture, 'other@example.com');
    http.expectOne('/api/vendor/me').flush(meBody(block('unclaimed', null)));
    await settle();
    expect(status.managed()).toBe(false);
  });

  it('does not call twice when the email arrives after a cached vendor role', async () => {
    const fixture = setup();
    // Cookie hint plus cached role: vendor before the session snapshot lands.
    isVendor.set(true);
    fixture.detectChanges();
    const req = http.expectOne('/api/vendor/me');

    email.set('v@example.com');
    fixture.detectChanges();
    await settle();
    http.expectNone('/api/vendor/me');

    req.flush(meBody(block('unclaimed', null)));
    await settle();
    expect(fixture.componentInstance.status.vendorSlug()).toBe('acme');
  });

  it('resets on an account switch under a still-vendor role and drops the stale response', async () => {
    const fixture = setup();
    const status = fixture.componentInstance.status;
    signInAsVendor(fixture, 'a@example.com');
    const first = http.expectOne('/api/vendor/me');

    email.set('b@example.com');
    fixture.detectChanges();
    const second = http.expectOne('/api/vendor/me');

    // The first session's answer lands late and must not paint session B.
    first.flush(meBody(block('verified', 'active')));
    await settle();
    expect(status.managed()).toBeNull();

    second.flush(meBody(block('unclaimed', null)));
    await settle();
    expect(status.managed()).toBe(false);
  });
});
