/**
 * Unit coverage for `POST /api/auth/profile/ensure` (AECI-195) in isolation:
 * given the `user` Variable that `requireUserAuth()` sets, the handler runs an
 * idempotent insert and audit-logs only when a row was actually created. The
 * middleware→handler 401 integration is covered in `lib/user-auth.spec.ts`.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import type { UserAuthVariables } from '../lib/user-auth';
import { createEnsureProfileHandler } from './auth-profile';

type CreateManyArgs = { data: { id: string }; skipDuplicates: true };
type AuditCreateArgs = { data: Record<string, unknown> };

function makeFakePrisma(createManyCount: number) {
  const createManyCalls: CreateManyArgs[] = [];
  const auditCalls: AuditCreateArgs[] = [];
  const tx = {
    profile: {
      createMany: async (args: CreateManyArgs) => {
        createManyCalls.push(args);
        return { count: createManyCount };
      },
    },
    auditLog: {
      create: async (args: AuditCreateArgs) => {
        auditCalls.push(args);
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  return { prisma, createManyCalls, auditCalls };
}

function appWith(prisma: unknown, user: UserAuthVariables['user'] = { userId: 'user-uuid-1' }) {
  const app = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
  app.use('/api/auth/profile/ensure', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.post(
    '/api/auth/profile/ensure',
    createEnsureProfileHandler(() => prisma as never),
  );
  return app;
}

function post(app: Hono<{ Bindings: Env; Variables: UserAuthVariables }>) {
  return app.request('/api/auth/profile/ensure', { method: 'POST' }, { DD_API_KEY: undefined });
}

describe('createEnsureProfileHandler', () => {
  it('creates the missing profile from the verified token sub and audit-logs it', async () => {
    const { prisma, createManyCalls, auditCalls } = makeFakePrisma(1);
    const res = await post(appWith(prisma));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ created: true });

    // The row id comes from the verified JWT, never from the request body.
    expect(createManyCalls).toEqual([{ data: { id: 'user-uuid-1' }, skipDuplicates: true }]);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.data).toMatchObject({
      actorId: 'user-uuid-1',
      actorType: 'user',
      action: 'profile.created',
      entityType: 'profile',
      entityId: 'user-uuid-1',
      metadata: { source: 'auth-callback' },
    });
  });

  it('is idempotent: an existing profile changes nothing and writes no audit row', async () => {
    const { prisma, createManyCalls, auditCalls } = makeFakePrisma(0);
    const res = await post(appWith(prisma));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: false });
    expect(createManyCalls).toHaveLength(1);
    expect(auditCalls).toHaveLength(0);
  });
});
