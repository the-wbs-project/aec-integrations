/**
 * `AnalyticsIdentity` — the session → `Analytics.identify()` bridge
 * (AECI-649 / §AW8; `docs/ANALYTICS.md` §8).
 *
 * `.component.spec.ts` because it needs Angular DI and the `afterNextRender`
 * lifecycle, which only runs under a real fixture. Modelled on
 * `session-status.component.spec.ts`, the other post-hydration auth probe.
 *
 * The properties pinned here are the ones a reader would otherwise have to
 * infer: the probe is browser-only and post-render (never SSR — a session read
 * during SSR is visitor state on a cacheable route), it passes the id straight
 * through with no consent opinion of its own (that gate lives in `Analytics`,
 * in one place), and a failing probe is silently anonymous rather than a thrown
 * error.
 */
import { Component, PLATFORM_ID, inject, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { Analytics } from './analytics';
import { AnalyticsIdentity } from './analytics-identity';

/** Macrotask boundary — lets the async `afterNextRender` probe settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

@Component({ selector: 'aec-host', template: '' })
class Host {
  readonly identity = inject(AnalyticsIdentity);
}

function setup(opts: {
  userId?: string | null;
  throws?: boolean;
  platform?: 'browser' | 'server';
}) {
  const currentUserId = vi.fn(async () => {
    if (opts.throws) throw new Error('SDK chunk failed to load');
    return opts.userId ?? null;
  });
  const identify = vi.fn();

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: PLATFORM_ID, useValue: opts.platform ?? 'browser' },
      { provide: AuthService, useValue: { currentUserId } },
      { provide: Analytics, useValue: { identify } },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  // `detectChanges` drives the render that flushes `afterNextRender`.
  fixture.detectChanges();
  return { currentUserId, identify };
}

describe('AnalyticsIdentity', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('identifies with the Supabase user id once the session resolves', async () => {
    const { identify } = setup({ userId: 'user-1' });
    await settle();
    expect(identify).toHaveBeenCalledExactlyOnceWith('user-1');
  });

  it('does not identify an anonymous visitor', async () => {
    const { identify } = setup({ userId: null });
    await settle();
    expect(identify).not.toHaveBeenCalled();
  });

  it('never probes on the server platform', async () => {
    const { currentUserId, identify } = setup({ userId: 'user-1', platform: 'server' });
    await settle();
    expect(currentUserId).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
  });

  it('stays anonymous when the session probe throws', async () => {
    const { identify } = setup({ throws: true });
    await settle();
    expect(identify).not.toHaveBeenCalled();
  });

  it('does not read consent — the gate lives in Analytics, once', async () => {
    // The probe resolves and hands the id over unconditionally; whether it is
    // ever written is decided downstream. Gating here would break the
    // sign-in-then-consent ordering, because the id would never be recorded in
    // time for the grant to fire it.
    const { identify } = setup({ userId: 'user-1' });
    await settle();
    expect(identify).toHaveBeenCalledWith('user-1');
  });
});
