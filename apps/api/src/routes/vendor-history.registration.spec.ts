/**
 * AECI-1194 — the two change-history reads are mounted on the REAL Worker with
 * `requireVendor()` and nothing else: no rate limit (reads are never
 * rate-limited, `waf-rate-limits.md` §6, ADR 0026) and no capability gate.
 *
 * The handler spec builds its own Hono app, so it cannot see `index.ts`. This
 * one drives `worker.fetch` with `requireVendor` swapped for a stub that seats a
 * Free vendor, and with BOTH limiter bindings set to refuse every call. A 200
 * with an untouched limiter proves no limiter sits on the route.
 */

import type { MiddlewareHandler } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbContext } from '../db/client';
import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';

const SEAT_USER = '00000000-0000-4000-8000-000000000101';
const VENDOR = '00000000-0000-4000-8000-000000000001';

const holder: { ctx: DbContext | null } = { ctx: null };

vi.mock('../db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/client')>()),
  getDb: () => holder.ctx,
}));

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

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  holder.ctx = t.dbCtx;
});
afterEach(() => t.dispose());

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

describe('change-history route registration', () => {
  it.each(['/api/vendor/history', '/api/vendor/history.csv'])(
    '%s answers 200 with every limiter refusing, and never asks one',
    async (path) => {
      const write = refusingLimiter();
      const token = refusingLimiter();
      const res = await worker.fetch(
        new Request(`https://api${path}`, { headers: { authorization: 'Bearer test' } }),
        { ENV: 'preview', WRITE_RATE_LIMIT: write, TOKEN_RATE_LIMIT: token } as Env,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(200);
      expect(write.keys).toEqual([]);
      expect(token.keys).toEqual([]);
    },
  );

  it.each(['/api/vendor/history', '/api/vendor/history.csv'])(
    '%s is behind the vendor guard',
    async (path) => {
      const res = await worker.fetch(
        new Request(`https://api${path}`),
        { ENV: 'preview' } as Env,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(401);
    },
  );
});
