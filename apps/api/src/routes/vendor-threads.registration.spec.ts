/**
 * AECI-1535 — the private row thread routes are mounted on the REAL Worker with
 * `requireVendor()` then `rateLimit('write')` on every write, and NO limiter on the
 * read (`STAGE_2_ATTESTATIONS_SPEC.md` §15.6, `waf-rate-limits.md` §6).
 *
 * Same technique as `vendor-review.registration.spec.ts`: `requireVendor` is
 * swapped for a stub that seats a vendor, and a refusing write limiter must answer
 * 429 before the handler. The key it saw carries the seat's user id, which proves it
 * runs after the guard. The GET must never consult it.
 *
 * AECI-1553: with `THREADS_ENABLED` anything but `"true"`, every vendor thread route
 * answers `404 NOT_FOUND` after the guard and before the limiter.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const SEAT_USER = '00000000-0000-4000-8000-000000000101';
const VENDOR = '00000000-0000-4000-8000-000000000001';
const CLAIM = '00000000-0000-4000-8000-000000000030';
const MESSAGE = '00000000-0000-4000-8000-000000000031';

vi.mock('../lib/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/authz')>();
  const stub =
    (): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> => async (c, next) => {
      if (!c.req.header('authorization')) {
        return c.json({ error: { code: 'UNAUTHENTICATED', message: 'No session' } }, 401);
      }
      c.set('auth', {
        userId: SEAT_USER,
        email: 'seat@example.test',
        role: 'vendor_admin',
        vendorId: VENDOR,
        entitlementTier: 'verified',
        entitlement: null,
      });
      await next();
    };
  return { ...actual, requireVendor: stub };
});

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const WRITES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: `/api/vendor/claims/${CLAIM}/thread/messages` },
  { method: 'DELETE', path: `/api/vendor/claims/${CLAIM}/thread/messages/${MESSAGE}` },
  { method: 'POST', path: `/api/vendor/claims/${CLAIM}/thread/help` },
];

function refusingLimiter(): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: false };
    },
  };
}

/** The switch's three readings (AECI-1553). Only `"true"` is on. */
type Switch = { THREADS_ENABLED?: string };
const ON: Switch = { THREADS_ENABLED: 'true' };

async function hit(
  method: string,
  path: string,
  limiter: RateLimit,
  authed = true,
  threads: Switch = ON,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://api${path}`, {
      method,
      body: method === 'GET' ? undefined : '{"body":"x"}',
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter, ...threads } as Env,
    fakeExecutionContext(),
  );
}

describe('vendor thread route registration', () => {
  it.each(WRITES)(
    '$method $path carries the write limiter, after the vendor guard',
    async ({ method, path }) => {
      const limiter = refusingLimiter();
      const res = await hit(method, path, limiter);
      expect(res.status).toBe(429);
      expect(limiter.keys).toHaveLength(1);
      expect(limiter.keys[0]).toContain(SEAT_USER);
    },
  );

  it.each(WRITES)(
    '$method $path never reaches the limiter without a session',
    async ({ method, path }) => {
      const limiter = refusingLimiter();
      const res = await hit(method, path, limiter, false);
      expect(res.status).toBe(401);
      expect(limiter.keys).toEqual([]);
    },
  );

  it('GET /api/vendor/integrations/:id/threads is never rate-limited (AECI-1546)', async () => {
    const limiter = refusingLimiter();
    const path = `/api/vendor/integrations/${CLAIM}/threads`;
    // Mounted behind the vendor guard: no session is a 401, not an unknown route.
    expect((await hit('GET', path, limiter, false)).status).toBe(401);
    const res = await hit('GET', path, limiter);
    expect(res.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });

  it('GET /api/vendor/claims/:claimId/thread is never rate-limited', async () => {
    const limiter = refusingLimiter();
    const res = await hit('GET', `/api/vendor/claims/${CLAIM}/thread`, limiter);
    // No D1 binding here, so the handler itself fails. What matters is that the
    // limiter was never asked.
    expect(res.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });

  // AECI-1548: the read by thread id sits behind the guard and is never limited.
  it('GET /api/vendor/threads/:threadId needs a session and is never rate-limited', async () => {
    const limiter = refusingLimiter();
    const path = `/api/vendor/threads/${MESSAGE}`;
    expect((await hit('GET', path, limiter, false)).status).toBe(401);
    expect((await hit('GET', path, limiter)).status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });

  // AECI-1551: the company's Conversations list, behind the guard and never limited.
  it('GET /api/vendor/threads needs a session and is never rate-limited', async () => {
    const limiter = refusingLimiter();
    const path = '/api/vendor/threads';
    expect((await hit('GET', path, limiter, false)).status).toBe(401);
    expect((await hit('GET', path, limiter)).status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });
});

/** Every vendor thread route (AECI-1553, `STAGE_2_ATTESTATIONS_SPEC.md` §15.16). */
const ROUTES: ReadonlyArray<{ method: string; path: string; write: boolean }> = [
  { method: 'GET', path: `/api/vendor/claims/${CLAIM}/thread`, write: false },
  { method: 'GET', path: `/api/vendor/integrations/${CLAIM}/threads`, write: false },
  { method: 'GET', path: `/api/vendor/threads/${MESSAGE}`, write: false },
  { method: 'GET', path: '/api/vendor/threads', write: false },
  ...WRITES.map((w) => ({ ...w, write: true })),
];

const OFF: ReadonlyArray<{ label: string; threads: Switch }> = [
  { label: '"false"', threads: { THREADS_ENABLED: 'false' } },
  { label: 'absent', threads: {} },
  { label: '"TRUE"', threads: { THREADS_ENABLED: 'TRUE' } },
];

const OFF_CASES = ROUTES.flatMap((route) => OFF.map((off) => ({ ...route, ...off })));

describe('THREADS_ENABLED release switch (AECI-1553)', () => {
  it.each(OFF_CASES)(
    '$method $path answers 404 when the switch is $label, before the limiter',
    async ({ method, path, threads }) => {
      const limiter = refusingLimiter();
      const res = await hit(method, path, limiter, true, threads);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(limiter.keys).toEqual([]);
    },
  );

  it.each(ROUTES)('$method $path still needs a session when off', async ({ method, path }) => {
    const limiter = refusingLimiter();
    const res = await hit(method, path, limiter, false, { THREADS_ENABLED: 'false' });
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)(
    '$method $path behaves normally when the switch is "true"',
    async ({ method, path, write }) => {
      const limiter = refusingLimiter();
      const res = await hit(method, path, limiter, true, ON);
      if (write) {
        // The refusing limiter answers, so the request got past the switch.
        expect(res.status).toBe(429);
      } else {
        // No D1 here, so the handler fails, but not with the switch's 404.
        expect(res.status).not.toBe(404);
        expect(limiter.keys).toEqual([]);
      }
    },
  );
});
