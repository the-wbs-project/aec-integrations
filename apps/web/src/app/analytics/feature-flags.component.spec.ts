/**
 * Tests for `FeatureFlags` (AECI-650 / §AW9). Named `.component.spec.ts` so it
 * runs under `ng test`: it needs Angular DI (`PLATFORM_ID`, `inject`), which
 * the plain-Vitest project deliberately excludes.
 *
 * The SDK is never loaded. `posthog-js` is mocked at the specifier
 * `posthog-client.ts` actually imports (the self-contained `no-external`
 * bundle) — a mismatched specifier does not error, it silently pulls in the
 * real 500 kB SDK.
 */
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('posthog-js/dist/module.full.no-external', async () => {
  const { posthogJsModuleMock } = await import('./posthog-js.harness');
  return posthogJsModuleMock();
});

import { Analytics } from './analytics';
import { ConsentService, type ConsentState } from './consent';
import { FeatureFlags, featureFlagDefaults, type FeatureFlag } from './feature-flags';
import { posthogJsFake, resetPosthogJsFake } from './posthog-js.harness';

/** A key that is guaranteed to exist in the catalogue whatever it holds. */
const KEY = Object.keys(featureFlagDefaults)[0] as FeatureFlag;
const DEFAULT = featureFlagDefaults[KEY];

/** Resolve the queued `await analytics.client()` microtasks. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type GlobalWithConfig = { __AECI_POSTHOG__?: unknown };

/**
 * A stand-in for the borrowed PostHog client. Unlike the real SDK it does NOT
 * invoke the handler on subscribe, so "before `/flags` answered" is a state a
 * test can actually sit in and assert on.
 */
function fakeClient(values: Record<string, boolean | undefined>) {
  const handlers: Array<() => void> = [];
  return {
    values,
    onFeatureFlags: vi.fn((cb: () => void) => {
      handlers.push(cb);
      return () => undefined;
    }),
    isFeatureEnabled: vi.fn((key: string) => values[key]),
    /** Simulate the `/flags` response landing (or a later flip). */
    emit: () => {
      for (const h of handlers) h();
    },
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

function setup(
  opts: { platform?: 'browser' | 'server'; client?: FakeClient | null | 'throws' } = {},
) {
  const client = opts.client === undefined ? fakeClient({}) : opts.client;
  const analytics = {
    client: vi.fn(() =>
      client === 'throws' ? Promise.reject(new Error('boom')) : Promise.resolve(client),
    ),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform ?? 'browser' },
      { provide: Analytics, useValue: analytics },
    ],
  });
  return { flags: TestBed.inject(FeatureFlags), client, analytics };
}

describe('featureFlagDefaults — the catalogue is the type', () => {
  it('is non-empty, so `FeatureFlag` is a real union and not `never`', () => {
    // An empty map types `FeatureFlag` as `never`, which makes every call site
    // a compile error. The placeholder row exists precisely to prevent that.
    expect(Object.keys(featureFlagDefaults).length).toBeGreaterThan(0);
  });

  it('names every flag in kebab-case (a different namespace from events)', () => {
    for (const key of Object.keys(featureFlagDefaults)) {
      expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('commits a boolean default for every flag', () => {
    for (const value of Object.values(featureFlagDefaults)) {
      expect(typeof value).toBe('boolean');
    }
  });
});

describe('FeatureFlags — there is no `undefined` window', () => {
  it('reads the committed default synchronously, before anything has resolved', () => {
    const { flags } = setup();
    const value = flags.flag(KEY);
    // No flush: this is the very first tick, the client promise is still
    // pending, and the value is already a boolean.
    expect(value()).toBe(DEFAULT);
    expect(typeof value()).toBe('boolean');
  });

  it('is still a boolean while the client is resolved but /flags has not answered', async () => {
    const { flags, client } = setup();
    const value = flags.flag(KEY);
    await flush();

    expect((client as FakeClient).onFeatureFlags).toHaveBeenCalledTimes(1);
    // Subscribed, but the response has not landed: the default stands, and the
    // SDK has NOT been asked (its answer would be `undefined` here).
    expect((client as FakeClient).isFeatureEnabled).not.toHaveBeenCalled();
    expect(typeof value()).toBe('boolean');
    expect(value()).toBe(DEFAULT);
  });

  it('never yields undefined across the whole boot sequence', async () => {
    const client = fakeClient({ [KEY]: !DEFAULT });
    const { flags } = setup({ client });
    const value = flags.flag(KEY);

    const observed = [value()];
    await flush();
    observed.push(value());
    client.emit();
    observed.push(value());

    for (const v of observed) expect(typeof v).toBe('boolean');
    expect(observed[observed.length - 1]).toBe(!DEFAULT);
  });
});

describe('FeatureFlags — adoption on the /flags callback', () => {
  it('adopts the real value when the response lands', async () => {
    const client = fakeClient({ [KEY]: !DEFAULT });
    const { flags } = setup({ client });
    const value = flags.flag(KEY);
    await flush();
    expect(value()).toBe(DEFAULT);

    client.emit();
    expect(value()).toBe(!DEFAULT);
  });

  it('propagates a later flip without a redeploy', async () => {
    const client = fakeClient({ [KEY]: !DEFAULT });
    const { flags } = setup({ client });
    const value = flags.flag(KEY);
    await flush();
    client.emit();
    expect(value()).toBe(!DEFAULT);

    // The operator flips it back in the PostHog UI; the SDK re-fires.
    client.values[KEY] = DEFAULT;
    client.emit();
    expect(value()).toBe(DEFAULT);
  });

  it('adopts the current value for a LATE subscriber', async () => {
    const client = fakeClient({ [KEY]: !DEFAULT });
    const { flags } = setup({ client });
    await flush();
    client.emit();

    // A component mounting only now must not sit on the default until the next
    // flag change, which may never come.
    expect(flags.flag(KEY)()).toBe(!DEFAULT);
  });

  it('reads without emitting a $feature_flag_called event', async () => {
    const client = fakeClient({ [KEY]: !DEFAULT });
    const { flags } = setup({ client });
    flags.flag(KEY);
    await flush();
    client.emit();

    expect(client.isFeatureEnabled).toHaveBeenCalledWith(KEY, { send_event: false });
  });
});

describe('FeatureFlags — the default is the fallback', () => {
  it('keeps the default when the project has no such flag (SDK returns undefined)', async () => {
    const client = fakeClient({}); // isFeatureEnabled -> undefined
    const { flags } = setup({ client });
    const value = flags.flag(KEY);
    await flush();
    client.emit();

    expect(client.isFeatureEnabled).toHaveBeenCalled();
    expect(value()).toBe(DEFAULT);
    expect(typeof value()).toBe('boolean');
  });

  it('keeps the default when evaluation throws', async () => {
    const client = fakeClient({ [KEY]: !DEFAULT });
    client.isFeatureEnabled.mockImplementation(() => {
      throw new Error('boom');
    });
    const { flags } = setup({ client });
    const value = flags.flag(KEY);
    await flush();
    client.emit();

    expect(value()).toBe(DEFAULT);
  });

  it('keeps the default when the client boot rejects', async () => {
    const { flags } = setup({ client: 'throws' });
    const value = flags.flag(KEY);
    await flush();
    expect(value()).toBe(DEFAULT);
  });

  it('keeps the default when the client exposes no flag API', async () => {
    const { flags } = setup({ client: null });
    const value = flags.flag(KEY);
    await flush();
    expect(value()).toBe(DEFAULT);
  });
});

describe('FeatureFlags — signal identity is stable across reads', () => {
  it('returns the SAME signal instance for repeated reads of a key', () => {
    const { flags } = setup();
    // A template binding calls this on every change-detection pass; a fresh
    // signal each time would churn the binding and defeat OnPush.
    expect(flags.flag(KEY)).toBe(flags.flag(KEY));
  });

  it('keeps identity across the /flags response', async () => {
    const client = fakeClient({ [KEY]: !DEFAULT });
    const { flags } = setup({ client });
    const before = flags.flag(KEY);
    await flush();
    client.emit();

    expect(flags.flag(KEY)).toBe(before);
    expect(before()).toBe(!DEFAULT);
  });
});

describe('FeatureFlags — cacheable SSR output is never flag-dependent', () => {
  it('resolves nothing on the server: defaults only, client never borrowed', async () => {
    const { flags, analytics } = setup({ platform: 'server' });
    const value = flags.flag(KEY);
    await flush();

    // The SSR render can only ever see the committed default, so the HTML that
    // lands in the URL-keyed edge cache is visitor-neutral by construction.
    expect(value()).toBe(DEFAULT);
    expect(analytics.client).not.toHaveBeenCalled();
  });
});

/**
 * The keyless case runs the REAL factory (no `POSTHOG_CLIENT_FACTORY`
 * override) behind the REAL `Analytics`, so it exercises production wiring
 * end to end: bare local dev with no injected config must not touch the
 * network at all, not merely end up on the default.
 */
describe('FeatureFlags — keyless tiers are deterministic (bare local dev)', () => {
  // Replaced rather than spied: `fetch` is not guaranteed to be present on the
  // test global, and `vi.spyOn` throws on a missing property.
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in specs')));
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    resetPosthogJsFake();
    fetchSpy.mockClear();
    delete (globalThis as GlobalWithConfig).__AECI_POSTHOG__;
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  function setupKeyless() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: Router, useValue: { events: new Subject() } },
        { provide: ConsentService, useValue: { state: signal<ConsentState>('denied') } },
      ],
    });
    return TestBed.inject(FeatureFlags);
  }

  it('never initialises the SDK and never fetches', async () => {
    const flags = setupKeyless();
    const value = flags.flag(KEY);
    await flush();

    expect(posthogJsFake.init).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(value()).toBe(DEFAULT);
  });

  it('still reads a boolean for a flag requested after the boot settled', async () => {
    const flags = setupKeyless();
    await flush();

    expect(flags.flag(KEY)()).toBe(DEFAULT);
    expect(posthogJsFake.init).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
