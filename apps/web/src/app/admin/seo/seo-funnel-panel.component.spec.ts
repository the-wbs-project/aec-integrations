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

const attached: HTMLElement[] = [];

async function flush(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  await settle();
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
}

async function setup(funnel: () => Promise<SeoFunnelResponse>) {
  const api = { queue: vi.fn(), trend: vi.fn(), funnel: vi.fn(funnel) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminSeoApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(SeoFunnelPanel);
  const announced: string[] = [];
  fixture.componentInstance.announce.subscribe((m) => announced.push(m));
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  // Attached, so focus moves can be observed.
  document.body.appendChild(el);
  attached.push(el);
  return { fixture, api, el, announced };
}

/** A Google engine whose `clicked` stage is replaced by `over`. */
function googleWithClicked(over: Partial<SeoFunnelEngine['stages'][number]>): SeoFunnelEngine {
  return {
    ...GOOGLE_FULL,
    stages: [...GOOGLE_FULL.stages.slice(0, 3), { ...GOOGLE_FULL.stages[3]!, ...over }],
  };
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
  afterEach(() => {
    vi.restoreAllMocks();
    while (attached.length > 0) attached.pop()!.remove();
  });

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
    expect(text(g)).toContain('The baseline is always shown.');
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
    // The count appears once, on the window line. The note does not repeat it,
    // and says Pacific like the window line does.
    expect(text(b)).toContain(
      'Some Pacific dates in this search window lack daily clicks or impressions',
    );
    expect(text(b).match(/17 of 28/g)).toHaveLength(1);
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

  it('clamps a rate above 1 to a full bar, and still prints the true rate', async () => {
    const over: SeoFunnelEngine = {
      ...BING_FULL,
      stages: BING_FULL.stages.map((st) =>
        st.stage === 'indexed' ? { ...st, count: 1800, rate: 1.175 } : st,
      ),
    };
    const { el } = await setup(async () => respond([GOOGLE_FULL, over]));
    const b = card(el, 'bing');
    expect(stageRow(b, 'indexed').cells).toEqual(['117.5%', '1,800']);
    const bar = b.querySelector(
      'tr[data-stage="indexed"] [aria-hidden="true"] span',
    ) as HTMLElement;
    expect(bar.style.width).toBe('100%');
  });

  it('reads "No rate" and draws no bar when the catalog is 0', async () => {
    const empty: SeoFunnelEngine = {
      ...GOOGLE_D1_ONLY,
      stages: [
        { ...CATALOG, count: 0 },
        { stage: 'crawled', count: 0, rate: null, measure: 'measured', source: 'd1' },
      ],
    };
    const { el } = await setup(async () => respond([empty, BING_D1_ONLY]));
    const g = card(el, 'google');
    expect(stageRow(g, 'crawled').cells).toEqual(['No rate', '0']);
    expect(g.querySelector('tr[data-stage="crawled"] [aria-hidden="true"] span')).toBeNull();
    expect(g.querySelector('tr[data-stage="catalog"] [aria-hidden="true"] span')).toBeNull();
  });

  it('reads "No impressions" when click-through is null', async () => {
    const { el } = await setup(async () =>
      respond([googleWithClicked({ count: 0, rate: null, impressions: 0 }), BING_D1_ONLY]),
    );
    expect(stageRow(card(el, 'google'), 'clicked').cells[0]).toBe(
      'No impressions at average position 33.4 0 clicks from 0 impressions',
    );
  });

  it('never prints "from 0 impressions" when the impressions figure is missing', async () => {
    const { impressions: _omit, ...noImpressions } = GOOGLE_FULL.stages[3]!;
    const g: SeoFunnelEngine = {
      ...GOOGLE_FULL,
      stages: [...GOOGLE_FULL.stages.slice(0, 3), noImpressions],
    };
    const { el } = await setup(async () => respond([g, BING_D1_ONLY]));
    const cell = stageRow(card(el, 'google'), 'clicked').cells[0]!;
    expect(cell).toContain('52 clicks, impressions not recorded');
    expect(cell).not.toContain('0 impressions');
  });

  it('says "Days recorded" on a short Google window', async () => {
    const short: SeoFunnelEngine = {
      ...GOOGLE_FULL,
      search_window: { ...WINDOW, days_recorded: 9 },
    };
    const { el } = await setup(async () => respond([short, BING_D1_ONLY]));
    expect(
      text(card(el, 'google').querySelector('[data-testid="admin-seo-funnel-window-google"]')),
    ).toBe(
      'Search Console figures cover the 28 Pacific dates Oct 30, 2026 to Nov 26, 2026. Days recorded: 9 of 28.',
    );
  });

  it('says "Days recorded" on a short baseline window, in the header and the explanation', async () => {
    const short: SeoFunnelEngine = {
      ...GOOGLE_FULL,
      baseline: {
        ...GOOGLE_FULL.baseline!,
        current: {
          ...GOOGLE_FULL.baseline!.current!,
          window: { ...WINDOW, days_recorded: 9 },
        },
      },
    };
    const { el } = await setup(async () => respond([short, BING_D1_ONLY]));
    const base = card(el, 'google').querySelector('[data-testid="admin-seo-baseline"]')!;
    expect(text(base.querySelector('[data-testid="admin-seo-baseline-recorded"]'))).toBe(
      'Days recorded: 9 of 28',
    );
    expect(text(base)).toContain('This covers 28 Pacific dates, and days recorded: 9 of 28.');
    expect(text(base)).not.toContain('this covers 28 days.');
  });

  it('shows no "Days recorded" on a full baseline window', async () => {
    const { el } = await setup(async () => respond([GOOGLE_FULL, BING_D1_ONLY]));
    expect(el.querySelector('[data-testid="admin-seo-baseline-recorded"]')).toBeNull();
  });

  it('takes the window length in the intro and the static note from the data', async () => {
    const clamped = respond([GOOGLE_FULL, BING_D1_ONLY]);
    clamped.crawl_window = { ...clamped.crawl_window, days: 20 };
    const { el } = await setup(async () => clamped);
    expect(text(el.querySelector('p'))).toContain('over the trailing 20 days');
    expect(text(el.querySelector('[data-testid="admin-seo-funnel-reading"]'))).toContain(
      'Crawled is our own record over 20 UTC days.',
    );
    expect(text(el)).not.toContain('28 UTC days');
  });

  it('makes every table wrapper a focusable scroll region named by its caption', async () => {
    const { el } = await setup(async () => respond([GOOGLE_FULL, BING_FULL]));
    const regions = [...el.querySelectorAll('[role="region"]')];
    // Two funnels and the baseline table.
    expect(regions).toHaveLength(3);
    for (const region of regions) {
      expect(region.getAttribute('tabindex')).toBe('0');
      const caption = el.querySelector(`#${region.getAttribute('aria-labelledby')}`);
      expect(caption?.tagName).toBe('CAPTION');
    }
  });

  it('keeps the row header to the stage name and links the description', async () => {
    const { el } = await setup(async () => respond([GOOGLE_FULL, BING_D1_ONLY]));
    const th = card(el, 'google').querySelector('tr[data-stage="crawled"] th[scope="row"]')!;
    const desc = el.querySelector(`#${th.getAttribute('aria-describedby')}`)!;
    expect(text(desc)).toContain('Verified Googlebot visits');
    expect(desc.getAttribute('aria-hidden')).toBe('true');
    expect(th.contains(desc)).toBe(true);
    const catalog = card(el, 'google').querySelector('tr[data-stage="catalog"] th')!;
    expect(catalog.hasAttribute('aria-describedby')).toBe(false);
  });

  it('a retry that fails again announces it and moves focus to the heading', async () => {
    const { el, fixture, api, announced } = await setup(async () => {
      throw new Error('boom');
    });
    const retry = [...el.querySelectorAll('button')].find((b) => text(b) === 'Try again')!;
    retry.click();
    await flush(fixture);
    expect(api.funnel).toHaveBeenCalledTimes(2);
    expect(announced.at(-1)).toBe('The search funnel still could not load.');
    expect(document.activeElement).toBe(el.querySelector('h3'));
  });

  it('a retry that succeeds announces it and moves focus to the heading', async () => {
    let calls = 0;
    const { el, fixture, announced } = await setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return respond([GOOGLE_FULL, BING_D1_ONLY]);
    });
    const retry = [...el.querySelectorAll('button')].find((b) => text(b) === 'Try again')!;
    retry.click();
    await flush(fixture);
    expect(announced.at(-1)).toBe('Search funnel loaded.');
    expect(document.activeElement).toBe(el.querySelector('h3'));
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
