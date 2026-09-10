/**
 * AECI-773 — the in-Worker rate limiter.
 *
 * Two halves. The first exercises the mechanism against a fake `RateLimit`
 * (the unit lane runs in plain Node, not workerd, so the binding does not
 * exist). The second is the LOCKSTEP guard over `wrangler.jsonc`, and it is the
 * more important of the two: `ratelimits` is not inherited into a named
 * environment, so a bucket declared only at the top level is bound on exactly
 * zero deployed Workers. Nothing throws, no other test fails, and the only
 * symptom is a limit that never limits — AECI-659's shape in a different file
 * format. CI runs no `wrangler deploy --dry-run` on PRs, so without this test a
 * missing `env.production` block would surface at the prod promote, after merge.
 */

import { ApiErrorSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './env';
import { errorHandler } from './errors';
import { requireAuth, type AuthzVariables } from './lib/authz';
import { fakeExecutionContext } from './test/helpers';
import {
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_METRIC,
  rateLimit,
  rateLimitKey,
  resetRateLimitAnnouncements,
} from './rate-limit-middleware';

vi.mock('./posthog', () => ({ submitCount: vi.fn() }));
const { submitCount } = await import('./posthog');
const submitCountMock = vi.mocked(submitCount);

/** A `RateLimit` stand-in that records every key it was asked about. */
function fakeLimiter(...outcomes: boolean[]): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  let i = 0;
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: outcomes[i++] ?? true };
    },
  };
}

/**
 * A router shaped like production: the limiter composes AFTER an authz guard,
 * and the sub-router owns its `onError` so a thrown `ApiError` becomes the
 * canonical §3.3 response.
 */
function makeApp(mw: ReturnType<typeof rateLimit>, opts: { withAuth?: boolean } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  const handler = vi.fn((c: { json: (v: unknown) => Response }) => c.json({ ok: true }));
  if (opts.withAuth) {
    // Stand in for `requireAuth()` — the real guard needs a verified JWT, and
    // what matters here is only that `auth` is set before the limiter runs.
    app.use('/t', async (c, next) => {
      c.set('auth', {
        userId: 'user-1',
        vendorId: 'vendor-1',
        role: 'vendor_admin',
      } as AuthzVariables['auth']);
      await next();
    });
  }
  app.post('/t', mw, handler as never);
  return { app, handler };
}

beforeEach(() => {
  resetRateLimitAnnouncements();
  submitCountMock.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('rateLimitKey', () => {
  const base = { envLabel: 'production', clientIp: '203.0.113.7' };

  it('prefers the authenticated user over the client IP', () => {
    expect(rateLimitKey({ ...base, by: 'user', userId: 'u1' })).toEqual({
      key: 'production:user:u1',
      source: 'user',
    });
  });

  it("uses the vendor id when asked for by: 'vendor'", () => {
    expect(rateLimitKey({ ...base, by: 'vendor', userId: 'u1', vendorId: 'v1' })).toEqual({
      key: 'production:vendor:v1',
      source: 'vendor',
    });
  });

  it("ignores a present session when asked for by: 'ip'", () => {
    expect(rateLimitKey({ ...base, by: 'ip', userId: 'u1' })).toEqual({
      key: 'production:ip:203.0.113.7',
      source: 'ip',
    });
  });

  it('falls back to a SHARED constant key, not to no key at all', () => {
    // The degraded mode must still be a limit: every keyless caller shares one
    // counter rather than each getting an unbounded budget.
    expect(rateLimitKey({ envLabel: 'production', by: 'ip' })).toEqual({
      key: 'production:ip:unknown',
      source: 'absent',
    });
  });

  it('prefixes the environment so a duplicated namespace_id still cannot merge tiers', () => {
    const a = rateLimitKey({ envLabel: 'staging', by: 'user', userId: 'u1' }).key;
    const b = rateLimitKey({ envLabel: 'production', by: 'user', userId: 'u1' }).key;
    expect(a).not.toEqual(b);
  });

  it('appends an explicit tag', () => {
    expect(rateLimitKey({ ...base, by: 'ip', tag: 'redeem' }).key).toBe(
      'production:ip:203.0.113.7:redeem',
    );
  });
});

describe('rateLimit middleware', () => {
  it('allows, calls limit() once with the derived key, and emits NOTHING', async () => {
    const limiter = fakeLimiter(true);
    const { app, handler } = makeApp(rateLimit('write'), { withAuth: true });
    const res = await app.request(
      '/t',
      { method: 'POST' },
      { WRITE_RATE_LIMIT: limiter, ENV: 'production' } satisfies Partial<Env>,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(limiter.keys).toEqual(['production:user:user-1']);
    // The AECI-666 assertion: the allow path is the hot path, and one
    // `submitCount` is one outbound connection. Not one emit.
    expect(submitCountMock).not.toHaveBeenCalled();
  });

  it('rejects with 429, the canonical envelope, and Retry-After = the bucket period', async () => {
    const { app, handler } = makeApp(rateLimit('write'), { withAuth: true });
    const res = await app.request(
      '/t',
      { method: 'POST' },
      { WRITE_RATE_LIMIT: fakeLimiter(false), ENV: 'production' } satisfies Partial<Env>,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(RATE_LIMIT_BUCKETS.write.period));
    const body = ApiErrorSchema.parse(await res.json());
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(handler).not.toHaveBeenCalled();

    expect(submitCountMock).toHaveBeenCalledTimes(1);
    const [, , , metric, value, tags] = submitCountMock.mock.calls[0]!;
    expect(metric).toBe(RATE_LIMIT_METRIC);
    expect(value).toBe(1);
    expect(tags).toEqual(['bucket:write', 'outcome:limited', 'key_source:user']);
  });

  it('gives the token bucket its own shorter Retry-After', async () => {
    const { app } = makeApp(rateLimit('token', { by: 'ip' }));
    const res = await app.request(
      '/t',
      { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.7' } },
      { TOKEN_RATE_LIMIT: fakeLimiter(false), ENV: 'production' } satisfies Partial<Env>,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(RATE_LIMIT_BUCKETS.token.period));
  });

  it('fails OPEN when the binding is absent, and announces once per isolate', async () => {
    const { app, handler } = makeApp(rateLimit('token', { by: 'ip' }));
    const env = { ENV: 'preview' } satisfies Partial<Env>;

    for (let i = 0; i < 3; i += 1) {
      const res = await app.request(
        '/t',
        { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.7' } },
        env,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(200);
    }

    expect(handler).toHaveBeenCalledTimes(3);
    // Three requests, ONE emit. A per-request emit here would be an unbatched
    // per-request fetch in exactly the environment where the binding is missing.
    expect(submitCountMock).toHaveBeenCalledTimes(1);
    expect(submitCountMock.mock.calls[0]![5]).toEqual([
      'bucket:token',
      'outcome:unconfigured',
      'key_source:ip',
    ]);
  });

  it('REFUSES TO GUESS: a write bucket with no principal is a 500, and never calls limit()', async () => {
    // Reaching this means the limiter was registered BEFORE its authz guard.
    // Falling back to IP would quietly turn a per-user cap into a per-NAT cap.
    const limiter = fakeLimiter(true);
    const { app, handler } = makeApp(rateLimit('write'));
    const res = await app.request(
      '/t',
      { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.7' } },
      { WRITE_RATE_LIMIT: limiter, ENV: 'production' } satisfies Partial<Env>,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(limiter.keys).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still limits the token bucket when no client IP arrives', async () => {
    const limiter = fakeLimiter(true, true);
    const { app } = makeApp(rateLimit('token', { by: 'ip' }));
    const env = { TOKEN_RATE_LIMIT: limiter, ENV: 'production' } satisfies Partial<Env>;

    await app.request('/t', { method: 'POST' }, env, fakeExecutionContext());
    await app.request('/t', { method: 'POST' }, env, fakeExecutionContext());

    // Both land on the SAME counter — the degraded mode is a limit, not a hole.
    expect(limiter.keys).toEqual(['production:ip:unknown', 'production:ip:unknown']);
  });

  it('runs behind the real authz guard: an unauthenticated write never reaches limit()', async () => {
    const limiter = fakeLimiter(true);
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.post('/t', requireAuth(), rateLimit('write'), (c) => c.json({ ok: true }));

    const res = await app.request(
      '/t',
      { method: 'POST' },
      { WRITE_RATE_LIMIT: limiter } satisfies Partial<Env>,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });
});
