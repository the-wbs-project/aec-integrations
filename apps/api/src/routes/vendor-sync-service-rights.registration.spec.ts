/**
 * AECI-2042 — every new write route on a Sync Service pair is mounted on the REAL
 * Worker with its guard, then `rateLimit('write')` (`waf-rate-limits.md` §6). The
 * pattern is `vendor-sync-service-pair-create.registration.spec.ts`'s: the guard is
 * swapped for a stub that seats the caller, a refusing limiter must answer 429 before
 * the handler, and the key it was asked about carries the seat's user id (so it ran
 * AFTER the guard). With no session the guard answers 401 and the limiter is never asked.
 * The two reads are never rate-limited.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const SEAT_USER = '00000000-0000-4000-8000-000000000101';
const VENDOR = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000999';

vi.mock('../lib/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/authz')>();
  const stub =
    (role: 'vendor_admin' | 'admin') =>
    (): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> =>
    async (c, next) => {
      if (!c.req.header('authorization')) {
        return c.json({ error: { code: 'UNAUTHENTICATED', message: 'No session' } }, 401);
      }
      c.set('auth', {
        userId: SEAT_USER,
        email: 'seat@example.test',
        role,
        vendorId: role === 'admin' ? null : VENDOR,
        entitlementTier: 'unclaimed',
        entitlement: null,
      });
      await next();
    };
  return { ...actual, requireVendor: stub('vendor_admin'), requireAdmin: stub('admin') };
});

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const WRITES = [
  { method: 'POST', path: `/api/vendor/integrations/${ID}/veto` },
  { method: 'POST', path: `/api/vendor/vetoes/${ID}/withdraw` },
  { method: 'POST', path: `/api/vendor/integrations/${ID}/pair-contests` },
  { method: 'POST', path: `/api/vendor/pair-contests/${ID}/withdraw` },
  { method: 'POST', path: `/api/vendor/pair-contests/${ID}/decision` },
  { method: 'POST', path: `/api/vendor/pair-contests/${ID}/protest` },
  { method: 'POST', path: `/api/vendor/pair-contests/${ID}/protest/withdraw` },
  { method: 'POST', path: `/api/admin/vetoes/${ID}/lift` },
  { method: 'PATCH', path: `/api/admin/pair-contests/${ID}` },
  { method: 'PATCH', path: `/api/admin/pair-contests/${ID}/protest` },
] as const;

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
  route: { method: string; path: string },
  limiter: RateLimit,
  authed = true,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://api${route.path}`, {
      method: route.method,
      body: '{}',
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

describe('AECI-2042 Sync Service pair rights registration', () => {
  it.each(WRITES)('$method $path carries the write limiter, after the guard', async (route) => {
    const limiter = refusingLimiter();
    const res = await hit(route, limiter);
    expect(res.status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toContain(SEAT_USER);
  });

  it.each(WRITES)('$method $path never reaches the limiter without a session', async (route) => {
    const limiter = refusingLimiter();
    const res = await hit(route, limiter, false);
    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });
});
