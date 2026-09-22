/**
 * Unit coverage for the server-side session refresh (node vitest lane). Boots
 * the REAL `@supabase/ssr` server client and stubs only the GoTrue round trip,
 * so the expiry decision, the cookie encoding and the chunk handling are the
 * library's own, not a mock's.
 */
import { describe, expect, it, vi } from 'vitest';

import { refreshSessionCookies, withRefreshedCookies } from './session-refresh';

const ENV = { SUPABASE_URL: 'https://testref.supabase.co', SUPABASE_ANON_KEY: 'anon-key' };
const COOKIE_NAME = 'sb-testref-auth-token';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'operator@example.com',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
};

function sessionCookie(expiresAt: number, refreshToken = 'refresh-old'): string {
  const session = {
    access_token: `access-${expiresAt}`,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user: USER,
  };
  const b64 = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${COOKIE_NAME}=base64-${b64}`;
}

function requestWith(cookie: string): Request {
  return new Request('https://www.example.com/admin/claims', { headers: { cookie } });
}

function goTrue(response: Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response.clone());
}

function decodeSessionCookie(cookieHeader: string): Record<string, unknown> {
  const match = cookieHeader.match(/sb-testref-auth-token=([^;]+)/);
  const value = decodeURIComponent(match?.[1] ?? '').replace(/^base64-/, '');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('refreshSessionCookies', () => {
  it('does nothing and makes no network call when the access token is fresh', async () => {
    const fetchStub = goTrue(new Response('{}'));
    const request = requestWith(sessionCookie(nowSeconds() + 3000));

    const result = await refreshSessionCookies(request, ENV, { fetch: fetchStub });

    expect(result.request).toBe(request);
    expect(result.setCookies).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and applies it to BOTH the request and the response', async () => {
    const fetchStub = goTrue(
      Response.json({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: nowSeconds() + 3600,
        user: USER,
      }),
    );
    const request = requestWith(`ph_other=keep%7Bme%7D; ${sessionCookie(nowSeconds() - 60)}`);

    const result = await refreshSessionCookies(request, ENV, { fetch: fetchStub });

    expect(fetchStub).toHaveBeenCalledOnce();
    expect(String(fetchStub.mock.calls[0]?.[0])).toContain('grant_type=refresh_token');

    const forwarded = result.request.headers.get('cookie') ?? '';
    expect(forwarded).toContain('ph_other=keep%7Bme%7D');
    expect(decodeSessionCookie(forwarded)).toMatchObject({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
    });

    expect(result.setCookies.some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
    expect(result.setCookies.every((c) => /Path=\//.test(c))).toBe(true);
  });

  it('clears the session cookie when the refresh token is dead', async () => {
    const fetchStub = goTrue(
      Response.json(
        { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' },
        { status: 400 },
      ),
    );
    const request = requestWith(sessionCookie(nowSeconds() - 60));

    const result = await refreshSessionCookies(request, ENV, { fetch: fetchStub });

    expect(result.request.headers.get('cookie') ?? '').not.toContain(COOKIE_NAME);
    expect(result.setCookies.some((c) => /Max-Age=0/.test(c))).toBe(true);
  });

  it('gives up at the deadline when GoTrue keeps failing, instead of waiting out the SDK retries', async () => {
    const fetchStub = goTrue(Response.json({ message: 'upstream down' }, { status: 503 }));
    const request = requestWith(sessionCookie(nowSeconds() - 60));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const started = Date.now();
    const result = await refreshSessionCookies(request, ENV, { fetch: fetchStub, deadlineMs: 50 });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ request, setCookies: [] });
    expect(fetchStub).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns the inbound request untouched when the env is unprovisioned', async () => {
    const request = requestWith(sessionCookie(nowSeconds() - 60));
    const result = await refreshSessionCookies(request, {});
    expect(result).toEqual({ request, setCookies: [] });
  });
});

describe('withRefreshedCookies', () => {
  it('returns the response untouched when there is nothing to set', () => {
    const response = new Response('ok', { headers: { 'Cache-Control': 'public, s-maxage=60' } });
    expect(withRefreshedCookies(response, [])).toBe(response);
  });

  it('appends every cookie and forces the response out of every cache', () => {
    const response = new Response('nf', {
      status: 404,
      headers: { 'Cache-Control': 'public, s-maxage=60', 'Cache-Tag': 'route:404' },
    });

    const out = withRefreshedCookies(response, ['a=1; Path=/', 'b=2; Path=/']);

    expect(out.status).toBe(404);
    expect(out.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(out.headers.get('Cache-Control')).toBe('private, no-store');
    expect(out.headers.get('Cache-Tag')).toBeNull();
  });
});
