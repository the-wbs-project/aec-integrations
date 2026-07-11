/**
 * Tests for the `Analytics` service (AECI-239). Named `.component.spec.ts` so it
 * runs under `ng test` — it needs Angular DI (`PLATFORM_ID`, `effect`) and the
 * DOM (`analyticsDimensions()` reads `<html lang>` / `data-theme`).
 *
 * The PostHog SDK is never loaded: a fake client is provided through the
 * `POSTHOG_CLIENT_FACTORY` seam (the `search-rum` / `SEARCH_ENGINE_FACTORY`
 * idiom), so every event's payload — including the required `locale` + `theme`
 * dimensions — is asserted on a `vi.fn()`.
 */
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Analytics } from './analytics';
import { ConsentService, type ConsentState } from './consent';
import { POSTHOG_CLIENT_FACTORY, type PostHogClient } from './posthog-client';

/** Resolve queued fire-and-forget `boot().then(capture)` microtasks. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(opts: { platform?: 'browser' | 'server'; consent?: ConsentState } = {}) {
  const events = new Subject<NavigationEnd>();
  const state = signal<ConsentState>(opts.consent ?? 'granted');
  const client = { capture: vi.fn(), register: vi.fn() };
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

    analytics.searchPerformed({
      query: 'revit',
      results_count: 8,
      filters_applied: ['categories'],
    });
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

  it('does not fire mailing_list_signup before consent is granted', async () => {
    const { analytics, client, factory } = setup({ consent: 'unknown' });
    TestBed.tick();
    analytics.mailingListSignup({ source: 'home_closing_cta' });
    await flush();
    expect(client.capture).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
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

describe('Analytics — consent + platform gating', () => {
  it('does not capture (or load PostHog) before consent is granted', async () => {
    const { analytics, client, factory } = setup({ consent: 'unknown' });
    TestBed.tick();
    analytics.productViewed('prod-1');
    await flush();
    expect(client.capture).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not capture when consent is denied (e.g. DNT)', async () => {
    const { analytics, client, factory } = setup({ consent: 'denied' });
    TestBed.tick();
    analytics.productViewed('prod-1');
    await flush();
    expect(client.capture).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('boots PostHog as soon as consent is granted (for the initial pageview)', () => {
    const { factory, state } = setup({ consent: 'unknown' });
    TestBed.tick();
    expect(factory).not.toHaveBeenCalled();
    state.set('granted');
    TestBed.tick();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on the server platform', async () => {
    const { analytics, client, factory } = setup({ platform: 'server' });
    analytics.productViewed('prod-1');
    await flush();
    expect(client.capture).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
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
