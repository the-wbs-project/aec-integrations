/**
 * Unit coverage for the AECI-193 Supabase server-client wiring (node vitest
 * lane). Exercises the option mapper, the Hono cookie adapter round-trip
 * through a real Hono app (chunked cookie names pass through unmerged; `setAll`
 * emits multiple `Set-Cookie` headers), and the `null` factory when the env is
 * unprovisioned. Does NOT boot `@supabase/ssr`'s client — that's the workerd
 * spike's job, proven by the /auth/whoami e2e + manual smoke.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { WebEnv } from '../../env';
import {
  createSupabaseServerClient,
  honoCookieAdapter,
  toHonoCookieOptions,
} from './supabase-server-client';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return { ASSETS: {} as Fetcher, API: {} as Fetcher, ENV: 'preview', ...overrides };
}

describe('toHonoCookieOptions', () => {
  it('maps the common serialize fields', () => {
    expect(toHonoCookieOptions({ path: '/', httpOnly: true, secure: true, maxAge: 3600 })).toEqual({
      path: '/',
      httpOnly: true,
      secure: true,
      maxAge: 3600,
    });
  });

  it('normalizes sameSite casing and boolean shorthand', () => {
    expect(toHonoCookieOptions({ sameSite: 'lax' }).sameSite).toBe('Lax');
    expect(toHonoCookieOptions({ sameSite: 'strict' }).sameSite).toBe('Strict');
    expect(toHonoCookieOptions({ sameSite: 'none' }).sameSite).toBe('None');
    expect(toHonoCookieOptions({ sameSite: true }).sameSite).toBe('Strict');
  });

  it('omits sameSite entirely when false', () => {
    expect('sameSite' in toHonoCookieOptions({ sameSite: false })).toBe(false);
  });

  it('returns an empty object for no options', () => {
    expect(toHonoCookieOptions()).toEqual({});
  });
});

describe('honoCookieAdapter', () => {
  it('getAll reads request cookies, including chunked sb-* names unmerged', async () => {
    const app = new Hono<{ Bindings: WebEnv }>();
    let seen: { name: string; value: string }[] = [];
    app.get('/probe', (c) => {
      seen = honoCookieAdapter(c).getAll();
      return c.body(null, 204);
    });

    await app.request(
      '/probe',
      {
        headers: {
          cookie: 'sb-ref-auth-token.0=part0; sb-ref-auth-token.1=part1; other=keep',
        },
      },
      makeEnv(),
    );

    expect(seen).toEqual(
      expect.arrayContaining([
        { name: 'sb-ref-auth-token.0', value: 'part0' },
        { name: 'sb-ref-auth-token.1', value: 'part1' },
        { name: 'other', value: 'keep' },
      ]),
    );
  });

  it('setAll emits one Set-Cookie header per cookie', async () => {
    const app = new Hono<{ Bindings: WebEnv }>();
    app.get('/set', (c) => {
      honoCookieAdapter(c).setAll([
        { name: 'sb-ref-auth-token.0', value: 'v0', options: { path: '/', httpOnly: true } },
        { name: 'sb-ref-auth-token.1', value: 'v1', options: { path: '/' } },
      ]);
      return c.body(null, 204);
    });

    const res = await app.request('/set', {}, makeEnv());
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(2);
    expect(setCookies.some((c) => c.startsWith('sb-ref-auth-token.0=v0'))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('sb-ref-auth-token.1=v1'))).toBe(true);
    expect(setCookies.some((c) => /HttpOnly/i.test(c))).toBe(true);
  });
});

describe('createSupabaseServerClient', () => {
  it('returns null when SUPABASE_URL is unset', async () => {
    const app = new Hono<{ Bindings: WebEnv }>();
    let client: unknown = 'sentinel';
    app.get('/c', (c) => {
      client = createSupabaseServerClient(c);
      return c.body(null, 204);
    });
    await app.request('/c', {}, makeEnv({ SUPABASE_ANON_KEY: 'anon' }));
    expect(client).toBeNull();
  });

  it('returns null when SUPABASE_ANON_KEY is unset', async () => {
    const app = new Hono<{ Bindings: WebEnv }>();
    let client: unknown = 'sentinel';
    app.get('/c', (c) => {
      client = createSupabaseServerClient(c);
      return c.body(null, 204);
    });
    await app.request('/c', {}, makeEnv({ SUPABASE_URL: 'https://x.supabase.co' }));
    expect(client).toBeNull();
  });

  it('returns a client when both are provided', async () => {
    const app = new Hono<{ Bindings: WebEnv }>();
    let client: unknown = null;
    app.get('/c', (c) => {
      client = createSupabaseServerClient(c);
      return c.body(null, 204);
    });
    await app.request(
      '/c',
      {},
      makeEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' }),
    );
    expect(client).not.toBeNull();
    expect(typeof (client as { auth: unknown }).auth).toBe('object');
  });
});
