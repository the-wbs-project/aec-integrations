import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../types';
import { feedback } from './feedback';

type CfProps = Record<string, unknown>;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {} as Fetcher,
    ANALYTICS: {} as AnalyticsEngineDataset,
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_PUBLISHABLE_KEY: 'anon-key',
    RESEND_API_KEY: '',
    NOTIFICATION_FROM: '',
    NOTIFICATION_TO: '',
    ...overrides,
  };
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/feedback', feedback);
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
  const url = opts.url ?? 'https://www.aecintegrations.com/api/feedback';
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

describe('feedback', () => {
  it('rejects when neither features nor tools is provided', async () => {
    // Guards: empty feedback is meaningless — reject before any DB write, even
    // if an email was supplied.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await post(buildApp(), makeEnv(), { email: 'a@b.co' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Please share at least one suggestion.' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats whitespace-only fields as empty', async () => {
    // Guards: the `.trim() || null` collapse — "   " is not a suggestion.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await post(buildApp(), makeEnv(), { features: '   ', tools: '\n\t' });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed email even when a suggestion is present', async () => {
    // Guards: email is optional, but if present it must be valid — order of
    // checks matters (suggestion first, then email).
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await post(buildApp(), makeEnv(), { features: 'dark mode', email: 'nope' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Please enter a valid email address.' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts anonymous feedback (no email) and writes the feedback row', async () => {
    // Guards: anonymous path — email null, subscribed false, suggestion stored.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    const res = await post(buildApp(), makeEnv(), { tools: 'Revit, Bluebeam' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const row = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(fetchSpy.mock.calls[0][0]).toBe('https://supabase.test/rest/v1/feedback');
    expect(row.features).toBeNull();
    expect(row.tools).toBe('Revit, Bluebeam');
    expect(row.email).toBeNull();
    expect(row.subscribed).toBe(false);
  });

  it('returns 500 and logs when the feedback insert fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(buildApp(), makeEnv(), { features: 'sso' });
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('also writes to the mailing list when subscribe=true and an email is given', async () => {
    // Guards: the opt-in dual-write — first the feedback row, then a best-effort
    // mailing_list insert with the normalized email and geo/UTM columns.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    const res = await post(
      buildApp(),
      makeEnv(),
      { features: 'sso', email: ' Casey@Example.com ', subscribe: true },
      { cf: { country: 'US' } },
    );

    expect(res.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://supabase.test/rest/v1/feedback');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://supabase.test/rest/v1/mailing_list');
    const subRow = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(subRow.email).toBe('casey@example.com');
    expect(subRow.country).toBe('US');
  });

  it('does not write to the mailing list when subscribe=true but no email given', async () => {
    // Guards: opt-in requires an address — no email means feedback row only.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await post(buildApp(), makeEnv(), { features: 'sso', subscribe: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('does not fail the submission when the mailing-list insert errors', async () => {
    // Guards: the mailing_list write is best-effort (.catch(() => {})); a failure
    // there must not turn a successful feedback submission into an error.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockRejectedValueOnce(new Error('network down'));

    const res = await post(buildApp(), makeEnv(), {
      features: 'sso',
      email: 'a@b.co',
      subscribe: true,
    });

    expect(res.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('schedules the admin notification via ctx.waitUntil', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const ctx = fakeExecutionContext();

    const req = new Request('https://www.aecintegrations.com/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features: 'sso' }),
    });
    (req as unknown as { cf: CfProps }).cf = {};
    await buildApp().request(req, undefined, makeEnv(), ctx);

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });
});
