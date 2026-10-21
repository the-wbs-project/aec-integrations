/**
 * AECI-1417 — the two proposal decisions are mounted on the REAL Worker with
 * `requireVendor()` then `rateLimit('write')` (`waf-rate-limits.md` §6). The pattern
 * is `vendor-review.registration.spec.ts`'s.
 *
 * The handler specs build their own Hono app, so they cannot see `index.ts`. This
 * one drives `worker.fetch` with `requireVendor` swapped for a stub that seats a
 * vendor. A refusing write limiter must then answer 429 before the handler, which
 * proves the limiter is registered and runs AFTER the guard: the key it was asked
 * about carries the seat's user id. With no session the real guard answers 401.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const SEAT_USER = '00000000-0000-4000-8000-000000000101';
const VENDOR = '00000000-0000-4000-8000-000000000001';
const PROPOSAL = '00000000-0000-4000-8000-000000000070';

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
        entitlementTier: 'unclaimed',
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

const ROUTES = [
  { method: 'POST', path: `/api/vendor/proposals/${PROPOSAL}/accept` },
  { method: 'POST', path: `/api/vendor/proposals/${PROPOSAL}/decline` },
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

async function hit(
  { method, path }: { method: string; path: string },
  limiter: RateLimit,
  authed = true,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://api${path}`, {
      method,
      body: method === 'GET' ? undefined : '{}',
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

describe('E6b.5 proposal decision registration', () => {
  it.each(ROUTES)(
    '$method $path carries the write limiter, after the vendor guard',
    async (route) => {
      const limiter = refusingLimiter();
      const res = await hit(route, limiter);
      expect(res.status).toBe(429);
      expect(limiter.keys).toHaveLength(1);
      expect(limiter.keys[0]).toContain(SEAT_USER);
    },
  );

  it.each(ROUTES)('$method $path never reaches the limiter without a session', async (route) => {
    const limiter = refusingLimiter();
    const res = await hit(route, limiter, false);
    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });

  it('GET /api/vendor/proposals is a read and never reaches the limiter', async () => {
    const limiter = refusingLimiter();
    const res = await hit({ method: 'GET', path: '/api/vendor/proposals' }, limiter);
    expect(res.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });
});
