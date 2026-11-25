/**
 * The weekly search ingest, Bing lane (AECI-821), and its transport, against the
 * real migrations in the in-memory D1 harness with Bing stubbed. Response shapes
 * follow Microsoft's `IWebmasterApi` reference pages: a `{"d":[...]}` body, WCF
 * `/Date(ms-0700)/` dates, and errors as HTTP 400 with `{"ErrorCode":3,
 * "Message":"InvalidApiKey"}`.
 *
 * What must hold, because each failure is silent in production:
 *   - a throttle that arrives as a 400 is `throttled`, not a refused key;
 *   - rows are filed under Bing's Pacific dates, only for days Bing returned;
 *   - one call's failure writes nothing for its keys and stops no other call;
 *   - only a credential refused everywhere fails the lane;
 *   - an absent key or site URL skips the lane and calls nothing;
 *   - every unread error body is released;
 *   - the API key never appears in anything the lane returns.
 */

import {
  ADMIN_SNAPSHOT_METRIC_KEYS,
  SEARCH_INGEST_BING_METRIC_KEYS,
  SEARCH_INGEST_GOOGLE_METRIC_KEYS,
  SEARCH_INGEST_METRIC_KEYS,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { metricsDaily } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  BWT_API_BASE,
  callBingWebmaster,
  parseBingDate,
  type BingMethod,
} from './bing-webmaster-api';
import {
  BING_INGEST_WRITTEN_KEYS,
  bingHeartbeatOutcome,
  bingReportingDay,
  isWwwBingSite,
  runBingSearchIngest,
  type BingSearchIngestDeps,
} from './search-ingest-bing';
import { SEARCH_INGEST_WWW_SITEMAP } from './search-ingest';

/** Obviously not a real BWT key. */
const KEY = 'test-bwt-key-not-real';
const SITE = 'https://www.aecintegrations.com/';

/** Sunday 2026-11-22 22:00 UTC, the cron's slot. 14:00 the same day in California. */
const NOW = new Date('2026-11-22T22:00:00.000Z');
/** Pacific today minus the three-day lag, and 14 days back. The Google lane's window. */
const END = '2026-11-19';
const START = '2026-11-06';

/** Bing's WCF date for local midnight of `day` at `offset` (PST is -0800). */
function wcf(day: string, offset = '-0800'): string {
  const sign = offset.startsWith('-') ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3)));
  const ms = Date.parse(`${day}T00:00:00.000Z`) - minutes * 60_000;
  return `/Date(${ms}${offset})/`;
}

const TRAFFIC = {
  d: [
    // Outside the window on both sides: never written.
    {
      __type: 'RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api',
      Clicks: 9,
      Date: wcf('2026-11-05'),
      Impressions: 99,
    },
    {
      __type: 'RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api',
      Clicks: 2,
      Date: wcf('2026-11-17'),
      Impressions: 40,
    },
    // A measured quiet day: Bing returned it with zeros, so zeros are stored.
    {
      __type: 'RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api',
      Clicks: 0,
      Date: wcf('2026-11-18'),
      Impressions: 0,
    },
    // Impressions left out: no impressions row for that day, never a 0.
    {
      __type: 'RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api',
      Clicks: 3,
      Date: wcf('2026-11-19'),
    },
    {
      __type: 'RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api',
      Clicks: 7,
      Date: wcf('2026-11-20'),
      Impressions: 70,
    },
  ],
};
const CRAWL = {
  d: [
    {
      __type: 'CrawlStats:#Microsoft.Bing.Webmaster.Api',
      AllOtherCodes: 0,
      BlockedByRobotsTxt: 0,
      Code2xx: 812,
      Code301: 3,
      Code302: 0,
      Code4xx: 1,
      Code5xx: 0,
      ContainsMalware: 0,
      CrawlErrors: 1,
      CrawledPages: 816,
      Date: wcf('2026-11-19'),
      InIndex: 1210,
      InLinks: 2048,
    },
  ],
};
const FEEDS = {
  d: [
    {
      __type: 'Feed:#Microsoft.Bing.Webmaster.Api',
      Compressed: false,
      FileSize: 1024,
      LastCrawled: `/Date(${Date.parse('2026-11-20T22:00:00.000Z')}-0800)/`,
      Status: 'Success',
      Submitted: `/Date(${Date.parse('2026-09-10T16:00:00.000Z')}-0700)/`,
      Type: 'Sitemap',
      Url: SEARCH_INGEST_WWW_SITEMAP,
      UrlCount: 1445,
    },
    {
      __type: 'Feed:#Microsoft.Bing.Webmaster.Api',
      Url: 'https://demo.aecintegrations.com/sitemap.xml',
      UrlCount: 9,
    },
  ],
};

type Answer = object | number | Error | { status: 400; body: object | string };
interface Script {
  GetRankAndTrafficStats?: Answer;
  GetCrawlStats?: Answer;
  GetFeeds?: Answer;
}

const responses: Response[] = [];
function respond(answer: Answer): Response {
  if (answer instanceof Error) throw answer;
  let res: Response;
  if (typeof answer === 'number') {
    res = new Response('<html>upstream</html>', { status: answer });
  } else if ('status' in answer && answer.status === 400) {
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    res = new Response(body, {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } else {
    res = new Response(JSON.stringify(answer), { status: 200 });
  }
  responses.push(res);
  return res;
}

const err400 = (code: number, message: string): Answer => ({
  status: 400,
  body: { ErrorCode: code, Message: message },
});

function bing(script: Script = {}) {
  const full: Required<Script> = {
    GetRankAndTrafficStats: TRAFFIC,
    GetCrawlStats: CRAWL,
    GetFeeds: FEEDS,
    ...script,
  };
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const method = u.pathname.split('/').pop() as BingMethod;
    if (!(method in full)) throw new Error(`unstubbed ${url}`);
    return respond(full[method]);
  });
}

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  responses.length = 0;
  // Every call here takes an injected stub. The global fetch fails loudly, so a
  // missed injection can never reach Bing.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no network in tests');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  t.dispose();
});

const deps = (
  fetchImpl: ReturnType<typeof bing>,
  over: Partial<BingSearchIngestDeps> = {},
): BingSearchIngestDeps => ({
  db: t.db,
  apiKey: KEY,
  siteUrl: SITE,
  fetchImpl: fetchImpl as unknown as typeof fetch,
  now: () => NOW,
  sleep: async () => {},
  ...over,
});

const valueOf = async (day: string, metric: string) =>
  (
    await t.db
      .select({ value: metricsDaily.value, source: metricsDaily.source })
      .from(metricsDaily)
      .where(and(eq(metricsDaily.day, day), eq(metricsDaily.metric, metric)))
  )[0];

const allRows = () => t.db.select().from(metricsDaily);

describe('the Bing key vocabulary', () => {
  it('is the second spread of the ingest list, and never a snapshot key', () => {
    expect([...SEARCH_INGEST_METRIC_KEYS]).toEqual([
      ...SEARCH_INGEST_GOOGLE_METRIC_KEYS,
      ...SEARCH_INGEST_BING_METRIC_KEYS,
    ]);
    const snapshot = new Set<string>(ADMIN_SNAPSHOT_METRIC_KEYS);
    expect(SEARCH_INGEST_BING_METRIC_KEYS.filter((k) => snapshot.has(k))).toEqual([]);
    expect(SEARCH_INGEST_BING_METRIC_KEYS.every((k) => k.startsWith('search.bing.www.'))).toBe(
      true,
    );
    expect(SEARCH_INGEST_BING_METRIC_KEYS).toContain('search.bing.www.in_index');
  });

  it('writes exactly the shared Bing keys', () => {
    expect([...BING_INGEST_WRITTEN_KEYS].sort()).toEqual(
      [...SEARCH_INGEST_BING_METRIC_KEYS].sort(),
    );
  });
});

describe('Bing dates', () => {
  it("reads Microsoft's sample as 2011-09-16, its stated local day", () => {
    expect(parseBingDate('/Date(1316156400000-0700)/')).toEqual({
      ms: 1316156400000,
      offsetMinutes: -420,
    });
    expect(bingReportingDay('/Date(1316156400000-0700)/')).toBe('2011-09-16');
  });

  it('files a winter row and a summer row under their Pacific dates, not UTC', () => {
    // Midnight PST is 08:00 UTC, midnight PDT is 07:00 UTC: the same UTC date.
    expect(bingReportingDay(wcf('2026-11-17', '-0800'))).toBe('2026-11-17');
    expect(bingReportingDay(wcf('2026-07-01', '-0700'))).toBe('2026-07-01');
    // 23:30 Pacific on the 17th is the 18th in UTC, and still the 17th here.
    const late = Date.parse('2026-11-18T07:30:00.000Z');
    expect(bingReportingDay(`/Date(${late}-0800)/`)).toBe('2026-11-17');
  });

  it('falls back to the Pacific date when Bing states no offset', () => {
    expect(bingReportingDay(`/Date(${Date.parse('2026-11-18T07:30:00.000Z')})/`)).toBe(
      '2026-11-17',
    );
  });

  it('refuses anything that is not a WCF date', () => {
    for (const bad of [undefined, 42, '', '2026-11-17', '/Date(abc)/', '/Date(1-07)/']) {
      expect(bingReportingDay(bad)).toBeNull();
    }
  });
});

describe('callBingWebmaster', () => {
  it('GETs the JSON endpoint with the site and the key as query parameters', async () => {
    const fetchImpl = bing();
    const res = await callBingWebmaster(fetchImpl as never, 'GetCrawlStats', SITE, KEY, {
      sleep: async () => {},
    });
    expect(res).toMatchObject({ ok: true, rows: CRAWL.d });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`${BWT_API_BASE}/GetCrawlStats`);
    expect(u.searchParams.get('siteUrl')).toBe(SITE);
    expect(u.searchParams.get('apikey')).toBe(KEY);
    expect(init.method).toBe('GET');
  });

  it.each([
    [4, 'ThrottleUser'],
    [5, 'ThrottleHost'],
  ])('reads a 400 ErrorCode %i as throttled, once, not as a refused key', async (code, name) => {
    const fetchImpl = bing({ GetCrawlStats: err400(code, name) });
    const res = await callBingWebmaster(fetchImpl as never, 'GetCrawlStats', SITE, KEY, {
      sleep: async () => {},
    });
    expect(res).toEqual({ ok: false, kind: 'throttled', message: `bwt_${name}`, errorCode: code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(responses[0]!.bodyUsed).toBe(true);
  });

  it.each([
    [3, 'InvalidApiKey'],
    [14, 'NotAuthorized'],
    [6, 'UserBlocked'],
  ])('reads a 400 ErrorCode %i as auth', async (code, name) => {
    const fetchImpl = bing({ GetCrawlStats: err400(code, name) });
    const res = await callBingWebmaster(fetchImpl as never, 'GetCrawlStats', SITE, KEY, {
      sleep: async () => {},
    });
    expect(res).toMatchObject({ ok: false, kind: 'auth', message: `bwt_${name}` });
  });

  it('falls back to the Message name when ErrorCode is missing', async () => {
    const fetchImpl = bing({ GetCrawlStats: { status: 400, body: { Message: 'ThrottleHost' } } });
    const res = await callBingWebmaster(fetchImpl as never, 'GetCrawlStats', SITE, KEY, {
      sleep: async () => {},
    });
    expect(res).toMatchObject({ ok: false, kind: 'throttled', errorCode: 5 });
  });

  it('retries a 400 InternalError and a 5xx, then reports transient', async () => {
    const internal = bing({ GetCrawlStats: err400(1, 'InternalError') });
    expect(
      await callBingWebmaster(internal as never, 'GetCrawlStats', SITE, KEY, {
        sleep: async () => {},
      }),
    ).toMatchObject({ ok: false, kind: 'transient', message: 'bwt_InternalError' });
    expect(internal).toHaveBeenCalledTimes(3);

    responses.length = 0;
    const down = bing({ GetCrawlStats: 503 });
    expect(
      await callBingWebmaster(down as never, 'GetCrawlStats', SITE, KEY, {
        sleep: async () => {},
      }),
    ).toEqual({ ok: false, kind: 'transient', message: 'http_503' });
    expect(down).toHaveBeenCalledTimes(3);
    for (const res of responses) expect(res.bodyUsed).toBe(true);
  });

  it('discards and classifies every other status', async () => {
    for (const [status, kind] of [
      [429, 'throttled'],
      [401, 'auth'],
      [403, 'auth'],
      [404, 'rejected'],
    ] as const) {
      responses.length = 0;
      const fetchImpl = bing({ GetFeeds: status });
      const res = await callBingWebmaster(fetchImpl as never, 'GetFeeds', SITE, KEY, {
        sleep: async () => {},
      });
      expect(res).toEqual({ ok: false, kind, message: `http_${status}` });
      expect(responses[0]!.bodyUsed).toBe(true);
    }
  });

  it('reads an unknown code and an unreadable 400 as rejected', async () => {
    const odd = bing({ GetFeeds: err400(99, 'Something') });
    expect(
      await callBingWebmaster(odd as never, 'GetFeeds', SITE, KEY, { sleep: async () => {} }),
    ).toMatchObject({ ok: false, kind: 'rejected', message: 'bwt_code_99' });
    const html = bing({ GetFeeds: { status: 400, body: '<html>bad</html>' } });
    expect(
      await callBingWebmaster(html as never, 'GetFeeds', SITE, KEY, { sleep: async () => {} }),
    ).toEqual({ ok: false, kind: 'rejected', message: 'http_400' });
  });

  it('records a thrown fetch error as network_error, never the runtime text', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      throw new Error(`connect ECONNRESET while fetching ${url}`);
    });
    const res = await callBingWebmaster(fetchImpl as never, 'GetCrawlStats', SITE, KEY, {
      sleep: async () => {},
    });
    // The thrown text really held the key, so the assertion below is not vacuous.
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(`apikey=${KEY}`);
    expect(res).toEqual({ ok: false, kind: 'transient', message: 'network_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('reads a null or absent d as zero rows, and any other non-array as rejected', async () => {
    for (const body of [{ d: null }, {}]) {
      const fetchImpl = bing({ GetFeeds: body });
      expect(
        await callBingWebmaster(fetchImpl as never, 'GetFeeds', SITE, KEY, {
          sleep: async () => {},
        }),
      ).toEqual({ ok: true, rows: [] });
    }
    const odd = bing({ GetFeeds: { d: { Url: 'x' } } });
    expect(
      await callBingWebmaster(odd as never, 'GetFeeds', SITE, KEY, { sleep: async () => {} }),
    ).toEqual({ ok: false, kind: 'rejected', message: 'unexpected_body' });
  });
});

describe('isWwwBingSite', () => {
  it('accepts only the www. site root', () => {
    expect(isWwwBingSite('https://www.aecintegrations.com/')).toBe(true);
    expect(isWwwBingSite('https://www.aecintegrations.com')).toBe(true);
    expect(isWwwBingSite('http://www.aecintegrations.com/')).toBe(true);
    expect(isWwwBingSite('https://aecintegrations.com/')).toBe(false);
    expect(isWwwBingSite('https://demo.aecintegrations.com/')).toBe(false);
    expect(isWwwBingSite('https://www.aecintegrations.com/products/')).toBe(false);
    expect(isWwwBingSite('aecintegrations.com')).toBe(false);
  });
});

describe('runBingSearchIngest', () => {
  it.each([
    [{ apiKey: undefined }, 'no_creds'],
    [{ apiKey: '  ' }, 'no_creds'],
    [{ siteUrl: undefined }, 'no_site_url'],
    [{ siteUrl: 'https://aecintegrations.com/' }, 'site_url_not_www'],
  ] as const)('skips with %o as %s, and calls nothing', async (over, reason) => {
    const fetchImpl = bing();
    const result = await runBingSearchIngest(deps(fetchImpl, over));
    expect(result).toMatchObject({ outcome: 'skipped', reason, written: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await allRows()).toEqual([]);
    expect(bingHeartbeatOutcome(result)).toBe('skipped');
  });

  it('makes three sequential calls and files each row under its Pacific day', async () => {
    const fetchImpl = bing();
    const result = await runBingSearchIngest(deps(fetchImpl));

    expect(
      fetchImpl.mock.calls.map(([u]) => new URL(u as string).pathname.split('/').pop()),
    ).toEqual(['GetRankAndTrafficStats', 'GetCrawlStats', 'GetFeeds']);
    expect(result.outcome).toBe('ok');
    expect(result.window).toEqual({ start: START, end: END });
    expect(result.siteUrl).toBe(SITE);

    expect(await valueOf('2026-11-17', 'search.bing.www.clicks')).toEqual({
      value: 2,
      source: 'measured',
    });
    expect((await valueOf('2026-11-17', 'search.bing.www.impressions'))?.value).toBe(40);
    // A day Bing returned with zeros stores zeros.
    expect((await valueOf('2026-11-18', 'search.bing.www.clicks'))?.value).toBe(0);
    expect((await valueOf('2026-11-18', 'search.bing.www.impressions'))?.value).toBe(0);
    // A field Bing left out stores nothing.
    expect((await valueOf('2026-11-19', 'search.bing.www.clicks'))?.value).toBe(3);
    expect(await valueOf('2026-11-19', 'search.bing.www.impressions')).toBeUndefined();
    // Outside the window, on both sides.
    expect(await valueOf('2026-11-05', 'search.bing.www.clicks')).toBeUndefined();
    expect(await valueOf('2026-11-20', 'search.bing.www.clicks')).toBeUndefined();

    expect((await valueOf('2026-11-19', 'search.bing.www.in_index'))?.value).toBe(1210);
    expect((await valueOf('2026-11-19', 'search.bing.www.crawled_pages'))?.value).toBe(816);
    expect((await valueOf('2026-11-19', 'search.bing.www.crawl_errors'))?.value).toBe(1);

    // The sitemap sample is filed under the run's UTC day.
    expect((await valueOf('2026-11-22', 'search.bing.www.sitemap_urls'))?.value).toBe(1445);
    expect((await valueOf('2026-11-22', 'search.bing.www.sitemap_crawl_age_days'))?.value).toBe(2);
    expect(result.sitemap).toEqual({
      url: SEARCH_INGEST_WWW_SITEMAP,
      lastCrawled: '2026-11-20T22:00:00.000Z',
      submitted: '2026-09-10T16:00:00.000Z',
      status: 'Success',
      urlCount: 1445,
    });

    expect(result.calls).toEqual({
      traffic: { outcome: 'ok', rows: 5, written: 5 },
      crawl: { outcome: 'ok', rows: 1, written: 3 },
      feeds: { outcome: 'ok', rows: 2, written: 2 },
    });
    expect(result.written).toBe(10);
    expect(Object.values(result.metrics).every((o) => o === 'written')).toBe(true);
    expect(bingHeartbeatOutcome(result)).toBe('ok');
  });

  it('writes no row for a day Bing did not return, so a re-pull never erases a figure', async () => {
    await runBingSearchIngest(deps(bing()));
    // The next run's answer has dropped 2026-11-17.
    await runBingSearchIngest(
      deps(
        bing({
          GetRankAndTrafficStats: { d: TRAFFIC.d.filter((r) => r.Date !== wcf('2026-11-17')) },
        }),
      ),
    );
    expect((await valueOf('2026-11-17', 'search.bing.www.clicks'))?.value).toBe(2);
  });

  it('reads an empty answer as no_data and stores no 0', async () => {
    const result = await runBingSearchIngest(
      deps(
        bing({
          GetRankAndTrafficStats: { d: [] },
          GetCrawlStats: { d: null },
          GetFeeds: { d: [] },
        }),
      ),
    );
    expect(result.outcome).toBe('ok');
    expect(await allRows()).toEqual([]);
    expect(Object.values(result.metrics).every((o) => o === 'no_data')).toBe(true);
  });

  it('isolates a throttled call: its keys fail, the others write', async () => {
    const result = await runBingSearchIngest(
      deps(bing({ GetCrawlStats: err400(4, 'ThrottleUser') })),
    );
    expect(result.outcome).toBe('ok');
    expect(result.calls.crawl).toEqual({
      outcome: 'throttled',
      message: 'bwt_ThrottleUser',
      errorCode: 4,
      rows: 0,
      written: 0,
    });
    expect(result.metrics['search.bing.www.in_index']).toBe('failed');
    expect(result.metrics['search.bing.www.clicks']).toBe('written');
    expect(result.metrics['search.bing.www.sitemap_urls']).toBe('written');
    expect(await valueOf('2026-11-19', 'search.bing.www.in_index')).toBeUndefined();
    expect(bingHeartbeatOutcome(result)).toBe('throttled');
  });

  it('reads a mix of throttle and other failure as partial', async () => {
    const result = await runBingSearchIngest(
      deps(bing({ GetCrawlStats: err400(5, 'ThrottleHost'), GetFeeds: 503 })),
    );
    expect(result.outcome).toBe('ok');
    expect(bingHeartbeatOutcome(result)).toBe('partial');
  });

  it('reads a key that failed under calls that all succeeded as partial, as Google does', () => {
    const ok = { outcome: 'ok' as const, rows: 1, written: 1 };
    const calls = { traffic: ok, crawl: ok, feeds: ok };
    expect(bingHeartbeatOutcome({ outcome: 'ok', calls, metrics: {}, written: 3 })).toBe('ok');
    expect(
      bingHeartbeatOutcome({
        outcome: 'ok',
        calls,
        metrics: { 'search.bing.www.clicks': 'failed' },
        written: 3,
      }),
    ).toBe('partial');
  });

  it('fails only when every call refuses the credential', async () => {
    const refused = err400(3, 'InvalidApiKey');
    const all = await runBingSearchIngest(
      deps(bing({ GetRankAndTrafficStats: refused, GetCrawlStats: refused, GetFeeds: refused })),
    );
    expect(all).toMatchObject({ outcome: 'failed', reason: 'bing_refused_credential', written: 0 });
    expect(bingHeartbeatOutcome(all)).toBe('failed');

    const one = await runBingSearchIngest(deps(bing({ GetFeeds: err400(14, 'NotAuthorized') })));
    expect(one.outcome).toBe('ok');
    expect(one.calls.feeds?.outcome).toBe('auth');
  });

  it('records the sitemap as missing when no feed is the www. sitemap', async () => {
    const result = await runBingSearchIngest(deps(bing({ GetFeeds: { d: [FEEDS.d[1]] } })));
    expect(result.sitemap).toBeNull();
    expect(result.metrics['search.bing.www.sitemap_urls']).toBe('no_data');
  });

  it('never returns the API key, whatever Bing or the network does', async () => {
    const scenarios: Script[] = [
      {},
      { GetRankAndTrafficStats: err400(3, 'InvalidApiKey') },
      { GetCrawlStats: { status: 400, body: { ErrorCode: 8, Message: `bad apikey=${KEY}` } } },
      { GetFeeds: new Error(`fetch failed: ${BWT_API_BASE}/GetFeeds?siteUrl=x&apikey=${KEY}`) },
      { GetCrawlStats: 500 },
    ];
    for (const script of scenarios) {
      const result = await runBingSearchIngest(deps(bing(script)));
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });
});
