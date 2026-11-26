/**
 * AECI-2213 — the owner flow routes on the REAL Worker. Every write carries
 * `rateLimit('write')` after `requireVendor()`. The history read never consults a
 * limiter (reads are never rate-limited, `waf-rate-limits.md` §6, ADR 0026).
 *
 * Same technique as `vendor-threads.registration.spec.ts`: `requireVendor` is swapped
 * for a stub that seats a vendor, and a refusing limiter answers 429 before a handler.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const SEAT_USER = '00000000-0000-4000-8000-000000000101';
const VENDOR = '00000000-0000-4000-8000-000000000001';
const ROW = '00000000-0000-4000-8000-000000000030';
const CLAIM = '00000000-0000-4000-8000-000000000031';

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
  { method: 'POST', path: `/api/vendor/owned-integrations/${ROW}/flows` },
  { method: 'PUT', path: `/api/vendor/owned-flows/${CLAIM}/answer` },
  { method: 'DELETE', path: `/api/vendor/owned-flows/${CLAIM}/answer` },
  { method: 'PATCH', path: `/api/vendor/owned-flows/${CLAIM}` },
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
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

describe('owner flow route registration', () => {
  it.each(WRITES)('$method $path carries the write limiter, after the guard', async (route) => {
    const limiter = refusingLimiter();
    const res = await hit(route.method, route.path, limiter);
    expect(res.status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toContain(SEAT_USER);
  });

  it('GET …/flows/history needs a session and is never rate-limited', async () => {
    const limiter = refusingLimiter();
    const path = `/api/vendor/owned-integrations/${ROW}/flows/history?data_object=rfis`;
    expect((await hit('GET', path, limiter, false)).status).toBe(401);
    // No D1 binding here, so the handler itself fails. What matters is that the
    // limiter was never asked.
    expect((await hit('GET', path, limiter)).status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });
});
