/**
 * AECI-2139 (§14.10) — the data flow correction routes are mounted on the REAL Worker
 * with `requireAdmin()` then `rateLimit('write')` on the two writes, and NO limiter on
 * the two reads (`waf-rate-limits.md` §6.2). Same technique as
 * `admin-field-hides.registration.spec.ts`.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const ADMIN_USER = '00000000-0000-4000-8000-000000000105';
const CLAIM = '00000000-0000-4000-8000-000000000600';
const VENDOR = '00000000-0000-4000-8000-000000000601';
const CORRECTION = '00000000-0000-4000-8000-000000000602';

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

async function hit(
  method: string,
  path: string,
  limiter: RateLimit,
  authed = true,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://api${path}`, {
      method,
      body: method === 'GET' ? undefined : '{"reason":"x"}',
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

const WRITES = [
  `/api/admin/flows/${CLAIM}/correction`,
  `/api/admin/flow-corrections/${CORRECTION}/lift`,
];
const READS = [`/api/admin/flows?pairId=${CLAIM}`, `/api/admin/vendors/${VENDOR}/flow-corrections`];

describe('admin data flow correction route registration', () => {
  it.each(WRITES)('POST %s carries the write limiter, after the admin guard', async (path) => {
    const limiter = refusingLimiter();
    const res = await hit('POST', path, limiter);
    expect(res.status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toContain(ADMIN_USER);
  });

  it.each(WRITES)('POST %s never reaches the limiter without a session', async (path) => {
    const limiter = refusingLimiter();
    const res = await hit('POST', path, limiter, false);
    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });

  it.each(READS)('GET %s is behind the admin guard and never rate-limited', async (path) => {
    expect((await hit('GET', path, refusingLimiter(), false)).status).toBe(401);
    const limiter = refusingLimiter();
    // No D1 binding here, so the handler itself fails. The limiter was never asked.
    expect((await hit('GET', path, limiter)).status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });
});
