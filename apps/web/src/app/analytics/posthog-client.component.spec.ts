/**
 * Tier 2 init contract (AECI-643 / `docs/POSTHOG_MIGRATION_SPEC.md` §3.3, D2).
 *
 * This is the ONE spec that drives the real `createPostHogClient`, against the
 * mocked `posthog-js` module, so the exact options handed to `posthog.init` are
 * asserted rather than assumed. `.component.spec.ts` so it runs under
 * `ng test` — `analyticsDimensions()` reads `<html lang>` / `data-theme`.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('posthog-js/dist/module.full.no-external', async () => {
  const { posthogJsModuleMock } = await import('./posthog-js.harness');
  return posthogJsModuleMock();
});

import {
  createPostHogClient,
  TIER_2_OPERATIONAL_CONFIG,
  TIER_3_PRODUCT_ANALYTICS_CONFIG,
} from './posthog-client';
import { lastInitConfig, posthogJsFake, resetPosthogJsFake } from './posthog-js.harness';

type GlobalWithConfig = { __AECI_POSTHOG__?: unknown };

const CONFIG = { key: 'phc_abc', host: 'https://us.i.posthog.com' };

function setDnt(value: string | undefined): void {
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value });
}

beforeEach(() => {
  resetPosthogJsFake();
  (globalThis as GlobalWithConfig).__AECI_POSTHOG__ = CONFIG;
  setDnt(undefined);
});

afterEach(() => {
  delete (globalThis as GlobalWithConfig).__AECI_POSTHOG__;
  setDnt(undefined);
});

describe('createPostHogClient — Tier 2 operational init (§3.3)', () => {
  it('initialises with the injected key + host and returns the client', async () => {
    const client = await createPostHogClient();
    expect(client).toBe(posthogJsFake);
    expect(posthogJsFake.init).toHaveBeenCalledTimes(1);
    expect(posthogJsFake.init.mock.calls[0][0]).toBe(CONFIG.key);
    expect(lastInitConfig()['api_host']).toBe(CONFIG.host);
  });

  it('writes nothing persistent: persistence is memory-only', async () => {
    await createPostHogClient();
    expect(lastInitConfig()['persistence']).toBe('memory');
  });

  it('captures no pageviews, no pageleave, and no autocapture before consent', async () => {
    await createPostHogClient();
    const cfg = lastInitConfig();
    expect(cfg['capture_pageview']).toBe(false);
    expect(cfg['capture_pageleave']).toBe(false);
    expect(cfg['autocapture']).toBe(false);
  });

  it('keeps session recording OFF (D5)', async () => {
    await createPostHogClient();
    expect(lastInitConfig()['disable_session_recording']).toBe(true);
  });

  it('enables the two operational signals: exceptions + web vitals', async () => {
    await createPostHogClient();
    const cfg = lastInitConfig();
    expect(cfg['capture_exceptions']).toBe(true);
    expect(cfg['capture_performance']).toEqual({ web_vitals: true });
  });

  it('sets respect_dnt FALSE so DNT does not suppress the operational slice (D2)', async () => {
    // `respect_dnt: true` makes posthog-js treat DNT as a hard opt-out, which
    // drops EVERY event on the instance, `$exception` and `$web_vitals`
    // included. DNT/GPC gating belongs to `ConsentService`, product slice only.
    await createPostHogClient();
    expect(lastInitConfig()['respect_dnt']).toBe(false);
    expect(TIER_2_OPERATIONAL_CONFIG.respect_dnt).toBe(false);
  });

  it('still initialises with the identical config when the browser sends DNT', async () => {
    setDnt('1');
    await createPostHogClient();
    expect(posthogJsFake.init).toHaveBeenCalledTimes(1);
    expect(lastInitConfig()['persistence']).toBe('memory');
    expect(lastInitConfig()['respect_dnt']).toBe(false);
  });

  it('registers the locale + theme dimensions from the loaded callback', async () => {
    document.documentElement.lang = 'en-US';
    await createPostHogClient();
    const loaded = lastInitConfig()['loaded'] as (ph: typeof posthogJsFake) => void;
    loaded(posthogJsFake);
    expect(posthogJsFake.register).toHaveBeenCalledWith({ locale: 'en-US', theme: 'light' });
  });

  it('never injects a remote script (CSP script-src stays untouched)', async () => {
    await createPostHogClient();
    expect(lastInitConfig()['disable_external_dependency_loading']).toBe(true);
  });

  it('returns null (and never inits) when the injected config is absent', async () => {
    delete (globalThis as GlobalWithConfig).__AECI_POSTHOG__;
    expect(await createPostHogClient()).toBeNull();
    expect(posthogJsFake.init).not.toHaveBeenCalled();
  });

  it('swallows an init failure rather than breaking the app', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    posthogJsFake.init.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await createPostHogClient()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('TIER_3_PRODUCT_ANALYTICS_CONFIG — the upgrade delta (§3.3)', () => {
  it('moves persistence to localStorage and turns pageviews on', () => {
    expect(TIER_3_PRODUCT_ANALYTICS_CONFIG).toEqual({
      persistence: 'localStorage+cookie',
      capture_pageview: 'history_change',
      capture_pageleave: 'if_capture_pageview',
    });
  });
});
