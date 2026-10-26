/**
 * AECI-1234: `DELETE /api/admin/vendors/:id/seats/:userId` is mounted on the REAL Worker
 * with `requireAdmin()` then `rateLimit('write')` (`waf-rate-limits.md` §6.2).
 *
 * Drives `worker.fetch` with `requireAdmin` swapped for a stub that signs an admin in.
 * A refusing write limiter must then answer 429 before the handler, and the key it saw
 * carries the admin's user id, which proves the limiter runs AFTER the guard. The
 * pattern is `admin-vendors-billing-email.registration.spec.ts`. The handler and the
 * real guard are covered by `admin-vendors.spec.ts`.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN_USER = uuid(105);
const VENDOR = uuid(1);
const SEAT = uuid(2);
const PATH = `/api/admin/vendors/${VENDOR}/seats/${SEAT}`;

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
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Left the company' }),
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

describe('admin seat revoke route registration', () => {
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
