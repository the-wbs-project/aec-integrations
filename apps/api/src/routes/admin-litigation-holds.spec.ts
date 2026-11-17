/**
 * The litigation hold routes (AECI-1638, `ADMIN_PANEL_SPEC.md` §5.22b), handlers mounted
 * bare with an admin session. The guard and the limiter are proven by
 * `admin-litigation-holds.registration.spec.ts` and the deny matrix.
 *
 *   1. **Place** writes the row and its `litigation_hold.placed` audit row in one batch.
 *   2. **One open hold per scope.** A second open global hold, or a second open hold for
 *      the same vendor, is 409 `LITIGATION_HOLD_EXISTS` and writes nothing, whether the
 *      early read or the partial unique index catches it.
 *   3. **Release** stamps the row and writes `litigation_hold.released`. A second release
 *      is 409 `LITIGATION_HOLD_RELEASED`. A release that loses a race writes nothing.
 *   4. **The list** returns open holds and the latest released ones, with vendor names.
 */

import {
  ApiErrorCode,
  LitigationHoldsResponseSchema,
  LitigationHoldWriteResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, litigationHolds, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { logBatchToPosthog } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  createAdminLitigationHoldsHandler,
  createPlaceLitigationHoldHandler,
  createReleaseLitigationHoldHandler,
  isOpenHoldConflict,
} from './admin-litigation-holds';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const NOW = new Date('2026-11-17T15:00:00.000Z');
const ADMIN = '00000000-0000-4000-8000-000000000910';
const VENDOR = '00000000-0000-4000-8000-000000000911';

let t: TestDb;
beforeEach(async () => {
  vi.mocked(logBatchToPosthog).mockClear();
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
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
  const deps = { now: () => NOW };
  a.get('/api/admin/litigation-holds', createAdminLitigationHoldsHandler(t.factory, deps));
  a.post('/api/admin/litigation-holds', createPlaceLitigationHoldHandler(t.factory, deps));
  a.post(
    '/api/admin/litigation-holds/:id/release',
    createReleaseLitigationHoldHandler(t.factory, deps),
  );
  return a;
}

const ENV = { ENV: 'staging' } as unknown as Env;

async function call(method: string, path: string, body?: unknown) {
  return app().request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
    fakeExecutionContext(),
  );
}

const place = (body: unknown) => call('POST', '/api/admin/litigation-holds', body);
const holdAudit = async () =>
  (await t.db.select().from(auditLog)).filter((r) => r.action.startsWith('litigation_hold.'));

describe('POST /api/admin/litigation-holds', () => {
  it('places a vendor hold with its audit row in the same batch', async () => {
    const res = await place({
      scope: 'vendor',
      vendor_id: VENDOR,
      reason: 'Demand letter received',
      matter_reference: 'AECI-9999',
    });

    expect(res.status).toBe(201);
    const body = LitigationHoldWriteResponseSchema.parse(await res.json());
    expect(body.hold).toMatchObject({
      scope: 'vendor',
      vendor_id: VENDOR,
      vendor_name: 'Acme',
      matter_reference: 'AECI-9999',
      placed_by: ADMIN,
      placed_at: NOW.toISOString(),
      released_at: null,
    });
    const audit = await holdAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'litigation_hold.placed',
      entityType: 'litigation_hold',
      entityId: body.hold.id,
      vendorId: VENDOR,
      actorId: ADMIN,
      actorType: 'admin',
    });
    expect(vi.mocked(logBatchToPosthog)).toHaveBeenCalledTimes(1);
  });

  it('places a global hold with no vendor', async () => {
    const res = await place({ scope: 'global', reason: 'Subpoena' });
    expect(res.status).toBe(201);
    const body = LitigationHoldWriteResponseSchema.parse(await res.json());
    expect(body.hold).toMatchObject({ scope: 'global', vendor_id: null, vendor_name: null });
  });

  it('refuses a second open hold of the same scope with 409 and writes nothing', async () => {
    expect((await place({ scope: 'global', reason: 'One' })).status).toBe(201);
    expect((await place({ scope: 'vendor', vendor_id: VENDOR, reason: 'One' })).status).toBe(201);

    const global = await place({ scope: 'global', reason: 'Two' });
    const vendor = await place({ scope: 'vendor', vendor_id: VENDOR, reason: 'Two' });

    for (const res of [global, vendor]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: ApiErrorCode.LITIGATION_HOLD_EXISTS },
      });
    }
    expect(await t.db.select().from(litigationHolds)).toHaveLength(2);
    expect(await holdAudit()).toHaveLength(2);
  });

  it('maps the partial unique index error to the same 409', async () => {
    // The early read misses a hold committed after it; the index is the backstop.
    let error: unknown;
    try {
      t.raw
        .prepare(
          `INSERT INTO litigation_holds (id, scope, reason, placed_by, placed_at, created_at)
           VALUES ('h1', 'global', 'a', 'x', 'now', 'now'), ('h2', 'global', 'b', 'x', 'now', 'now')`,
        )
        .run();
    } catch (e) {
      error = e;
    }
    expect(isOpenHoldConflict(error)).toBe(true);
  });

  it('refuses a vendor hold with no vendor, and a global hold that names one', async () => {
    expect((await place({ scope: 'vendor', reason: 'x' })).status).toBe(400);
    expect((await place({ scope: 'global', vendor_id: VENDOR, reason: 'x' })).status).toBe(400);
    expect((await place({ scope: 'global', reason: '   ' })).status).toBe(400);
    expect(await t.db.select().from(litigationHolds)).toEqual([]);
  });

  it('is 404 for a vendor that does not exist', async () => {
    const res = await place({ scope: 'vendor', vendor_id: 'nope', reason: 'x' });
    expect(res.status).toBe(404);
    expect(await t.db.select().from(litigationHolds)).toEqual([]);
  });
});

describe('POST /api/admin/litigation-holds/:id/release', () => {
  async function placed(): Promise<string> {
    const res = await place({ scope: 'vendor', vendor_id: VENDOR, reason: 'Demand letter' });
    return LitigationHoldWriteResponseSchema.parse(await res.json()).hold.id;
  }
  const release = (id: string, reason = 'Matter settled') =>
    call('POST', `/api/admin/litigation-holds/${id}/release`, { reason });

  it('releases the hold and writes its audit row', async () => {
    const id = await placed();
    const res = await release(id);

    expect(res.status).toBe(200);
    const body = LitigationHoldWriteResponseSchema.parse(await res.json());
    expect(body.hold).toMatchObject({
      released_at: NOW.toISOString(),
      released_by: ADMIN,
      release_reason: 'Matter settled',
    });
    const [row] = await t.db.select().from(litigationHolds).where(eq(litigationHolds.id, id));
    expect(row?.releasedAt).toBe(NOW.toISOString());
    expect((await holdAudit()).map((r) => r.action)).toEqual([
      'litigation_hold.placed',
      'litigation_hold.released',
    ]);
  });

  it('refuses a second release with 409 and writes nothing', async () => {
    const id = await placed();
    await release(id);
    const res = await release(id, 'Again');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: ApiErrorCode.LITIGATION_HOLD_RELEASED },
    });
    expect(await holdAudit()).toHaveLength(2);
  });

  it('writes nothing when another release lands between the read and the batch', async () => {
    const id = await placed();
    const batch = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (stmts) => {
      await t.db
        .update(litigationHolds)
        .set({ releasedAt: '2026-11-17T14:59:00.000Z', releasedBy: 'other', releaseReason: 'x' })
        .where(eq(litigationHolds.id, id));
      return batch(stmts);
    });

    const res = await release(id);
    spy.mockRestore();

    expect(res.status).toBe(409);
    const [row] = await t.db.select().from(litigationHolds).where(eq(litigationHolds.id, id));
    expect(row?.releasedBy).toBe('other');
    expect(await holdAudit()).toHaveLength(1);
  });

  it('is 404 for an unknown hold, and 400 without a reason', async () => {
    expect((await release('nope')).status).toBe(404);
    const id = await placed();
    expect((await release(id, '')).status).toBe(400);
  });

  it('lets a new hold be placed once the old one is released', async () => {
    const id = await placed();
    await release(id);
    expect((await place({ scope: 'vendor', vendor_id: VENDOR, reason: 'New matter' })).status).toBe(
      201,
    );
  });
});

describe('GET /api/admin/litigation-holds', () => {
  it('lists open holds and released holds, newest first, with the vendor name', async () => {
    await place({ scope: 'global', reason: 'Global matter' });
    const res = await place({ scope: 'vendor', vendor_id: VENDOR, reason: 'Vendor matter' });
    const vendorHold = LitigationHoldWriteResponseSchema.parse(await res.json()).hold.id;
    await call('POST', `/api/admin/litigation-holds/${vendorHold}/release`, { reason: 'Done' });

    const list = await call('GET', '/api/admin/litigation-holds');
    expect(list.status).toBe(200);
    const body = LitigationHoldsResponseSchema.parse(await list.json());
    expect(body.open.map((h) => h.scope)).toEqual(['global']);
    expect(body.released).toHaveLength(1);
    expect(body.released[0]).toMatchObject({ id: vendorHold, vendor_name: 'Acme' });
    // A read writes no audit row.
    expect((await holdAudit()).map((r) => r.action)).toEqual([
      'litigation_hold.placed',
      'litigation_hold.placed',
      'litigation_hold.released',
    ]);
  });
});
