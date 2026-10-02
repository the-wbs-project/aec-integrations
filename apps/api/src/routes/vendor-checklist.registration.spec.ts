/**
 * AECI-1217 — the two checklist reads are mounted on the REAL Worker behind
 * `requireVendor()` and are never rate-limited (`waf-rate-limits.md` §6.3).
 *
 * The handler spec builds its own Hono app, so it cannot see `index.ts`. This one
 * drives `worker.fetch` with `requireVendor` swapped for a stub that seats a
 * vendor, and a write limiter that refuses everything. The limiter must never be
 * asked. With no session the real guard's place answers 401.
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

const ROUTES = ['/api/vendor/checklist', `/api/vendor/products/${PRODUCT}/checklist`];

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
      method: 'GET',
      headers: authed ? { authorization: 'Bearer test' } : {},
    }),
    { ENV: 'preview', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

describe('checklist route registration', () => {
  it.each(ROUTES)('%s is mounted and never consults a limiter', async (path) => {
    const limiter = refusingLimiter();
    // The missing binding's 500 is logged; keep the run quiet.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await hit(path, limiter);
    quiet.mockRestore();
    // No `DB` binding here, so the handler itself fails. What matters is that the
    // route exists (not 404) and that no limiter stood in front of it (not 429).
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });

  it.each(ROUTES)('%s needs a session', async (path) => {
    const res = await hit(path, refusingLimiter(), false);
    expect(res.status).toBe(401);
  });
});
