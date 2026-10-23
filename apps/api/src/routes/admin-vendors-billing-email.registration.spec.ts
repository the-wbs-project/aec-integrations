/**
 * AECI-1381: `PUT /api/admin/vendors/:id/billing/email` is mounted on the REAL Worker
 * with `requireAdmin()` then `rateLimit('write')` (`waf-rate-limits.md` §6).
 *
 * Two halves. The first drives `worker.fetch` with `requireAdmin` swapped for a stub
 * that signs an admin in. A refusing write limiter must then answer 429 before the
 * handler, and the key it saw carries the admin's user id, which proves the limiter
 * runs AFTER the guard. The pattern is `admin-review-responses.registration.spec.ts`.
 *
 * The second mounts the handler behind the REAL `requireAdmin()` (pulled past the
 * mock with `vi.importActual`) over the in-memory D1, the `admin-licenses.spec.ts`
 * authorization describe: no token is 401, a reviewer, a vendor seat on this very
 * vendor and a banned admin are 403, and none of them writes.
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, billingAccounts, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { seedBillingAccount } from '../test/licenses';
import { createAdminUpdateBillingEmailHandler } from './admin-vendors-billing';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN_USER = uuid(105);
const VENDOR = uuid(1);
const PATH = `/api/admin/vendors/${VENDOR}/billing/email`;

vi.mock('../lib/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/authz')>();
  const stub =
    (): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> => async (c, next) => {
      if (!c.req.header('authorization')) {
        return c.json({ error: { code: 'UNAUTHENTICATED', message: 'No session' } }, 401);
      }
      c.set('auth', {
        userId: ADMIN_USER,
        email: 'admin@example.test',
        role: 'admin',
      } as AuthzVariables['auth']);
      await next();
    };
  return { ...actual, requireAdmin: stub };
});

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

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

async function hit(limiter: RateLimit, authed = true): Promise<Response> {
  return worker.fetch(
    new Request(`https://api${PATH}`, {
      method: 'PUT',
      body: JSON.stringify({ billing_email: 'ap@example.test' }),
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

describe('admin billing email route registration', () => {
  it('carries the write limiter, after the admin guard', async () => {
    const limiter = refusingLimiter();
    const res = await hit(limiter);
    expect(res.status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toContain(ADMIN_USER);
  });

  it('never reaches the limiter without a session', async () => {
    const limiter = refusingLimiter();
    const res = await hit(limiter, false);
    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });
});

describe('admin billing email authorization (the real requireAdmin)', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'staging', SUPABASE_URL } as Env;
  const REVIEWER = uuid(910);
  const SEAT = uuid(911);
  const BANNED_ADMIN = uuid(912);

  let jwks: TestJwks;
  let t: TestDb;

  beforeAll(async () => {
    jwks = await makeTestJwks();
  });
  beforeEach(async () => {
    t = await makeTestDb();
    await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
    await t.db.insert(profiles).values([
      { id: ADMIN_USER, role: 'admin' },
      { id: REVIEWER, role: 'reviewer' },
      { id: SEAT, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
      { id: BANNED_ADMIN, role: 'admin', bannedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await seedBillingAccount(t.db, VENDOR);
  });
  afterEach(() => t.dispose());

  async function call(token?: string): Promise<number> {
    const { requireAdmin } = await vi.importActual<typeof import('../lib/authz')>('../lib/authz');
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.put(
      '/api/admin/vendors/:id/billing/email',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createAdminUpdateBillingEmailHandler(t.factory),
    );
    const res = await app.request(
      PATH,
      {
        method: 'PUT',
        body: JSON.stringify({ billing_email: 'ap@example.test' }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );
    return res.status;
  }

  const storedEmail = async () => (await t.db.select().from(billingAccounts))[0]!.billingEmail;

  it('401s with no token and writes nothing', async () => {
    expect(await call()).toBe(401);
    expect(await storedEmail()).toBeNull();
  });

  it.each([
    ['a plain reviewer', REVIEWER],
    ['an owner seat on this very vendor', SEAT],
    ['a banned admin', BANNED_ADMIN],
  ])('403s %s and writes nothing', async (_label, sub) => {
    const token = await jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL });
    expect(await call(token)).toBe(403);
    expect(await storedEmail()).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('200s an admin', async () => {
    const token = await jwks.mintToken({ sub: ADMIN_USER, supabaseUrl: SUPABASE_URL });
    expect(await call(token)).toBe(200);
    expect(await storedEmail()).toBe('ap@example.test');
  });
});
