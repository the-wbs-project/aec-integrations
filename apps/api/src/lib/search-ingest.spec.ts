/**
 * The weekly search ingest, Google lane (AECI-820), against the real migrations in
 * the in-memory D1 harness with Google stubbed. Response shapes follow Google's
 * reference pages for `searchanalytics.query` and `sitemaps.list`.
 *
 * What must hold, because each failure is silent in production:
 *   - every `www_page` call carries the anchored `www.` page filter, and the
 *     `property` call carries none and asks for `byProperty`;
 *   - rows are filed under Google's Pacific dates, only for days Google returned,
 *     and a day with no impressions gets no position row;
 *   - one call's failure writes nothing for its keys and stops no other call;
 *   - only a credential refused everywhere fails the run;
 *   - every unread error body is released;
 *   - the ingest keys never overlap the snapshot keys.
 */

import { generateKeyPairSync } from 'node:crypto';

import {
  ADMIN_SNAPSHOT_METRIC_KEYS,
  SEARCH_INGEST_GOOGLE_METRIC_KEYS,
  SEARCH_INGEST_METRIC_KEYS,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { metricsDaily } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { GOOGLE_TOKEN_ENDPOINT, SEARCH_CONSOLE_SITE } from './google-service-account';
import { SEARCH_CONSOLE_API_BASE } from './search-console-api';
import {
  pacificDay,
  runGoogleSearchIngest,
  searchIngestHadFailures,
  SEARCH_INGEST_WRITTEN_KEYS,
  SEARCH_INGEST_WWW_PAGE_REGEX,
  SEARCH_INGEST_WWW_SITEMAP,
  type GoogleSearchIngestDeps,
} from './search-ingest';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_JSON = JSON.stringify({
  client_email: 'ingest@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

/** Sunday 2026-11-22 22:00 UTC, the cron's slot. 14:00 the same day in California. */
const NOW = new Date('2026-11-22T22:00:00.000Z');
/** Pacific today minus the three-day lag. */
const DAILY_END = '2026-11-19';
const DAILY_START = '2026-11-06';

const SITE_PATH = `${SEARCH_CONSOLE_API_BASE}/sites/${encodeURIComponent(SEARCH_CONSOLE_SITE)}`;
const QUERY_URL = `${SITE_PATH}/searchAnalytics/query`;
const SITEMAPS_URL = `${SITE_PATH}/sitemaps`;

type Body = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  dimensionFilterGroups?: {
    filters: { dimension: string; operator: string; expression: string }[];
  }[];
  aggregationType?: string;
  dataState?: string;
  startRow?: number;
};

/** Which Search Analytics call a request body is. */
function callOf(body: Body): 'www_daily' | 'property_daily' | 'pages' | 'queries' {
  const dim = body.dimensions?.[0];
  if (dim === 'page') return 'pages';
  if (dim === 'query') return 'queries';
  return body.dimensionFilterGroups ? 'www_daily' : 'property_daily';
}

type Answer = object | number | Error;

const DAILY_WWW = {
  rows: [
    { keys: ['2026-11-17'], clicks: 2, impressions: 40, ctr: 0.05, position: 31.5 },
    { keys: ['2026-11-18'], clicks: 0, impressions: 0, ctr: 0, position: 0 },
    { keys: ['2026-11-19'], clicks: 3, impressions: 60, ctr: 0.05, position: 28.25 },
  ],
  responseAggregationType: 'byPage',
};
const DAILY_PROPERTY = {
  rows: [{ keys: ['2026-11-19'], clicks: 4, impressions: 70, ctr: 0.057, position: 25 }],
  responseAggregationType: 'byProperty',
};
const PAGES = {
  rows: [
    { keys: ['https://www.aecintegrations.com/products/procore'], clicks: 1, impressions: 9 },
    {
      keys: ['https://www.aecintegrations.com/products/autodesk-build'],
      clicks: 0,
      impressions: 3,
    },
    { keys: ['https://www.aecintegrations.com/docs/vendors/plans'], clicks: 0, impressions: 1 },
  ],
  responseAggregationType: 'byPage',
};
const QUERIES = {
  rows: [
    { keys: ['procore integrations'], clicks: 1, impressions: 5 },
    { keys: ['bim 360 api'], clicks: 0, impressions: 2 },
  ],
};
const SITEMAPS = {
  sitemap: [
    {
      path: 'https://demo.aecintegrations.com/sitemap.xml',
      lastDownloaded: '2026-11-01T00:00:00.000Z',
      errors: '9',
      warnings: '9',
      contents: [{ type: 'web', submitted: '9', indexed: '0' }],
    },
    {
      path: SEARCH_INGEST_WWW_SITEMAP,
      lastSubmitted: '2026-11-10T08:00:00.000Z',
      lastDownloaded: '2026-11-20T22:00:00.000Z',
      isPending: false,
      isSitemapsIndex: false,
      type: 'sitemap',
      errors: '0',
      warnings: '2',
      contents: [{ type: 'web', submitted: '1445', indexed: '0' }],
    },
  ],
};

interface Script {
  www_daily?: Answer;
  property_daily?: Answer;
  pages?: Answer;
  queries?: Answer;
  sitemaps?: Answer;
  token?: Answer | Answer[];
}

const responses: Response[] = [];
function respond(answer: Answer): Response {
  if (answer instanceof Error) throw answer;
  const res =
    typeof answer === 'number'
      ? new Response('{"error":{"code":1}}', { status: answer })
      : new Response(JSON.stringify(answer), { status: 200 });
  responses.push(res);
  return res;
}

function google(script: Script = {}) {
  const full: Required<Script> = {
    www_daily: DAILY_WWW,
    property_daily: DAILY_PROPERTY,
    pages: PAGES,
    queries: QUERIES,
    sitemaps: SITEMAPS,
    token: { access_token: 'tok' },
    ...script,
  };
  const tokens = Array.isArray(full.token) ? [...full.token] : null;
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return respond(
        tokens ? (tokens.length > 1 ? tokens.shift()! : tokens[0]!) : (full.token as Answer),
      );
    }
    if (url === SITEMAPS_URL) return respond(full.sitemaps);
    if (url === QUERY_URL) return respond(full[callOf(JSON.parse(init!.body as string))]);
    throw new Error(`unstubbed ${url}`);
  });
}

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  responses.length = 0;
});
afterEach(() => t.dispose());

const deps = (
  fetchImpl: ReturnType<typeof google>,
  over: Partial<GoogleSearchIngestDeps> = {},
): GoogleSearchIngestDeps => ({
  db: t.db,
  serviceAccountJson: SA_JSON,
  indexNowKey: 'k',
  publicSiteUrl: 'https://www.aecintegrations.com',
  fetchImpl: fetchImpl as unknown as typeof fetch,
  now: () => NOW,
  sleep: async () => {},
  catalogUrls: async () =>
    new Set([
      'https://www.aecintegrations.com/products/procore',
      'https://www.aecintegrations.com/products/autodesk-build',
      'https://www.aecintegrations.com/products/never-impressed',
    ]),
  ...over,
});

const valueOf = async (day: string, metric: string) =>
  (
    await t.db
      .select({ value: metricsDaily.value, source: metricsDaily.source })
      .from(metricsDaily)
      .where(and(eq(metricsDaily.day, day), eq(metricsDaily.metric, metric)))
  )[0];

const bodies = (fetchImpl: ReturnType<typeof google>): Body[] =>
  fetchImpl.mock.calls
    .filter(([u]) => u === QUERY_URL)
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Body);

describe('the key vocabulary', () => {
  it('never overlaps the snapshot keys, so the snapshot cannot write or zero-fill them', () => {
    const snapshot = new Set<string>(ADMIN_SNAPSHOT_METRIC_KEYS);
    expect(SEARCH_INGEST_METRIC_KEYS.filter((k) => snapshot.has(k))).toEqual([]);
    expect(SEARCH_INGEST_METRIC_KEYS.every((k) => k.startsWith('search.'))).toBe(true);
  });

  it('writes exactly the shared Google keys', () => {
    expect([...SEARCH_INGEST_WRITTEN_KEYS].sort()).toEqual(
      [...SEARCH_INGEST_GOOGLE_METRIC_KEYS].sort(),
    );
  });
});

describe('pacificDay', () => {
  it('reads the date in California, not UTC', () => {
    expect(pacificDay(new Date('2026-11-23T05:00:00.000Z'))).toBe('2026-11-22');
    expect(pacificDay(new Date('2026-07-01T06:59:00.000Z'))).toBe('2026-06-30');
    expect(pacificDay(new Date('2026-07-01T07:00:00.000Z'))).toBe('2026-07-01');
  });
});

describe('runGoogleSearchIngest', () => {
  it('skips with no key, and calls nothing', async () => {
    const fetchImpl = google();
    const result = await runGoogleSearchIngest(deps(fetchImpl, { serviceAccountJson: undefined }));
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'no_creds', written: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips off production, where the env is not public', async () => {
    const fetchImpl = google();
    const result = await runGoogleSearchIngest(deps(fetchImpl, { indexNowKey: undefined }));
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'not_public' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails when the token exchange is refused, and writes nothing', async () => {
    const fetchImpl = google({ token: 401 });
    const result = await runGoogleSearchIngest(deps(fetchImpl));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'token_http_401', written: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await t.db.select().from(metricsDaily)).toHaveLength(0);
  });

  it('fails on a refused credential (400 invalid_grant) without retrying', async () => {
    const fetchImpl = google({ token: 400 });
    const result = await runGoogleSearchIngest(deps(fetchImpl));
    expect(result).toMatchObject({ outcome: 'failed', reason: 'token_http_400', written: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a transient token failure in-process, then runs as normal', async () => {
    const fetchImpl = google({ token: [503, { access_token: 'tok' }] });
    const result = await runGoogleSearchIngest(deps(fetchImpl));
    expect(result.outcome).toBe('ok');
    expect(result.calls.token).toBeUndefined();
    expect(fetchImpl.mock.calls.filter(([u]) => u === GOOGLE_TOKEN_ENDPOINT)).toHaveLength(2);
    expect(await valueOf('2026-11-17', 'search.google.www_page.clicks')).toMatchObject({
      value: 2,
    });
  });

  it('records a token failure that stays transient, writes nothing, and does not fail the run', async () => {
    const fetchImpl = google({ token: 503 });
    const result = await runGoogleSearchIngest(deps(fetchImpl));
    expect(result).toMatchObject({
      outcome: 'ok',
      reason: 'token_transient',
      calls: { token: { outcome: 'transient', message: 'token_http_503' } },
      written: 0,
    });
    expect(searchIngestHadFailures(result)).toBe(true);
    expect(result.metrics['search.google.www_page.clicks']).toBe('failed');
    // Three attempts on the token endpoint, and no Search Console call.
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([
      GOOGLE_TOKEN_ENDPOINT,
      GOOGLE_TOKEN_ENDPOINT,
      GOOGLE_TOKEN_ENDPOINT,
    ]);
    expect(await t.db.select().from(metricsDaily)).toHaveLength(0);
  });

  it('writes no 28-day zero when the www series has no day in the window', async () => {
    const fetchImpl = google({ www_daily: { responseAggregationType: 'byPage' } });
    const result = await runGoogleSearchIngest(deps(fetchImpl));
    expect(result.outcome).toBe('ok');
    for (const key of [
      'search.google.www_page.pages_with_impressions_28d',
      'search.google.www_page.catalog_pages_with_impressions_28d',
      'search.google.www_page.queries_28d',
    ] as const) {
      expect(result.metrics[key]).toBe('no_data');
    }
    // Calls 3 and 4 are skipped.
    expect(bodies(fetchImpl).map(callOf)).toEqual(['www_daily', 'property_daily']);
    const rows = await t.db.select().from(metricsDaily);
    expect(rows.filter((r) => r.metric.endsWith('_28d'))).toEqual([]);
  });

  it('writes no zero when the page and query lists come back empty', async () => {
    const result = await runGoogleSearchIngest(deps(google({ pages: { rows: [] }, queries: {} })));
    expect(result.metrics['search.google.www_page.pages_with_impressions_28d']).toBe('no_data');
    expect(result.metrics['search.google.www_page.queries_28d']).toBe('no_data');
    const rows = await t.db.select().from(metricsDaily);
    expect(rows.filter((r) => r.metric.endsWith('_28d'))).toEqual([]);
  });

  it('asks for final data over Pacific windows, with the www filter on every www call', async () => {
    const fetchImpl = google();
    const result = await runGoogleSearchIngest(deps(fetchImpl));

    expect(result.window).toEqual({
      daily: { start: DAILY_START, end: DAILY_END },
      // Ends on the newest day call 1 returned.
      rolling: { start: '2026-10-23', end: '2026-11-19' },
    });
    const sent = bodies(fetchImpl);
    expect(sent.map(callOf)).toEqual(['www_daily', 'property_daily', 'pages', 'queries']);
    for (const body of sent) expect(body.dataState).toBe('final');
    const wwwFilter = [
      {
        groupType: 'and',
        filters: [
          {
            dimension: 'page',
            operator: 'includingRegex',
            expression: SEARCH_INGEST_WWW_PAGE_REGEX,
          },
        ],
      },
    ];
    expect(sent[0]).toMatchObject({
      startDate: DAILY_START,
      endDate: DAILY_END,
      dimensionFilterGroups: wwwFilter,
    });
    expect(sent[1]!.dimensionFilterGroups).toBeUndefined();
    expect(sent[1]!.aggregationType).toBe('byProperty');
    expect(sent[2]).toMatchObject({
      startDate: '2026-10-23',
      endDate: '2026-11-19',
      dimensionFilterGroups: wwwFilter,
      startRow: 0,
    });
    expect(sent[3]).toMatchObject({ dimensionFilterGroups: wwwFilter });
    // The regex is anchored, so the apex and demo. never match it.
    const re = new RegExp(SEARCH_INGEST_WWW_PAGE_REGEX);
    expect(re.test('https://www.aecintegrations.com/products/x')).toBe(true);
    expect(re.test('https://demo.aecintegrations.com/products/x')).toBe(false);
    expect(re.test('https://aecintegrations.com/products/x')).toBe(false);
    // Sequential: one token, then the five calls in order.
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([
      GOOGLE_TOKEN_ENDPOINT,
      QUERY_URL,
      QUERY_URL,
      QUERY_URL,
      QUERY_URL,
      SITEMAPS_URL,
    ]);
  });

  it('files each daily figure under its Pacific date, and only days Google returned', async () => {
    const result = await runGoogleSearchIngest(deps(google()));
    expect(result.outcome).toBe('ok');

    expect(await valueOf('2026-11-17', 'search.google.www_page.clicks')).toEqual({
      value: 2,
      source: 'measured',
    });
    expect(await valueOf('2026-11-17', 'search.google.www_page.impressions')).toMatchObject({
      value: 40,
    });
    expect(await valueOf('2026-11-19', 'search.google.www_page.position_avg')).toMatchObject({
      value: 28.25,
    });
    // A day with no impressions: clicks and impressions are 0, position has no row.
    expect(await valueOf('2026-11-18', 'search.google.www_page.impressions')).toMatchObject({
      value: 0,
    });
    expect(await valueOf('2026-11-18', 'search.google.www_page.position_avg')).toBeUndefined();
    // A day Google did not return is never written as 0.
    expect(await valueOf('2026-11-16', 'search.google.www_page.clicks')).toBeUndefined();
    expect(await valueOf('2026-11-19', 'search.google.property.impressions')).toMatchObject({
      value: 70,
    });
    expect(await valueOf('2026-11-17', 'search.google.property.clicks')).toBeUndefined();
  });

  it('counts impressed pages, the catalog subset and distinct queries on the window end', async () => {
    await runGoogleSearchIngest(deps(google()));
    expect(
      await valueOf('2026-11-19', 'search.google.www_page.pages_with_impressions_28d'),
    ).toMatchObject({ value: 3 });
    expect(
      await valueOf('2026-11-19', 'search.google.www_page.catalog_pages_with_impressions_28d'),
    ).toMatchObject({ value: 2 });
    expect(await valueOf('2026-11-19', 'search.google.www_page.queries_28d')).toMatchObject({
      value: 2,
    });
  });

  it('records the www sitemap state, parsing Google longs sent as strings', async () => {
    const result = await runGoogleSearchIngest(deps(google()));
    expect(result.sitemap).toEqual({
      path: SEARCH_INGEST_WWW_SITEMAP,
      lastDownloaded: '2026-11-20T22:00:00.000Z',
      lastSubmitted: '2026-11-10T08:00:00.000Z',
      isPending: false,
      errors: 0,
      warnings: 2,
      submitted: 1445,
    });
    // A sample at the run, filed under the run's UTC day.
    expect(await valueOf('2026-11-22', 'search.google.www_sitemap.urls_submitted')).toMatchObject({
      value: 1445,
    });
    expect(await valueOf('2026-11-22', 'search.google.www_sitemap.warnings')).toMatchObject({
      value: 2,
    });
    expect(await valueOf('2026-11-22', 'search.google.www_sitemap.errors')).toMatchObject({
      value: 0,
    });
    expect(
      await valueOf('2026-11-22', 'search.google.www_sitemap.download_age_days'),
    ).toMatchObject({ value: 2 });
  });

  it('is idempotent: a second run overwrites rather than adds', async () => {
    await runGoogleSearchIngest(deps(google()));
    const first = (await t.db.select().from(metricsDaily)).length;
    await runGoogleSearchIngest(
      deps(
        google({
          www_daily: {
            rows: [
              { keys: ['2026-11-17'], clicks: 5, impressions: 41, position: 30 },
              { keys: ['2026-11-19'], clicks: 3, impressions: 60, position: 28.25 },
            ],
          },
        }),
      ),
    );
    expect((await t.db.select().from(metricsDaily)).length).toBe(first);
    expect(await valueOf('2026-11-17', 'search.google.www_page.clicks')).toMatchObject({
      value: 5,
    });
    // A day missing from the re-pull keeps its earlier figure.
    expect(await valueOf('2026-11-18', 'search.google.www_page.impressions')).toMatchObject({
      value: 0,
    });
  });

  it('isolates a failed call: its keys are not written and the other calls still run', async () => {
    const fetchImpl = google({ pages: 500, queries: 403 });
    const result = await runGoogleSearchIngest(deps(fetchImpl));

    expect(result.outcome).toBe('ok');
    expect(result.calls.www_pages_28d).toMatchObject({ outcome: 'transient', written: 0 });
    expect(result.calls.www_queries_28d).toMatchObject({ outcome: 'auth', message: 'http_403' });
    expect(result.calls.sitemaps).toMatchObject({ outcome: 'ok' });
    expect(result.metrics['search.google.www_page.pages_with_impressions_28d']).toBe('failed');
    expect(result.metrics['search.google.www_page.queries_28d']).toBe('failed');
    expect(result.metrics['search.google.www_page.clicks']).toBe('written');
    expect(
      await valueOf('2026-11-19', 'search.google.www_page.pages_with_impressions_28d'),
    ).toBeUndefined();
    // The 5xx was retried twice. The 403 was not retried.
    expect(bodies(fetchImpl).map(callOf)).toEqual([
      'www_daily',
      'property_daily',
      'pages',
      'pages',
      'pages',
      'queries',
    ]);
  });

  it('releases every error body it does not read', async () => {
    await runGoogleSearchIngest(deps(google({ property_daily: 404, pages: 500, sitemaps: 429 })));
    const errors = responses.filter((r) => !r.ok);
    expect(errors.length).toBe(5);
    // A cancelled body is disturbed. An untouched one would hold a connection.
    for (const res of errors) expect(res.bodyUsed).toBe(true);
  });

  it('keeps the catalog figure out, not guessed, when the catalog read fails', async () => {
    const result = await runGoogleSearchIngest(
      deps(google(), {
        catalogUrls: async () => {
          throw new Error('d1 down');
        },
      }),
    );
    expect(result.metrics['search.google.www_page.pages_with_impressions_28d']).toBe('written');
    expect(result.metrics['search.google.www_page.catalog_pages_with_impressions_28d']).toBe(
      'failed',
    );
    // The all-pages figure is in D1, the catalog figure is not, and the run went on.
    expect(
      await valueOf('2026-11-19', 'search.google.www_page.pages_with_impressions_28d'),
    ).toMatchObject({ value: 3 });
    expect(
      await valueOf('2026-11-19', 'search.google.www_page.catalog_pages_with_impressions_28d'),
    ).toBeUndefined();
    expect(result.calls.www_pages_28d).toMatchObject({ outcome: 'ok', written: 1 });
    expect(result.calls.www_queries_28d).toMatchObject({ outcome: 'ok' });
    // Every call is ok, yet the run is not healthy: the heartbeat reads partial,
    // and the read error is kept for `/admin/system`.
    expect(Object.values(result.calls).every((c) => c.outcome === 'ok')).toBe(true);
    expect(searchIngestHadFailures(result)).toBe(true);
    expect(result.calls.www_pages_28d?.catalogReadError).toBe('d1 down');
  });

  it('reports a clean run as healthy, with no catalog read error', async () => {
    const result = await runGoogleSearchIngest(deps(google()));
    expect(searchIngestHadFailures(result)).toBe(false);
    expect(result.calls.www_pages_28d).not.toHaveProperty('catalogReadError');
  });

  it('throws, and records nothing ok, when the catalog figure upsert fails in D1', async () => {
    // The catalog read succeeds. Only the D1 write of the catalog key fails.
    t.raw
      .prepare(
        `CREATE TRIGGER catalog_key_guard BEFORE INSERT ON metrics_daily
         WHEN NEW.metric = 'search.google.www_page.catalog_pages_with_impressions_28d'
         BEGIN SELECT RAISE(ABORT, 'd1 write failed'); END;`,
      )
      .run();
    const fetchImpl = google();
    await expect(runGoogleSearchIngest(deps(fetchImpl))).rejects.toThrow('d1 write failed');
    expect(
      await valueOf('2026-11-19', 'search.google.www_page.catalog_pages_with_impressions_28d'),
    ).toBeUndefined();
    // The run stopped at the throw: the later calls never ran.
    expect(bodies(fetchImpl).map(callOf)).not.toContain('queries');
  });

  it('records no sitemap rows when Google lists no www sitemap', async () => {
    const result = await runGoogleSearchIngest(deps(google({ sitemaps: { sitemap: [] } })));
    expect(result.sitemap).toBeNull();
    expect(result.metrics['search.google.www_sitemap.errors']).toBe('no_data');
    expect(await valueOf('2026-11-22', 'search.google.www_sitemap.errors')).toBeUndefined();
  });

  it('fails only when Google refuses the credential on every call', async () => {
    const result = await runGoogleSearchIngest(
      deps(
        google({ www_daily: 403, property_daily: 403, pages: 403, queries: 401, sitemaps: 403 }),
      ),
    );
    expect(result).toMatchObject({ outcome: 'failed', reason: 'google_refused_credential' });
  });

  it('survives a dropped connection on a call', async () => {
    const result = await runGoogleSearchIngest(deps(google({ sitemaps: new Error('reset') })));
    expect(result.outcome).toBe('ok');
    expect(result.calls.sitemaps).toMatchObject({ outcome: 'transient', message: 'reset' });
  });
});
