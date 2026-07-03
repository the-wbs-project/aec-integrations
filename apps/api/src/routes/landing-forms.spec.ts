/**
 * POST /api/feedback + POST /api/subscribe on the Drizzle/D1 path
 * (ADR 0016 / AECI-257), against the in-memory D1 harness. The landing
 * lead-capture forms, moved off Supabase Postgres onto D1. Inserts are awaited
 * synchronously (the landing Worker needs the `{ created }` result to shape its
 * response), so no settling context is required.
 */

import { LANDING_CF_HEADERS } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bookmarkMiddleware } from '../bookmark-middleware';
import { feedback, mailingList } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, recordingFactory, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createFeedbackHandler, createSubscribeHandler } from './landing-forms';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function postFeedback(body: unknown, extraHeaders: Record<string, string> = {}) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/feedback',
    handler: createFeedbackHandler(t.factory),
  });
  return app.request(
    '/api/feedback',
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...extraHeaders },
    },
    TEST_ENV,
    fakeExecutionContext(),
  );
}

function postSubscribe(body: unknown, extraHeaders: Record<string, string> = {}) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/subscribe',
    handler: createSubscribeHandler(t.factory),
  });
  return app.request(
    '/api/subscribe',
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...extraHeaders },
    },
    TEST_ENV,
    fakeExecutionContext(),
  );
}

describe('POST /api/feedback', () => {
  it('inserts a feedback row and returns 201 { created: true }', async () => {
    const res = await postFeedback({
      features: 'Bidirectional Revit ↔ IFC sync',
      tools: 'Revit, Navisworks',
      email: 'Aec@Example.com',
      subscribed: true,
      country: 'US',
      city: 'Denver',
      region: 'Colorado',
      timezone: 'America/Denver',
      referrer: 'https://news.ycombinator.com/',
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { created: boolean }).toEqual({ created: true });

    const rows = await t.db.select().from(feedback);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.features).toBe('Bidirectional Revit ↔ IFC sync');
    expect(rows[0]!.tools).toBe('Revit, Navisworks');
    expect(rows[0]!.email).toBe('Aec@Example.com');
    expect(rows[0]!.subscribed).toBe(true);
    expect(rows[0]!.country).toBe('US');
    expect(rows[0]!.city).toBe('Denver');
  });

  it('accepts a suggestion with no email (subscribed defaults to false)', async () => {
    const res = await postFeedback({ tools: 'AutoCAD' });
    expect(res.status).toBe(201);

    const rows = await t.db.select().from(feedback);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBeNull();
    expect(rows[0]!.subscribed).toBe(false);
  });

  it('400s when neither features nor tools is provided, and inserts nothing', async () => {
    const res = await postFeedback({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(await t.db.select().from(feedback)).toHaveLength(0);
  });

  it('400s a malformed body', async () => {
    const res = await postFeedback('not json');
    expect(res.status).toBe(400);
    expect(await t.db.select().from(feedback)).toHaveLength(0);
  });
});

describe('POST /api/subscribe', () => {
  it('inserts a mailing_list row and returns 201 { created: true }', async () => {
    const res = await postSubscribe({
      email: 'sub@example.com',
      country: 'US',
      utm_source: 'twitter',
      asn: 13335,
      metro_code: 751,
      as_organization: 'Cloudflare',
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { created: boolean }).toEqual({ created: true });

    const rows = await t.db.select().from(mailingList);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('sub@example.com');
    expect(rows[0]!.utmSource).toBe('twitter');
    expect(rows[0]!.asn).toBe(13335);
    expect(rows[0]!.metroCode).toBe(751);
    expect(rows[0]!.asOrganization).toBe('Cloudflare');
  });

  it('is idempotent on email: a duplicate returns 200 { created: false } and inserts no second row', async () => {
    await postSubscribe({ email: 'dupe@example.com' });
    const second = await postSubscribe({ email: 'dupe@example.com' });

    expect(second.status).toBe(200);
    expect((await second.json()) as { created: boolean }).toEqual({ created: false });
    expect(await t.db.select().from(mailingList)).toHaveLength(1);
  });

  it('400s an invalid email and inserts nothing', async () => {
    const res = await postSubscribe({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(await t.db.select().from(mailingList)).toHaveLength(0);
  });

  // AECI-250 — subscribe is the single-insert write shape: it anchors first-primary
  // + emits the bookmark (feedback/page-views deliberately don't — see handlers).
  it('threads first-primary into getDb and emits x-d1-bookmark', async () => {
    const rec = recordingFactory(t.db);
    rec.setBookmark('bk-sub');
    const env = { ...TEST_ENV } as Env;

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', bookmarkMiddleware());
    app.post('/api/subscribe', createSubscribeHandler(rec.factory));

    const res = await app.request(
      '/api/subscribe',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'ryw@example.com' }),
        headers: { 'content-type': 'application/json', 'x-d1-bookmark': 'in-7' },
      },
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(201);
    expect(rec.calls[0]).toEqual({ bookmark: 'in-7', constraint: 'first-primary' });
    expect(res.headers.get('x-d1-bookmark')).toBe('bk-sub');
    expect(await t.db.select().from(mailingList)).toHaveLength(1);
  });
});

// AECI-275 — the unified home's closing-CTA island POSTs through the SSR `/api/*`
// proxy, which forwards CF geo on the trusted `LANDING_CF_HEADERS` (the browser
// can't read `request.cf`). The handlers read a header when present and fall back
// to the body value otherwise, so BOTH callers work: the legacy landing Worker
// (geo in body, no headers) and the app island (geo on headers, none in body).
describe('AECI-275 trusted geo headers + app-origin', () => {
  it('subscribe: reads all geo from LANDING_CF_HEADERS when the body omits it', async () => {
    const res = await postSubscribe(
      { email: 'island@example.com', utm_source: 'home' },
      {
        [LANDING_CF_HEADERS.country]: 'GB',
        [LANDING_CF_HEADERS.city]: 'London',
        [LANDING_CF_HEADERS.region]: 'England',
        [LANDING_CF_HEADERS.timezone]: 'Europe/London',
        [LANDING_CF_HEADERS.asOrganization]: 'BT',
        [LANDING_CF_HEADERS.asn]: '2856',
        [LANDING_CF_HEADERS.metroCode]: '826',
      },
    );
    expect(res.status).toBe(201);

    const [row] = await t.db.select().from(mailingList);
    expect(row!.country).toBe('GB');
    expect(row!.city).toBe('London');
    expect(row!.region).toBe('England');
    expect(row!.timezone).toBe('Europe/London');
    expect(row!.asOrganization).toBe('BT');
    expect(row!.asn).toBe(2856);
    expect(row!.metroCode).toBe(826);
    // UTM still rides the body, untouched by the header path.
    expect(row!.utmSource).toBe('home');
  });

  it('subscribe: a trusted header wins over a body geo value (header precedence)', async () => {
    const res = await postSubscribe(
      { email: 'precedence@example.com', country: 'US', city: 'Denver' },
      { [LANDING_CF_HEADERS.country]: 'GB', [LANDING_CF_HEADERS.city]: 'London' },
    );
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(mailingList);
    expect(row!.country).toBe('GB');
    expect(row!.city).toBe('London');
  });

  it('subscribe: a malformed asn/metro header degrades to null, never NaN', async () => {
    const res = await postSubscribe(
      { email: 'nan@example.com' },
      { [LANDING_CF_HEADERS.asn]: 'not-a-number', [LANDING_CF_HEADERS.metroCode]: '' },
    );
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(mailingList);
    expect(row!.asn).toBeNull();
    expect(row!.metroCode).toBeNull();
  });

  it('feedback: reads its geo subset from headers (no asn/metro columns)', async () => {
    const res = await postFeedback(
      { tools: 'Revit' },
      {
        [LANDING_CF_HEADERS.country]: 'CA',
        [LANDING_CF_HEADERS.city]: 'Toronto',
        [LANDING_CF_HEADERS.region]: 'Ontario',
        [LANDING_CF_HEADERS.timezone]: 'America/Toronto',
      },
    );
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(feedback);
    expect(row!.country).toBe('CA');
    expect(row!.city).toBe('Toronto');
    expect(row!.region).toBe('Ontario');
    expect(row!.timezone).toBe('America/Toronto');
  });

  // The handlers have no CORS / Origin guard — they were built for the landing
  // Worker but are reached over the service binding from BOTH the landing and the
  // SSR (app) Worker. A request carrying the app origin is accepted unchanged.
  it('accepts a request carrying the app origin (no origin guard)', async () => {
    const res = await postSubscribe(
      { email: 'app-origin@example.com' },
      { origin: 'https://aec-integrations.com' },
    );
    expect(res.status).toBe(201);
    expect(await t.db.select().from(mailingList)).toHaveLength(1);
  });
});
