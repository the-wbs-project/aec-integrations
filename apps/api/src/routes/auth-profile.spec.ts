/**
 * POST /api/auth/profile/ensure on the Drizzle/D1 path (ADR 0016 / AECI-253),
 * against the in-memory D1 harness. Idempotent provisioning: first call creates +
 * audits, re-runs are no-ops.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, profiles } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import type { UserAuthVariables } from '../lib/user-auth';
import { createEnsureProfileHandler } from './auth-profile';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = u(900);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function post() {
  const a = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('user', { userId: USER, email: undefined });
    await next();
  });
  a.post('/api/auth/profile/ensure', createEnsureProfileHandler(t.factory));
  return a.request(
    '/api/auth/profile/ensure',
    { method: 'POST' },
    TEST_ENV,
    fakeExecutionContext(),
  );
}

describe('POST /api/auth/profile/ensure', () => {
  it('creates the profile + a profile.created audit on first call', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()) as { created: boolean }).toEqual({ created: true });

    const rows = await t.db.select().from(profiles);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(USER);
    expect(rows[0]!.role).toBe('reviewer'); // schema default

    const audit = await t.db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('profile.created');
    expect(audit[0]!.entityId).toBe(USER);
  });

  it('is idempotent: a re-run creates nothing and writes no new audit', async () => {
    await post();
    const second = await post();
    expect((await second.json()) as { created: boolean }).toEqual({ created: false });

    expect(await t.db.select().from(profiles)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(1); // no second audit
  });
});
