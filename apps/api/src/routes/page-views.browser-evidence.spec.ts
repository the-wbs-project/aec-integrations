/**
 * Browser evidence (AECI-1713, epic AECI-1711), against the in-memory D1 harness.
 *
 * Two paths, modelled on the Turnstile verdict beside it
 * (`page-views.turnstile.spec.ts`). An in-app (`browser-spa`) insert is itself
 * proof the page script ran, so it is written with `ran`. Every other report
 * arrives on `POST /api/page-views/browser-evidence`, matched on `cf_ray`, and only
 * ever moves a row forward: NULL to `ran` to `interacted`.
 *
 * `submitCount` and `logToPosthog` are mocked so the metric and the warn can be
 * asserted.
 */

import { PAGE_VIEW_WRITER_HEADER, type BrowserEvidence } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pageViews } from '../db/schema';
import type { Env } from '../env';
import { logToPosthog, submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, TEST_ENV } from '../test/helpers';
import {
  BROWSER_EVIDENCE_RETRY_MS,
  BROWSER_EVIDENCE_WINDOW_MS,
  createBrowserEvidenceHandler,
  createPageViewsHandler,
} from './page-views';

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const RAY = '8c1a2b3c4d5e6f70-IAD';
const OTHER_RAY = '0000000000000000-LHR';
const URL_PATH = '/api/page-views/browser-evidence';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(submitCount).mockClear();
  vi.mocked(logToPosthog).mockClear();
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

function evidenceTags(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.pageviews.browser_evidence')
    .map((call) => call[5] as string[]);
}

function settlingCtx() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(promises), pending: () => promises.length };
}

async function beacon(
  body: unknown,
  opts: { writer?: string; headers?: Record<string, string>; env?: Partial<Env> } = {},
) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/page-views',
    handler: createPageViewsHandler(t.factory),
  });
  const { ctx, settle } = settlingCtx();
  const res = await app.request(
    '/api/page-views',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'user-agent': CHROME_UA,
        [PAGE_VIEW_WRITER_HEADER]: opts.writer ?? 'browser-spa',
        'cf-connecting-ip': '203.0.113.9',
        'x-aeci-cf-ray': RAY,
        'x-aeci-cf-country': 'US',
        ...opts.headers,
      },
    },
    { ...TEST_ENV, ...opts.env },
    ctx,
  );
  await settle();
  return res;
}

async function evidencePost(
  body: unknown,
  opts: {
    wait?: (ms: number) => Promise<void>;
    dbFor?: Parameters<typeof createBrowserEvidenceHandler>[0];
  } = {},
) {
  const app = buildAppWithHandler({
    method: 'post',
    path: URL_PATH,
    handler: createBrowserEvidenceHandler(opts.dbFor ?? t.factory, {
      wait: opts.wait ?? (async () => {}),
    }),
  });
  const { ctx, settle, pending } = settlingCtx();
  const res = await app.request(
    URL_PATH,
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    },
    TEST_ENV,
    ctx,
  );
  const deferred = pending();
  await settle();
  return { res, deferred };
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/** Insert a row directly, defaulting to a fresh US arrival with RAY and no evidence. */
async function seedRow(overrides: Partial<typeof pageViews.$inferInsert> = {}): Promise<number> {
  const [row] = await t.db
    .insert(pageViews)
    .values({
      path: '/',
      cfRay: RAY,
      cfCountry: 'US',
      writerProvenance: 'ssr-arrival',
      privacySignal: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    })
    .returning({ id: pageViews.id });
  return row!.id;
}

async function rowOf(id: number) {
  const rows = await t.db.select().from(pageViews);
  return rows.find((r) => r.id === id)!;
}

async function evidenceOf(id: number): Promise<BrowserEvidence | null> {
  return ((await rowOf(id)).browserEvidence ?? null) as BrowserEvidence | null;
}

describe('POST /api/page-views — an in-app row is written with ran (AECI-1713)', () => {
  it('writes ran and a server timestamp on a browser-spa insert from the US', async () => {
    const before = Date.now();
    await beacon({ route: '/products/procore', navigation: 'spa' });

    const [row] = await t.db.select().from(pageViews);
    expect(row!.writerProvenance).toBe('browser-spa');
    expect(row!.cfRay).toBe(RAY);
    expect(row!.browserEvidence).toBe('ran');
    expect(Date.parse(row!.browserEvidenceAt!)).toBeGreaterThanOrEqual(before - 1);
  });

  it('never writes evidence on an ssr-arrival insert', async () => {
    await beacon({ route: '/', navigation: 'arrival' }, { writer: 'ssr-arrival' });

    const [row] = await t.db.select().from(pageViews);
    expect(row!.writerProvenance).toBe('ssr-arrival');
    expect(row!.browserEvidence).toBeNull();
    expect(row!.browserEvidenceAt).toBeNull();
  });

  it.each([
    ['a held EU country', { 'x-aeci-cf-country': 'DE' }],
    ['the UK', { 'x-aeci-cf-country': 'GB' }],
    ['Switzerland', { 'x-aeci-cf-country': 'CH' }],
    ['an unknown location', { 'x-aeci-cf-country': 'XX' }],
  ])('never writes ran on a browser-spa row from %s', async (_label, headers) => {
    await beacon({ route: '/products/procore', navigation: 'spa' }, { headers });

    const [row] = await t.db.select().from(pageViews);
    expect(row!.writerProvenance).toBe('browser-spa');
    expect(row!.browserEvidence).toBeNull();
    expect(row!.browserEvidenceAt).toBeNull();
  });

  it('never writes ran on a browser-spa row with no country, which fails closed', async () => {
    const app = buildAppWithHandler({
      method: 'post',
      path: '/api/page-views',
      handler: createPageViewsHandler(t.factory),
    });
    const { ctx, settle } = settlingCtx();
    await app.request(
      '/api/page-views',
      {
        method: 'POST',
        body: JSON.stringify({ route: '/products/procore', navigation: 'spa' }),
        headers: {
          'content-type': 'application/json',
          'user-agent': CHROME_UA,
          [PAGE_VIEW_WRITER_HEADER]: 'browser-spa',
          'x-aeci-cf-ray': RAY,
        },
      },
      TEST_ENV,
      ctx,
    );
    await settle();

    const [row] = await t.db.select().from(pageViews);
    expect(row!.cfCountry).toBeNull();
    expect(row!.browserEvidence).toBeNull();
    expect(row!.browserEvidenceAt).toBeNull();
  });

  it('never writes ran on a privacy-signal browser-spa row', async () => {
    await beacon({ route: '/products/procore', navigation: 'spa' }, { headers: { dnt: '1' } });

    const [row] = await t.db.select().from(pageViews);
    expect(row!.privacySignal).toBe(true);
    expect(row!.browserEvidence).toBeNull();
    expect(row!.browserEvidenceAt).toBeNull();
  });
});

describe('POST /api/page-views/browser-evidence (AECI-1713)', () => {
  it('400s a body that is not JSON, and defers nothing', async () => {
    const { res, deferred } = await evidencePost('not json');
    expect(res.status).toBe(400);
    expect(deferred).toBe(0);
    expect(evidenceTags()).toEqual([]);
  });

  it.each([
    ['an invalid evidence word', { cf_ray: RAY, evidence: 'human' }],
    ['no evidence', { cf_ray: RAY }],
    ['a bad ray', { cf_ray: 'nope', evidence: 'ran' }],
    ['an extra key', { cf_ray: RAY, evidence: 'ran', path: '/' }],
  ])('400s %s, and defers nothing', async (_label, body) => {
    const id = await seedRow();
    const { res, deferred } = await evidencePost(body);
    expect(res.status).toBe(400);
    expect(deferred).toBe(0);
    expect(await evidenceOf(id)).toBeNull();
  });

  it('204s with no body and defers the UPDATE to waitUntil', async () => {
    const id = await seedRow();
    const { res, deferred } = await evidencePost({ cf_ray: RAY, evidence: 'ran' });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(deferred).toBe(1);
    expect(await evidenceOf(id)).toBe('ran');
  });

  it('upgrades a NULL arrival row to ran, with the server time', async () => {
    const id = await seedRow();
    const before = Date.now();

    await evidencePost({ cf_ray: RAY, evidence: 'ran' });

    const row = await rowOf(id);
    expect(row.browserEvidence).toBe('ran');
    expect(Date.parse(row.browserEvidenceAt!)).toBeGreaterThanOrEqual(before);
    expect(evidenceTags()).toEqual([['evidence:ran', 'result:updated']]);
  });

  it('upgrades a ran arrival row to interacted', async () => {
    const id = await seedRow({
      browserEvidence: 'ran',
      browserEvidenceAt: '2026-11-13T00:00:00.000Z',
    });

    await evidencePost({ cf_ray: RAY, evidence: 'interacted' });

    const row = await rowOf(id);
    expect(row.browserEvidence).toBe('interacted');
    expect(row.browserEvidenceAt).not.toBe('2026-11-13T00:00:00.000Z');
    expect(evidenceTags()).toEqual([['evidence:interacted', 'result:updated']]);
  });

  it('upgrades a NULL arrival row straight to interacted when the ran post was lost', async () => {
    const id = await seedRow();
    await evidencePost({ cf_ray: RAY, evidence: 'interacted' });
    expect(await evidenceOf(id)).toBe('interacted');
  });

  it('upgrades an in-app row, written with ran, to interacted on its own ray', async () => {
    await beacon({ route: '/products/procore', navigation: 'spa' });
    const [spa] = await t.db.select().from(pageViews);

    await evidencePost({ cf_ray: RAY, evidence: 'interacted' });

    expect(await evidenceOf(spa!.id)).toBe('interacted');
    expect(evidenceTags()).toEqual([['evidence:interacted', 'result:updated']]);
  });

  it('never downgrades: ran on an interacted row changes nothing', async () => {
    const at = '2026-11-13T00:00:00.000Z';
    const id = await seedRow({ browserEvidence: 'interacted', browserEvidenceAt: at });
    const wait = vi.fn(async () => {});

    await evidencePost({ cf_ray: RAY, evidence: 'ran' }, { wait });

    const row = await rowOf(id);
    expect(row.browserEvidence).toBe('interacted');
    expect(row.browserEvidenceAt).toBe(at);
    expect(evidenceTags()).toEqual([['evidence:ran', 'result:no_match']]);
  });

  it('a replayed ran changes nothing, not even the timestamp', async () => {
    const at = '2026-11-13T00:00:00.000Z';
    const id = await seedRow({ browserEvidence: 'ran', browserEvidenceAt: at });

    await evidencePost({ cf_ray: RAY, evidence: 'ran' });

    expect((await rowOf(id)).browserEvidenceAt).toBe(at);
    expect(evidenceTags()).toEqual([['evidence:ran', 'result:no_match']]);
  });

  it('a replayed interacted changes nothing and does not retry', async () => {
    const at = '2026-11-13T00:00:00.000Z';
    const id = await seedRow({ browserEvidence: 'interacted', browserEvidenceAt: at });
    const wait = vi.fn(async () => {});

    await evidencePost({ cf_ray: RAY, evidence: 'interacted' }, { wait });

    const row = await rowOf(id);
    expect(row.browserEvidence).toBe('interacted');
    expect(row.browserEvidenceAt).toBe(at);
    expect(wait).not.toHaveBeenCalled();
    expect(evidenceTags()).toEqual([['evidence:interacted', 'result:no_match']]);
  });

  it.each([
    ['a held EU country', 'DE'],
    ['a held EU country in lower case', 'de'],
    ['the UK', 'GB'],
    ['Norway', 'NO'],
    ['an EU territory', 'RE'],
    ['an unknown location', 'XX'],
    ['no country', null],
  ])('never marks a row from %s, for either word', async (_label, cfCountry) => {
    const arrival = await seedRow({ cfCountry });
    const spa = await seedRow({
      cfCountry,
      cfRay: OTHER_RAY,
      writerProvenance: 'browser-spa',
    });

    await evidencePost({ cf_ray: RAY, evidence: 'ran' });
    await evidencePost({ cf_ray: RAY, evidence: 'interacted' });
    await evidencePost({ cf_ray: OTHER_RAY, evidence: 'interacted' });

    expect(await evidenceOf(arrival)).toBeNull();
    expect(await evidenceOf(spa)).toBeNull();
    expect((await rowOf(arrival)).browserEvidenceAt).toBeNull();
  });

  it('never touches a privacy row, an old row, another ray or a row of no known writer', async () => {
    const privacy = await seedRow({ privacySignal: true });
    const old = await seedRow({
      createdAt: new Date(Date.now() - BROWSER_EVIDENCE_WINDOW_MS - 60_000).toISOString(),
    });
    const otherRay = await seedRow({ cfRay: OTHER_RAY });
    const noWriter = await seedRow({ writerProvenance: null });
    const unknownWriter = await seedRow({ writerProvenance: 'something-else' });

    await evidencePost({ cf_ray: RAY, evidence: 'interacted' });

    for (const id of [privacy, old, otherRay, noWriter, unknownWriter]) {
      expect(await evidenceOf(id)).toBeNull();
    }
    expect(evidenceTags()).toEqual([['evidence:interacted', 'result:no_match']]);
  });

  it('retries a ran report once after 2 s when no row matches, then counts no_match', async () => {
    const wait = vi.fn(async () => {});

    const { res } = await evidencePost({ cf_ray: RAY, evidence: 'ran' }, { wait });

    expect(res.status).toBe(204);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(BROWSER_EVIDENCE_RETRY_MS);
    expect(BROWSER_EVIDENCE_RETRY_MS).toBe(2_000);
    expect(evidenceTags()).toEqual([['evidence:ran', 'result:no_match']]);
  });

  it('lands a ran report on the retry when the arrival write commits during the wait', async () => {
    let id = 0;
    const wait = vi.fn(async () => {
      id = await seedRow();
    });

    await evidencePost({ cf_ray: RAY, evidence: 'ran' }, { wait });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(await evidenceOf(id)).toBe('ran');
    expect(evidenceTags()).toEqual([['evidence:ran', 'result:updated']]);
  });

  it('never retries an interacted report', async () => {
    const wait = vi.fn(async () => {});
    await evidencePost({ cf_ray: RAY, evidence: 'interacted' }, { wait });
    expect(wait).not.toHaveBeenCalled();
    expect(evidenceTags()).toEqual([['evidence:interacted', 'result:no_match']]);
  });

  it('answers the same 204 whether or not a row matched', async () => {
    const miss = await evidencePost({ cf_ray: OTHER_RAY, evidence: 'interacted' });
    await seedRow();
    const hit = await evidencePost({ cf_ray: RAY, evidence: 'interacted' });

    expect(miss.res.status).toBe(204);
    expect(hit.res.status).toBe(204);
    expect(headersOf(miss.res)).toEqual(headersOf(hit.res));
    expect(await miss.res.text()).toBe(await hit.res.text());
  });

  it('counts a D1 failure as result:error, warns, and never throws', async () => {
    const { res } = await evidencePost(
      { cf_ray: RAY, evidence: 'ran' },
      {
        dbFor: () => {
          throw new Error('d1 down');
        },
      },
    );

    expect(res.status).toBe(204);
    expect(evidenceTags()).toEqual([['evidence:ran', 'result:error']]);
    const warns = vi.mocked(logToPosthog).mock.calls.map((call) => call[3]);
    expect(warns).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'aeci.api.page_view.browser_evidence_update_failed',
        source: 'page-views',
        reason: 'd1 down',
      }),
    ]);
  });
});
