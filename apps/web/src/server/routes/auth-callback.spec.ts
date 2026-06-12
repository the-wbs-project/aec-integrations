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
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from '../../env';
import type { ServerApiClient } from '../../server-api-client';
import { submitCount } from '../../server-datadog';
import {
  createAuthCallbackHandler,
  normalizeAuthMethod,
  sanitizeReturnPath,
  type AuthCallbackDeps,
} from './auth-callback';

// The callback emits the `aeci.auth.signin` count (AECI-206) via the shared
// transport; mock it so we can assert the per-branch metric/tags directly.
vi.mock('../../server-datadog', () => ({ submitCount: vi.fn() }));

const submitCountMock = vi.mocked(submitCount);

/** Fire-and-forget metrics ride `ctx.waitUntil`; the handler reads
 *  `c.executionCtx`, so the test app must provide one (matches admin-purge.spec). */
function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}

/** The `aeci.auth.signin` calls recorded this test, as `{ value, tags }`. */
function signinMetrics(): Array<{ value: number; tags: string[] }> {
  return submitCountMock.mock.calls
    .filter((call) => call[3] === 'aeci.auth.signin')
    .map((call) => ({ value: call[4] as number, tags: call[5] as string[] }));
}

beforeEach(() => {
  submitCountMock.mockClear();
});

describe('normalizeAuthMethod', () => {
  it.each([
    ['google', 'google'],
    ['magic_link', 'magic_link'],
    [null, 'unknown'],
    ['', 'unknown'],
    ['facebook', 'unknown'],
  ])('maps %s → %s', (raw, expected) => {
    expect(normalizeAuthMethod(raw)).toBe(expected);
  });
});

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
    app.request(`/auth/callback${query}`, {}, {} as unknown as WebEnv, fakeExecutionContext());
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

describe('aeci.auth.signin metric (AECI-206)', () => {
  it('emits outcome:success tagged by method on a successful exchange', async () => {
    const { request } = makeHarness({});
    await request('?code=pkce-123&method=google&return=%2Faccount');
    expect(signinMetrics()).toEqual([{ value: 1, tags: ['method:google', 'outcome:success'] }]);
  });

  it('emits outcome:failed reason:link_invalid (method preserved) on a failed exchange', async () => {
    const { request } = makeHarness({
      exchange: () => ({ data: { session: null }, error: { message: 'expired' } }),
    });
    await request('?code=stale&method=magic_link');
    expect(signinMetrics()).toEqual([
      { value: 1, tags: ['method:magic_link', 'outcome:failed', 'reason:link_invalid'] },
    ]);
  });

  it('emits reason:link_invalid on a provider error param', async () => {
    const { request } = makeHarness({});
    await request('?error=access_denied&method=google');
    expect(signinMetrics()).toEqual([
      { value: 1, tags: ['method:google', 'outcome:failed', 'reason:link_invalid'] },
    ]);
  });

  it('emits reason:missing_code with method:unknown when no method hint is present', async () => {
    const { request } = makeHarness({});
    await request('');
    expect(signinMetrics()).toEqual([
      { value: 1, tags: ['method:unknown', 'outcome:failed', 'reason:missing_code'] },
    ]);
  });

  it('emits reason:auth_not_configured when the env is unprovisioned', async () => {
    const { request } = makeHarness({ configured: false });
    await request('?code=pkce-123&method=magic_link');
    expect(signinMetrics()).toEqual([
      { value: 1, tags: ['method:magic_link', 'outcome:failed', 'reason:auth_not_configured'] },
    ]);
  });
});
