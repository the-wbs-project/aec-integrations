/**
 * AECI-576 / Phase 8.3 P1.2 — `AdminOverview` logic + structural a11y.
 *
 * Harness mirrors `request-queue.component.spec.ts` (the pattern
 * `docs/ADMIN_PANEL_SPEC.md` §11 names for component specs): browser platform, a
 * macrotask `settle()` to drain `afterNextRender`'s async load, and a stubbed API
 * client. The live axe pass runs in Playwright / static-serve on rendered routes.
 *
 * What's actually load-bearing here, beyond load/error/empty:
 *   - the **two-wave** load — the page must be useful on wave 1 and must survive
 *     wave 2 failing entirely (a sparkline is not worth a broken dashboard);
 *   - **recompute is a GET with a flag** (§13 D8), and the two expensive status
 *     items go from "Not measured" to real numbers rather than from 0 to a number;
 *   - **no delta is invented** — a tile the API gives no delta for shows none.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminOverviewResponse, AdminTimeseriesResponse, VersionResponse } from '@aeci/shared';

import { AdminPanelApi } from '../admin-panel-api';
import { AdminOverview } from './overview';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** 30 consecutive UTC days, index 0 = 2026-07-14 … index 29 = 2026-08-12. */
function dayAt(index: number): string {
  const base = Date.UTC(2026, 6, 14); // 2026-07-14
  return new Date(base + index * 86_400_000).toISOString().slice(0, 10);
}

function series30d(): AdminOverviewResponse['traffic']['series_30d'] {
  return Array.from({ length: 30 }, (_, i) => ({ day: dayAt(i), human: i, bot: i * 2 }));
}

function makeOverview(over: Partial<AdminOverviewResponse> = {}): AdminOverviewResponse {
  return {
    window: {
      from: '2026-08-12T00:00:00.000Z',
      to: '2026-08-13T00:00:00.000Z',
      timezone: 'UTC',
      days: 1,
    },
    generated_at: '2026-08-13T05:00:00.000Z',
    source: 'live',
    recomputed: false,
    notes: [
      {
        code: 'requires_recompute',
        severity: 'info',
        message: 'Data-quality checks and Algolia drift are omitted.',
      },
    ],
    internal_filter: { available: false, applied: false, asns: [] },
    traffic: {
      // Post-automation (AECI-745): 92 counted server-side, 18 flagged.
      page_views_human: { total: 74, excluding_internal: null },
      page_views_human_raw: { total: 92, excluding_internal: null },
      automation_flagged: 18,
      page_views_bot: { total: 1840, excluding_internal: null },
      unique_visitors: { total: 31, excluding_internal: null },
      delta_day: { current: 74, prior: 68, diff: 6, pct: 9 },
      delta_7d: { current: 610, prior: 500, diff: 110, pct: 22 },
      series_30d: series30d(),
      top_sources: [
        { source: 'Google', views: 40 },
        { source: null, views: 12 },
      ],
      top_products: [{ name: 'Procore', slug: 'procore', views: 25 }],
      corroborated_views: 9,
      corroborated_visitors: 6,
      operator_leak_excluded: 26,
    },
    audience: {
      new_sign_ins: { current: 3, prior: 1, diff: 2, pct: 200 },
      total_users: 57,
      active_subscribers: 412,
    },
    catalog: { products: 130, integrations: 496, vendors: 88, claims: 210, attestations: 64 },
    status: {
      version: {
        sha: 'abcdef1234567890',
        deployed_at: '2026-08-13T04:00:00.000Z',
        environment: 'production',
      },
      stats_freshness: { computed_at: '2026-08-13T07:00:00.000Z', age_hours: 3, stale: false },
      moderation: { pending_reviews: 4, open_requests: 2 },
      data_quality: null,
      algolia_drift: null,
    },
    ...over,
  };
}

function makeRecomputed(): AdminOverviewResponse {
  const base = makeOverview();
  return {
    ...base,
    recomputed: true,
    notes: [],
    status: {
      ...base.status,
      data_quality: {
        source: 'live',
        computed_at: '2026-08-13T05:00:00.000Z',
        failing: 1,
        checks: [
          {
            id: 'logo_404',
            label: 'Product logos returning 404',
            severity: 'warn',
            count: 3,
            sample: [],
          },
          {
            id: 'orphan_integrations',
            label: 'Orphan integrations',
            severity: 'error',
            count: 0,
            sample: [],
          },
        ],
      },
      algolia_drift: {
        drifted: 1,
        indexes: [
          {
            entity: 'products',
            index_name: 'products_preview',
            database: 130,
            algolia: 128,
            drift: 2,
          },
          { entity: 'vendors', index_name: 'vendors_preview', database: 88, algolia: 88, drift: 0 },
        ],
      },
    },
  };
}

function makeTimeseries(metric: AdminTimeseriesResponse['metric']): AdminTimeseriesResponse {
  return {
    metric,
    interval: 'day',
    basis: 'additions',
    window: {
      from: '2026-07-14T00:00:00.000Z',
      to: '2026-08-13T00:00:00.000Z',
      timezone: 'UTC',
      days: 30,
    },
    generated_at: '2026-08-13T05:00:00.000Z',
    source: 'live',
    notes: [],
    internal_filter: { available: false, applied: false, asns: [] },
    points: Array.from({ length: 30 }, (_, i) => ({
      day: dayAt(i),
      value: i,
      value_excluding_internal: null,
      reconstructed: false,
    })),
    total: { total: 435, excluding_internal: null },
  };
}

const SSR_VERSION: VersionResponse = {
  sha: 'abcdef1234567890',
  deployedAt: '2026-08-13T04:00:00.000Z',
  environment: 'production',
};

// ─── Harness ─────────────────────────────────────────────────────────────────

interface ApiMock {
  getOverview: ReturnType<typeof vi.fn>;
  getTimeseries: ReturnType<typeof vi.fn>;
  getSsrVersion: ReturnType<typeof vi.fn>;
}

function makeApiMock(overview: AdminOverviewResponse = makeOverview()): ApiMock {
  return {
    getOverview: vi.fn(async () => structuredClone(overview)),
    getTimeseries: vi.fn(async ({ metric }: { metric: AdminTimeseriesResponse['metric'] }) =>
      makeTimeseries(metric),
    ),
    getSsrVersion: vi.fn(async () => ({ ...SSR_VERSION })),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminPanelApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(AdminOverview);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  // A second drain: wave 2 is dispatched from wave 1's continuation.
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

function sectionText(el: HTMLElement, headingId: string): string {
  const section = el.querySelector(`[aria-labelledby="${headingId}"]`);
  if (!section) throw new Error(`No section labelled by #${headingId}`);
  return section.textContent ?? '';
}

// ─── Specs ───────────────────────────────────────────────────────────────────

describe('AdminOverview', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('requests the default (digest) window — no day, no recompute', async () => {
    const { api } = await setup(makeApiMock());
    expect(api.getOverview).toHaveBeenCalledWith({});
  });

  it('renders the headline figures, catalog totals and the reported UTC day', async () => {
    const { el } = await setup(makeApiMock());
    expect(el.textContent).toContain('92'); // human page views
    expect(el.textContent).toContain('31'); // unique visitors
    expect(el.textContent).toContain('412'); // active subscribers
    expect(el.textContent).toContain('496'); // catalog integrations
    expect(el.textContent).toContain('2026-08-12'); // the window, stated
    expect(el.textContent).toContain('UTC');
  });

  it('renders the top sources and top products, linking a product to its page', async () => {
    const { el } = await setup(makeApiMock());
    expect(sectionText(el, 'admin-overview-sources-heading')).toContain('Google');
    const productLink = el.querySelector('a[href="/products/procore"]');
    expect(productLink?.textContent).toContain('Procore');
  });

  it('surfaces a null traffic source rather than dropping the row', async () => {
    const { el } = await setup(makeApiMock());
    const sources = sectionText(el, 'admin-overview-sources-heading');
    expect(sources).toContain('Unattributed');
    expect(sources).toContain('12');
  });

  it('renders the honesty notes as localized prose, not the wire message', async () => {
    const { el } = await setup(makeApiMock());
    expect(el.textContent).toContain('Recompute');
    expect(el.textContent).not.toContain('Data-quality checks and Algolia drift are omitted.');
  });

  describe('deltas', () => {
    it('renders both the day and 7-day delta for human page views', async () => {
      const { el } = await setup(makeApiMock());
      // The day delta is post-automation on both sides; the 7-day delta is raw
      // on both. Different populations, deliberately, and the caption says so.
      expect(el.textContent).toContain('+6 (+9%)');
      expect(el.textContent).toContain('+110 (+22%)');
    });

    it('omits the percentage when the prior period was zero — as the digest does', async () => {
      const base = makeOverview();
      const { el } = await setup(
        makeApiMock({
          ...base,
          traffic: { ...base.traffic, delta_day: { current: 5, prior: 0, diff: 5, pct: null } },
        }),
      );
      expect(el.textContent).toContain('+5 vs 0');
      expect(el.textContent).not.toContain('+5 (');
    });

    it('says "no change" rather than "+0"', async () => {
      const base = makeOverview();
      const { el } = await setup(
        makeApiMock({
          ...base,
          traffic: { ...base.traffic, delta_day: { current: 5, prior: 5, diff: 0, pct: 0 } },
        }),
      );
      expect(el.textContent).toContain('No change vs the prior day');
    });

    it('carries the measurement envelope on the human page-views tile (AECI-683)', async () => {
      // The figures that qualify the headline sit ON the headline's tile, the way
      // the 05:00 email prints them beside its own. A separate tile would put the
      // caveat somewhere the number is not.
      const { el } = await setup(makeApiMock());
      const tile = [...el.querySelectorAll('aec-stat-tile')].find((t) =>
        t.textContent?.includes('Human page views'),
      )!;
      expect(tile.textContent).toContain('upper bound');
      expect(tile.textContent).toContain('external search or social referrer: 9');
      expect(tile.textContent).toContain('distinct visitors: 6');
      expect(tile.textContent).toContain('lapsed session: 26');
    });

    it('leads with the post-automation figure and shows the subtraction (AECI-745)', async () => {
      // The number on the tile is the number the 05:00 email leads with. The raw
      // count it came from is beside it, because a filtered figure with no
      // visible minuend is a figure nobody can check.
      const { el } = await setup(makeApiMock());
      const tile = [...el.querySelectorAll('aec-stat-tile')].find((t) =>
        t.textContent?.includes('Human page views'),
      )!;
      expect(tile.textContent).toContain('Human page views after automation');
      expect(tile.textContent).toContain('74');
      expect(tile.textContent).toContain('Counted server-side: 92');
      expect(tile.textContent).toContain('attributed to automated clients: 18');
      // The upper-bound label now qualifies the RAW figure, not the headline.
      expect(tile.textContent).toContain('The server-side figure is an upper bound');
      // …and the raw week and trend line are labelled as such, since they sit
      // above a filtered headline.
      expect(tile.textContent).toContain('no automation filter applied');
    });

    it('says the figure is UNFILTERED when the detector did not run', async () => {
      // Null is an outage, not a clean day. It must never render as "0 flagged",
      // and the headline must not silently keep its "after automation" framing.
      const base = makeOverview();
      const { el } = await setup(
        makeApiMock({
          ...base,
          traffic: { ...base.traffic, automation_flagged: null },
        }),
      );
      const tile = [...el.querySelectorAll('aec-stat-tile')].find((t) =>
        t.textContent?.includes('Human page views'),
      )!;
      expect(tile.textContent).toContain('automation filter did not run');
      expect(tile.textContent).toContain('UNFILTERED');
      expect(tile.textContent).not.toContain('attributed to automated clients: 0');
      expect(tile.textContent).not.toContain('Counted server-side');
    });

    it('renders the two AECI-745 automation notes in the honesty envelope', async () => {
      const base = makeOverview();
      const applied = await setup(
        makeApiMock({
          ...base,
          notes: [
            {
              code: 'automation_filter_applied',
              severity: 'info',
              message: 'server fallback text',
            },
          ],
        }),
      );
      expect(applied.el.textContent).toContain('less those attributed to automated clients');
      // The localized body replaces the server's English message rather than
      // appearing beside it.
      expect(applied.el.textContent).not.toContain('server fallback text');

      const failed = await setup(
        makeApiMock({
          ...base,
          notes: [
            {
              code: 'automation_filter_did_not_run',
              severity: 'warn',
              message: 'server fallback text',
            },
          ],
        }),
      );
      expect(failed.el.textContent).toContain('automation filter did not run for this window');
    });

    it('omits the operator-leak sentence entirely when nothing leaked', async () => {
      // Zero is the healthy state, and "excluded: 0" reads like a finding.
      const base = makeOverview();
      const { el } = await setup(
        makeApiMock({ ...base, traffic: { ...base.traffic, operator_leak_excluded: 0 } }),
      );
      const tile = [...el.querySelectorAll('aec-stat-tile')].find((t) =>
        t.textContent?.includes('Human page views'),
      )!;
      expect(tile.textContent).not.toContain('lapsed session');
      expect(tile.textContent).toContain('external search or social referrer: 9');
    });

    it('renders the two AECI-683 caveats in the honesty envelope', async () => {
      const { el } = await setup(
        makeApiMock({
          ...makeOverview(),
          notes: [
            {
              code: 'corroborated_is_a_referrer_floor',
              severity: 'info',
              message: 'server copy is ignored',
            },
            {
              code: 'operator_leak_is_an_inference',
              severity: 'info',
              message: 'server copy is ignored',
            },
          ],
        }),
      );
      expect(el.textContent).toContain('Read it as a floor, not a count of people');
      expect(el.textContent).toContain('inference about who the visitor was');
    });

    it('invents no delta for the snapshot tiles (subscribers, catalog)', async () => {
      const { el } = await setup(makeApiMock());
      const tiles = [...el.querySelectorAll('aec-stat-tile')];
      const subscriberTile = tiles.find((t) => t.textContent?.includes('Active subscribers'))!;
      expect(subscriberTile.querySelector('ul[role="list"]')).toBeNull();
      expect(subscriberTile.textContent).toContain('Live total as of now');
    });
  });

  describe('second wave (sparkline series + SSR build)', () => {
    it('fetches only the series the bundle does not already carry, over its window', async () => {
      const { api } = await setup(makeApiMock());
      const metrics = api.getTimeseries.mock.calls.map((c) => c[0].metric);
      expect(metrics).toEqual(['traffic.unique_visitors', 'accounts.sign_ins_new']);
      expect(api.getTimeseries).toHaveBeenCalledWith({
        metric: 'traffic.unique_visitors',
        from: dayAt(0),
        to: dayAt(29),
      });
      // Human page views already ship in the bundle — never re-fetched.
      expect(metrics).not.toContain('traffic.page_views_human');
    });

    it('still renders the page when the whole second wave fails', async () => {
      const api = makeApiMock();
      api.getTimeseries.mockRejectedValue(new Error('boom'));
      api.getSsrVersion.mockRejectedValue(new Error('boom'));
      const { el } = await setup(api);
      expect(el.textContent).toContain('92');
      expect(el.querySelector('[role="alert"]')).toBeNull();
      // The human sparkline comes from the bundle, so it survives regardless.
      expect(el.querySelectorAll('aec-sparkline').length).toBeGreaterThan(0);
    });

    it('gives active subscribers no sparkline — there is no series for it', async () => {
      const { el } = await setup(makeApiMock());
      const subscriberTile = [...el.querySelectorAll('aec-stat-tile')].find((t) =>
        t.textContent?.includes('Active subscribers'),
      )!;
      expect(subscriberTile.querySelector('aec-sparkline')).toBeNull();
    });
  });

  describe('status strip', () => {
    it('reports the two network-dependent items as unmeasured, never as zero', async () => {
      const { el } = await setup(makeApiMock());
      const status = sectionText(el, 'admin-overview-status-heading');
      expect(status).toContain('Not measured');
      expect(status).not.toContain('0 of 0 failing');
    });

    it('links the moderation depths to their queues', async () => {
      const { el } = await setup(makeApiMock());
      const status = el.querySelector('[aria-labelledby="admin-overview-status-heading"]')!;
      expect(status.querySelector('a[href="/admin/reviews"]')?.textContent).toContain('4');
      expect(status.querySelector('a[href="/admin/requests"]')?.textContent).toContain('2');
    });

    it('flags an SSR/API build mismatch (AECI-92) and stays quiet when they agree', async () => {
      const agreeing = await setup(makeApiMock());
      expect(sectionText(agreeing.el, 'admin-overview-status-heading')).not.toContain(
        'different builds',
      );

      const api = makeApiMock();
      api.getSsrVersion.mockResolvedValue({ ...SSR_VERSION, sha: '9999999999999999' });
      const { el } = await setup(api);
      expect(sectionText(el, 'admin-overview-status-heading')).toContain('different builds');
    });

    it('does not cry wolf when a build sha is the "unknown" placeholder', async () => {
      const api = makeApiMock();
      api.getSsrVersion.mockResolvedValue({ ...SSR_VERSION, sha: 'unknown' });
      const { el } = await setup(api);
      expect(sectionText(el, 'admin-overview-status-heading')).not.toContain('different builds');
    });
  });

  describe('recompute', () => {
    it('re-requests with the flag — a GET, never a POST — and fills the expensive items', async () => {
      const api = makeApiMock();
      const { el, fixture } = await setup(api);
      api.getOverview.mockResolvedValueOnce(makeRecomputed());

      buttonByText(el, 'Recompute').click();
      await settle();
      await settle();
      fixture.detectChanges();

      expect(api.getOverview).toHaveBeenLastCalledWith({ recompute: true });
      const status = sectionText(el, 'admin-overview-status-heading');
      expect(status).not.toContain('Not measured');
      expect(status).toContain('1 of 2 failing');
      expect(status).toContain('Product logos returning 404');
      expect(status).toContain('1 of 2 indexes drifted');
    });

    it('announces the outcome politely — the numbers change with no focus change', async () => {
      const api = makeApiMock();
      const { el, fixture } = await setup(api);
      api.getOverview.mockResolvedValueOnce(makeRecomputed());

      buttonByText(el, 'Recompute').click();
      await settle();
      await settle();
      fixture.detectChanges();

      const live = el.querySelector('[role="status"]');
      expect(live?.getAttribute('aria-live')).toBe('polite');
      expect(live?.textContent).toContain('Recomputed');
    });

    it('keeps the figures already on screen when the recompute fails', async () => {
      const api = makeApiMock();
      const { el, fixture } = await setup(api);
      api.getOverview.mockRejectedValueOnce(new Error('boom'));

      buttonByText(el, 'Recompute').click();
      await settle();
      fixture.detectChanges();

      // Inline alert, not the full-page error state: throwing away a good
      // response over a failed optional refresh loses real information.
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Recompute failed');
      expect(el.textContent).not.toContain("couldn't load");
      expect(el.textContent).toContain('92');
      expect(el.querySelector('aec-status-strip')).not.toBeNull();
      expect(el.querySelector('[role="status"]')?.textContent).toContain('unchanged');
      // Still retryable.
      expect(buttonByText(el, 'Recompute').disabled).toBe(false);
    });
  });

  describe('load failure and empty windows', () => {
    it('shows a retryable state when the initial load fails, then recovers', async () => {
      const api = makeApiMock();
      api.getOverview.mockRejectedValueOnce(new Error('boom'));
      const { el, fixture } = await setup(api);

      expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
      buttonByText(el, 'Try again').click();
      await settle();
      await settle();
      fixture.detectChanges();
      expect(el.textContent).toContain('92');
    });

    it('renders per-section empty states for a window with no traffic', async () => {
      const base = makeOverview();
      const { el } = await setup(
        makeApiMock({
          ...base,
          traffic: {
            ...base.traffic,
            page_views_human: { total: 0, excluding_internal: null },
            series_30d: [],
            top_sources: [],
            top_products: [],
          },
        }),
      );
      expect(el.textContent).toContain('No page views recorded in the last 30 days');
      expect(el.textContent).toContain('No traffic sources recorded');
      expect(el.textContent).toContain('No product page views recorded');
    });

    it('skips the second wave entirely when there is no window to ask about', async () => {
      const base = makeOverview();
      const { api } = await setup(
        makeApiMock({ ...base, traffic: { ...base.traffic, series_30d: [] } }),
      );
      expect(api.getTimeseries).not.toHaveBeenCalled();
      // The SSR build check is independent of the traffic window.
      expect(api.getSsrVersion).toHaveBeenCalled();
    });
  });

  describe('accessibility (structural)', () => {
    it('uses a single h2 then h3 sections (no skipped levels, shell owns the h1)', async () => {
      const { el } = await setup(makeApiMock());
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelectorAll('h3').length).toBeGreaterThan(0);
      expect(el.querySelector('h4, h5, h6')).toBeNull();
    });

    it('names every section region with a real heading', async () => {
      const { el } = await setup(makeApiMock());
      for (const region of el.querySelectorAll('[aria-labelledby]')) {
        const id = region.getAttribute('aria-labelledby')!;
        expect(el.querySelector(`#${id}`)?.textContent?.trim()).toBeTruthy();
      }
    });

    it('gives the 30-day chart a text alternative as well as an accessible name', async () => {
      const { el } = await setup(makeApiMock());
      const chart = el.querySelector('aec-stacked-bar-chart')!;
      expect(chart.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBeTruthy();
      // §8: never the only representation — the same series in a hidden table.
      const table = chart.querySelector('table.sr-only');
      expect(table).not.toBeNull();
      expect(table!.querySelectorAll('tbody tr')).toHaveLength(30);
    });
  });
});
