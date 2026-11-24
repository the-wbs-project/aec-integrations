/**
 * AECI-2036 (`ADMIN_PANEL_SPEC.md` §5.7, `waf-rate-limits.md` §6). The connector kind PATCH is
 * mounted on the REAL Worker with `requireAdmin()` then `rateLimit('write')`. Same technique
 * as `admin-litigation-holds.registration.spec.ts`: `requireAdmin` is swapped for a stub that
 * signs an admin in, and a refusing write limiter must answer 429 before the handler, with
 * the admin's id in its key.
 */

import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { fakeExecutionContext } from '../test/helpers';

const ADMIN_USER = '00000000-0000-4000-8000-000000000105';
const PRODUCT = '00000000-0000-4000-8000-000000000611';

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
      body: method === 'GET' ? undefined : '{"connector_kind":"sync_service"}',
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: 'Bearer test' } : {}),
      },
    }),
    { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
    fakeExecutionContext(),
  );
}

const PATH = `/api/admin/products/${PRODUCT}/connector-kind`;

describe('admin connector kind route registration', () => {
  it('carries the write limiter, after the admin guard', async () => {
    const limiter = refusingLimiter();
    const res = await hit('PATCH', PATH, limiter);
    expect(res.status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toContain(ADMIN_USER);
  });

  it('never reaches the limiter without a session', async () => {
    const limiter = refusingLimiter();
    const res = await hit('PATCH', PATH, limiter, false);
    expect(res.status).toBe(401);
    expect(limiter.keys).toEqual([]);
  });
});
