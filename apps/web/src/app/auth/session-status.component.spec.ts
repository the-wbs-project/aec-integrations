import { Component, inject, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';
import { SessionStatus } from './session-status';

/**
 * `SessionStatus` is the header's cache-neutral auth probe (Phase 5 §4.4). The
 * load-bearing guarantee — identical to `ReviewCta` (AECI-201) — is that the
 * value is the **neutral default (`false`)** during SSR / before the
 * `afterNextRender` reconcile runs, and only reconciles to the real session
 * truth *after* hydration (browser-only). Reconcile is two-step: a synchronous
 * cookie-presence hint flips the header immediately (so a just-signed-in visitor
 * sees the account menu on their OAuth landing page, not a beat later), then the
 * async `isSignedIn()` probe confirms or corrects it. These tests pin the neutral
 * default, both reconcile steps, and the graceful-degradation branches
 * (unconfigured env, probe throw with and without a cookie).
 */

interface AuthMock {
  isConfigured: ReturnType<typeof vi.fn>;
  hasSessionCookie: ReturnType<typeof vi.fn>;
  isSignedIn: ReturnType<typeof vi.fn>;
}

function makeAuthMock(
  opts: { configured?: boolean; hasCookie?: boolean; signedIn?: boolean } = {},
): AuthMock {
  return {
    isConfigured: vi.fn(() => opts.configured ?? true),
    hasSessionCookie: vi.fn(() => opts.hasCookie ?? false),
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

  it('flips to true synchronously from the cookie hint, before the async probe resolves', () => {
    // The OAuth/magic-link landing case: a JS-readable session cookie is present
    // the moment hydration runs, so the header must not wait on the ~58 kB SDK.
    const status = create(makeAuthMock({ hasCookie: true, signedIn: true }));
    expect(status.signedIn()).toBe(true);
  });

  it('reconciles to true once the probe reports a session', async () => {
    const status = create(makeAuthMock({ signedIn: true }));
    await settle();
    expect(status.signedIn()).toBe(true);
  });

  it('downgrades a stale cookie to neutral once the probe reports no session', async () => {
    const status = create(makeAuthMock({ hasCookie: true, signedIn: false }));
    // Synchronous hint optimistically shows signed-in…
    expect(status.signedIn()).toBe(true);
    // …then the probe corrects a present-but-invalid cookie back to neutral.
    await settle();
    expect(status.signedIn()).toBe(false);
  });

  it('keeps the cookie hint signed-in when the probe throws but a cookie is present', async () => {
    const auth = makeAuthMock({ hasCookie: true, signedIn: true });
    auth.isSignedIn.mockRejectedValue(new Error('SDK chunk failed to load'));
    const status = create(auth);
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
