/**
 * Unit coverage for the Phase 5.4 `/auth/callback` handler (AECI-195):
 * return-path validation (no open redirect), the error → `/auth/login`
 * contract, code→session exchange, defensive profile-ensure (idempotent on
 * the API side; non-fatal here), and that session `Set-Cookie` headers
 * written during the exchange survive onto the redirect response.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { describe, expect, it, vi } from 'vitest';

import type { WebEnv } from '../../env';
import type { ServerApiClient } from '../../server-api-client';
import {
  createAuthCallbackHandler,
  sanitizeReturnPath,
  type AuthCallbackDeps,
} from './auth-callback';

describe('sanitizeReturnPath', () => {
  it('keeps plain same-origin paths', () => {
    expect(sanitizeReturnPath('/products/foo?tab=reviews')).toBe('/products/foo?tab=reviews');
  });

  it.each([
    [null, 'missing'],
    ['', 'empty'],
    ['https://evil.com/', 'absolute URL'],
    ['//evil.com/', 'scheme-relative'],
    ['/\\evil.com/', 'backslash-disguised scheme-relative'],
    ['evil.com/x', 'no leading slash'],
  ])('collapses %s (%s) to /', (raw) => {
    expect(sanitizeReturnPath(raw)).toBe('/');
  });
});

type ExchangeResult = {
  data: { session: { access_token: string } | null };
  error: { message: string } | null;
};

function makeHarness(options: {
  exchange?: (code: string) => ExchangeResult;
  configured?: boolean;
  ensure?: ServerApiClient['request'];
}) {
  const exchangeCalls: string[] = [];
  const ensure =
    options.ensure ?? vi.fn().mockResolvedValue({ created: false } as never as Promise<never>);

  const deps: AuthCallbackDeps = {
    createClient: (c) => {
      if (options.configured === false) return null;
      // Mimic the @supabase/ssr cookie adapter: a successful exchange writes
      // session cookies through the Hono context.
      const client = {
        auth: {
          exchangeCodeForSession: async (code: string) => {
            exchangeCalls.push(code);
            const result = options.exchange?.(code) ?? {
              data: { session: { access_token: 'jwt-abc' } },
              error: null,
            };
            if (result.data.session) {
              setCookie(c, 'sb-test-auth-token', 'session-value', {
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
                path: '/',
              });
            }
            return result;
          },
        },
      };
      return client as unknown as SupabaseClient;
    },
    apiFor: () => ({ request: ensure }),
  };

  const app = new Hono<{ Bindings: WebEnv }>();
  app.get('/auth/callback', createAuthCallbackHandler(deps));
  const request = (query: string) =>
    app.request(`/auth/callback${query}`, {}, {} as unknown as WebEnv);
  return { request, exchangeCalls, ensure };
}

describe('createAuthCallbackHandler', () => {
  it('exchanges the code, ensures the profile with the fresh bearer, and 303s to return', async () => {
    const { request, exchangeCalls, ensure } = makeHarness({});
    const res = await request('?code=pkce-123&return=%2Fproducts%2Ffoo');

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/products/foo');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(exchangeCalls).toEqual(['pkce-123']);
    // Session cookies written during the exchange survive the redirect.
    expect(res.headers.get('Set-Cookie')).toContain('sb-test-auth-token=session-value');
    expect(ensure).toHaveBeenCalledWith('/api/auth/profile/ensure', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt-abc' },
    });
  });

  it('defaults the redirect to / when return is absent', async () => {
    const { request } = makeHarness({});
    const res = await request('?code=pkce-123');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/');
  });

  it('collapses an open-redirect return target to /', async () => {
    const { request } = makeHarness({});
    const res = await request(`?code=pkce-123&return=${encodeURIComponent('//evil.com/')}`);
    expect(res.headers.get('Location')).toBe('/');
  });

  it('redirects to /auth/login with link_invalid when the code exchange fails', async () => {
    const { request } = makeHarness({
      exchange: () => ({ data: { session: null }, error: { message: 'expired' } }),
    });
    const res = await request('?code=stale&return=%2Fproducts%2Ffoo');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(
      `/auth/login?error=link_invalid&return=${encodeURIComponent('/products/foo')}`,
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('redirects to /auth/login with link_invalid on a provider error param', async () => {
    const { request, exchangeCalls } = makeHarness({});
    const res = await request('?error=access_denied&error_description=expired');
    expect(res.headers.get('Location')).toBe('/auth/login?error=link_invalid');
    expect(exchangeCalls).toHaveLength(0);
  });

  it('redirects to /auth/login with missing_code when no code is present', async () => {
    const { request } = makeHarness({});
    const res = await request('');
    expect(res.headers.get('Location')).toBe('/auth/login?error=missing_code');
  });

  it('redirects to /auth/login with auth_not_configured when env is unprovisioned', async () => {
    const { request } = makeHarness({ configured: false });
    const res = await request('?code=pkce-123');
    expect(res.headers.get('Location')).toBe('/auth/login?error=auth_not_configured');
  });

  it('treats a profile-ensure failure as non-fatal and still redirects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ensure = vi.fn().mockRejectedValue(new Error('api down'));
      const { request } = makeHarness({ ensure });
      const res = await request('?code=pkce-123&return=%2Faccount');
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('/account');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
