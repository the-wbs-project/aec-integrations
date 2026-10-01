/**
 * The per-seat nudge mute (AECI-1204): the portal pair and the one-click route,
 * real handlers over one real in-memory D1, with `c.set('auth', …)` stubbed the way
 * `seat-invites.spec.ts` does.
 *
 * Most of this file is about what must NOT happen: muting a colleague's seat or
 * another vendor's, a preference change with no audit row, a GET that writes, and
 * a one-click that leaks whether a token exists.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, notificationPreferences, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { PREFERENCES_UPDATED_ACTION } from '../lib/notification-preferences';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createGetNotificationPreferencesHandler,
  createNudgeMuteHandler,
  createUpdateNotificationPreferencesHandler,
} from './notification-preferences';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const SEAT = uuid(100);
const COLLEAGUE = uuid(101);
const OTHER_VENDOR_SEAT = uuid(200);

const session = (over: Partial<AuthzVariables['auth']> = {}): AuthzVariables['auth'] => ({
  userId: SEAT,
  email: 'seat@acme.com',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
  ...over,
});

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'acme', companyName: 'Acme' },
    { id: OTHER_VENDOR, slug: 'globex', companyName: 'Globex' },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT, role: 'vendor_admin', vendorId: VENDOR },
    { id: COLLEAGUE, role: 'vendor_admin', vendorId: VENDOR },
    { id: OTHER_VENDOR_SEAT, role: 'vendor_admin', vendorId: OTHER_VENDOR },
  ]);
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', (c.req.raw as Request & { __auth?: AuthzVariables['auth'] }).__auth ?? session());
    await next();
  });
  a.get('/api/vendor/notification-preferences', createGetNotificationPreferencesHandler(t.factory));
  a.put(
    '/api/vendor/notification-preferences',
    createUpdateNotificationPreferencesHandler(t.factory),
  );
  a.post('/api/notifications/nudges/mute', createNudgeMuteHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  path: string,
  init: RequestInit = {},
  auth: AuthzVariables['auth'] = session(),
): Promise<{ status: number; body: JsonBody }> {
  const req = new Request(`http://x${path}`, init) as Request & { __auth?: AuthzVariables['auth'] };
  req.__auth = auth;
  const execCtx = fakeExecutionContext();
  const res = await app().fetch(req, TEST_ENV, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody };
}

const put = (body: unknown, auth = session()) =>
  call(
    '/api/vendor/notification-preferences',
    { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    auth,
  );

const prefRows = () => t.db.select().from(notificationPreferences);
const updates = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, PREFERENCES_UPDATED_ACTION));

describe('GET /api/vendor/notification-preferences', () => {
  it('reads unmuted with no row, and creates none (a GET never writes)', async () => {
    const res = await call('/api/vendor/notification-preferences');
    expect(res).toEqual({ status: 200, body: { nudges_muted: false, nudges_muted_at: null } });
    expect(await prefRows()).toHaveLength(0);
  });

  it('reads the caller’s own seat, not a colleague’s', async () => {
    await t.db
      .insert(notificationPreferences)
      .values({ profileId: COLLEAGUE, nudgesMutedAt: '2026-09-01T00:00:00.000Z' });
    const res = await call('/api/vendor/notification-preferences');
    expect(res.body.nudges_muted).toBe(false);
  });
});

describe('PUT /api/vendor/notification-preferences', () => {
  it('mutes the caller’s own seat, minting the row and its token', async () => {
    const res = await put({ nudges_muted: true });

    expect(res.status).toBe(200);
    expect(res.body.nudges_muted).toBe(true);
    expect(typeof res.body.nudges_muted_at).toBe('string');
    // The token is a capability: never in a response.
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);

    const rows = await prefRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profileId: SEAT });
    expect(rows[0]!.muteToken).toMatch(/[0-9a-f-]{36}/);
  });

  it('writes the audit row, with before and after, and no token', async () => {
    await put({ nudges_muted: true });
    const audit = await updates();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: SEAT,
      actorType: 'user',
      entityType: 'profile',
      entityId: SEAT,
      beforeState: { nudgesMuted: false },
      afterState: { nudgesMuted: true },
      metadata: { source: 'vendor-portal' },
    });
    const [pref] = await prefRows();
    expect(JSON.stringify(audit[0])).not.toContain(pref!.muteToken);
  });

  it('writes the preference and its audit row in ONE db.batch', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    await put({ nudges_muted: true });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
  });

  it('rolls the preference back when its audit row cannot be written', async () => {
    t.raw.prepare('DROP TABLE audit_log').run();
    const res = await put({ nudges_muted: true });
    expect(res.status).toBe(500);
    expect(await prefRows()).toHaveLength(0);
  });

  it('unmutes, and a repeat of the same state writes nothing', async () => {
    await put({ nudges_muted: true });
    const first = (await prefRows())[0]!.nudgesMutedAt;

    const again = await put({ nudges_muted: true });
    expect(again.body.nudges_muted_at).toBe(first);
    expect(await updates()).toHaveLength(1);

    const off = await put({ nudges_muted: false });
    expect(off.body).toEqual({ nudges_muted: false, nudges_muted_at: null });
    expect(await updates()).toHaveLength(2);
  });

  it('acts only on the session seat: a colleague and another vendor are untouched', async () => {
    await put({ nudges_muted: true });
    await put(
      { nudges_muted: true },
      session({ userId: OTHER_VENDOR_SEAT, vendorId: OTHER_VENDOR }),
    );

    const rows = await prefRows();
    expect(rows.map((r) => r.profileId).sort()).toEqual([SEAT, OTHER_VENDOR_SEAT].sort());
    expect(rows.find((r) => r.profileId === COLLEAGUE)).toBeUndefined();
  });

  it('refuses a body that names a profile: no id is ever read from the request', async () => {
    const res = await put({ nudges_muted: true, profile_id: COLLEAGUE });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await prefRows()).toHaveLength(0);
  });

  it('refuses a missing or non-boolean value, and malformed JSON', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ nudges_muted: 'yes' })).status).toBe(400);
    const bad = await call('/api/vendor/notification-preferences', {
      method: 'PUT',
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('MALFORMED_REQUEST');
  });
});

describe('POST /api/notifications/nudges/mute (one-click)', () => {
  const TOKEN = '6f1c2f7e-4c0b-4b8e-9d0a-0f0e0d0c0b0a';

  beforeEach(async () => {
    await t.db.insert(notificationPreferences).values({ profileId: SEAT, muteToken: TOKEN });
  });

  const oneClick = (token: string) =>
    call(`/api/notifications/nudges/mute?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      // RFC 8058: the mail client posts this form body. It is ignored.
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  it('mutes the seat that owns the token, from an RFC 8058 form POST', async () => {
    const res = await oneClick(TOKEN);
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const [row] = await prefRows();
    expect(row!.nudgesMutedAt).not.toBeNull();
    const audit = await updates();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: SEAT,
      actorType: 'user',
      entityId: SEAT,
      metadata: { source: 'one-click' },
    });
  });

  it('takes the token from a JSON body (the confirm page)', async () => {
    const res = await call('/api/notifications/nudges/mute', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.body).toEqual({ ok: true });
  });

  it('is idempotent: a repeat answers ok, keeps the timestamp, writes no second audit row', async () => {
    await oneClick(TOKEN);
    const first = (await prefRows())[0]!.nudgesMutedAt;
    const again = await oneClick(TOKEN);
    expect(again.body).toEqual({ ok: true });
    expect((await prefRows())[0]!.nudgesMutedAt).toBe(first);
    expect(await updates()).toHaveLength(1);
  });

  it('answers 200 { ok: false } for an unknown token and writes nothing', async () => {
    const res = await oneClick('not-a-real-token');
    expect(res).toEqual({ status: 200, body: { ok: false } });
    expect((await prefRows())[0]!.nudgesMutedAt).toBeNull();
    expect(await updates()).toHaveLength(0);
  });

  it('refuses a request with no token at all', async () => {
    const res = await call('/api/notifications/nudges/mute', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('route registration (apps/api/src/index.ts)', () => {
  const index = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  const squash = (s: string) => s.replace(/\s+/g, ' ');

  it('rate-limits the one-click mute on the token bucket, keyed by IP', () => {
    expect(squash(index)).toContain(
      "phase28.post( '/api/notifications/nudges/mute', rateLimit('token', { by: 'ip' }), createNudgeMuteHandler(), );",
    );
  });

  it('guards the PUT with requireVendor, THEN the write limiter', () => {
    expect(squash(index)).toContain(
      "authVendor.put( '/api/vendor/notification-preferences', requireVendor(), rateLimit('write'), createUpdateNotificationPreferencesHandler(), );",
    );
  });

  it('never rate-limits the GET (reads are never limited, ADR 0026)', () => {
    expect(squash(index)).toContain(
      "authVendor.get( '/api/vendor/notification-preferences', requireVendor(), createGetNotificationPreferencesHandler(), );",
    );
  });
});
