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

import { APP_STARTED_EVENT, Analytics } from './analytics';
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
