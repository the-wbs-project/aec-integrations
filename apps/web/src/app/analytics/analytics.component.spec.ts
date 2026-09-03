/**
 * Tests for the `Analytics` service (AECI-239; two-mode init AECI-643). Named
 * `.component.spec.ts` so it runs under `ng test` — it needs Angular DI
 * (`PLATFORM_ID`, `effect`) and the DOM (`analyticsDimensions()` reads
 * `<html lang>` / `data-theme`).
 *
 * The PostHog SDK is never loaded: `posthog-js` is mocked module-wide (belt),
 * and a fake client is provided through the `POSTHOG_CLIENT_FACTORY` seam
 * (braces — the `search-rum` / `SEARCH_ENGINE_FACTORY` idiom), so every event's
 * payload — including the required `locale` + `theme` dimensions — is asserted
 * on a `vi.fn()`.
 */
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('posthog-js/dist/module.full.no-external', async () => {
  const { posthogJsModuleMock } = await import('./posthog-js.harness');
  return posthogJsModuleMock();
});

import { APP_STARTED_EVENT, Analytics, VENDOR_GROUP_TYPE } from './analytics';
import { ConsentService, type ConsentState } from './consent';
import {
  POSTHOG_CLIENT_FACTORY,
  TIER_3_PRODUCT_ANALYTICS_CONFIG,
  type PostHogClient,
} from './posthog-client';

/** Resolve queued fire-and-forget `boot().then(capture)` microtasks. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(opts: { platform?: 'browser' | 'server'; consent?: ConsentState } = {}) {
  const events = new Subject<NavigationEnd>();
  const state = signal<ConsentState>(opts.consent ?? 'granted');
  const client = {
    capture: vi.fn(),
    register: vi.fn(),
    set_config: vi.fn(),
    captureException: vi.fn(),
    historyAutocapture: { startIfEnabled: vi.fn() },
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
  };
  const factory = vi.fn((): Promise<PostHogClient | null> => Promise.resolve(client));

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform ?? 'browser' },
      { provide: Router, useValue: { events } },
      { provide: ConsentService, useValue: { state } },
      { provide: POSTHOG_CLIENT_FACTORY, useValue: factory },
    ],
  });
  const analytics = TestBed.inject(Analytics);
  return { analytics, client, factory, state, events };
}

const nav = (id: number, url: string) => new NavigationEnd(id, url, url);

/** Names of the events captured so far, ignoring their payloads. */
const captured = (client: { capture: ReturnType<typeof vi.fn> }): string[] =>
  client.capture.mock.calls.map((c) => c[0] as string);

const SEARCH_INPUT = {
  query: 'revit',
  results_count: 8,
  results_products: 6,
  results_vendors: 2,
  filters_applied: ['categories'],
  status: 'ok',
  duration_ms: 7,
  results_bucket: '6-20',
};

beforeEach(() => {
  document.documentElement.lang = 'en-US';
  delete document.documentElement.dataset['theme'];
});

afterEach(() => {
  delete document.documentElement.dataset['theme'];
});

describe('Analytics — custom events carry locale + theme (§14.1)', () => {
  it('every typed method fires its event with the locale + theme dimensions', async () => {
    const { analytics, client } = setup();

    analytics.searchPerformed(SEARCH_INPUT);
    analytics.productViewed('prod-1');
    analytics.integrationViewed('int-1');
    analytics.reviewSubmitted('prod-1');
    analytics.claimRequested({ target_type: 'vendor', slug: 'autodesk', request_id: 'req-1' });
    analytics.correctionRequested({ target_type: 'product', slug: 'revit', request_id: 'req-2' });
    analytics.externalLinkClicked({ destination: 'https://x.com', source: 'product_detail' });
    analytics.mailingListSignup({ source: 'home_closing_cta' });
    await flush();

    const dims = { locale: 'en-US', theme: 'light' };
    expect(client.capture).toHaveBeenCalledWith(
      'search_performed',
      expect.objectContaining({
        query: 'revit',
        results_count: 8,
        filters_applied: ['categories'],
        ...dims,
      }),
    );
    expect(client.capture).toHaveBeenCalledWith(
      'product_viewed',
      expect.objectContaining({ product_id: 'prod-1', source: 'direct', ...dims }),
    );
    expect(client.capture).toHaveBeenCalledWith(
      'integration_viewed',
      expect.objectContaining({ integration_id: 'int-1', ...dims }),
    );
    expect(client.capture).toHaveBeenCalledWith(
      'review_submitted',
      expect.objectContaining({ product_id: 'prod-1', ...dims }),
    );
    expect(client.capture).toHaveBeenCalledWith(
      'claim_requested',
      expect.objectContaining({
        target_type: 'vendor',
        slug: 'autodesk',
        request_id: 'req-1',
        ...dims,
      }),
    );
    expect(client.capture).toHaveBeenCalledWith(
      'correction_requested',
      expect.objectContaining({
        target_type: 'product',
        slug: 'revit',
        request_id: 'req-2',
        ...dims,
      }),
    );
    expect(client.capture).toHaveBeenCalledWith(
      'external_link_clicked',
      expect.objectContaining({ destination: 'https://x.com', source: 'product_detail', ...dims }),
    );
    expect(client.capture).toHaveBeenCalledWith(
      'mailing_list_signup',
      expect.objectContaining({ source: 'home_closing_cta', ...dims }),
    );
  });

  it('search_performed carries the re-homed status / duration_ms / results_bucket (§3.9)', async () => {
    const { analytics, client } = setup();
    analytics.searchPerformed(SEARCH_INPUT);
    await flush();
    expect(client.capture).toHaveBeenCalledWith(
      'search_performed',
      expect.objectContaining({ status: 'ok', duration_ms: 7, results_bucket: '6-20' }),
    );
  });

  it('does not fire mailing_list_signup before consent is granted', async () => {
    const { analytics, client } = setup({ consent: 'unknown' });
    TestBed.tick();
    analytics.mailingListSignup({ source: 'home_closing_cta' });
    await flush();
    expect(captured(client)).not.toContain('mailing_list_signup');
  });

  it('reads the live locale + theme from the <html> element', async () => {
    document.documentElement.lang = 'fr-FR';
    document.documentElement.dataset['theme'] = 'dark';
    const { analytics, client } = setup();

    analytics.integrationViewed('int-9');
    await flush();

    expect(client.capture).toHaveBeenCalledWith(
      'integration_viewed',
      expect.objectContaining({ locale: 'fr-FR', theme: 'dark' }),
    );
  });
});

describe('Analytics — Tier 2 operational slice (§3.3, runs for EVERY visitor)', () => {
  it('boots the client with NO consent decision and fires app_started', async () => {
    const { client, factory } = setup({ consent: 'unknown' });
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.capture).toHaveBeenCalledWith(APP_STARTED_EVENT, {
      locale: 'en-US',
      theme: 'light',
    });
  });

  it('boots the client when consent is DENIED (the DNT / GPC path)', async () => {
    const { client, factory } = setup({ consent: 'denied' });
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(captured(client)).toEqual([APP_STARTED_EVENT]);
  });

  it('never upgrades to Tier 3 while consent is unknown or denied', async () => {
    for (const consent of ['unknown', 'denied'] as const) {
      const { client } = setup({ consent });
      TestBed.tick();
      await flush();
      expect(client.set_config).not.toHaveBeenCalled();
      expect(captured(client)).not.toContain('$pageview');
    }
  });

  it('reports an exception without consent (operational, not gated)', async () => {
    const { analytics, client } = setup({ consent: 'denied' });
    const error = new Error('kaboom');
    analytics.captureException(error);
    await flush();
    expect(client.captureException).toHaveBeenCalledWith(error);
  });

  it('is a total no-op on the server platform', async () => {
    const { analytics, client, factory } = setup({ platform: 'server' });
    analytics.productViewed('prod-1');
    analytics.captureException(new Error('x'));
    await flush();
    expect(client.capture).not.toHaveBeenCalled();
    expect(client.captureException).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('Analytics — Tier 3 upgrade in place (§3.3)', () => {
  it('upgrades the SAME client on grant: set_config, history patch, $pageview', async () => {
    const { client, state } = setup({ consent: 'unknown' });
    TestBed.tick();
    await flush();
    expect(client.set_config).not.toHaveBeenCalled();

    state.set('granted');
    TestBed.tick();
    await flush();

    expect(client.set_config).toHaveBeenCalledExactlyOnceWith({
      ...TIER_3_PRODUCT_ANALYTICS_CONFIG,
    });
    expect(client.historyAutocapture.startIfEnabled).toHaveBeenCalledTimes(1);
    expect(client.capture).toHaveBeenCalledWith('$pageview', {
      locale: 'en-US',
      theme: 'light',
    });
  });

  it('never re-inits the client — one factory call across both tiers', async () => {
    const { factory, state } = setup({ consent: 'unknown' });
    TestBed.tick();
    await flush();
    state.set('granted');
    TestBed.tick();
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('upgrades at most once even if the consent signal re-fires', async () => {
    const { client, state } = setup({ consent: 'granted' });
    TestBed.tick();
    await flush();
    state.set('denied');
    state.set('granted');
    TestBed.tick();
    await flush();
    expect(client.set_config).toHaveBeenCalledTimes(1);
  });

  it('boots the client at most once across many events', async () => {
    const { analytics, factory } = setup();
    analytics.productViewed('a');
    analytics.productViewed('b');
    analytics.reviewSubmitted('a');
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('Analytics — product_viewed source inference', () => {
  it('is "direct" on the first view (no previous route)', async () => {
    const { analytics, client } = setup();
    analytics.productViewed('p');
    await flush();
    expect(client.capture).toHaveBeenCalledWith(
      'product_viewed',
      expect.objectContaining({ source: 'direct' }),
    );
  });

  it('is "search" when arriving from /search', async () => {
    const { analytics, client, events } = setup();
    events.next(nav(1, '/search?q=revit'));
    events.next(nav(2, '/products/x'));
    analytics.productViewed('x');
    await flush();
    expect(client.capture).toHaveBeenCalledWith(
      'product_viewed',
      expect.objectContaining({ source: 'search' }),
    );
  });

  it('is "browse" when arriving from a catalog index page', async () => {
    const { analytics, client, events } = setup();
    events.next(nav(1, '/products'));
    events.next(nav(2, '/products/x'));
    analytics.productViewed('x');
    await flush();
    expect(client.capture).toHaveBeenCalledWith(
      'product_viewed',
      expect.objectContaining({ source: 'browse' }),
    );
  });

  it('is "direct" when arriving from another detail page', async () => {
    const { analytics, client, events } = setup();
    events.next(nav(1, '/products/other'));
    events.next(nav(2, '/products/x'));
    analytics.productViewed('x');
    await flush();
    expect(client.capture).toHaveBeenCalledWith(
      'product_viewed',
      expect.objectContaining({ source: 'direct' }),
    );
  });
});

/**
 * Identity — AECI-649 / §AW8 (`docs/ANALYTICS.md` §8).
 *
 * The load-bearing property is the CONSENT INTERACTION, and it has to hold in
 * both directions: `identify()` and `group()` are Tier 3, so they must fire
 * once consent and the fact are BOTH present, whichever arrives second, and
 * never for a visitor who declined (or sends DNT/GPC, which `consent.ts` maps
 * to the same `'denied'`).
 */
describe('Analytics — identify (§AW8)', () => {
  it('identifies a consented, signed-in visitor with the user id and nothing else', async () => {
    const { analytics, client } = setup({ consent: 'granted' });
    TestBed.tick();
    await flush();

    analytics.identify('user-1');
    TestBed.tick();
    await flush();

    expect(client.identify).toHaveBeenCalledExactlyOnceWith('user-1');
  });

  it('does NOT identify a signed-in visitor who declined the banner', async () => {
    const { analytics, client } = setup({ consent: 'denied' });
    analytics.identify('user-1');
    TestBed.tick();
    await flush();
    expect(client.identify).not.toHaveBeenCalled();
  });

  it('does NOT identify while the banner is still unanswered', async () => {
    const { analytics, client } = setup({ consent: 'unknown' });
    analytics.identify('user-1');
    TestBed.tick();
    await flush();
    expect(client.identify).not.toHaveBeenCalled();
  });

  it('identifies when consent is granted AFTER sign-in (the other ordering)', async () => {
    const { analytics, client, state } = setup({ consent: 'unknown' });
    analytics.identify('user-1');
    TestBed.tick();
    await flush();
    expect(client.identify).not.toHaveBeenCalled();

    state.set('granted');
    TestBed.tick();
    await flush();

    expect(client.identify).toHaveBeenCalledExactlyOnceWith('user-1');
  });

  it('identifies only once when the same id is re-resolved on a later page', async () => {
    const { analytics, client } = setup({ consent: 'granted' });
    analytics.identify('user-1');
    TestBed.tick();
    await flush();
    analytics.identify('user-1');
    TestBed.tick();
    await flush();
    expect(client.identify).toHaveBeenCalledTimes(1);
  });

  it('upgrades to Tier 3 before identifying — the id must not land on memory persistence', async () => {
    const { analytics, client } = setup({ consent: 'granted' });
    analytics.identify('user-1');
    TestBed.tick();
    await flush();
    const upgradeOrder = client.set_config.mock.invocationCallOrder[0];
    const identifyOrder = client.identify.mock.invocationCallOrder[0];
    expect(upgradeOrder).toBeLessThan(identifyOrder);
  });

  it('is a no-op on the server platform', async () => {
    const { analytics, client } = setup({ platform: 'server', consent: 'granted' });
    analytics.identify('user-1');
    TestBed.tick();
    await flush();
    expect(client.identify).not.toHaveBeenCalled();
  });
});

describe('Analytics — vendor group (§AW8)', () => {
  it('groups the vendor by id, carrying only the display name', async () => {
    const { analytics, client } = setup({ consent: 'granted' });
    analytics.groupVendor({ id: 'vendor-1', name: 'Autodesk' });
    TestBed.tick();
    await flush();

    expect(client.group).toHaveBeenCalledExactlyOnceWith(VENDOR_GROUP_TYPE, 'vendor-1', {
      name: 'Autodesk',
    });
    expect(VENDOR_GROUP_TYPE).toBe('vendor');
  });

  it('does NOT group a vendor admin who declined the banner', async () => {
    const { analytics, client } = setup({ consent: 'denied' });
    analytics.groupVendor({ id: 'vendor-1', name: 'Autodesk' });
    TestBed.tick();
    await flush();
    expect(client.group).not.toHaveBeenCalled();
  });

  it('groups when consent is granted after the dashboard was already open', async () => {
    const { analytics, client, state } = setup({ consent: 'unknown' });
    analytics.groupVendor({ id: 'vendor-1', name: 'Autodesk' });
    TestBed.tick();
    await flush();
    expect(client.group).not.toHaveBeenCalled();

    state.set('granted');
    TestBed.tick();
    await flush();
    expect(client.group).toHaveBeenCalledExactlyOnceWith(VENDOR_GROUP_TYPE, 'vendor-1', {
      name: 'Autodesk',
    });
  });

  it('groups once across repeat navigations back to /vendor', async () => {
    const { analytics, client } = setup({ consent: 'granted' });
    analytics.groupVendor({ id: 'vendor-1', name: 'Autodesk' });
    TestBed.tick();
    await flush();
    analytics.groupVendor({ id: 'vendor-1', name: 'Autodesk' });
    TestBed.tick();
    await flush();
    expect(client.group).toHaveBeenCalledTimes(1);
  });
});

describe('Analytics — resetIdentity on logout (§AW8)', () => {
  it('resets the client', async () => {
    const { analytics, client } = setup({ consent: 'granted' });
    await analytics.resetIdentity();
    expect(client.reset).toHaveBeenCalledTimes(1);
    // Never `reset(true)` — the device id is not the person and survives logout.
    expect(client.reset).toHaveBeenCalledWith();
  });

  it('re-registers the required dimensions, which reset() clears from persistence', async () => {
    const { analytics, client } = setup({ consent: 'granted' });
    await analytics.resetIdentity();
    expect(client.register).toHaveBeenCalledWith({ locale: 'en-US', theme: 'light' });
    const resetOrder = client.reset.mock.invocationCallOrder[0];
    const registerOrder = client.register.mock.invocationCallOrder.at(-1) as number;
    expect(resetOrder).toBeLessThan(registerOrder);
  });

  it('forgets the identity, so the next person on the browser is identified afresh', async () => {
    const { analytics, client } = setup({ consent: 'granted' });
    analytics.identify('user-1');
    TestBed.tick();
    await flush();

    await analytics.resetIdentity();

    analytics.identify('user-2');
    TestBed.tick();
    await flush();
    expect(client.identify).toHaveBeenNthCalledWith(1, 'user-1');
    expect(client.identify).toHaveBeenNthCalledWith(2, 'user-2');
  });

  it('keeps the Tier 2 floor: the client is never torn down and events still flow', async () => {
    const { analytics, client, factory } = setup({ consent: 'denied' });
    await analytics.resetIdentity();
    analytics.captureException(new Error('after logout'));
    await flush();
    expect(client.captureException).toHaveBeenCalled();
    // Same client — reset never re-inits.
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on the server platform', async () => {
    const { analytics, client } = setup({ platform: 'server', consent: 'granted' });
    await analytics.resetIdentity();
    expect(client.reset).not.toHaveBeenCalled();
  });
});

describe('Analytics — an email address never reaches PostHog (§2)', () => {
  it('sends no argument containing an "@" across the whole surface', async () => {
    const { analytics, client } = setup({ consent: 'granted' });

    // The whole API a signed-in, vendor-admin visitor can drive. `identify`
    // takes the Supabase user id — the one place an email would be tempting,
    // and the one §2 names explicitly. `search_performed.query` is the single
    // grandfathered free-text property (§2), so it gets a real search term
    // rather than an address; if that term is ever an email it is the visitor's
    // own typing, not something this service put there.
    analytics.identify('4f1a0e3e-0000-4000-8000-000000000001');
    analytics.groupVendor({ id: 'vendor-1', name: 'Autodesk' });
    analytics.searchPerformed(SEARCH_INPUT);
    analytics.productViewed('prod-1');
    analytics.reviewSubmitted('prod-1');
    analytics.claimRequested({ target_type: 'vendor', slug: 'autodesk', request_id: 'req-1' });
    analytics.correctionRequested({ target_type: 'product', slug: 'revit', request_id: 'req-2' });
    analytics.externalLinkClicked({
      destination: 'https://autodesk.com',
      source: 'product_detail',
    });
    analytics.mailingListSignup({ source: 'mailing_list_band' });
    TestBed.tick();
    await flush();
    await analytics.resetIdentity();

    const everySentArgument = [
      ...client.capture.mock.calls,
      ...client.identify.mock.calls,
      ...client.group.mock.calls,
      ...client.register.mock.calls,
    ].flat();
    expect(everySentArgument.length).toBeGreaterThan(0);
    expect(JSON.stringify(everySentArgument)).not.toContain('@');
  });
});
