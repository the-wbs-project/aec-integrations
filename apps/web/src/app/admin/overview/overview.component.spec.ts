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
  return Array.from({ length: 30 }, (_, i) => ({
    day: dayAt(i),
    human: i,
    bot: i * 2,
    degraded: false,
  }));
}

/** AECI-1346. Per-class views for day `i`: identified, suspected, human, unresolved. */
function classCounts(i: number) {
  return {
    identified_automation: 1000 + i,
    suspected_automation: 200 + i,
    browser_with_human_evidence: 40 + i,
    unresolved: 300 + i,
  };
}

function classSeries30d(
  version: (i: number) => string | null = () => 'tc-2026.10.1',
): AdminOverviewResponse['classification_series_30d'] {
  return Array.from({ length: 30 }, (_, i) => {
    const v = version(i);
    return {
      day: dayAt(i),
      classifier_version: v,
      counts: v === null ? null : classCounts(i),
      method_change: null,
    };
  });
}

/** The reported day (index 29) against the prior day (index 28), all comparable. */
function classSummary(
  over: Partial<AdminOverviewResponse['classification']> = {},
): AdminOverviewResponse['classification'] {
  const today = classCounts(29);
  const prior = classCounts(28);
  const keys = [
    'identified_automation',
    'suspected_automation',
    'browser_with_human_evidence',
    'unresolved',
  ] as const;
  return {
    classifier_version: 'tc-2026.10.1',
    counts: keys.map((k) => ({
      class: k,
      views: today[k],
      visitors: Math.floor(today[k] / 3),
      delta_day: {
        current: today[k],
        prior: prior[k],
        diff: today[k] - prior[k],
        pct: Math.round(((today[k] - prior[k]) / prior[k]) * 100),
      },
    })),
    internal_excluded: { views: 37, operator_leak_inferred: 4 },
    basis: 'requests',
    version_seam: null,
    method_seams: [],
    ...over,
  };
}

/** AECI-1346. The API's not-classified shape: null version, four zeros. */
function notClassifiedSummary(): AdminOverviewResponse['classification'] {
  return classSummary({
    classifier_version: null,
    counts: classSummary().counts.map((c) => ({ ...c, views: 0, visitors: 0, delta_day: null })),
    internal_excluded: { views: 0, operator_leak_inferred: 0 },
  });
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
      page_views_bot: { total: 1840, excluding_internal: null },
      unique_visitors: { total: 31, excluding_internal: null },
      series_30d: series30d(),
      top_sources: [
        { source: 'Google', views: 40 },
        { source: null, views: 12 },
      ],
      top_products: [{ name: 'Procore', slug: 'procore', views: 25 }],
      // Healthy by default (AECI-869); the blind case is seeded per test.
      arrival_telemetry: {
        arrivals: 900,
        arrivals_with_asn: 900,
        coverage: 1,
        degraded: false,
      },
    },
    // AECI-1346. The lead card's figures: one version across the window.
    classification: classSummary(),
    classification_series_30d: classSeries30d(),
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
      moderation: { pending_reviews: 4, open_requests: 2, open_claims: 3 },
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
    it('renders the sign-in day delta', async () => {
      const { el } = await setup(makeApiMock());
      expect(el.textContent).toContain('+2 (+200%)');
    });

    it('omits the percentage when the prior period was zero — as the digest does', async () => {
      const base = makeOverview();
      const { el } = await setup(
        makeApiMock({
          ...base,
          audience: {
            ...base.audience,
            new_sign_ins: { current: 5, prior: 0, diff: 5, pct: null },
          },
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
          audience: {
            ...base.audience,
            new_sign_ins: { current: 5, prior: 5, diff: 0, pct: 0 },
          },
        }),
      );
      expect(el.textContent).toContain('No change vs the prior day');
    });

    it('renders the two AECI-869 notes in the honesty envelope', async () => {
      const base = makeOverview();
      const blind = await setup(
        makeApiMock({
          ...base,
          notes: [
            {
              code: 'arrival_telemetry_unavailable',
              severity: 'warn',
              message: 'server fallback text',
              params: { arrivals: 2736, arrivals_with_asn: 0 },
            },
          ],
        }),
      );
      expect(blind.el.textContent).toContain(
        'Network information was missing from most page loads',
      );
      expect(blind.el.textContent).toContain('0');
      expect(blind.el.textContent).toContain('2736');
      // Localized prose replaces the server's English fallback rather than
      // appearing beside it (§9.4).
      expect(blind.el.textContent).not.toContain('server fallback text');

      const spans = await setup(
        makeApiMock({
          ...base,
          notes: [
            {
              code: 'series_spans_degraded_days',
              severity: 'warn',
              message: 'server fallback text',
              params: { degraded_days: 4, requested: 30 },
            },
          ],
        }),
      );
      expect(spans.el.textContent).toContain('were missing network information');
      expect(spans.el.textContent).toContain('Do not read a step across those days');
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
      expect(el.textContent).toContain('31');
      expect(el.querySelector('[role="alert"]')).toBeNull();
      // Since AECI-1460 every sparkline comes from the second wave, so the tiles
      // render without one rather than failing.
      expect(el.querySelectorAll('aec-stat-tile')).toHaveLength(3);
      expect(el.querySelectorAll('aec-sparkline')).toHaveLength(0);
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

    // AECI-922: one link per Operations queue. Corrections and claims are counted
    // apart because `/admin/requests` is corrections-only — a combined figure here
    // would send the operator to a page holding fewer rows than the number they
    // clicked, and would disagree with the nav badge beside it.
    it('links each moderation depth to its own queue', async () => {
      const { el } = await setup(makeApiMock());
      const status = el.querySelector('[aria-labelledby="admin-overview-status-heading"]')!;
      expect(status.querySelector('a[href="/admin/reviews"]')?.textContent).toContain('4');
      expect(status.querySelector('a[href="/admin/requests"]')?.textContent).toContain('2');
      expect(status.querySelector('a[href="/admin/claims"]')?.textContent).toContain('3');
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
      expect(el.textContent).toContain('412');
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
            series_30d: [],
            top_sources: [],
            top_products: [],
          },
          // The chart draws from the class series since AECI-1346.
          classification_series_30d: [],
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

    // AECI-877 — a degraded day must not draw exactly like a healthy one.
    it('marks degraded days on the chart and in its hidden table, and only those', async () => {
      const series = series30d().map((p, i) => (i === 3 || i === 7 ? { ...p, degraded: true } : p));
      const base = makeOverview();
      const { el } = await setup(
        makeApiMock(makeOverview({ traffic: { ...base.traffic, series_30d: series } })),
      );
      const chart = el.querySelector('aec-stacked-bar-chart')!;
      expect(chart.querySelectorAll('rect[data-degraded-day]')).toHaveLength(2);
      expect(chart.querySelectorAll('rect[fill-opacity="0.4"]').length).toBeGreaterThan(0);
      expect(chart.textContent).toContain('Missing network information');

      const rows = [...chart.querySelectorAll('table.sr-only tbody tr')];
      const flagged = rows.filter((tr) => tr.lastElementChild?.textContent?.trim() === 'Yes');
      expect(flagged).toHaveLength(2);
    });

    it('adds no degraded legend, overlay or table column when no day is degraded', async () => {
      const { el } = await setup(makeApiMock());
      const chart = el.querySelector('aec-stacked-bar-chart')!;
      expect(chart.querySelector('rect[data-degraded-day]')).toBeNull();
      expect(chart.querySelector('pattern')).toBeNull();
      expect(chart.textContent).not.toContain('Missing network information');
    });
  });
  // ─── AECI-1346: the classes lead; AECI-1460: the residual tile is gone ──────
  describe('traffic classes (AECI-1346)', () => {
    it('leads with the classes card, before the stat tiles', async () => {
      const { el } = await setup(makeApiMock());
      const card = el.querySelector('aec-traffic-classes-card');
      const firstTile = el.querySelector('aec-stat-tile');
      expect(card).not.toBeNull();
      // DOCUMENT_POSITION_FOLLOWING: the tile comes after the card.
      expect(card!.compareDocumentPosition(firstTile!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const classes = [...card!.querySelectorAll('[data-class]')].map((n) =>
        n.getAttribute('data-class'),
      );
      expect(classes).toEqual([
        'identified_automation',
        'suspected_automation',
        'browser_with_human_evidence',
        'unresolved',
      ]);
      expect(card!.textContent).toContain('Classifier tc-2026.10.1');
      expect(card!.textContent).toContain('Requests, not people');
    });

    it('renders no residual tile and no residual caption (AECI-1460)', async () => {
      const { el } = await setup(makeApiMock());
      const labels = [...el.querySelectorAll('aec-stat-tile')].map((t) => t.textContent ?? '');
      expect(labels).toHaveLength(3);
      expect(labels.some((l) => l.includes('Unique visitors'))).toBe(true);
      expect(labels.some((l) => l.includes('New sign-ins'))).toBe(true);
      expect(labels.some((l) => l.includes('Active subscribers'))).toBe(true);
      expect(el.textContent).not.toContain('unresolved origin');
      expect(el.textContent).not.toContain('previous measure');
      expect(el.textContent).not.toContain('Requests no rule could exclude');
      expect(el.textContent).not.toContain('corroborates them as human');
      expect(el.textContent).not.toContain('Browser starts');
    });

    it('renders the tables_unclassified note as localized prose (AECI-1460)', async () => {
      const { el } = await setup(
        makeApiMock({
          ...makeOverview(),
          notes: [{ code: 'tables_unclassified', severity: 'info', message: 'server copy' }],
        }),
      );
      expect(el.textContent).toContain(
        'This day has no traffic classes, so the product and source tables are not filtered for automation.',
      );
      expect(el.textContent).not.toContain('server copy');
    });

    it('names the classifier change when the reported day starts a new version', async () => {
      const series = classSeries30d((i) => (i < 29 ? 'tc-2026.10.1' : 'tc-2026.10.2'));
      const summary = classSummary({
        classifier_version: 'tc-2026.10.2',
        counts: classSummary().counts.map((c) => ({ ...c, delta_day: null })),
        version_seam: {
          from_version: 'tc-2026.10.1',
          to_version: 'tc-2026.10.2',
          changed_on: dayAt(29),
        },
      });
      const { el } = await setup(
        makeApiMock(makeOverview({ classification: summary, classification_series_30d: series })),
      );
      const deltas = [...el.querySelectorAll('aec-traffic-classes-card [data-delta]')];
      expect(deltas).toHaveLength(4);
      for (const d of deltas) {
        expect(d.textContent?.trim()).toBe(
          'Not comparable with the prior day (classifier changed)',
        );
      }
    });

    it('says the prior day was not classified when that is why', async () => {
      const series = classSeries30d((i) => (i === 28 ? null : 'tc-2026.10.1'));
      const summary = classSummary({
        counts: classSummary().counts.map((c) => ({ ...c, delta_day: null })),
      });
      const { el } = await setup(
        makeApiMock(makeOverview({ classification: summary, classification_series_30d: series })),
      );
      const delta = el.querySelector('aec-traffic-classes-card [data-delta]');
      expect(delta?.textContent?.trim()).toBe(
        'Not comparable with the prior day (prior day not classified)',
      );
    });

    it('shows "Not classified" and no zeros when the classifier did not run', async () => {
      const { el } = await setup(
        makeApiMock(
          makeOverview({
            classification: notClassifiedSummary(),
            classification_series_30d: classSeries30d(() => null),
          }),
        ),
      );
      const card = el.querySelector('aec-traffic-classes-card')!;
      expect(card.querySelector('[data-not-classified]')).not.toBeNull();
      expect(card.querySelector('[data-class]')).toBeNull();
      expect(card.querySelector('[data-internal]')).toBeNull();
      expect(card.textContent).toContain('Not classified');

      const chart = el.querySelector('aec-stacked-bar-chart')!;
      expect(chart.querySelectorAll('rect[data-not-measured]')).toHaveLength(30);
      // Outlines, not the empty-state line that would claim nothing was recorded.
      expect(chart.textContent).not.toContain('No page views recorded');
      const firstRow = chart.querySelector('table.sr-only tbody tr')!;
      expect(firstRow.textContent).toContain('Not classified');
      expect(firstRow.textContent).not.toMatch(/\b0\b/);
    });

    it('draws the 30-day chart from the class series, four labelled series', async () => {
      const { el } = await setup(makeApiMock());
      const chart = el.querySelector('aec-stacked-bar-chart')!;
      const headers = [...chart.querySelectorAll('table.sr-only thead th')].map((th) =>
        th.textContent?.trim(),
      );
      expect(headers).toEqual([
        'Day',
        'Identified automation',
        'Suspected automation',
        'Browser activity with supporting human evidence',
        'Unresolved',
      ]);
      const lastRow = [...chart.querySelectorAll('table.sr-only tbody tr')].at(-1)!;
      expect([...lastRow.querySelectorAll('td')].map((td) => td.textContent?.trim())).toEqual([
        '1029',
        '229',
        '69',
        '329',
      ]);
      expect(chart.querySelector('line[data-boundary]')).toBeNull();
      expect(chart.querySelector('rect[data-not-measured]')).toBeNull();
    });

    it('draws a boundary at a classifier change and a method change, with legend entries', async () => {
      const series = classSeries30d((i) =>
        i < 3 ? null : i < 20 ? 'tc-2026.10.1' : 'tc-2026.10.2',
      );
      series[25] = {
        ...series[25]!,
        method_change: { summary: 'gateway writes every arrival', arrivals_comparable: true },
      };
      const { el } = await setup(makeApiMock(makeOverview({ classification_series_30d: series })));
      const chart = el.querySelector('aec-stacked-bar-chart')!;
      // The first classified day after unclassified ones is not a version change.
      expect(chart.querySelectorAll('line[data-boundary]')).toHaveLength(2);
      expect(chart.querySelectorAll('rect[data-not-measured]')).toHaveLength(3);
      expect(chart.textContent).toContain('Classifier changed: tc-2026.10.1 to tc-2026.10.2');
      expect(chart.textContent).toContain('Collection method changed, counts comparable');
      expect(chart.textContent).toContain('Not classified');
      const headers = [...chart.querySelectorAll('table.sr-only thead th')].map((th) =>
        th.textContent?.trim(),
      );
      expect(headers).toContain('Classifier version');
      expect(headers).toContain('Change before this day');
    });
  });
});
