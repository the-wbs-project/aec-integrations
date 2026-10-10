/**
 * AECI-1216 — the three "Looks right" routes are mounted on the REAL Worker with
 * `requireVendor()` then `rateLimit('write')` (`STAGE_2_PAID_TIERS_SPEC.md` §13.8,
 * `waf-rate-limits.md` §6).
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
const PRODUCT = '00000000-0000-4000-8000-000000000010';

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
  '/api/vendor/profile/review',
  `/api/vendor/products/${PRODUCT}/review`,
  `/api/vendor/products/${PRODUCT}/integrations/review`,
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

async function hit(path: string, limiter: RateLimit, authed = true): Promise<Response> {
  return worker.fetch(
    new Request(`https://api${path}`, {
      method: 'POST',
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

describe('"Looks right" route registration', () => {
  it.each(ROUTES)('%s carries the write limiter, after the vendor guard', async (path) => {
    const limiter = refusingLimiter();
    const res = await hit(path, limiter);
    expect(res.status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toContain(SEAT_USER);
  });

  it.each(ROUTES)('%s never reaches the limiter without a session', async (path) => {
    const limiter = refusingLimiter();
    const res = await hit(path, limiter, false);
    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });
});
