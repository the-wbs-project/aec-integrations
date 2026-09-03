/**
 * `signOutAndGoHome` — the ONE sign-out path (AECI-259, + the PostHog identity
 * reset in AECI-649 / `docs/ANALYTICS.md` §8).
 *
 * Plain Vitest (no `.component.` suffix): the helper is a free function with no
 * DI, so there is nothing to bootstrap. `location` is stubbed because the node
 * environment has none.
 *
 * The case that matters is the ORDER. The redirect is a hard
 * `location.assign('/')`, so anything not written before it is written into a
 * document that is already being torn down — and the identity being dropped is
 * a localStorage write that must survive the reload, not a network call that
 * can be retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Analytics } from '../analytics/analytics';
import type { AuthService } from './auth.service';
import { signOutAndGoHome } from './sign-out';

let assignSpy: ReturnType<typeof vi.fn>;
let originalLocation: PropertyDescriptor | undefined;

function makeAuth(signOut: () => Promise<void>): AuthService {
  return { signOut: vi.fn(signOut) } as unknown as AuthService;
}

function makeAnalytics(): { analytics: Analytics; resetIdentity: ReturnType<typeof vi.fn> } {
  const resetIdentity = vi.fn(async () => undefined);
  return { analytics: { resetIdentity } as unknown as Analytics, resetIdentity };
}

beforeEach(() => {
  assignSpy = vi.fn();
  originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { assign: assignSpy, href: 'http://localhost/' },
  });
});

afterEach(() => {
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else delete (globalThis as { location?: unknown }).location;
});

describe('signOutAndGoHome', () => {
  it('clears the session, drops the PostHog identity, then redirects home', async () => {
    const auth = makeAuth(async () => undefined);
    const { analytics, resetIdentity } = makeAnalytics();

    await expect(signOutAndGoHome(auth, analytics)).resolves.toBe(true);

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(resetIdentity).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith('/');
  });

  it('resets the identity BEFORE the hard redirect', async () => {
    const { analytics, resetIdentity } = makeAnalytics();
    await signOutAndGoHome(
      makeAuth(async () => undefined),
      analytics,
    );

    // The redirect reloads the document; a reset queued after it may never run,
    // and the persisted distinct id would outlive the person it names.
    expect(resetIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      assignSpy.mock.invocationCallOrder[0],
    );
  });

  it('reports failure and neither resets nor redirects when signOut throws', async () => {
    const auth = makeAuth(async () => {
      throw new Error('supabase down');
    });
    const { analytics, resetIdentity } = makeAnalytics();

    await expect(signOutAndGoHome(auth, analytics)).resolves.toBe(false);

    // The visitor is still signed in, so the identity is still correct.
    expect(resetIdentity).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
