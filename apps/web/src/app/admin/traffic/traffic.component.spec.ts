/**
 * AECI-578 / Phase 8.3 P1.4 — `/admin/traffic`.
 *
 * Mirrors `request-queue.component.spec.ts`: browser platform, a macrotask
 * `settle()` to drain `afterNextRender`'s async load, and a mocked API. The live
 * axe pass runs in Playwright against the rendered route (the repo's
 * component-level a11y convention).
 *
 * The load-bearing assertion in this file is the **§9.5 timezone invariant**:
 * flipping UTC ↔ WIB must issue no request and must not move a bucket. It is
 * asserted rather than trusted because the failure mode is silent — the numbers
 * would still look plausible, they would just no longer be the numbers the 05:00
 * digest email reports.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminTimeseriesResponse, AdminTrafficBreakdownResponse } from '@aeci/shared';

import { AdminTraffic } from './traffic';
import { AdminTrafficApi } from './admin-traffic-api';

const WINDOW = {
  from: '2026-07-15T00:00:00.000Z',
  to: '2026-08-14T00:00:00.000Z',
  timezone: 'UTC' as const,
  days: 30,
};

function makeTimeseries(over: Partial<AdminTimeseriesResponse> = {}): AdminTimeseriesResponse {
  return {
    metric: 'traffic.page_views_human',
    interval: 'day',
    window: WINDOW,
    generated_at: '2026-08-13T17:30:00.000Z',
    source: 'live',
    notes: [],
    internal_filter: { available: false, applied: false, asns: [] },
    points: [
      { day: '2026-08-11', value: 12, value_excluding_internal: null },
      { day: '2026-08-12', value: 3400, value_excluding_internal: null },
      { day: '2026-08-13', value: 7, value_excluding_internal: null },
    ],
    total: { total: 3419, excluding_internal: null },
    ...over,
  };
}

function makeBreakdown(
  over: Partial<AdminTrafficBreakdownResponse> = {},
): AdminTrafficBreakdownResponse {
  return {
    data: [
      {
        key: 'google.com',
        label: 'google.com',
        ref: null,
        views: 900,
        views_excluding_internal: null,
      },
      { key: null, label: 'Unattributed', ref: null, views: 100, views_excluding_internal: null },
    ],
    page: 1,
    perPage: 8,
    total: 2,
    dimension: 'source',
    traffic: 'human',
    window: WINDOW,
    generated_at: '2026-08-13T17:30:00.000Z',
    source: 'live',
    notes: [],
    internal_filter: { available: false, applied: false, asns: [] },
    window_total: { total: 3419, excluding_internal: null },
    ...over,
  };
}

interface ApiMock {
  timeseries: ReturnType<typeof vi.fn>;
  breakdown: ReturnType<typeof vi.fn>;
}

function makeApi(over: Partial<ApiMock> = {}): ApiMock {
  return {
    timeseries: vi.fn(async () => makeTimeseries()),
    breakdown: vi.fn(async () => makeBreakdown()),
    ...over,
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock = makeApi()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminTrafficApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(AdminTraffic);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn;
}

async function click(fixture: { detectChanges(): void }, btn: HTMLButtonElement) {
  btn.click();
  await settle();
  fixture.detectChanges();
}

describe('AdminTraffic', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('paints a visitor-state-neutral shell before any data arrives', () => {
    // The SSR first paint: no fetch has resolved, so nothing data-derived and
    // nothing date-derived is in the HTML. `/admin/*` is non-cacheable, but the
    // page still must not bake a clock reading into its server render.
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AdminTrafficApi, useValue: makeApi() },
      ],
    });
    const fixture = TestBed.createComponent(AdminTraffic);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Loading traffic data');
    expect(el.textContent).not.toContain('3,419');
    expect(el.querySelector('svg')).toBeNull();
  });

  it('fetches three metrics and five breakdowns for the default 30-day window', async () => {
    const { api } = await setup();
    expect(api.timeseries).toHaveBeenCalledTimes(3);
    expect(api.breakdown).toHaveBeenCalledTimes(5);

    const metrics = api.timeseries.mock.calls.map((c) => (c[0] as { metric: string }).metric);
    expect(metrics).toEqual([
      'traffic.page_views_human',
      'traffic.page_views_bot',
      'traffic.unique_visitors',
    ]);

    const dimensions = api.breakdown.mock.calls.map(
      (c) => (c[0] as { dimension: string }).dimension,
    );
    expect(dimensions).toEqual(['source', 'path', 'product', 'country', 'bot']);

    // Both ends inclusive, so a 30-day window spans 29 days of offset.
    const q = api.timeseries.mock.calls[0]![0] as { from: string; to: string };
    const from = Date.parse(`${q.from}T00:00:00Z`);
    const to = Date.parse(`${q.to}T00:00:00Z`);
    expect((to - from) / 86_400_000).toBe(29);
  });

  it('renders the headline figures and the day-bucketed charts', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('Human page views');
    expect(el.textContent).toContain('3,419');
    expect(el.querySelectorAll('[role="img"]').length).toBeGreaterThan(0);
    // Day labels come from the bucket keys, never from an instant.
    expect(el.textContent).toContain('11 Aug');
  });

  it('states the visitor definition next to the number (§9.8)', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('distinct browser-and-network pair');
    expect(el.textContent).toContain('over-counts');
    expect(el.textContent).toContain('under-counts');
  });

  // ── §9.5: the timezone toggle is presentational ────────────────────────────

  it('labels the window in UTC by default and says buckets are UTC days', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('2026-07-15 00:00 UTC');
    expect(el.textContent).toContain('Daily buckets are UTC days.');
  });

  it('re-labels instants in WIB WITHOUT issuing a request (§9.5)', async () => {
    const { fixture, api, el } = await setup();
    const callsBefore = api.timeseries.mock.calls.length + api.breakdown.mock.calls.length;

    await click(fixture, buttonByText(el, 'WIB'));

    // The invariant: presentational only. The underlying window is always UTC.
    expect(api.timeseries.mock.calls.length + api.breakdown.mock.calls.length).toBe(callsBefore);
    expect(el.textContent).toContain('2026-07-15 07:00 WIB');
    // And it still says what a bucket is, in terms the operator can reconcile.
    expect(el.textContent).toContain('07:00 to 07:00 WIB');
  });

  it('does not move a bucket when the display zone changes', async () => {
    const { fixture, el } = await setup();
    const before = el.textContent;
    expect(before).toContain('11 Aug');

    await click(fixture, buttonByText(el, 'WIB'));

    // `generated_at` is 17:30Z — 00:30 the NEXT day in Jakarta. The instant
    // re-labels; the buckets do not.
    expect(el.textContent).toContain('2026-08-14 00:30 WIB');
    expect(el.textContent).toContain('11 Aug');
    expect(el.textContent).toContain('13 Aug');
    expect(el.textContent).not.toContain('14 Aug ');
  });

  // ── Filters that DO re-query ───────────────────────────────────────────────

  it('re-fetches on a range change', async () => {
    const { fixture, api, el } = await setup();
    api.timeseries.mockClear();
    await click(fixture, buttonByText(el, '7 days'));
    expect(api.timeseries).toHaveBeenCalledTimes(3);
    const q = api.timeseries.mock.calls[0]![0] as { from: string; to: string };
    const days = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000;
    expect(days).toBe(6);
  });

  it('re-fetches on a population change and passes it to the breakdowns', async () => {
    const { fixture, api, el } = await setup();
    api.breakdown.mockClear();
    await click(fixture, buttonByText(el, 'Bots'));
    const traffic = api.breakdown.mock.calls.map((c) => (c[0] as { traffic?: string }).traffic);
    expect(traffic).toEqual(['bot', 'bot', 'bot', 'bot', 'bot']);
  });

  it('ignores a re-click of the active filter rather than re-querying', async () => {
    const { fixture, api, el } = await setup();
    api.timeseries.mockClear();
    await click(fixture, buttonByText(el, '30 days'));
    expect(api.timeseries).not.toHaveBeenCalled();
  });

  // ── The internal-traffic filter (§13 D10) ──────────────────────────────────

  it('hides the internal-traffic toggle when the var is unset (the shipped default)', async () => {
    const { el } = await setup();
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('shows the toggle, named with its ASNs, when the filter is configured', async () => {
    const filter = { available: true, applied: false, asns: [23700] };
    const { el } = await setup(
      makeApi({
        timeseries: vi.fn(async () => makeTimeseries({ internal_filter: filter })),
        breakdown: vi.fn(async () => makeBreakdown({ internal_filter: filter })),
      }),
    );
    expect(el.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(el.textContent).toContain('AS23700');
  });

  it('reports the unfiltered figure until the operator opts in', async () => {
    // §13 D10 constraint 2: `total` is ALWAYS the unfiltered figure and a
    // filtered one can never masquerade as it.
    const filter = { available: true, applied: true, asns: [23700] };
    const { el } = await setup(
      makeApi({
        timeseries: vi.fn(async () =>
          makeTimeseries({
            internal_filter: filter,
            total: { total: 3419, excluding_internal: 120 },
          }),
        ),
        breakdown: vi.fn(async () => makeBreakdown({ internal_filter: filter })),
      }),
    );
    expect(el.textContent).toContain('3,419');
    expect(el.textContent).not.toContain('120');
  });

  // ── Notes, empty and error states ──────────────────────────────────────────

  it('localizes the honesty envelope from the note code, not the wire message', async () => {
    const notes = [
      {
        code: 'bot_classification_incomplete' as const,
        severity: 'warn' as const,
        message: 'RAW OPERATOR TEXT',
        // `rows` is the key the API actually sends (`trafficNotes`). The fixture
        // used to say `count`, which masked the component reading the wrong key.
        params: { rows: 42 },
      },
    ];
    const { el } = await setup(
      makeApi({ timeseries: vi.fn(async () => makeTimeseries({ notes })) }),
    );
    expect(el.textContent).toContain('42 views in this window have no bot classification');
    expect(el.textContent).not.toContain('RAW OPERATOR TEXT');
  });

  it('shows each note once even though eight responses repeat it', async () => {
    const note = {
      code: 'partial_day' as const,
      severity: 'info' as const,
      message: 'partial',
    };
    const { el } = await setup(
      makeApi({
        timeseries: vi.fn(async () => makeTimeseries({ notes: [note] })),
        breakdown: vi.fn(async () => makeBreakdown({ notes: [note] })),
      }),
    );
    const rendered = el.querySelectorAll('aec-admin-note-list li');
    expect(rendered).toHaveLength(1);
  });

  it('falls back to the operator message for a code this build does not know', async () => {
    const notes = [
      {
        code: 'some_future_code' as unknown as 'partial_day',
        severity: 'info' as const,
        message: 'A caveat from a newer API.',
      },
    ];
    const { el } = await setup(
      makeApi({ timeseries: vi.fn(async () => makeTimeseries({ notes })) }),
    );
    // Untranslated beats swallowed: a caveat that silently vanishes is the exact
    // failure the honesty envelope exists to prevent.
    expect(el.textContent).toContain('A caveat from a newer API.');
  });

  it('renders empty states rather than blank charts on an empty window', async () => {
    const { el } = await setup(
      makeApi({
        timeseries: vi.fn(async () =>
          makeTimeseries({ points: [], total: { total: 0, excluding_internal: null } }),
        ),
        breakdown: vi.fn(async () =>
          makeBreakdown({
            data: [],
            total: 0,
            window_total: { total: 0, excluding_internal: null },
          }),
        ),
      }),
    );
    expect(el.textContent).toContain('No views recorded in this window.');
    expect(el.textContent).toContain('0');
  });

  it('surfaces a retryable error when the reads fail', async () => {
    const api = makeApi({ timeseries: vi.fn(async () => Promise.reject(new Error('boom'))) });
    const { fixture, el } = await setup(api);
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.textContent).toContain('Traffic data could not be loaded.');

    api.timeseries = vi.fn(async () => makeTimeseries());
    await click(fixture, buttonByText(el, 'Try again'));
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain('3,419');
  });

  // ── Structural a11y the axe pass relies on ─────────────────────────────────

  it('gives every filter group an accessible name and every toggle a pressed state', async () => {
    const { el } = await setup();
    const legends = [...el.querySelectorAll('fieldset legend')].map((l) => l.textContent?.trim());
    expect(legends).toContain('Date range');
    expect(legends).toContain('Traffic type');
    expect(legends).toContain('Timestamp display timezone');
    expect(buttonByText(el, 'UTC').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText(el, 'WIB').getAttribute('aria-pressed')).toBe('false');
  });

  it('renders headings in order beneath the shell h1', async () => {
    const { el } = await setup();
    const levels = [...el.querySelectorAll('h2, h3')].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(2);
    // No level is skipped — the shell owns h1, this page starts at h2.
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    }
  });

  it('labels the unattributed bucket in the UI, not with the server fallback', async () => {
    // The API's `label` for a NULL key is untranslated operator text by contract;
    // the UI keys off `key === null`.
    const { el } = await setup(
      makeApi({
        breakdown: vi.fn(async () =>
          makeBreakdown({
            data: [
              {
                key: null,
                label: 'Unattributed',
                ref: null,
                views: 100,
                views_excluding_internal: null,
              },
            ],
          }),
        ),
      }),
    );
    expect(el.textContent).toContain('Unknown page');
  });

  it('links product rows to their detail page', async () => {
    const { el } = await setup(
      makeApi({
        breakdown: vi.fn(async (q: { dimension: string }) =>
          q.dimension === 'product'
            ? makeBreakdown({
                dimension: 'product',
                data: [
                  {
                    key: 'p1',
                    label: 'Procore',
                    ref: { id: 'p1', name: 'Procore', slug: 'procore' },
                    views: 42,
                    views_excluding_internal: null,
                  },
                ],
              })
            : makeBreakdown(),
        ),
      }),
    );
    const link = [...el.querySelectorAll('a')].find((a) =>
      a.getAttribute('href')?.includes('/products/procore'),
    );
    expect(link).toBeDefined();
  });
});
