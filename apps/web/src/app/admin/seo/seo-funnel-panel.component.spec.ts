/**
 * AECI-823. `SeoFunnelPanel`, Panel 3 of `/admin/seo` (`ADMIN_PANEL_SPEC.md`
 * §5.24.7 and §5.24.11).
 *
 * The rule this spec exists for is "render what the API sends, never invent":
 * a stage the API omits is not drawn and not zeroed, and Bing can never show an
 * "Impressed" row or an average position, even if a future API sent one. It also
 * pins the states the preview gallery shows (loading, both engines' shapes, a
 * failed load with its retry), the baseline table with a null `current` row,
 * the two static notes and the window each figure states.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminNote, SeoFunnelEngine, SeoFunnelResponse } from '@aeci/shared';

import { AdminSeoApi } from './admin-seo.api';
import { SeoFunnelPanel } from './seo-funnel-panel';

const CATALOG = {
  stage: 'catalog',
  count: 1532,
  rate: null,
  measure: 'measured',
  source: 'd1',
} as const;

const WINDOW = {
  from: '2026-10-30',
  to: '2026-11-26',
  timezone: 'America/Los_Angeles' as const,
  days: 28,
  days_recorded: 28,
};

const REFERENCE = {
  clicks: 41,
  impressions: 15900,
  ctr: 0.0026,
  position_avg: 31.9,
  window_end: '2026-09-05',
  window_months: 3,
  taken_on: '2026-09-09',
  impressions_rounded: true,
};

const GOOGLE_FULL: SeoFunnelEngine = {
  engine: 'google',
  scope: 'www_page',
  search_window: WINDOW,
  stages: [
    CATALOG,
    { stage: 'crawled', count: 410, rate: 0.2676, measure: 'measured', source: 'd1' },
    {
      stage: 'impressed',
      count: 380,
      rate: 0.248,
      measure: 'lower_bound',
      source: 'search_console',
      as_of: '2026-11-26',
    },
    {
      stage: 'clicked',
      count: 52,
      rate: 0.0031,
      measure: 'measured',
      source: 'search_console',
      impressions: 16800,
      position_avg: 33.4,
    },
  ],
  baseline: {
    scope: 'property',
    current: {
      clicks: 60,
      impressions: 20100,
      ctr: 0.003,
      position_avg: 31.2,
      window: WINDOW,
    },
    reference: REFERENCE,
  },
};

const GOOGLE_D1_ONLY: SeoFunnelEngine = {
  engine: 'google',
  scope: 'www_page',
  search_window: null,
  stages: [
    CATALOG,
    { stage: 'crawled', count: 410, rate: 0.2676, measure: 'measured', source: 'd1' },
  ],
  baseline: { scope: 'property', current: null, reference: REFERENCE },
};

const BING_D1_ONLY: SeoFunnelEngine = {
  engine: 'bing',
  scope: 'www',
  search_window: null,
  stages: [
    CATALOG,
    { stage: 'crawled', count: 1010, rate: 0.6593, measure: 'measured', source: 'd1' },
  ],
  baseline: null,
};

const BING_FULL: SeoFunnelEngine = {
  engine: 'bing',
  scope: 'www',
  search_window: { ...WINDOW, days_recorded: 17 },
  stages: [
    CATALOG,
    { stage: 'crawled', count: 1010, rate: 0.6593, measure: 'measured', source: 'd1' },
    {
      stage: 'indexed',
      count: 1236,
      rate: 0.8068,
      measure: 'engine_reported',
      source: 'bing_webmaster',
      as_of: '2026-11-28',
    },
    {
      stage: 'clicked',
      count: 17,
      rate: 0.0043,
      measure: 'measured',
      source: 'bing_webmaster',
      impressions: 3950,
    },
  ],
  baseline: null,
};

const STANDING: AdminNote[] = [
  { code: 'crawl_coverage_is_gateway_arrivals', severity: 'info', message: 'fallback a' },
  { code: 'crawler_label_includes_inspection_tool', severity: 'info', message: 'fallback b' },
];

function respond(engines: SeoFunnelEngine[], notes: AdminNote[] = STANDING): SeoFunnelResponse {
  return {
    generated_at: '2026-12-01T09:00:00.000Z',
    day: '2026-11-30',
    crawl_window: {
      from: '2026-11-03T00:00:00.000Z',
      to: '2026-12-01T00:00:00.000Z',
      timezone: 'UTC',
      days: 28,
    },
    engines,
    notes,
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(funnel: () => Promise<SeoFunnelResponse>) {
  const api = { queue: vi.fn(), trend: vi.fn(), funnel: vi.fn(funnel) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminSeoApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(SeoFunnelPanel);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function card(el: HTMLElement, engine: 'google' | 'bing'): HTMLElement {
  const c = el.querySelector<HTMLElement>(`[data-testid="admin-seo-funnel-${engine}"]`);
  if (!c) throw new Error(`No ${engine} card`);
  return c;
}

/** The funnel table's stages, in order, as `data-stage` values. */
function stages(c: HTMLElement): string[] {
  const funnel = c.querySelector('table')!;
  return [...funnel.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-stage') ?? '');
}

/** One stage row's header and cells, as visible text. */
function stageRow(c: HTMLElement, stage: string): { label: string; cells: string[] } {
  const row = c.querySelector(`tr[data-stage="${stage}"]`);
  if (!row) throw new Error(`No ${stage} row`);
  return {
    label: text(row.querySelector('th[scope="row"]')),
    cells: [...row.querySelectorAll('td')].map((td) => text(td)),
  };
}

function baselineRow(c: HTMLElement, key: string): string[] {
  const row = c.querySelector(`[data-testid="admin-seo-baseline"] tr[data-measure="${key}"]`);
  if (!row) throw new Error(`No baseline row ${key}`);
  return [text(row.querySelector('th')), ...[...row.querySelectorAll('td')].map((td) => text(td))];
}

describe('SeoFunnelPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('shows a loading line while the read is in flight', async () => {
    const { el } = await setup(() => new Promise(() => undefined));
    expect(text(el)).toContain('Loading the search funnel');
    expect(el.querySelector('table')).toBeNull();
  });

  it('draws Google with all four stages: rate as text and bar, count beside it', async () => {
    const { el } = await setup(async () => respond([GOOGLE_FULL, BING_D1_ONLY]));
    const g = card(el, 'google');
    expect(stages(g)).toEqual(['catalog', 'crawled', 'impressed', 'clicked']);
    expect(stageRow(g, 'catalog').cells).toEqual(['Base', '1,532']);
    expect(stageRow(g, 'crawled').cells).toEqual(['26.8%', '410']);
    expect(stageRow(g, 'impressed').label).toContain('Indexed (lower bound)');
    expect(stageRow(g, 'impressed').label).toContain('Google offers no indexed count');
    expect(stageRow(g, 'impressed').cells).toEqual(['24.8%', '380']);
    // CTR to two decimals, with the impression-weighted position beside it.
    expect(stageRow(g, 'clicked').cells[0]).toBe(
      '0.31% click-through at average position 33.4 52 clicks from 16,800 impressions',
    );
    // The bar is decoration, and its width is the rate.
    const bar = g.querySelector(
      'tr[data-stage="impressed"] [aria-hidden="true"] span',
    ) as HTMLElement;
    expect(bar.style.width).toBe('24.8%');
    expect(bar.classList).toContain('chart-swatch-1');
  });

  it('puts the crawl-coverage caveat beside the Crawled stage', async () => {
    const { el } = await setup(async () => respond([GOOGLE_FULL, BING_D1_ONLY]));
    expect(stageRow(card(el, 'google'), 'crawled').label).toContain(
      'A crawl that got an error or a redirect is not counted.',
    );
    expect(stageRow(card(el, 'bing'), 'crawled').label).toContain('Verified Bingbot visits');
  });

  it('states every figure scope and window: www pages, the UTC day, Pacific dates', async () => {
    const { el } = await setup(async () => respond([GOOGLE_FULL, BING_D1_ONLY]));
    const g = card(el, 'google');
    expect(text(g)).toContain('Pages on www.aecintegrations.com.');
    expect(text(g)).toContain('Crawled counts the 28 UTC days ending Nov 30, 2026.');
    expect(text(g.querySelector('[data-testid="admin-seo-funnel-window-google"]'))).toBe(
      'Search Console figures cover the 28 Pacific dates Oct 30, 2026 to Nov 26, 2026.',
    );
    expect(text(g.querySelector('caption'))).toBe(
      'Google funnel, www pages, 28 days ending Nov 30, 2026',
    );
  });

  it('names the clamped crawl window from the data, never a fixed 28', async () => {
    const clamped = respond([GOOGLE_FULL, BING_D1_ONLY]);
    clamped.crawl_window = { ...clamped.crawl_window, days: 20 };
    const { el } = await setup(async () => clamped);
    expect(text(card(el, 'google'))).toContain(
      'Crawled counts the 20 UTC days ending Nov 30, 2026.',
    );
    expect(text(card(el, 'bing').querySelector('caption'))).toBe(
      'Bing funnel, www pages, 20 days ending Nov 30, 2026',
    );
  });

  it('shows Bing with stage 1 only, explained, and never zeroes the absent stages', async () => {
    const { el } = await setup(async () =>
      respond(
        [GOOGLE_FULL, BING_D1_ONLY],
        [
          ...STANDING,
          {
            code: 'search_ingest_absent',
            severity: 'info',
            message: 'fallback',
            params: { engine: 'bing' },
          },
        ],
      ),
    );
    const b = card(el, 'bing');
    expect(stages(b)).toEqual(['catalog', 'crawled']);
    expect(text(b)).toContain('No Bing Webmaster Tools data has been pulled for this window');
    expect(text(b)).not.toContain('0%');
    expect(b.querySelector('[data-testid="admin-seo-funnel-window-bing"]')).toBeNull();
    // The engine note sits in Bing's card, not in Google's.
    expect(text(card(el, 'google'))).not.toContain('Bing Webmaster Tools data');
  });

  it('shows Google with no ingest data: catalog and crawled, the explanation, a null baseline row', async () => {
    const { el } = await setup(async () =>
      respond(
        [GOOGLE_D1_ONLY, BING_FULL],
        [
          ...STANDING,
          {
            code: 'search_ingest_absent',
            severity: 'info',
            message: 'fallback',
            params: { engine: 'google' },
          },
        ],
      ),
    );
    const g = card(el, 'google');
    expect(stages(g)).toEqual(['catalog', 'crawled']);
    expect(text(g)).toContain('No Search Console data has been pulled for this window');
    expect(g.querySelector('[data-testid="admin-seo-funnel-window-google"]')).toBeNull();
    // The null `current` row reads "Not recorded". The baseline is still shown.
    expect(baselineRow(g, 'ctr')).toEqual(['Click-through', 'Not recorded', '0.26%']);
    expect(baselineRow(g, 'clicks')).toEqual(['Clicks', 'Not recorded', '41']);
    expect(text(g)).toContain('The baseline row is always shown.');
  });

  it('shows Bing with every stage it can have, captioned as reported by Bing', async () => {
    const { el } = await setup(async () => respond([GOOGLE_FULL, BING_FULL]));
    const b = card(el, 'bing');
    expect(stages(b)).toEqual(['catalog', 'crawled', 'indexed', 'clicked']);
    expect(stageRow(b, 'indexed').label).toContain('Indexed, as reported by Bing');
    expect(stageRow(b, 'indexed').label).toContain('read on Nov 28, 2026');
    expect(stageRow(b, 'indexed').cells).toEqual(['80.7%', '1,236']);
    expect(stageRow(b, 'clicked').cells[0]).toBe(
      '0.43% click-through 17 clicks from 3,950 impressions',
    );
    expect(b.querySelector('[data-testid="admin-seo-baseline"]')).toBeNull();
    const bar = b.querySelector(
      'tr[data-stage="indexed"] [aria-hidden="true"] span',
    ) as HTMLElement;
    expect(bar.classList).toContain('chart-swatch-2');
  });

  it('shows "days recorded" when the click window is incomplete', async () => {
    const { el } = await setup(async () =>
      respond(
        [GOOGLE_FULL, BING_FULL],
        [
          ...STANDING,
          {
            code: 'search_window_incomplete',
            severity: 'warn',
            message: 'fallback',
            params: {
              engine: 'bing',
              days_recorded: 17,
              days: 28,
              from: '2026-10-30',
              to: '2026-11-26',
            },
          },
        ],
      ),
    );
    const b = card(el, 'bing');
    expect(text(b.querySelector('[data-testid="admin-seo-funnel-window-bing"]'))).toContain(
      'Days recorded: 17 of 28.',
    );
    expect(text(b)).toContain('Only 17 of the 28 days from 2026-10-30 to 2026-11-26');
  });

  it('never draws a Bing Impressed stage or a Bing position, even if the API sent them', async () => {
    const future: SeoFunnelEngine = {
      ...BING_FULL,
      stages: [
        ...BING_FULL.stages.slice(0, 3),
        {
          stage: 'impressed',
          count: 214,
          rate: 0.1397,
          measure: 'lower_bound',
          source: 'bing_webmaster',
        },
        { ...BING_FULL.stages[3]!, position_avg: 19.6 },
      ],
    };
    const { el } = await setup(async () => respond([GOOGLE_FULL, future]));
    const b = card(el, 'bing');
    expect(stages(b)).toEqual(['catalog', 'crawled', 'indexed', 'clicked']);
    expect(text(b)).not.toContain('position');
    expect(text(b)).not.toContain('19.6');
    expect(b.querySelector('[data-testid="admin-seo-funnel-position"]')).toBeNull();
  });

  it('never draws a Google indexed stage, and keeps the API order', async () => {
    const odd: SeoFunnelEngine = {
      ...GOOGLE_FULL,
      stages: [
        GOOGLE_FULL.stages[3]!,
        {
          stage: 'indexed',
          count: 999,
          rate: 0.6521,
          measure: 'engine_reported',
          source: 'search_console',
        },
        ...GOOGLE_FULL.stages.slice(0, 3),
      ],
    };
    const { el } = await setup(async () => respond([odd, BING_D1_ONLY]));
    expect(stages(card(el, 'google'))).toEqual(['catalog', 'crawled', 'impressed', 'clicked']);
    expect(text(card(el, 'google'))).not.toContain('999');
  });

  it('renders the baseline table beside the reference, with proper headers', async () => {
    const { el } = await setup(async () => respond([GOOGLE_FULL, BING_D1_ONLY]));
    const g = card(el, 'google');
    const base = g.querySelector('[data-testid="admin-seo-baseline"]')!;
    expect(text(base.querySelector('h5'))).toBe('Against the September baseline');
    expect(text(base)).toContain('The baseline covers 3 months and this covers 28 days.');
    expect(text(base)).toContain('not a like-for-like comparison');
    const headers = [...base.querySelectorAll('thead th')];
    expect(headers.every((h) => h.getAttribute('scope') === 'col')).toBe(true);
    expect(headers.map((h) => text(h))).toEqual([
      'Measure',
      'Last 28 days Oct 30, 2026 to Nov 26, 2026',
      'Baseline 3 months to Sep 5, 2026',
    ]);
    expect(baselineRow(g, 'ctr')).toEqual(['Click-through', '0.30%', '0.26%']);
    expect(baselineRow(g, 'position')).toEqual(['Average position', '31.2', '31.9']);
    expect(baselineRow(g, 'clicks')).toEqual(['Clicks', '60', '41']);
    expect(baselineRow(g, 'impressions')).toEqual(['Impressions', '20,100', 'about 15,900']);
    expect(base.querySelectorAll('tbody th[scope="row"]')).toHaveLength(4);
  });

  it('carries the two static notes and renders every API note through AdminNotes', async () => {
    const { el } = await setup(async () =>
      respond(
        [GOOGLE_FULL, BING_D1_ONLY],
        [
          ...STANDING,
          { code: 'indexed_is_impression_lower_bound', severity: 'info', message: 'fallback' },
          {
            code: 'crawl_window_clamped',
            severity: 'info',
            message: 'fallback',
            params: { from: '2026-08-18T03:49:00.000Z' },
          },
          {
            code: 'crawler_label_unverified',
            severity: 'info',
            message: 'fallback',
            params: { since: '2026-10-13T08:02:33.500Z' },
          },
        ],
      ),
    );
    const reading = text(el.querySelector('[data-testid="admin-seo-funnel-reading"]'));
    expect(reading).toContain('Average position is expected to fall while indexing improves');
    expect(reading).toContain('Newly indexed pages enter at rank 40 to 80');
    expect(reading).toContain('The stages will not reconcile exactly.');
    const all = text(el);
    expect(all).toContain('Crawl coverage counts the page views');
    expect(all).toContain('The Googlebot label also covers');
    expect(all).toContain("Google's indexed figure counts catalog pages");
    expect(all).toContain('The crawl window starts at');
    expect(all).toContain('carry no Cloudflare bot verification');
    // Localized prose, never the wire fallback.
    expect(all).not.toContain('fallback');
    expect(all).toContain('Read at Dec 1, 2026');
  });

  it('fails on its own with a retry that reloads', async () => {
    let calls = 0;
    const { fixture, el, api } = await setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return respond([GOOGLE_FULL, BING_D1_ONLY]);
    });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "We couldn't load the search funnel",
    );
    const retry = [...el.querySelectorAll('button')].find((b) => text(b) === 'Try again')!;
    retry.click();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.funnel).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(stages(card(el, 'google'))).toEqual(['catalog', 'crawled', 'impressed', 'clicked']);
  });
});
