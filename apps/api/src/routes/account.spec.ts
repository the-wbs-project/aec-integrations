/**
 * GET / PATCH / DELETE /api/account on the Drizzle/D1 path (ADR 0016 / AECI-253,
 * AECI-254), against the in-memory D1 harness. DELETE asserts the atomic erasure
 * batch (null inbound refs + audit + delete profile) and the injected seam-#3
 * auth-user delete.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, products, profiles, reviews } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createDeleteAccountHandler,
  createGetAccountHandler,
  createUpdateAccountHandler,
} from './account';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = u(900);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

type Handler = Parameters<typeof appFor>[0];
function appFor(handler: (c: never) => Promise<Response>, method: 'get' | 'patch' | 'delete') {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', { userId: USER, email: 'me@example.com', role: 'reviewer' });
    await next();
  });
  a.on(method.toUpperCase(), '/api/account', handler as never);
  return a;
}
const run = (handler: Handler, method: 'get' | 'patch' | 'delete', body?: unknown) =>
  appFor(handler, method).request(
    '/api/account',
    {
      method: method.toUpperCase(),
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

describe('GET /api/account', () => {
  it('returns the session identity + display_name', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    const res = await run(createGetAccountHandler(t.factory), 'get');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_id: USER,
      email: 'me@example.com',
      display_name: 'Ada',
      role: 'reviewer',
    });
  });
});

describe('PATCH /api/account', () => {
  it('updates display_name and writes a profile.updated audit', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      display_name: 'Ada L.',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { display_name: string }).toMatchObject({
      display_name: 'Ada L.',
    });

    const [row] = await t.db.select().from(profiles);
    expect(row!.displayName).toBe('Ada L.');
    const audit = await t.db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('profile.updated');
  });
});

describe('DELETE /api/account', () => {
  it('erases the profile, anonymizes refs, audits, and deletes the auth user', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'p', name: 'P', promotionStatus: 'promoted' });
    await t.db.insert(reviews).values({
      id: u(11),
      productId: u(1),
      reviewerId: USER,
      ratingOverall: 5,
      ratingOnboarding: 4,
      title: 'T',
      body: 'B',
      status: 'approved',
    });

    const deleteAuthUser = vi.fn(async () => ({ ok: true }));
    const res = await run(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');
    expect(res.status).toBe(200);

    // Profile gone; review survives but is anonymized.
    expect(await t.db.select().from(profiles)).toHaveLength(0);
    const [review] = await t.db.select().from(reviews);
    expect(review!.reviewerId).toBeNull();

    // account.deleted audit written with a null actor.
    const audit = await t.db.select().from(auditLog);
    const deletion = audit.find((a) => a.action === 'account.deleted');
    expect(deletion).toBeDefined();
    expect(deletion!.actorId).toBeNull();

    // Seam #3 invoked with the user id.
    expect(deleteAuthUser).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('still succeeds (data erased) when the auth-user delete fails', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const deleteAuthUser = vi.fn(async () => ({ ok: false, status: 500, error: 'boom' }));
    const res = await run(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');
    expect(res.status).toBe(200);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
  });
});
