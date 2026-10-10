/**
 * AECI-1177 — the admin review-reply routes are mounted on the REAL Worker with
 * `requireAdmin()` then `rateLimit('write')` on the decision PATCH, and NO limiter
 * on the queue read (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.14, `waf-rate-limits.md`
 * §6.2).
 *
 * Same technique as `vendor-review-responses.registration.spec.ts`: `requireAdmin`
 * is swapped for a stub that signs an admin in, and a refusing write limiter must
 * answer 429 before the handler. The key it saw carries the admin's user id, which
 * proves it runs after the guard. The GET must never consult it.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const ADMIN_USER = '00000000-0000-4000-8000-000000000105';
const REPLY = '00000000-0000-4000-8000-000000000500';

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
      body: method === 'GET' ? undefined : '{"decision":"approve"}',
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

describe('admin review-reply route registration', () => {
  it('PATCH /api/admin/review-responses/:id carries the write limiter, after the admin guard', async () => {
    const limiter = refusingLimiter();
    const res = await hit('PATCH', `/api/admin/review-responses/${REPLY}`, limiter);
    expect(res.status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toContain(ADMIN_USER);
  });

  it('the PATCH never reaches the limiter without a session', async () => {
    const limiter = refusingLimiter();
    const res = await hit('PATCH', `/api/admin/review-responses/${REPLY}`, limiter, false);
    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });

  it('GET /api/admin/review-responses is never rate-limited', async () => {
    const limiter = refusingLimiter();
    const res = await hit('GET', '/api/admin/review-responses', limiter);
    // No D1 binding here, so the handler itself fails. What matters is that the
    // limiter was never asked.
    expect(res.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });
});
