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
 * async `sessionSnapshot()` probe confirms or corrects it — and supplies the
 * session's email, which the claim/correction forms prefill from. These tests pin
 * the neutral default, both reconcile steps, the email, and the
 * graceful-degradation branches (unconfigured env, probe throw with and without a
 * cookie).
 */

interface AuthMock {
  isConfigured: ReturnType<typeof vi.fn>;
  hasSessionCookie: ReturnType<typeof vi.fn>;
  sessionSnapshot: ReturnType<typeof vi.fn>;
}

function makeAuthMock(
  opts: {
    configured?: boolean;
    hasCookie?: boolean;
    signedIn?: boolean;
    email?: string | null;
  } = {},
): AuthMock {
  const signedIn = opts.signedIn ?? false;
  return {
    isConfigured: vi.fn(() => opts.configured ?? true),
    hasSessionCookie: vi.fn(() => opts.hasCookie ?? false),
    sessionSnapshot: vi.fn(async () => ({
      signedIn,
      email: signedIn ? (opts.email ?? 'dana@example.com') : null,
    })),
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
    auth.sessionSnapshot.mockRejectedValue(new Error('SDK chunk failed to load'));
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
    expect(auth.sessionSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the neutral default when the probe throws', async () => {
    const auth = makeAuthMock({ signedIn: true });
    auth.sessionSnapshot.mockRejectedValue(new Error('probe failed'));
    const status = create(auth);
    await settle();
    expect(status.signedIn()).toBe(false);
  });

  it('exposes the session email once the probe resolves, and null before it', async () => {
    const status = create(
      makeAuthMock({ hasCookie: true, signedIn: true, email: 'dana@acme.dev' }),
    );
    // The synchronous cookie hint proves a session exists but carries no email.
    expect(status.email()).toBeNull();
    await settle();
    expect(status.email()).toBe('dana@acme.dev');
  });

  it('keeps the email null for an anonymous visitor', async () => {
    const status = create(makeAuthMock({ signedIn: false }));
    await settle();
    expect(status.email()).toBeNull();
  });
});
