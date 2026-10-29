/**
 * Turnstile capture (AECI-1457), against the in-memory D1 harness.
 *
 * Two paths. An in-app (`browser-spa`) beacon carries a token, which is verified
 * before the insert and stored on the row. A landing view's row is written by the
 * SSR gateway with no token, and its verdict arrives later on
 * `POST /api/page-views/turnstile`, matched on `cf_ray`.
 *
 * Siteverify is the global `fetch`, stubbed. `submitCount` is mocked so the
 * `aeci.pageviews.turnstile` tags can be asserted.
 */

import {
  PAGE_VIEW_WRITER_HEADER,
  type RawPageViewEnvelope,
  type TurnstileVerdict,
} from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { pageViews } from '../db/schema';
import type { Env } from '../env';
import { SITEVERIFY_URL } from '../lib/turnstile';
import { submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, TEST_ENV } from '../test/helpers';
import {
  TURNSTILE_VERDICT_RETRY_MS,
  createPageViewsHandler,
  createTurnstileVerdictHandler,
} from './page-views';

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SECRET = { TURNSTILE_SECRET_KEY: 'test-secret' };
const RAY = '8c1a2b3c4d5e6f70-IAD';
const TOKEN = '0.single-use-token';
const SPA = { route: '/products/procore', navigation: 'spa' as const };

let t: TestDb;
let fetchSpy: MockInstance<typeof fetch>;

beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(submitCount).mockClear();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  siteverifyAnswers({ success: true });
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

/** Every siteverify call answers `body`. */
function siteverifyAnswers(body: Record<string, unknown>) {
  fetchSpy.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
}

function siteverifyCalls() {
  return fetchSpy.mock.calls.filter(([url]) => url === SITEVERIFY_URL);
}

function turnstileTags(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.pageviews.turnstile')
    .map((call) => call[5] as string[]);
}

function writeTags(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.pageviews.write')
    .map((call) => call[5] as string[]);
}

function settlingCtx() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(promises) };
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
        ...opts.headers,
      },
    },
    { ...TEST_ENV, ...opts.env },
    ctx,
  );
  await settle();
  return res;
}

async function verdictPost(
  body: unknown,
  opts: { env?: Partial<Env>; wait?: (ms: number) => Promise<void> } = {},
) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/page-views/turnstile',
    handler: createTurnstileVerdictHandler(t.factory, { wait: opts.wait ?? (async () => {}) }),
  });
  const { ctx, settle } = settlingCtx();
  const res = await app.request(
    '/api/page-views/turnstile',
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    },
    { ...TEST_ENV, ...SECRET, ...opts.env },
    ctx,
  );
  await settle();
  return res;
}

async function onlyRow() {
  const rows = await t.db.select().from(pageViews);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('POST /api/page-views — Turnstile on an in-app beacon (AECI-1457)', () => {
  it('verifies the token before the insert and stores the verdict', async () => {
    const res = await beacon({ ...SPA, turnstile_token: TOKEN }, { env: SECRET });
    expect(res.status).toBe(204);

    expect((await onlyRow()).turnstileVerdict).toBe('pass');
    const calls = siteverifyCalls();
    expect(calls).toHaveLength(1);
    const form = calls[0]![1]!.body as URLSearchParams;
    expect(form.get('response')).toBe(TOKEN);
    expect(form.get('remoteip')).toBe('203.0.113.9');
    expect(form.has('cdata')).toBe(false);
    expect(turnstileTags()).toEqual([['verdict:pass', 'writer:spa']]);
  });

  it.each([
    [{ success: false, 'error-codes': ['invalid-input-response'] }, 'fail'],
    [{ success: false, 'error-codes': ['timeout-or-duplicate'] }, 'unknown'],
  ] as const)('stores siteverify answer %j as %s', async (answer, verdict) => {
    siteverifyAnswers(answer);
    await beacon({ ...SPA, turnstile_token: TOKEN }, { env: SECRET });
    expect((await onlyRow()).turnstileVerdict).toBe(verdict);
    expect(turnstileTags()).toEqual([[`verdict:${verdict}`, 'writer:spa']]);
  });

  it('still writes the row when siteverify fails outright, as unknown', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    await beacon({ ...SPA, turnstile_token: TOKEN }, { env: SECRET });

    const row = await onlyRow();
    expect(row.turnstileVerdict).toBe('unknown');
    expect(row.path).toBe('/products/procore');
    expect(writeTags()).toEqual([['outcome:ok', 'bot:false', 'privacy:false']]);
  });

  it('stores null and counts verdict:absent when the secret is set but no token came', async () => {
    await beacon(SPA, { env: SECRET });

    expect((await onlyRow()).turnstileVerdict).toBeNull();
    expect(siteverifyCalls()).toHaveLength(0);
    expect(turnstileTags()).toEqual([['verdict:absent', 'writer:spa']]);
  });

  it('is dark without a secret: null verdict, no fetch, no metric', async () => {
    await beacon({ ...SPA, turnstile_token: TOKEN });

    expect((await onlyRow()).turnstileVerdict).toBeNull();
    expect(siteverifyCalls()).toHaveLength(0);
    expect(turnstileTags()).toEqual([]);
  });

  it('never checks a privacy-signal request: null verdict, no fetch, no metric', async () => {
    await beacon({ ...SPA, turnstile_token: TOKEN }, { env: SECRET, headers: { dnt: '1' } });

    const row = await onlyRow();
    expect(row.privacySignal).toBe(true);
    expect(row.turnstileVerdict).toBeNull();
    expect(siteverifyCalls()).toHaveLength(0);
    expect(turnstileTags()).toEqual([]);
  });

  it('ignores a token on an ssr-arrival write', async () => {
    await beacon(
      { route: '/', navigation: 'arrival', turnstile_token: TOKEN },
      { env: SECRET, writer: 'ssr-arrival' },
    );

    expect((await onlyRow()).turnstileVerdict).toBeNull();
    expect(siteverifyCalls()).toHaveLength(0);
    expect(turnstileTags()).toEqual([]);
  });

  it('spends no siteverify call on a deduped capture', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await beacon({ ...SPA, turnstile_token: TOKEN }, { env: SECRET });
    await beacon({ ...SPA, turnstile_token: 'another' }, { env: SECRET });

    expect(await t.db.select().from(pageViews)).toHaveLength(1);
    expect(siteverifyCalls()).toHaveLength(1);
  });

  it('keeps the token out of the raw envelope and puts the verdict in derived', async () => {
    const sent: RawPageViewEnvelope[] = [];
    const stream = {
      send: vi.fn(async (records: Record<string, unknown>[]) => {
        for (const r of records) sent.push(r['value'] as RawPageViewEnvelope);
      }),
    } as unknown as NonNullable<Env['PAGE_VIEW_RAW']>;

    await beacon({ ...SPA, turnstile_token: TOKEN }, { env: { ...SECRET, PAGE_VIEW_RAW: stream } });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual(SPA);
    expect(sent[0]!.derived.turnstile_verdict).toBe('pass');
    expect(JSON.stringify(sent[0])).not.toContain(TOKEN);
  });
});

describe('POST /api/page-views/turnstile — a landing view verdict (AECI-1457)', () => {
  /** Insert a row directly, defaulting to a fresh arrival with RAY. */
  async function seedRow(overrides: Partial<typeof pageViews.$inferInsert> = {}): Promise<number> {
    const [row] = await t.db
      .insert(pageViews)
      .values({
        path: '/',
        cfRay: RAY,
        writerProvenance: 'ssr-arrival',
        privacySignal: false,
        createdAt: new Date().toISOString(),
        ...overrides,
      })
      .returning({ id: pageViews.id });
    return row!.id;
  }

  async function verdictOf(id: number): Promise<TurnstileVerdict | null> {
    const rows = await t.db.select().from(pageViews);
    return (rows.find((r) => r.id === id)?.turnstileVerdict ?? null) as TurnstileVerdict | null;
  }

  it('400s a body that is not JSON', async () => {
    const res = await verdictPost('not json');
    expect(res.status).toBe(400);
    expect(siteverifyCalls()).toHaveLength(0);
  });

  it.each([
    ['a bad ray', { cf_ray: 'nope', token: TOKEN }],
    ['no token', { cf_ray: RAY }],
    ['an empty token', { cf_ray: RAY, token: '' }],
  ])('400s %s', async (_label, body) => {
    const res = await verdictPost(body);
    expect(res.status).toBe(400);
    expect(siteverifyCalls()).toHaveLength(0);
  });

  it('204s, verifies with the ray as cdata, and updates the arrival row', async () => {
    siteverifyAnswers({ success: true, cdata: RAY });
    const id = await seedRow();

    const res = await verdictPost({ cf_ray: RAY, token: TOKEN });

    expect(res.status).toBe(204);
    expect(await verdictOf(id)).toBe('pass');
    expect(siteverifyCalls()).toHaveLength(1);
    expect(turnstileTags()).toEqual([['verdict:pass', 'writer:arrival', 'outcome:updated']]);
  });

  it('stores fail when the token was minted for another ray', async () => {
    siteverifyAnswers({ success: true, cdata: '0000000000000000-LHR' });
    const id = await seedRow();

    await verdictPost({ cf_ray: RAY, token: TOKEN });

    expect(await verdictOf(id)).toBe('fail');
    expect(turnstileTags()).toEqual([['verdict:fail', 'writer:arrival', 'outcome:updated']]);
  });

  it('stores unknown, never fail, when siteverify echoes no cdata', async () => {
    siteverifyAnswers({ success: true });
    const id = await seedRow();

    await verdictPost({ cf_ray: RAY, token: TOKEN });

    expect(await verdictOf(id)).toBe('unknown');
    expect(turnstileTags()).toEqual([['verdict:unknown', 'writer:arrival', 'outcome:updated']]);
  });

  it('retries once after 2 s when no row matches, then counts no_row', async () => {
    siteverifyAnswers({ success: true, cdata: RAY });
    const wait = vi.fn(async () => {});

    const res = await verdictPost({ cf_ray: RAY, token: TOKEN }, { wait });

    expect(res.status).toBe(204);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(TURNSTILE_VERDICT_RETRY_MS);
    expect(turnstileTags()).toEqual([['verdict:pass', 'writer:arrival', 'outcome:no_row']]);
  });

  it('lands on the retry when the arrival write commits during the wait', async () => {
    siteverifyAnswers({ success: true, cdata: RAY });
    let id = 0;
    const wait = vi.fn(async () => {
      id = await seedRow();
    });

    await verdictPost({ cf_ray: RAY, token: TOKEN }, { wait });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(await verdictOf(id)).toBe('pass');
    expect(turnstileTags()).toEqual([['verdict:pass', 'writer:arrival', 'outcome:updated']]);
  });

  it('never touches a privacy row, an in-app row, an old row or one already judged', async () => {
    siteverifyAnswers({ success: true, cdata: RAY });
    const privacy = await seedRow({ privacySignal: true });
    const spa = await seedRow({ writerProvenance: 'browser-spa' });
    const old = await seedRow({ createdAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    const judged = await seedRow({ turnstileVerdict: 'fail' });
    const otherRay = await seedRow({ cfRay: '0000000000000000-LHR' });

    await verdictPost({ cf_ray: RAY, token: TOKEN });

    expect(await verdictOf(privacy)).toBeNull();
    expect(await verdictOf(spa)).toBeNull();
    expect(await verdictOf(old)).toBeNull();
    expect(await verdictOf(judged)).toBe('fail');
    expect(await verdictOf(otherRay)).toBeNull();
    expect(turnstileTags()).toEqual([['verdict:pass', 'writer:arrival', 'outcome:no_row']]);
  });

  it('does nothing without a secret: no fetch, no write, no metric', async () => {
    const id = await seedRow();
    const wait = vi.fn(async () => {});

    const res = await verdictPost(
      { cf_ray: RAY, token: TOKEN },
      { env: { TURNSTILE_SECRET_KEY: undefined }, wait },
    );

    expect(res.status).toBe(204);
    expect(siteverifyCalls()).toHaveLength(0);
    expect(wait).not.toHaveBeenCalled();
    expect(await verdictOf(id)).toBeNull();
    expect(turnstileTags()).toEqual([]);
  });

  it('counts a D1 failure as outcome:failed and never throws', async () => {
    siteverifyAnswers({ success: true, cdata: RAY });
    const app = buildAppWithHandler({
      method: 'post',
      path: '/api/page-views/turnstile',
      handler: createTurnstileVerdictHandler(() => {
        throw new Error('d1 down');
      }),
    });
    const { ctx, settle } = settlingCtx();
    const res = await app.request(
      '/api/page-views/turnstile',
      { method: 'POST', body: JSON.stringify({ cf_ray: RAY, token: TOKEN }) },
      { ...TEST_ENV, ...SECRET },
      ctx,
    );
    await settle();

    expect(res.status).toBe(204);
    expect(turnstileTags()).toEqual([['verdict:pass', 'writer:arrival', 'outcome:failed']]);
  });
});
