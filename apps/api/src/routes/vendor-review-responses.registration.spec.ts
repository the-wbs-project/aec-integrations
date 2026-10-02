/**
 * AECI-1176 — the vendor review-reply routes are mounted on the REAL Worker with
 * `requireVendor()` then `rateLimit('write')` on every write, and NO limiter on the
 * read (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.14, `waf-rate-limits.md` §6).
 *
 * Same technique as `vendor-review.registration.spec.ts`: `requireVendor` is
 * swapped for a stub that seats a vendor, and a refusing write limiter must answer
 * 429 before the handler. The key it saw carries the seat's user id, which proves it
 * runs after the guard. The GET must never consult it.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const SEAT_USER = '00000000-0000-4000-8000-000000000101';
const VENDOR = '00000000-0000-4000-8000-000000000001';
const REVIEW = '00000000-0000-4000-8000-000000000030';

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
  { method: 'POST', path: `/api/vendor/reviews/${REVIEW}/response` },
  { method: 'PATCH', path: `/api/vendor/reviews/${REVIEW}/response` },
  { method: 'POST', path: `/api/vendor/reviews/${REVIEW}/response/withdraw` },
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
  method: string,
  path: string,
  limiter: RateLimit,
  authed = true,
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
    { ENV: 'preview', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

describe('vendor review-reply route registration', () => {
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

  it('GET /api/vendor/reviews is never rate-limited', async () => {
    const limiter = refusingLimiter();
    const res = await hit('GET', '/api/vendor/reviews', limiter);
    // No D1 binding here, so the handler itself fails. What matters is that the
    // limiter was never asked.
    expect(res.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });
});
