import { Component, inject, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';
import { SessionStatus } from './session-status';

/**
 * `SessionStatus` is the header's cache-neutral auth probe (Phase 5 §4.4). The
 * load-bearing guarantee — identical to `ReviewCta` (AECI-201) — is that the
 * value is the **neutral default (`false`)** during SSR / before the
 * `afterNextRender` probe resolves, and only reconciles to the real session
 * truth *after* hydration (browser-only). These tests pin both halves plus the
 * graceful-degradation branches (unconfigured env, probe throw).
 */

interface AuthMock {
  isConfigured: ReturnType<typeof vi.fn>;
  isSignedIn: ReturnType<typeof vi.fn>;
}

function makeAuthMock(opts: { configured?: boolean; signedIn?: boolean } = {}): AuthMock {
  return {
    isConfigured: vi.fn(() => opts.configured ?? true),
    isSignedIn: vi.fn(async () => opts.signedIn ?? false),
  };
}

/** Macrotask boundary — lets the async `afterNextRender` probe settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

@Component({ selector: 'aec-host', template: '' })
class Host {
  readonly status = inject(SessionStatus);
}

function create(auth: AuthMock) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AuthService, useValue: auth }],
  });
  const fixture = TestBed.createComponent(Host);
  // `detectChanges` drives the render that flushes `afterNextRender`.
  fixture.detectChanges();
  return fixture.componentInstance.status;
}

describe('SessionStatus', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is neutral (false) synchronously, before the post-hydration probe resolves', () => {
    const status = create(makeAuthMock({ signedIn: true }));
    // The probe is async (dispatched via afterNextRender) — not yet applied.
    expect(status.signedIn()).toBe(false);
  });

  it('reconciles to true once the probe reports a session', async () => {
    const status = create(makeAuthMock({ signedIn: true }));
    await settle();
    expect(status.signedIn()).toBe(true);
  });

  it('reconciles to false when there is no session', async () => {
    const status = create(makeAuthMock({ signedIn: false }));
    await settle();
    expect(status.signedIn()).toBe(false);
  });

  it('stays neutral and never probes when auth is unconfigured', async () => {
    const auth = makeAuthMock({ configured: false, signedIn: true });
    const status = create(auth);
    await settle();
    expect(status.signedIn()).toBe(false);
    expect(auth.isSignedIn).not.toHaveBeenCalled();
  });

  it('keeps the neutral default when the probe throws', async () => {
    const auth = makeAuthMock({ signedIn: true });
    auth.isSignedIn.mockRejectedValue(new Error('probe failed'));
    const status = create(auth);
    await settle();
    expect(status.signedIn()).toBe(false);
  });
});
