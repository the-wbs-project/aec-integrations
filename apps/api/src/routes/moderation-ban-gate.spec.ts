/**
 * Moderation ban gate — end-to-end immediate effect (AECI-524 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §7).
 *
 * The AECI-520 deny matrix already proves a *pre-seeded* banned `vendor_admin`
 * gets 403 on every `/api/vendor/*` route. This spec proves the property the §7
 * gate actually hangs on: banning a seat takes effect on the VERY NEXT request,
 * with the SAME already-issued token — there is no cached-token bypass, because
 * `createAuthzMiddleware` re-fetches `banned_at` from D1 on every request.
 *
 * It composes the REAL `requireAdmin()` + ban handler with the REAL
 * `requireVendor()` + vendor handler over one shared in-memory D1, driven by
 * genuinely signed JWTs (offline JWKS). The sequence, all with one unchanged
 * vendor token:
 *   1. GET /api/vendor/me            → 200 (active granted seat)
 *   2. admin bans the seat           → 200
 *   3. GET /api/vendor/me (same tok) → 403 'Portal abuse'   ← immediate effect
 *   4. admin unbans the seat         → 200
 *   5. GET /api/vendor/me (same tok) → 200                  ← unban restores access
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { productVendors, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, requireVendor, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { createBanReviewerHandler } from './admin-reviewers';
import { createVendorMeHandler } from './vendor';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ENV = { ENV: 'preview', SUPABASE_URL } as Env;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const PRODUCT = uuid(10);
const SEAT = uuid(100); // the granted vendor_admin seat under test
const ADMIN = uuid(900); // the acting site admin

let t: TestDb;
let jwks: TestJwks;

beforeEach(async () => {
  t = await makeTestDb();
  jwks = await makeTestJwks();

  await t.db
    .insert(vendors)
    .values({ id: VENDOR, slug: 'autodesk', companyName: 'Autodesk', verified: true });
  await t.db.insert(products).values({ id: PRODUCT, slug: 'revit', name: 'Revit' });
  await t.db
    .insert(productVendors)
    .values({ productId: PRODUCT, vendorId: VENDOR, isPrimary: true });
  await t.db.insert(profiles).values([
    { id: SEAT, role: 'vendor_admin', vendorId: VENDOR },
    { id: ADMIN, role: 'admin' },
  ]);
});
afterEach(() => t.dispose());

/** Real admin ban route + real vendor read route, sharing one D1. Nothing is
 *  stubbed but the JWKS (offline keypair). */
function makeApp() {
  const guard = { getKey: jwks.getKey, dbFor: t.factory };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get('/api/vendor/me', requireVendor(guard), createVendorMeHandler(t.factory));
  app.patch('/api/admin/reviewers/:id', requireAdmin(guard), createBanReviewerHandler(t.factory));
  return app;
}

async function tokenFor(sub: string): Promise<string> {
  return jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL });
}

type Result = { status: number; body: Record<string, unknown> };

async function request(
  token: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<Result> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await makeApp().request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    ENV,
    fakeExecutionContext(),
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe('moderation ban gate — immediate effect on /api/vendor/* (AECI-524)', () => {
  it('a ban blocks the next request with the same token; unban restores it', async () => {
    // One vendor token, minted once and reused for every vendor call below — so
    // any change in outcome is due to the D1 ban state, not a re-issued token.
    const vendorToken = await tokenFor(SEAT);
    const adminToken = await tokenFor(ADMIN);

    // 1. Active granted seat → 200.
    expect((await request(vendorToken, '/api/vendor/me', 'GET')).status).toBe(200);

    // 2. Admin bans the seat.
    const ban = await request(adminToken, `/api/admin/reviewers/${SEAT}`, 'PATCH', {
      action: 'ban',
      reason: 'Portal abuse',
    });
    expect(ban.status).toBe(200);

    // 3. The SAME vendor token now 403s on the very next request — no cached
    //    token bypasses the fresh D1 ban read. The ban reason surfaces.
    const blocked = await request(vendorToken, '/api/vendor/me', 'GET');
    expect(blocked.status).toBe(403);
    expect((blocked.body.error as { message?: string })?.message).toBe('Portal abuse');

    // 4. Admin unbans the seat.
    expect(
      (await request(adminToken, `/api/admin/reviewers/${SEAT}`, 'PATCH', { action: 'unban' }))
        .status,
    ).toBe(200);

    // 5. Access is restored with no re-grant — the seat is still a linked
    //    vendor_admin (ban never touched role/vendor_id), so the same token 200s.
    expect((await request(vendorToken, '/api/vendor/me', 'GET')).status).toBe(200);
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT));
    expect(seat!.role).toBe('vendor_admin');
    expect(seat!.vendorId).toBe(VENDOR);
    expect(seat!.bannedAt).toBeNull();
  });
});
