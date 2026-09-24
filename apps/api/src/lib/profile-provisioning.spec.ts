/**
 * AECI-770: the `GET /api/account` profile self-heal, composed with the REAL
 * `requireAuth()` guard and the REAL account handler over the in-memory D1 harness.
 *
 * The defect: a sign-in whose `/auth/callback` profile-ensure failed left a verified
 * session with no `profiles` row, and every authed call 401'd forever. These cells
 * pin the recovery and the limits on it:
 *
 *   stuck user, heal hook          → 200, row created, `profile.created{source:self-heal}`
 *   ensure throws, heal hook       → 503 PROFILE_UNAVAILABLE, metric `outcome:failed`
 *   ensure throws, then recovers   → 503, then 200 on the next request
 *   erased account, heal hook      → 401, NO row resurrected
 *   stuck user, strict requireAuth → 401, no row (writes and admin stay strict)
 *   existing profile               → hook never runs
 */

import { ApiErrorCode } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, profiles } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { submitCount } from '../posthog';
import { createGetAccountHandler, createUpdateAccountHandler } from '../routes/account';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { requireAuth, type AuthzVariables } from './authz';
import type { DbFactory } from './handler-utils';
import { healMissingProfile, type MissingProfileHook } from './profile-provisioning';

vi.mock('../posthog', () => ({
  submitCount: vi.fn(),
  logToPosthog: vi.fn(),
}));

const SUPABASE_URL = 'https://test-project.supabase.co';
const ENV = { ENV: 'preview', SUPABASE_URL } as Env;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STUCK = u(900);

let jwks: TestJwks;
beforeAll(async () => {
  jwks = await makeTestJwks();
});

let t: TestDb;
beforeEach(async () => {
  vi.mocked(submitCount).mockClear();
  // The failure path logs at `error` by design; keep the run quiet.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t = await makeTestDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  t.dispose();
});

/** A factory whose `db.insert` throws while `broken.on` is true — stands in for a
 *  D1 write outage during the self-heal. Reads keep working. */
function flakyFactory(broken: { on: boolean }): DbFactory {
  return ((env: Env, opts?: never) => {
    const ctx = t.factory(env, opts);
    const db = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === 'insert' && broken.on) {
          return () => {
            throw new Error('D1_ERROR: simulated outage');
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    return { ...ctx, db };
  }) as DbFactory;
}

function appWith(opts: { heal?: MissingProfileHook | null; dbFor?: DbFactory } = {}) {
  const dbFor = opts.dbFor ?? t.factory;
  const heal = opts.heal === undefined ? healMissingProfile() : opts.heal;
  const guard = {
    getKey: jwks.getKey,
    dbFor,
    ...(heal ? { onMissingProfile: heal } : {}),
  };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get('/api/account', requireAuth(guard), createGetAccountHandler(dbFor));
  // A write stays strict: no hook, whatever the read route does.
  app.patch(
    '/api/account',
    requireAuth({ getKey: jwks.getKey, dbFor }),
    createUpdateAccountHandler(dbFor),
  );
  return app;
}

async function call(
  app: ReturnType<typeof appWith>,
  method: 'GET' | 'PATCH' = 'GET',
): Promise<Response> {
  const token = await jwks.mintToken({
    sub: STUCK,
    email: 'new@vendor.example',
    supabaseUrl: SUPABASE_URL,
  });
  return app.request(
    '/api/account',
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === 'PATCH' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'PATCH' ? { body: JSON.stringify({ display_name: 'X' }) } : {}),
    },
    ENV,
    fakeExecutionContext(),
  );
}

const metricOutcomes = () =>
  vi
    .mocked(submitCount)
    .mock.calls.filter((args) => args[3] === 'aeci.auth.profile_ensure')
    .map((args) => (args[5] as string[]).join(','));

describe('GET /api/account self-heal (AECI-770)', () => {
  it('creates the missing profile and answers 200 for a stuck user', async () => {
    const res = await call(appWith());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user_id: string }).user_id).toBe(STUCK);

    const rows = await t.db.select().from(profiles);
    expect(rows.map((r) => [r.id, r.role])).toEqual([[STUCK, 'reviewer']]);
    const audit = await t.db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('profile.created');
    expect(audit[0]!.metadata).toEqual({ source: 'self-heal' });
    expect(metricOutcomes()).toEqual(['source:self-heal,outcome:created']);
  });

  it('answers 503 PROFILE_UNAVAILABLE and counts the failure when the ensure throws', async () => {
    const res = await call(appWith({ dbFor: flakyFactory({ on: true }) }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ApiErrorCode.PROFILE_UNAVAILABLE);

    expect(await t.db.select().from(profiles)).toHaveLength(0);
    expect(metricOutcomes()).toEqual(['source:self-heal,outcome:failed']);
  });

  it('recovers on the next request once the ensure stops failing', async () => {
    const broken = { on: true };
    const app = appWith({ dbFor: flakyFactory(broken) });

    expect((await call(app)).status).toBe(503);
    broken.on = false;
    expect((await call(app)).status).toBe(200);

    expect(await t.db.select().from(profiles)).toHaveLength(1);
    expect(metricOutcomes()).toEqual([
      'source:self-heal,outcome:failed',
      'source:self-heal,outcome:created',
    ]);
  });

  it('never resurrects an erased account: 401 and no row', async () => {
    await t.db.insert(auditLog).values({
      actorId: null,
      actorType: 'user',
      action: 'account.deleted',
      entityType: 'profile',
      entityId: STUCK,
    });

    const res = await call(appWith());
    expect(res.status).toBe(401);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
    expect(metricOutcomes()).toEqual(['source:self-heal,outcome:erased']);
  });

  it('does not run the hook when the profile already exists', async () => {
    await t.db.insert(profiles).values({ id: STUCK });
    const hook = vi.fn<MissingProfileHook>(async () => undefined);

    expect((await call(appWith({ heal: hook }))).status).toBe(200);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('requireAuth stays strict without the hook (AECI-770)', () => {
  it('401s a stuck user on a guard with no hook, and creates nothing', async () => {
    const res = await call(appWith({ heal: null }));
    expect(res.status).toBe(401);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
  });

  it('401s a stuck user on a write route even when the read route heals', async () => {
    const res = await call(appWith(), 'PATCH');
    expect(res.status).toBe(401);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
  });
});
