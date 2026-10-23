/**
 * The raw page-view store (AECI-1384, ADR 0041): every capture that reaches
 * `capturePageView` sends exactly one envelope to `PAGE_VIEW_RAW`, whatever the D1
 * outcome, and the raw write can never change that outcome. A capture with a
 * privacy signal sends none, on any outcome (AECI-1386).
 */

import {
  PAGE_VIEW_RAW_HEADERS,
  PAGE_VIEW_WRITER_HEADER,
  encodeCfRaw,
  type RawPageViewEnvelope,
} from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pageViews } from '../db/schema';
import type { Env } from '../env';
import type { DbFactory } from '../lib/handler-utils';
import { submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, TEST_ENV } from '../test/helpers';
import { createPageViewsHandler } from './page-views';

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const IP = '203.0.113.9';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(submitCount).mockClear();
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

function fakeStream(impl?: () => Promise<void>) {
  const sent: RawPageViewEnvelope[] = [];
  const send = vi.fn(async (records: Record<string, unknown>[]) => {
    // Every record must carry the envelope under `value`, the schema-less
    // stream's one required field; a bare envelope would be dropped.
    for (const record of records) {
      expect(Object.keys(record)).toEqual(['value']);
      sent.push(record['value'] as RawPageViewEnvelope);
    }
    if (impl) await impl();
  });
  return { stream: { send } as unknown as NonNullable<Env['PAGE_VIEW_RAW']>, send, sent };
}

function post(
  body: unknown,
  opts: { headers?: Record<string, string>; env?: Partial<Env>; factory?: DbFactory } = {},
) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/page-views',
    handler: createPageViewsHandler(opts.factory ?? t.factory),
  });
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = app.request(
    '/api/page-views',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'user-agent': CHROME_UA, ...opts.headers },
    },
    { ...TEST_ENV, ...opts.env },
    ctx,
  );
  return { res, settle: () => Promise.all(promises) };
}

function rawTags(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.pageviews.raw')
    .map((call) => call[5] as string[]);
}

const ARRIVAL = { route: '/products/:slug', path: '/products/leap-crm', navigation: 'arrival' };

describe('raw page-view store (AECI-1384)', () => {
  it('inserted: sends one envelope carrying the D1 row id and the full context', async () => {
    const { stream, send, sent } = fakeStream();
    const { res, settle } = post(ARRIVAL, {
      env: { PAGE_VIEW_RAW: stream, PAGE_VIEW_IP_HASH_SECRET: 's3cret', ENV: 'staging' },
      headers: {
        [PAGE_VIEW_WRITER_HEADER]: 'ssr-arrival',
        [PAGE_VIEW_RAW_HEADERS.cfRaw]: encodeCfRaw({ city: 'São Paulo', asn: 22773 }) as string,
        [PAGE_VIEW_RAW_HEADERS.eyeballUrl]:
          'https://www.aecintegrations.com/products/leap-crm?utm_source=x&token=t',
        [PAGE_VIEW_RAW_HEADERS.clientIp]: IP,
        'cf-connecting-ip': IP,
        cookie: 'sb-access-token=secret',
        authorization: 'Bearer secret',
        referer: 'https://www.google.com/',
      },
    });
    expect((await res).status).toBe(204);
    await settle();

    const [row] = await t.db.select().from(pageViews);
    expect(send).toHaveBeenCalledTimes(1);
    const envelope = sent[0]!;
    expect(envelope.outcome).toBe('inserted');
    expect(envelope.page_view_id).toBe(row!.id);
    expect(envelope.env).toBe('staging');
    expect(envelope.writer).toBe('ssr-arrival');
    expect(envelope.cf).toEqual({ city: 'São Paulo', asn: 22773 });
    expect(envelope.eyeball_url).toBe(
      'https://www.aecintegrations.com/products/leap-crm?utm_source=x',
    );
    expect(envelope.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.derived.user_agent_hash).toBe(row!.userAgentHash);
    expect(envelope.derived.referrer_source).toBe('Google');
    expect(envelope.derived.dedupe_keys?.current).toBe(row!.dedupeKey);
    expect(envelope.body).toEqual(ARRIVAL);

    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain(IP);
    expect(rawTags()).toEqual([['outcome:ok', 'ip_hash:present']]);
  });

  it('deduped: the second arrival in the window still sends an envelope, with no id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { stream, sent } = fakeStream();
    const first = post(ARRIVAL, { env: { PAGE_VIEW_RAW: stream } });
    await first.res;
    await first.settle();
    const second = post(ARRIVAL, { env: { PAGE_VIEW_RAW: stream } });
    await second.res;
    await second.settle();

    expect(await t.db.select().from(pageViews)).toHaveLength(1);
    expect(sent.map((e) => e.outcome)).toEqual(['inserted', 'deduped']);
    expect(sent[1]!.page_view_id).toBeNull();
    expect(sent[1]!.derived.dedupe_keys).not.toBeNull();
  });

  it('conflict: the insert hits the dedupe UNIQUE index after the probe passed; no id', async () => {
    // The real race is two inserts in flight from `waitUntil`, which the in-memory
    // harness cannot interleave. Reproduce its effect: a row with the same
    // `dedupe_key` commits between the probe and this capture's insert.
    const { stream, sent } = fakeStream();
    const racing: DbFactory = (env) => {
      const handle = t.factory(env);
      const db = new Proxy(handle.db, {
        get(target, prop, receiver) {
          if (prop !== 'insert') return Reflect.get(target, prop, receiver);
          return (table: typeof pageViews) => {
            const builder = target.insert(table);
            return {
              values(v: { dedupeKey: string | null }) {
                t.raw
                  .prepare('insert into page_views (path, created_at, dedupe_key) values (?, ?, ?)')
                  .run('/products/leap-crm', '2026-10-16T00:00:00.000Z', v.dedupeKey);
                return builder.values(v as never);
              },
            };
          };
        },
      });
      return { ...handle, db };
    };
    const { res, settle } = post(ARRIVAL, { env: { PAGE_VIEW_RAW: stream }, factory: racing });
    await res;
    await settle();

    expect(await t.db.select().from(pageViews)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.outcome).toBe('conflict');
    expect(sent[0]!.page_view_id).toBeNull();
  });

  it('sampled_out: below the bot-score floor, no row but one envelope', async () => {
    const { stream, sent } = fakeStream();
    const { res, settle } = post(ARRIVAL, {
      env: { PAGE_VIEW_RAW: stream, PAGE_VIEWS_MIN_BOT_SCORE: '30' },
      headers: { 'x-aeci-cf-bot-score': '5' },
    });
    await res;
    await settle();

    expect(await t.db.select().from(pageViews)).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.outcome).toBe('sampled_out');
    expect(sent[0]!.derived.locale).toBe('en-US');
    expect(sent[0]!.derived.user_agent_hash).toBeNull();
  });

  it('failed: a D1 error still sends an envelope with the message and what was derived', async () => {
    const { stream, sent } = fakeStream();
    const broken: DbFactory = () => {
      throw new Error('D1 unavailable');
    };
    const { res, settle } = post(ARRIVAL, { env: { PAGE_VIEW_RAW: stream }, factory: broken });
    expect((await res).status).toBe(204);
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.outcome).toBe('failed');
    expect(sent[0]!.outcome_detail).toBe('D1 unavailable');
    expect(sent[0]!.derived.user_agent_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binding absent: the D1 row is still written and the raw write counts as skipped', async () => {
    const { res, settle } = post(ARRIVAL);
    await res;
    await settle();

    expect(await t.db.select().from(pageViews)).toHaveLength(1);
    expect(rawTags()).toEqual([['outcome:skipped', 'ip_hash:no_secret']]);
  });

  it('send throws: the D1 outcome stands and the failure is counted', async () => {
    const { stream } = fakeStream(() => Promise.reject(new Error('stream down')));
    const { res, settle } = post(ARRIVAL, {
      env: { PAGE_VIEW_RAW: stream, PAGE_VIEW_IP_HASH_SECRET: 's3cret' },
    });
    expect((await res).status).toBe(204);
    await expect(settle()).resolves.toBeDefined();

    expect(await t.db.select().from(pageViews)).toHaveLength(1);
    expect(rawTags()).toEqual([['outcome:failed', 'ip_hash:no_ip']]);
    const writeTags = vi
      .mocked(submitCount)
      .mock.calls.filter((call) => call[3] === 'aeci.pageviews.write')
      .map((call) => call[5]);
    expect(writeTags).toEqual([['outcome:ok', 'bot:false', 'privacy:false']]);
  });
});

describe('raw page-view store: privacy signal (AECI-1386)', () => {
  const PRIVACY_HEADERS = {
    [PAGE_VIEW_WRITER_HEADER]: 'ssr-arrival',
    [PAGE_VIEW_RAW_HEADERS.cfRaw]: encodeCfRaw({ city: 'Lyon', asn: 3215 }) as string,
    [PAGE_VIEW_RAW_HEADERS.clientIp]: IP,
  };

  it.each([
    ['sec-gpc', '1'],
    ['dnt', '1'],
  ])('%s: %s writes the row but sends no envelope', async (name, value) => {
    const { stream, send } = fakeStream();
    const { res, settle } = post(ARRIVAL, {
      env: { PAGE_VIEW_RAW: stream, PAGE_VIEW_IP_HASH_SECRET: 's3cret' },
      headers: { ...PRIVACY_HEADERS, [name]: value },
    });
    expect((await res).status).toBe(204);
    await settle();

    expect(await t.db.select().from(pageViews)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    expect(rawTags()).toEqual([['outcome:privacy_signal']]);
  });

  it('failed: a D1 error on a privacy request still sends no envelope', async () => {
    const { stream, send } = fakeStream();
    const broken: DbFactory = () => {
      throw new Error('D1 unavailable');
    };
    const { res, settle } = post(ARRIVAL, {
      env: { PAGE_VIEW_RAW: stream },
      headers: { ...PRIVACY_HEADERS, 'sec-gpc': '1' },
      factory: broken,
    });
    expect((await res).status).toBe(204);
    await settle();

    expect(send).not.toHaveBeenCalled();
    expect(rawTags()).toEqual([['outcome:privacy_signal']]);
  });

  it('sampled_out: a privacy request below the floor sends no envelope', async () => {
    const { stream, send } = fakeStream();
    const { res, settle } = post(ARRIVAL, {
      env: { PAGE_VIEW_RAW: stream, PAGE_VIEWS_MIN_BOT_SCORE: '30' },
      headers: { ...PRIVACY_HEADERS, dnt: '1', 'x-aeci-cf-bot-score': '5' },
    });
    await res;
    await settle();

    expect(await t.db.select().from(pageViews)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(rawTags()).toEqual([['outcome:privacy_signal']]);
  });

  it('binding absent: a privacy request never counts as skipped', async () => {
    const { res, settle } = post(ARRIVAL, { headers: { 'sec-gpc': '1' } });
    await res;
    await settle();

    expect(rawTags()).toEqual([['outcome:privacy_signal']]);
  });
});
