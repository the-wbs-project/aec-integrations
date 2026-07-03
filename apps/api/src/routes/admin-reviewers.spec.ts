/**
 * Reviewer ban-management API (AECI-218 / Phase 6.11) on the Drizzle/D1 path
 * (ADR 0016 / AECI-253), against the in-memory D1 harness.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, profiles, workflowInstances } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createBanReviewerHandler, createBannedReviewersListHandler } from './admin-reviewers';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

const emails = vi.fn(async () => new Map<string, string>());

function listApp() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', { userId: ADMIN, email: undefined, role: 'admin' });
    await next();
  });
  a.get('/api/admin/reviewers', createBannedReviewersListHandler(t.factory, emails));
  return a;
}
function patchApp() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', { userId: ADMIN, email: undefined, role: 'admin' });
    await next();
  });
  a.patch('/api/admin/reviewers/:id', createBanReviewerHandler(t.factory));
  return a;
}
const patch = (id: string, body: unknown) =>
  patchApp().request(
    `/api/admin/reviewers/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

describe('PATCH /api/admin/reviewers/:id', () => {
  it('bans an active reviewer (sets banned_at, audits, opens the workflow)', async () => {
    await t.db.insert(profiles).values({ id: u(1) });
    const res = await patch(u(1), { action: 'ban', reason: 'Repeated spam reviews.' });
    expect(res.status).toBe(200);

    const [row] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, u(1)));
    expect(row!.bannedAt).not.toBeNull();
    expect(row!.banReason).toBe('Repeated spam reviews.');
    expect((await t.db.select().from(auditLog)).some((a) => a.action === 'reviewer.banned')).toBe(
      true,
    );
    const [wf] = await t.db.select().from(workflowInstances);
    expect(wf!.workflowType).toBe('reviewer_ban');
    expect(wf!.currentState).toBe('banned');
    expect(wf!.completedAt).toBeNull(); // reversible workflow
  });

  it('unbans a banned reviewer', async () => {
    await t.db
      .insert(profiles)
      .values({ id: u(1), bannedAt: '2026-01-01T00:00:00.000Z', banReason: 'x' });
    const res = await patch(u(1), { action: 'unban' });
    expect(res.status).toBe(200);
    const [row] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, u(1)));
    expect(row!.bannedAt).toBeNull();
  });

  it('403s banning an admin or yourself', async () => {
    await t.db.insert(profiles).values({ id: u(2), role: 'admin' });
    expect((await patch(u(2), { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      403,
    );
    expect((await patch(ADMIN, { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      403,
    );
  });

  it('422s an already-banned reviewer', async () => {
    await t.db.insert(profiles).values({ id: u(1), bannedAt: '2026-01-01T00:00:00.000Z' });
    expect((await patch(u(1), { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      422,
    );
  });
});

describe('GET /api/admin/reviewers', () => {
  it('lists the currently-banned reviewers', async () => {
    await t.db.insert(profiles).values([
      { id: u(1), bannedAt: '2026-01-02T00:00:00.000Z', banReason: 'a' },
      { id: u(2) }, // not banned
    ]);
    const res = await listApp().request(
      '/api/admin/reviewers',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = (await res.json()) as { total: number; data: Array<{ reviewer_id: string }> };
    expect(body.total).toBe(1);
    expect(body.data[0]!.reviewer_id).toBe(u(1));
  });
});
