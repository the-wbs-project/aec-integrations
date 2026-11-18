/**
 * AECI-1665 (`ADMIN_PANEL_SPEC.md` §5.23). The copyright notice routes are mounted on the
 * REAL Worker with `requireAdmin()` then `rateLimit('write')` on the POST and the PATCH,
 * and NO limiter on the list (`waf-rate-limits.md` §6.2). Same technique as
 * `admin-field-hides.registration.spec.ts`: `requireAdmin` is swapped for a stub that signs
 * an admin in, and a refusing write limiter must answer 429 before the handler, with the
 * admin's id in its key.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const ADMIN_USER = '00000000-0000-4000-8000-000000000105';
const NOTICE = '00000000-0000-4000-8000-000000000600';

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
      body: method === 'GET' ? undefined : '{"kind":"notice"}',
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

const WRITES: Array<[string, string]> = [
  ['POST', '/api/admin/dmca-notices'],
  ['PATCH', `/api/admin/dmca-notices/${NOTICE}`],
];

describe('admin copyright notice route registration', () => {
  it.each(WRITES)(
    '%s %s carries the write limiter, after the admin guard',
    async (method, path) => {
      const limiter = refusingLimiter();
      const res = await hit(method, path, limiter);
      expect(res.status).toBe(429);
      expect(limiter.keys).toHaveLength(1);
      expect(limiter.keys[0]).toContain(ADMIN_USER);
    },
  );

  it.each(WRITES)('%s %s never reaches the limiter without a session', async (method, path) => {
    const limiter = refusingLimiter();
    const res = await hit(method, path, limiter, false);
    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });

  it('GET /api/admin/dmca-notices is never rate-limited', async () => {
    const limiter = refusingLimiter();
    const res = await hit('GET', '/api/admin/dmca-notices', limiter);
    // No D1 binding here, so the handler itself fails. The limiter was never asked.
    expect(res.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });

  it('GET /api/admin/dmca-notices is behind the admin guard', async () => {
    const res = await hit('GET', '/api/admin/dmca-notices', refusingLimiter(), false);
    expect(res.status).toBe(401);
  });
});
