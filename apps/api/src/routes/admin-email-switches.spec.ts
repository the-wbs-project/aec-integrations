/**
 * `/api/admin/email/switches` (AECI-1224), against the in-memory D1 harness. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.14 "Sending switches", §6, §13 D24.
 *
 * INVARIANT tests here. None should be deleted without reopening the decision behind it:
 *
 *   1. **A non-pausable entry cannot be paused.** 400 `NOTIFICATION_NOT_PAUSABLE`, nothing
 *      written. Resuming one is allowed.
 *   2. **Every change writes the setting and its audit row in ONE batch.** Actor, key, old
 *      and new value.
 *   3. **A request naming the current state writes nothing**, audit row included.
 *   4. **The sentinel aborts the whole batch** when another tab moved the switch.
 */

import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AdminEmailSwitchesResponseSchema,
  SetAdminEmailSwitchResponseSchema,
  type AdminEmailSwitchesResponse,
} from '@aeci/shared';

import { auditLog, notificationSettings, profiles } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import worker from '../index';
import type { BatchTuple } from '../lib/audit';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { isSwitchRaceError, switchWriteStatements } from '../lib/notifications/switches';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  createAdminEmailSwitchesHandler,
  createSetAdminEmailSwitchHandler,
} from './admin-email-switches';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const clock = { now: () => NOW };
const ADMIN = '00000000-0000-4000-8000-000000000900';
const PREVIEW = { ENV: 'preview' } as Env;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: ADMIN,
      email: undefined,
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.get('/api/admin/email/switches', createAdminEmailSwitchesHandler(t.factory, clock));
  a.put('/api/admin/email/switches/:key', createSetAdminEmailSwitchHandler(t.factory, clock));
  return a;
}

const get = async (env: Env = PREVIEW): Promise<AdminEmailSwitchesResponse> => {
  const res = await app().request('/api/admin/email/switches', {}, env, fakeExecutionContext());
  expect(res.status).toBe(200);
  return AdminEmailSwitchesResponseSchema.parse(await res.json());
};

const put = (key: string, body: unknown) =>
  app().request(
    `/api/admin/email/switches/${key}`,
    { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    PREVIEW,
    fakeExecutionContext(),
  );

const settings = () =>
  t.db.select().from(notificationSettings).orderBy(asc(notificationSettings.key));
const audits = () => t.db.select().from(auditLog);

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/email/switches', () => {
  it('lists the support copy first, then every email entry, all enabled with no rows', async () => {
    const body = await get();
    expect(body.environment).toBe('preview');
    expect(body.switches[0]).toEqual(
      expect.objectContaining({
        key: 'support-copy',
        kind: 'support_copy',
        pausable: true,
        enabled: true,
      }),
    );
    const keys = body.switches.map((s) => s.key);
    expect(keys).toContain('vendor-seat-invite');
    expect(keys).toContain('digest-analytics');
    // Not email: no switch is listed for them.
    expect(keys).not.toContain('supabase-sign-in');
    expect(keys.some((k) => k.startsWith('portal-') || k.startsWith('linear-'))).toBe(false);
    expect(body.switches.every((s) => s.enabled)).toBe(true);
  });

  it('reports a paused pausable entry as paused, with who and when', async () => {
    await t.db.insert(notificationSettings).values({
      key: 'landing-feedback',
      enabled: false,
      updatedBy: ADMIN,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const s = (await get()).switches.find((x) => x.key === 'landing-feedback')!;
    expect(s).toEqual(
      expect.objectContaining({
        enabled: false,
        updated_by: ADMIN,
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
    );
  });

  it('reports a non-pausable entry as enabled even with a stale paused row', async () => {
    await t.db.insert(notificationSettings).values({ key: 'claim-approved', enabled: false });
    const s = (await get()).switches.find((x) => x.key === 'claim-approved')!;
    expect(s.pausable).toBe(false);
    expect(s.enabled).toBe(true);
  });

  it('says whether EMAIL_BCC is set, never its value', async () => {
    expect((await get()).support_copy_configured).toBe(false);
    const res = await app().request(
      '/api/admin/email/switches',
      {},
      { ENV: 'preview', EMAIL_BCC: 'chris@thewbsproject.com' } as Env,
      fakeExecutionContext(),
    );
    const text = await res.text();
    expect(JSON.parse(text).support_copy_configured).toBe(true);
    expect(text).not.toContain('chris@thewbsproject.com');
  });
});

// ─── PUT ─────────────────────────────────────────────────────────────────────

describe('PUT /api/admin/email/switches/:key', () => {
  it('pauses a pausable template and writes its audit row in the same batch', async () => {
    const res = await put('landing-feedback', { enabled: false, reason: 'Spam wave' });
    expect(res.status).toBe(200);
    const body = SetAdminEmailSwitchResponseSchema.parse(await res.json());
    expect(body.changed).toBe(true);
    expect(body.switch).toEqual(
      expect.objectContaining({ key: 'landing-feedback', enabled: false, updated_by: ADMIN }),
    );

    expect(await settings()).toEqual([
      expect.objectContaining({ key: 'landing-feedback', enabled: false, updatedBy: ADMIN }),
    ]);
    expect(await audits()).toEqual([
      expect.objectContaining({
        actorId: ADMIN,
        actorType: 'admin',
        action: 'notification_settings.updated',
        entityType: 'notification_setting',
        entityId: 'landing-feedback',
        beforeState: { enabled: true },
        afterState: { enabled: false },
        metadata: { source: 'admin-email-switches', tier: 'preview', reason: 'Spam wave' },
      }),
    ]);
  });

  it('resumes it, with a second audit row', async () => {
    await put('landing-feedback', { enabled: false });
    const res = await put('landing-feedback', { enabled: true });
    expect(res.status).toBe(200);
    expect((await settings())[0]?.enabled).toBe(true);
    const rows = await audits();
    expect(rows.map((r) => [r.beforeState, r.afterState])).toEqual([
      [{ enabled: true }, { enabled: false }],
      [{ enabled: false }, { enabled: true }],
    ]);
  });

  it('pauses the support copy', async () => {
    expect((await put('support-copy', { enabled: false })).status).toBe(200);
    expect((await settings())[0]).toEqual(
      expect.objectContaining({ key: 'support-copy', enabled: false }),
    );
  });

  it('naming the current state is a 200 that writes nothing', async () => {
    const res = await put('landing-feedback', { enabled: true });
    expect(res.status).toBe(200);
    expect(SetAdminEmailSwitchResponseSchema.parse(await res.json()).changed).toBe(false);
    expect(await settings()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it.each([
    'vendor-seat-invite',
    'claim-approved',
    'account-deleted',
    'portal-claim-added',
    'supabase-sign-in',
  ])('refuses to pause %s: 400 NOTIFICATION_NOT_PAUSABLE, nothing written', async (key) => {
    const res = await put(key, { enabled: false });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'NOTIFICATION_NOT_PAUSABLE',
    );
    expect(await settings()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('allows resuming a non-pausable entry, so a stale paused row can be cleared', async () => {
    await t.db.insert(notificationSettings).values({ key: 'claim-approved', enabled: false });
    const res = await put('claim-approved', { enabled: true });
    expect(res.status).toBe(200);
    expect((await settings())[0]?.enabled).toBe(true);
    expect(await audits()).toHaveLength(1);
  });

  it('404s an unknown key', async () => {
    const res = await put('no-such-template', { enabled: false });
    expect(res.status).toBe(404);
    expect(await settings()).toEqual([]);
  });

  it('400s a body with an extra field, and a non-boolean', async () => {
    expect((await put('landing-feedback', { enabled: false, key: 'x' })).status).toBe(400);
    expect((await put('landing-feedback', { enabled: 'no' })).status).toBe(400);
    expect(await settings()).toEqual([]);
  });
});

// ─── The race sentinel ───────────────────────────────────────────────────────

describe('switchWriteStatements', () => {
  it('aborts the whole batch, audit row included, when the switch moved', async () => {
    // The caller read "enabled" (no row); another tab has since paused it.
    await t.db.insert(notificationSettings).values({ key: 'landing-feedback', enabled: false });
    const { stmts } = switchWriteStatements(t.db, {
      key: 'landing-feedback',
      from: true,
      to: false,
      actorId: ADMIN,
      actorType: 'admin',
      tier: 'preview',
      now: NOW.toISOString(),
    });
    let error: unknown;
    try {
      await t.db.batch(stmts as unknown as BatchTuple);
    } catch (e) {
      error = e;
    }
    expect(isSwitchRaceError(error)).toBe(true);
    expect(await audits()).toEqual([]);
  });

  it('commits when the stored state still matches', async () => {
    const { stmts } = switchWriteStatements(t.db, {
      key: 'landing-feedback',
      from: true,
      to: false,
      actorId: ADMIN,
      actorType: 'admin',
      tier: 'preview',
      now: NOW.toISOString(),
    });
    await t.db.batch(stmts as unknown as BatchTuple);
    expect(
      (
        await t.db
          .select()
          .from(notificationSettings)
          .where(eq(notificationSettings.key, 'landing-feedback'))
      )[0]?.enabled,
    ).toBe(false);
    expect(await audits()).toHaveLength(1);
  });
});

// ─── Authorization, against the REAL requireAdmin() guard ────────────────────

describe('authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'preview', SUPABASE_URL } as Env;
  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guardedApp() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.put(
      '/api/admin/email/switches/:key',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createSetAdminEmailSwitchHandler(t.factory, clock),
    );
    return a;
  }

  const call = (token?: string) =>
    guardedApp().request(
      '/api/admin/email/switches/landing-feedback',
      {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  it('401s with no token', async () => {
    expect((await call()).status).toBe(401);
    expect(await settings()).toEqual([]);
  });

  it('403s a plain reviewer', async () => {
    const reviewer = '00000000-0000-4000-8000-000000000910';
    await t.db.insert(profiles).values({ id: reviewer, role: 'reviewer' });
    const token = await jwks.mintToken({ sub: reviewer, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect(await settings()).toEqual([]);
  });

  it('200s an admin', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(200);
    expect((await settings())[0]?.enabled).toBe(false);
  });
});

// ─── Registration, against the REAL app from index.ts ────────────────────────

describe('route registration', () => {
  it.each([
    ['GET', '/api/admin/email/switches'],
    ['PUT', '/api/admin/email/switches/landing-feedback'],
  ])('%s %s is mounted behind requireAdmin(): 401, not 404', async (method, path) => {
    const res = await worker.fetch(
      new Request(`https://api${path}`, {
        method,
        ...(method === 'PUT'
          ? {
              body: JSON.stringify({ enabled: false }),
              headers: { 'content-type': 'application/json' },
            }
          : {}),
      }),
      { ENV: 'preview', SUPABASE_URL: 'https://test-project.supabase.co' } as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });
});
