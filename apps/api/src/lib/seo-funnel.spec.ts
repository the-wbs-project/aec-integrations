/**
 * The funnel derivation (AECI-823, `ADMIN_PANEL_SPEC.md` §5.24.7). Pure where it
 * can be, against the in-memory D1 harness where it reads. No `fetch` anywhere:
 * the funnel reads `metrics_daily` and `page_views` only.
 */
import { SeoFunnelResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { metricsDaily, pageViews, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { shiftDay } from './admin-analytics';
import {
  AECI_799_BASELINE,
  bingFunnel,
  googleFunnel,
  lastCompleteUtcDay,
  readSeoFunnel,
  sumSeries,
  type FunnelRows,
} from './seo-funnel';

const DAY = '2026-11-23';
const D1 = { catalog: 1000, crawled: { google: 250, bing: 600 } };

function rowsOf(entries: [metric: string, day: string, value: number][]): FunnelRows {
  const rows: FunnelRows = new Map();
  for (const [metric, day, value] of entries) {
    if (!rows.has(metric)) rows.set(metric, new Map());
    rows.get(metric)!.set(day, value);
  }
  return rows;
}

describe('lastCompleteUtcDay', () => {
  it('is the UTC day before now, at either edge of a day', () => {
    expect(lastCompleteUtcDay(new Date('2026-11-24T00:00:00.000Z'))).toBe('2026-11-23');
    expect(lastCompleteUtcDay(new Date('2026-11-24T23:59:59.999Z'))).toBe('2026-11-23');
  });
});

describe('sumSeries', () => {
  const keys = {
    clicks: 'c',
    impressions: 'i',
    position: 'p',
  } as unknown as Parameters<typeof sumSeries>[1];

  it('derives CTR from sums and weights position by each day’s impressions', () => {
    const rows = rowsOf([
      ['c', '2026-11-01', 1],
      ['i', '2026-11-01', 100],
      ['p', '2026-11-01', 10],
      ['c', '2026-11-02', 9],
      ['i', '2026-11-02', 900],
      ['p', '2026-11-02', 40],
      // Outside the window: ignored.
      ['c', '2026-10-01', 500],
      ['i', '2026-10-01', 500],
    ]);
    // Mean of daily CTRs would be 1%. Sum over sum is 1%. Mean position would be
    // 25. Weighted: (10×100 + 40×900) ÷ 1000 = 37.
    expect(sumSeries(rows, keys, '2026-11-01', '2026-11-28')).toEqual({
      clicks: 10,
      impressions: 1000,
      ctr: 0.01,
      position_avg: 37,
    });
  });

  it('is null with no impressions row in the window, and a null CTR at zero impressions', () => {
    expect(sumSeries(rowsOf([['c', '2026-11-01', 1]]), keys, '2026-11-01', '2026-11-28')).toBe(
      null,
    );
    expect(
      sumSeries(
        rowsOf([
          ['c', '2026-11-01', 0],
          ['i', '2026-11-01', 0],
        ]),
        keys,
        '2026-11-01',
        '2026-11-28',
      ),
    ).toEqual({
      clicks: 0,
      impressions: 0,
      ctr: null,
      position_avg: null,
    });
  });

  it('is null, never a measured 0% CTR, when the clicks series is missing from the window', () => {
    const rows = rowsOf([
      ['i', '2026-11-01', 100],
      ['p', '2026-11-01', 10],
      ['i', '2026-11-02', 200],
      // A clicks row outside the window does not rescue it.
      ['c', '2026-10-01', 5],
    ]);
    expect(sumSeries(rows, keys, '2026-11-01', '2026-11-28')).toBeNull();
  });

  it('is null when the impressions series is missing from the window', () => {
    const rows = rowsOf([
      ['c', '2026-11-01', 3],
      ['c', '2026-11-02', 4],
    ]);
    expect(sumSeries(rows, keys, '2026-11-01', '2026-11-28')).toBeNull();
  });

  it('sums only the dates that hold both rows, whichever side is missing', () => {
    const rows = rowsOf([
      // Matched.
      ['c', '2026-11-01', 2],
      ['i', '2026-11-01', 100],
      ['p', '2026-11-01', 10],
      // Clicks with no impressions: no denominator, not summed.
      ['c', '2026-11-02', 3],
      // Impressions with no clicks: not a measured zero, not summed. Its
      // position is not weighted in either.
      ['i', '2026-11-03', 900],
      ['p', '2026-11-03', 50],
    ]);
    expect(sumSeries(rows, keys, '2026-11-01', '2026-11-28')).toEqual({
      clicks: 2,
      impressions: 100,
      ctr: 0.02,
      position_avg: 10,
    });
  });
});

describe('googleFunnel', () => {
  it('has catalog and crawled only, and the static baseline, with no ingest data', () => {
    const g = googleFunnel(new Map(), DAY, D1);
    expect(g.stages.map((s) => s.stage)).toEqual(['catalog', 'crawled']);
    expect(g.stages[1]).toMatchObject({ count: 250, rate: 0.25, source: 'd1' });
    expect(g.search_window).toBeNull();
    expect(g.baseline).toEqual({ scope: 'property', current: null, reference: AECI_799_BASELINE });
  });

  it('ends the Pacific window on the newest ingested date and reads stage 3 there', () => {
    // The ingest's newest date is five days behind the last complete UTC day.
    const end = shiftDay(DAY, -5);
    const rows = rowsOf([
      ['search.google.www_page.impressions', end, 400],
      ['search.google.www_page.clicks', end, 2],
      ['search.google.www_page.position_avg', end, 30],
      ['search.google.www_page.impressions', shiftDay(end, -27), 600],
      ['search.google.www_page.clicks', shiftDay(end, -27), 3],
      ['search.google.www_page.position_avg', shiftDay(end, -27), 20],
      // One day before the window: not summed.
      ['search.google.www_page.impressions', shiftDay(end, -28), 9999],
      ['search.google.www_page.catalog_pages_with_impressions_28d', end, 380],
      // A 28-day count from the week before covers different dates: never read.
      ['search.google.www_page.catalog_pages_with_impressions_28d', shiftDay(end, -7), 999],
    ]);
    const g = googleFunnel(rows, DAY, D1);
    expect(g.search_window).toEqual({
      from: shiftDay(end, -27),
      to: end,
      timezone: 'America/Los_Angeles',
      days: 28,
      days_recorded: 2,
    });
    expect(g.stages).toEqual([
      { stage: 'catalog', count: 1000, rate: null, measure: 'measured', source: 'd1' },
      { stage: 'crawled', count: 250, rate: 0.25, measure: 'measured', source: 'd1' },
      {
        stage: 'impressed',
        count: 380,
        rate: 0.38,
        measure: 'lower_bound',
        source: 'search_console',
        as_of: end,
      },
      {
        stage: 'clicked',
        count: 5,
        rate: 0.005,
        measure: 'measured',
        source: 'search_console',
        impressions: 1000,
        position_avg: 24,
      },
    ]);
  });

  it('omits stage 3 when the 28-day count is missing on the window end', () => {
    const end = shiftDay(DAY, -4);
    const rows = rowsOf([
      ['search.google.www_page.impressions', end, 10],
      ['search.google.www_page.clicks', end, 0],
      ['search.google.www_page.catalog_pages_with_impressions_28d', shiftDay(end, -7), 50],
    ]);
    expect(googleFunnel(rows, DAY, D1).stages.map((s) => s.stage)).toEqual([
      'catalog',
      'crawled',
      'clicked',
    ]);
  });

  it('treats a series older than the 28 days ending on the last complete day as no data', () => {
    const stale = shiftDay(DAY, -28);
    const rows = rowsOf([
      ['search.google.www_page.impressions', stale, 10],
      ['search.google.property.impressions', stale, 10],
    ]);
    const g = googleFunnel(rows, DAY, D1);
    expect(g.search_window).toBeNull();
    expect(g.baseline?.current).toBeNull();
  });

  it('fills the baseline from the property series on its own window', () => {
    const end = shiftDay(DAY, -3);
    const rows = rowsOf([
      ['search.google.property.impressions', end, 2000],
      ['search.google.property.clicks', end, 8],
      ['search.google.property.position_avg', end, 33.44],
    ]);
    const g = googleFunnel(rows, DAY, D1);
    // No `www_page` row: the funnel has no ingest stages, the baseline still fills.
    expect(g.stages.map((s) => s.stage)).toEqual(['catalog', 'crawled']);
    expect(g.baseline?.current).toEqual({
      clicks: 8,
      impressions: 2000,
      ctr: 0.004,
      position_avg: 33.4,
      window: {
        from: shiftDay(end, -27),
        to: end,
        timezone: 'America/Los_Angeles',
        days: 28,
        days_recorded: 1,
      },
    });
  });
});

describe('bingFunnel', () => {
  it('has stages 0, 1, 2 and 4, never 3, and no position', () => {
    const end = shiftDay(DAY, -6);
    const rows = rowsOf([
      ['search.bing.www.impressions', end, 500],
      ['search.bing.www.clicks', end, 4],
      ['search.bing.www.in_index', end, 700],
      ['search.bing.www.in_index', shiftDay(end, -1), 690],
    ]);
    const b = bingFunnel(rows, DAY, D1);
    expect(b.scope).toBe('www');
    expect(b.baseline).toBeNull();
    expect(b.stages).toEqual([
      { stage: 'catalog', count: 1000, rate: null, measure: 'measured', source: 'd1' },
      { stage: 'crawled', count: 600, rate: 0.6, measure: 'measured', source: 'd1' },
      {
        stage: 'indexed',
        count: 700,
        rate: 0.7,
        measure: 'engine_reported',
        source: 'bing_webmaster',
        as_of: end,
      },
      {
        stage: 'clicked',
        count: 4,
        rate: 0.008,
        measure: 'measured',
        source: 'bing_webmaster',
        impressions: 500,
      },
    ]);
  });

  it('drops a clicks-only date from the totals and from days_recorded', () => {
    // The Bing ingest fixture's shape: Bing left `Impressions` out of one day, so
    // that day stored three clicks and no impressions row.
    const end = shiftDay(DAY, -6);
    const rows = rowsOf([
      ['search.bing.www.clicks', end, 2],
      ['search.bing.www.impressions', end, 40],
      ['search.bing.www.clicks', shiftDay(end, -1), 3],
      ['search.bing.www.clicks', shiftDay(end, -2), 9],
      ['search.bing.www.impressions', shiftDay(end, -2), 99],
    ]);
    const b = bingFunnel(rows, DAY, D1);
    expect(b.search_window).toMatchObject({ to: end, days: 28, days_recorded: 2 });
    expect(b.stages.find((s) => s.stage === 'clicked')).toEqual({
      stage: 'clicked',
      count: 11,
      rate: 0.0791,
      measure: 'measured',
      source: 'bing_webmaster',
      impressions: 139,
    });
  });

  it('omits stage 4 when only impressions were stored, and records no matched day', () => {
    const end = shiftDay(DAY, -6);
    const rows = rowsOf([['search.bing.www.impressions', end, 40]]);
    const b = bingFunnel(rows, DAY, D1);
    expect(b.stages.map((s) => s.stage)).toEqual(['catalog', 'crawled']);
    expect(b.search_window).toMatchObject({ to: end, days_recorded: 0 });
  });

  it('keeps stage 2 when only the crawl call wrote, and omits stage 4', () => {
    const rows = rowsOf([['search.bing.www.in_index', shiftDay(DAY, -4), 300]]);
    expect(bingFunnel(rows, DAY, D1).stages.map((s) => s.stage)).toEqual([
      'catalog',
      'crawled',
      'indexed',
    ]);
  });

  it('keeps stage 1 with no ingest data at all', () => {
    const b = bingFunnel(new Map(), DAY, D1);
    expect(b.stages.map((s) => s.stage)).toEqual(['catalog', 'crawled']);
    expect(b.search_window).toBeNull();
  });
});

describe('readSeoFunnel', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const NOW = new Date('2026-11-24T12:00:00.000Z');
  const row = (day: string, metric: string, value: number) => ({
    day,
    metric,
    value,
    source: 'measured',
    computedAt: `${day}T23:59:00.000Z`,
  });

  it('reads the stored snapshot stocks for the last complete UTC day', async () => {
    await t.db
      .insert(metricsDaily)
      .values([
        row(DAY, 'seo.catalog_urls', 1532),
        row(DAY, 'seo.crawled_urls_google', 410),
        row(DAY, 'seo.crawled_urls_bing', 1010),
      ]);
    const body = SeoFunnelResponseSchema.parse(await readSeoFunnel(t.db, NOW));
    expect(body.day).toBe(DAY);
    expect(body.crawl_window).toEqual({
      from: '2026-10-27T00:00:00.000Z',
      to: '2026-11-24T00:00:00.000Z',
      timezone: 'UTC',
      days: 28,
    });
    expect(body.engines.map((e) => [e.engine, e.stages[1]?.count])).toEqual([
      ['google', 410],
      ['bing', 1010],
    ]);
    expect(body.notes.map((n) => [n.code, n.params?.engine])).toEqual([
      ['crawl_coverage_is_gateway_arrivals', undefined],
      ['crawler_label_includes_inspection_tool', undefined],
      ['search_ingest_absent', 'google'],
      ['search_ingest_absent', 'bing'],
    ]);
  });

  it('computes the D1 stages live, to the same instant, before the snapshot has run', async () => {
    await t.db.insert(products).values({
      id: 'p1',
      slug: 'one',
      name: 'One',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await t.db.insert(pageViews).values([
      {
        path: '/products/:slug',
        concretePath: '/products/one',
        isBot: true,
        botName: 'Bingbot',
        cfVerifiedBotCategory: 'Search Engine Crawler',
        createdAt: '2026-11-20T00:00:00.000Z',
      },
      // After the last complete day ends: not in the window.
      {
        path: '/products/:slug',
        concretePath: '/products/one',
        isBot: true,
        botName: 'Googlebot',
        cfVerifiedBotCategory: 'Search Engine Crawler',
        createdAt: '2026-11-24T06:00:00.000Z',
      },
    ]);
    const body = await readSeoFunnel(t.db, NOW);
    expect(body.engines.map((e) => e.stages.map((s) => s.count))).toEqual([
      [1, 0],
      [1, 1],
    ]);
  });

  it('anchors the click window on the daily series when the newest daily call failed', async () => {
    // The earlier run wrote 14 daily dates ending E0 and the page count on E0. The
    // newest run's daily call failed and its page-count call wrote on E0 + 7.
    const e0 = shiftDay(DAY, -12);
    const daily = Array.from({ length: 14 }, (_, i) => shiftDay(e0, -i)).flatMap((d) => [
      row(d, 'search.google.www_page.impressions', 100),
      row(d, 'search.google.www_page.clicks', 1),
    ]);
    await t.db
      .insert(metricsDaily)
      .values([
        ...daily,
        row(e0, 'search.google.www_page.catalog_pages_with_impressions_28d', 40),
        row(shiftDay(e0, 7), 'search.google.www_page.catalog_pages_with_impressions_28d', 55),
      ]);
    const body = await readSeoFunnel(t.db, NOW);
    const google = body.engines[0]!;
    expect(google.search_window).toMatchObject({ to: e0, days: 28, days_recorded: 14 });
    // Stage 3 is the count filed on the click window's own end, not the newer one.
    expect(google.stages.find((s) => s.stage === 'impressed')).toMatchObject({
      count: 40,
      as_of: e0,
    });
    expect(google.stages.find((s) => s.stage === 'clicked')).toMatchObject({
      count: 14,
      impressions: 1400,
    });
    expect(body.notes.find((n) => n.code === 'search_window_incomplete')).toMatchObject({
      severity: 'warn',
      params: { engine: 'google', days_recorded: 14, days: 28, to: e0 },
    });
  });

  it('counts only matched dates in days_recorded and the incomplete note', async () => {
    // 28 impressions dates. The newest lacks its clicks row. One extra clicks row
    // sits on the date after it, which holds no impressions row.
    const end = shiftDay(DAY, -5);
    const dates = Array.from({ length: 28 }, (_, i) => shiftDay(end, -i));
    await t.db.insert(metricsDaily).values([
      ...dates.map((d) => row(d, 'search.google.www_page.impressions', 100)),
      ...dates.slice(1).map((d) => row(d, 'search.google.www_page.clicks', 1)),
      // Outside the impressions dates but inside the 28 ending on `day`: the
      // anchor stays on the newest impressions date, so this is out of window.
      row(shiftDay(end, 1), 'search.google.www_page.clicks', 50),
    ]);
    const body = await readSeoFunnel(t.db, NOW);
    const google = body.engines[0]!;
    expect(google.search_window).toMatchObject({ to: end, days: 28, days_recorded: 27 });
    expect(google.stages.find((s) => s.stage === 'clicked')).toMatchObject({
      count: 27,
      impressions: 2700,
      rate: 0.01,
    });
    expect(body.notes.find((n) => n.code === 'search_window_incomplete')).toMatchObject({
      params: { engine: 'google', days_recorded: 27, days: 28 },
    });
  });

  it('carries search_ingest_absent whenever no ingested stage survives', async () => {
    // Google: only a page count, from a run whose daily call failed. No daily row
    // anchors a window, so stage 3 is not read and every ingested stage is gone.
    // Bing: only an index reading, so stage 2 shows and the note does not.
    await t.db
      .insert(metricsDaily)
      .values([
        row(shiftDay(DAY, -5), 'search.google.www_page.catalog_pages_with_impressions_28d', 40),
        row(shiftDay(DAY, -5), 'search.bing.www.in_index', 300),
      ]);
    const body = await readSeoFunnel(t.db, NOW);
    expect(body.engines.map((e) => e.stages.map((s) => s.stage))).toEqual([
      ['catalog', 'crawled'],
      ['catalog', 'crawled', 'indexed'],
    ]);
    expect(
      body.notes.filter((n) => n.code === 'search_ingest_absent').map((n) => n.params),
    ).toEqual([{ engine: 'google' }]);
    expect(body.notes.map((n) => n.code)).not.toContain('search_window_incomplete');
  });

  it('adds the lower-bound note when Google stage 3 is present', async () => {
    const end = shiftDay(DAY, -5);
    await t.db
      .insert(metricsDaily)
      .values([
        row(end, 'search.google.www_page.impressions', 100),
        row(end, 'search.google.www_page.catalog_pages_with_impressions_28d', 40),
      ]);
    const body = await readSeoFunnel(t.db, NOW);
    const codes = body.notes.map((n) => n.code);
    expect(codes).toContain('indexed_is_impression_lower_bound');
    expect(body.notes.filter((n) => n.code === 'search_ingest_absent')).toEqual([
      expect.objectContaining({ params: { engine: 'bing' } }),
    ]);
  });
});
