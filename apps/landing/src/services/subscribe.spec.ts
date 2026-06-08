import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../types';
import { subscribe } from './subscribe';

type CfProps = Record<string, unknown>;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {} as Fetcher,
    ANALYTICS: {} as AnalyticsEngineDataset,
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_PUBLISHABLE_KEY: 'anon-key',
    // Resend deliberately left unconfigured: the notification path no-ops so
    // tests assert the subscribe contract without a second mocked endpoint.
    RESEND_API_KEY: '',
    NOTIFICATION_FROM: '',
    NOTIFICATION_TO: '',
    ...overrides,
  };
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/subscribe', subscribe);
  return app;
}

function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}

function post(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  body: unknown,
  opts: { cf?: CfProps; headers?: Record<string, string>; url?: string } = {},
) {
  const url = opts.url ?? 'https://www.aecintegrations.com/api/subscribe';
  const req = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify(body),
  });
  (req as unknown as { cf: CfProps }).cf = opts.cf ?? {};
  return app.request(req, undefined, env, fakeExecutionContext());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subscribe', () => {
  it('rejects a missing email with 400 and does not call Supabase', async () => {
    // Guards: validation runs before any network call — a junk request never
    // touches the database.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await post(buildApp(), makeEnv(), {});

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A valid email address is required.' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed email with 400', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await post(buildApp(), makeEnv(), { email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes the email (trim + lowercase) and maps cf geo + UTM into the row', async () => {
    // Guards: the Supabase row shape — normalized email plus the geo/UTM columns
    // sourced from request.cf and the query string. The numeric asn/metro_code
    // coercion matters: Supabase columns are typed.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    const res = await post(
      buildApp(),
      makeEnv(),
      { email: '  Casey@Example.COM ' },
      {
        url: 'https://www.aecintegrations.com/api/subscribe?utm_source=reddit&utm_medium=social&utm_campaign=launch',
        headers: { referer: 'https://news.ycombinator.com/' },
        cf: {
          country: 'US',
          city: 'Austin',
          region: 'Texas',
          timezone: 'America/Chicago',
          asOrganization: 'Comcast',
          asn: 7922,
          metroCode: 635,
        },
      },
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://supabase.test/rest/v1/mailing_list');
    expect((init.headers as Record<string, string>).apikey).toBe('anon-key');
    const row = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(row.email).toBe('casey@example.com');
    expect(row.country).toBe('US');
    expect(row.city).toBe('Austin');
    expect(row.as_organization).toBe('Comcast');
    expect(row.asn).toBe(7922);
    expect(row.metro_code).toBe(635);
    expect(row.utm_source).toBe('reddit');
    expect(row.utm_medium).toBe('social');
    expect(row.utm_campaign).toBe('launch');
    expect(row.referrer).toBe('https://news.ycombinator.com/');
  });

  it('nulls geo/UTM columns when cf and query string are empty', async () => {
    // Guards: a direct signup with no edge metadata yields explicit nulls, not
    // undefined — so the JSON body stays well-formed for PostgREST.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await post(buildApp(), makeEnv(), { email: 'a@b.co' });

    const row = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(row.country).toBeNull();
    expect(row.asn).toBeNull();
    expect(row.metro_code).toBeNull();
    expect(row.utm_source).toBeNull();
    expect(row.referrer).toBeNull();
  });

  it('returns 409 when Supabase reports an HTTP 409 conflict', async () => {
    // Guards: the "already on the list" UX — a duplicate must be a friendly 409,
    // not a generic 500.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('conflict', { status: 409 }));

    const res = await post(buildApp(), makeEnv(), { email: 'dup@example.com' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This email is already on the list.' });
  });

  it('returns 409 when a non-409 response body mentions a unique/duplicate violation', async () => {
    // Guards: PostgREST sometimes returns 400/500 with a "duplicate key ...
    // unique constraint" body rather than 409 — that still means "already on
    // the list", so the body sniff must catch it.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('duplicate key value violates unique constraint', { status: 400 }),
    );

    const res = await post(buildApp(), makeEnv(), { email: 'dup@example.com' });
    expect(res.status).toBe(409);
  });

  it('returns 500 on an unexpected Supabase error', async () => {
    // Guards: a genuine server failure surfaces as a generic 500 with the
    // retry-friendly message (and is logged for ops).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(buildApp(), makeEnv(), { email: 'x@example.com' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong. Please try again.' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('schedules the admin notification via ctx.waitUntil on success', async () => {
    // Guards: the signup notification is fire-and-forget through waitUntil so it
    // never blocks the 201 — but it must actually be scheduled.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const ctx = fakeExecutionContext();

    const req = new Request('https://www.aecintegrations.com/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    });
    (req as unknown as { cf: CfProps }).cf = {};
    await buildApp().request(req, undefined, makeEnv(), ctx);

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });
});
