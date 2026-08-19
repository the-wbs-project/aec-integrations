/**
 * Unit coverage for the Phase 5.5 authz middleware (AECI-196), on the Drizzle/D1
 * path (ADR 0016 / AECI-254). A locally-generated ES256 keypair stands in for the
 * Supabase JWKS via the `getKey` seam, tokens are minted with `SignJWT`, and the
 * profile lookup runs against the in-memory D1 harness (seeded `profiles` rows),
 * injected via the `dbFor` seam. Covers the AC matrix: no token → 401, invalid →
 * 401, missing profile → 401, banned → 403 (FORBIDDEN / REVIEW_BANNED), non-admin
 * on an admin route → 403, uid+role threading, cookie-path extraction, and that
 * the DB is never touched before the JWT verifies (via a `dbFor` call counter).
 *
 * AECI-520 extends it with `requireVendor()` (Stage 2 vendor portal,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4): the role × `vendor_id` × ban matrix,
 * including the explicit "a site `admin` is NOT a vendor" cell (no impersonation
 * at launch) and the half-granted `vendor_admin` with a null `vendor_id`.
 */

import { ApiErrorCode } from '@aeci/shared';
import { CAPABILITIES } from '@aeci/shared/entitlements';
import { Hono } from 'hono';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { profiles, vendorEntitlements, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, errorHandler } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  auditActorType,
  extractSessionCookieToken,
  requireAdmin,
  requireAuth,
  requireCapability,
  requireVendor,
  type AuthzContext,
  type AuthzOptions,
  type AuthzVariables,
} from './authz';
import type { DbFactory } from './handler-utils';
import type { Db } from '../db/client';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' };
  getKey = createLocalJWKSet({ keys: [publicJwk] });
});

type SignOptions = {
  sub?: string;
  email?: string;
  expiresIn?: string;
};

async function mintToken(opts: SignOptions = {}): Promise<string> {
  const payload: Record<string, unknown> = { sub: opts.sub ?? 'user-123' };
  if (opts.email !== undefined) payload.email = opts.email;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(privateKey);
}

/** Per-test in-memory D1 + a `dbFor` counter (proves the DB is untouched until
 *  the JWT verifies). Reset in `beforeEach`. */
let t: TestDb;
let dbCalls: number;
const dbFor: DbFactory = (env, bookmark) => {
  dbCalls++;
  return t.factory(env, bookmark);
};

beforeEach(async () => {
  t = await makeTestDb();
  dbCalls = 0;
});
afterEach(() => t.dispose());

type ProfileSeed = {
  role?: string;
  vendorId?: string | null;
  bannedAt?: string | null;
  banReason?: string | null;
};

/** Seed one `profiles` row keyed by `id` (the verified token `sub`). */
async function seedProfile(id: string, seed: ProfileSeed = {}): Promise<void> {
  await t.db.insert(profiles).values({ id, ...seed });
}

/** The vendor a granted `vendor_admin` seat points at (`profiles.vendor_id`
 *  FKs `vendors.id`, and the harness runs with foreign keys ON). */
const VENDOR_ID = '99999999-9999-4999-8999-999999999999';
/** A second vendor, so the join can be proved to scope by `profiles.vendor_id`
 *  rather than picking up whatever entitlement row happens to exist. */
const OTHER_VENDOR_ID = '88888888-8888-4888-8888-888888888888';
async function seedVendor(): Promise<void> {
  await t.db.insert(vendors).values([
    { id: VENDOR_ID, slug: 'autodesk', companyName: 'Autodesk' },
    { id: OTHER_VENDOR_ID, slug: 'bentley', companyName: 'Bentley' },
  ]);
}

let entitlementSeq = 0;
/** Seed one `vendor_entitlements` row (AECI-609). Defaults to the launch grant:
 *  the paid entry rung, active, perpetual. */
async function seedEntitlement(
  vendorId: string,
  seed: { tier?: string; status?: string; periodEnd?: string | null } = {},
): Promise<void> {
  await t.db.insert(vendorEntitlements).values({
    id: `77777777-7777-4777-8777-${String(++entitlementSeq).padStart(12, '0')}`,
    vendorId,
    tier: seed.tier ?? 'verified',
    status: seed.status ?? 'active',
    periodEnd: seed.periodEnd ?? null,
  });
}

const REVIEWER: ProfileSeed = { role: 'reviewer' };
const ADMIN: ProfileSeed = { role: 'admin' };
/** A fully granted vendor-portal seat (AECI-520). */
const VENDOR_ADMIN: ProfileSeed = { role: 'vendor_admin', vendorId: VENDOR_ID };
const BANNED: ProfileSeed = {
  role: 'reviewer',
  bannedAt: '2026-06-01T00:00:00.000Z',
  banReason: 'Spam reviews',
};

/**
 * Tiny app mounting both guard variants the way the Phase 5.6+ routers will:
 * `POST /api/reviews` behind `requireAuth({ bannedCode: REVIEW_BANNED })`,
 * `DELETE /api/account` behind plain `requireAuth()`, and
 * `PATCH /api/admin/reviews/:id` behind `requireAdmin()`. Each handler echoes
 * `c.get('auth')` so threading is observable. The reviews handler also echoes
 * a client-supplied `reviewer_id` body field next to the server-set value to
 * pin the "client can never supply it" contract. The profile lookup runs against
 * the harness via the `dbFor` seam.
 */
function makeApp() {
  const options: AuthzOptions = { getKey, dbFor };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.post(
    '/api/reviews',
    requireAuth({ ...options, bannedCode: ApiErrorCode.REVIEW_BANNED }),
    async (c) => {
      const auth = c.get('auth');
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // The §4.5 contract: reviewer_id comes from the verified session,
      // regardless of what the client sent.
      return c.json({ auth, reviewerId: auth.userId, clientSent: body['reviewer_id'] ?? null });
    },
  );
  app.delete('/api/account', requireAuth(options), (c) => c.json({ auth: c.get('auth') }));
  app.patch('/api/admin/reviews/:id', requireAdmin(options), (c) =>
    c.json({ auth: c.get('auth') }),
  );
  // AECI-520 — the vendor-portal guard. Echoes the session so `vendorId`
  // threading (what every `/api/vendor/*` handler scopes by) is observable.
  app.get('/api/vendor/me', requireVendor(options), (c) => c.json({ auth: c.get('auth') }));
  return app;
}

const ENV = { SUPABASE_URL } as Env;

type CallResult = {
  status: number;
  body: {
    error?: { code: string; message?: string };
    auth?: {
      userId: string;
      email?: string;
      role: string;
      vendorId: string | null;
      entitlementTier?: string;
      entitlement?: { status: string; periodEnd: string | null } | null;
    };
    reviewerId?: string;
    clientSent?: unknown;
  };
};

async function call(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  path: string,
  method: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<CallResult> {
  const res = await app.request(path, { method, headers, body }, ENV);
  return { status: res.status, body: (await res.json()) as CallResult['body'] };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Encode a session object the way `@supabase/ssr` writes its cookie value. */
function encodeSessionCookie(session: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(session))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `base64-${b64}`;
}

describe('requireAuth', () => {
  it('rejects a missing token with 401 UNAUTHENTICATED and never touches the DB', async () => {
    await seedProfile('user-123', REVIEWER);
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE');
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
    expect(dbCalls).toBe(0);
  });

  it('rejects an invalid token with 401 and never touches the DB', async () => {
    await seedProfile('user-123', REVIEWER);
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', bearer('not-a-jwt'));
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
    expect(dbCalls).toBe(0);
  });

  it('rejects an expired token with 401', async () => {
    await seedProfile('user-123', REVIEWER);
    const token = await mintToken({ expiresIn: '-1h' });
    const { status } = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(status).toBe(401);
  });

  it('rejects a verified token whose profile row is missing with 401', async () => {
    const token = await mintToken({ sub: 'user-ghost' });
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
    expect(dbCalls).toBe(1); // the DB WAS queried (after verify) and returned no row
  });

  it('rejects a banned user with 403 FORBIDDEN (default) and surfaces the ban reason', async () => {
    await seedProfile('user-banned', BANNED);
    const token = await mintToken({ sub: 'user-banned' });
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(body.error?.message).toBe('Spam reviews');
  });

  it('rejects a banned user with 403 REVIEW_BANNED on a review write', async () => {
    await seedProfile('user-banned', BANNED);
    const token = await mintToken({ sub: 'user-banned' });
    const { status, body } = await call(makeApp(), '/api/reviews', 'POST', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.code).toBe(ApiErrorCode.REVIEW_BANNED);
  });

  it('threads the verified uid, email, and DB role to the handler', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc', email: 'a@example.com' });
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(status).toBe(200);
    expect(body.auth).toEqual({
      userId: 'user-abc',
      email: 'a@example.com',
      role: 'reviewer',
      vendorId: null,
      // AECI-611: a non-vendor session never resolves to a paid tier, and never
      // runs the entitlement join.
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    expect(dbCalls).toBe(1);
  });

  it('server-sets reviewer_id from the verified uid, ignoring the client-supplied value', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const { status, body } = await call(
      makeApp(),
      '/api/reviews',
      'POST',
      { ...bearer(token), 'Content-Type': 'application/json' },
      JSON.stringify({ reviewer_id: 'user-evil' }),
    );
    expect(status).toBe(200);
    expect(body.reviewerId).toBe('user-abc');
    expect(body.clientSent).toBe('user-evil');
  });

  it('accepts the session via an sb-*-auth-token cookie (verified, not trusted)', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const cookie = `sb-test-project-auth-token=${encodeSessionCookie({ access_token: token })}`;
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', { Cookie: cookie });
    expect(status).toBe(200);
    expect(body.auth?.userId).toBe('user-abc');
  });

  it('reassembles a chunked session cookie', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const encoded = encodeSessionCookie({ access_token: token, padding: 'x'.repeat(64) });
    const mid = Math.floor(encoded.length / 2);
    const cookie = [
      `sb-test-project-auth-token.0=${encoded.slice(0, mid)}`,
      `sb-test-project-auth-token.1=${encoded.slice(mid)}`,
    ].join('; ');
    const { status, body } = await call(makeApp(), '/api/account', 'DELETE', { Cookie: cookie });
    expect(status).toBe(200);
    expect(body.auth?.userId).toBe('user-abc');
  });

  it('rejects an invalid cookie session token with 401', async () => {
    await seedProfile('user-abc', REVIEWER);
    const cookie = `sb-test-project-auth-token=${encodeSessionCookie({ access_token: 'garbage' })}`;
    const { status } = await call(makeApp(), '/api/account', 'DELETE', { Cookie: cookie });
    expect(status).toBe(401);
  });

  it('does not fall back to the cookie when a bearer token is present but invalid', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const cookie = `sb-test-project-auth-token=${encodeSessionCookie({ access_token: token })}`;
    const { status } = await call(makeApp(), '/api/account', 'DELETE', {
      ...bearer('not-a-jwt'),
      Cookie: cookie,
    });
    expect(status).toBe(401);
  });
});

describe('requireAdmin', () => {
  it('rejects a non-admin with 403 FORBIDDEN', async () => {
    await seedProfile('user-abc', REVIEWER);
    const token = await mintToken({ sub: 'user-abc' });
    const { status, body } = await call(makeApp(), '/api/admin/reviews/r1', 'PATCH', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.code).toBe(ApiErrorCode.FORBIDDEN);
  });

  it('rejects a banned admin with 403 before the role grants access', async () => {
    await seedProfile('user-banned-admin', {
      ...ADMIN,
      bannedAt: '2026-06-01T00:00:00.000Z',
      banReason: null,
    });
    const token = await mintToken({ sub: 'user-banned-admin' });
    const { status } = await call(makeApp(), '/api/admin/reviews/r1', 'PATCH', bearer(token));
    expect(status).toBe(403);
  });

  it('rejects a missing token with 401', async () => {
    await seedProfile('user-admin', ADMIN);
    const { status } = await call(makeApp(), '/api/admin/reviews/r1', 'PATCH');
    expect(status).toBe(401);
  });

  it('accepts an admin and threads the session', async () => {
    await seedProfile('user-admin', ADMIN);
    const token = await mintToken({ sub: 'user-admin' });
    const { status, body } = await call(makeApp(), '/api/admin/reviews/r1', 'PATCH', bearer(token));
    expect(status).toBe(200);
    expect(body.auth).toEqual({
      userId: 'user-admin',
      email: undefined,
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
  });
});

/**
 * AECI-520 — the vendor-portal guard (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4).
 * The matrix is role × `vendor_id` × ban. Two cells are the ones worth being
 * loud about:
 *   - a site `admin` is REJECTED (no impersonation at launch — admins act
 *     through `/api/admin/*` so the audit trail names the real actor);
 *   - a `vendor_admin` with a NULL `vendor_id` is rejected, because there is
 *     nothing to scope its queries by (a half-granted seat).
 */
describe('requireVendor', () => {
  const VENDOR_PATH = '/api/vendor/me';

  it('rejects an anonymous caller with 401', async () => {
    const { status, body } = await call(makeApp(), VENDOR_PATH, 'GET');
    expect(status).toBe(401);
    expect(body.error?.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('rejects a verified token with no profiles row with 401', async () => {
    const token = await mintToken({ sub: 'user-ghost' });
    const { status } = await call(makeApp(), VENDOR_PATH, 'GET', bearer(token));
    expect(status).toBe(401);
  });

  it('rejects a reviewer with 403 FORBIDDEN', async () => {
    await seedProfile('user-reviewer', REVIEWER);
    const token = await mintToken({ sub: 'user-reviewer' });
    const { status, body } = await call(makeApp(), VENDOR_PATH, 'GET', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.code).toBe(ApiErrorCode.FORBIDDEN);
  });

  it('rejects a site admin with 403 — no impersonation at launch', async () => {
    await seedProfile('user-admin', ADMIN);
    const token = await mintToken({ sub: 'user-admin' });
    const { status, body } = await call(makeApp(), VENDOR_PATH, 'GET', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.message).toBe('Vendor admin role required');
  });

  it('rejects a vendor_admin whose vendor_id is null with 403', async () => {
    await seedProfile('user-halfgrant', { role: 'vendor_admin', vendorId: null });
    const token = await mintToken({ sub: 'user-halfgrant' });
    const { status, body } = await call(makeApp(), VENDOR_PATH, 'GET', bearer(token));
    expect(status).toBe(403);
    expect(body.error?.message).toBe('Vendor account is not linked to a vendor');
  });

  it('rejects a banned vendor_admin with 403 before the role grants access', async () => {
    await seedVendor();
    await seedProfile('user-banned-vendor', {
      ...VENDOR_ADMIN,
      bannedAt: '2026-07-01T00:00:00.000Z',
      banReason: 'Portal abuse',
    });
    const token = await mintToken({ sub: 'user-banned-vendor' });
    const { status, body } = await call(makeApp(), VENDOR_PATH, 'GET', bearer(token));
    expect(status).toBe(403);
    // The ban reason surfaces, which is only possible if the ban check ran
    // BEFORE the role check — the §7 / AECI-524 gate ordering.
    expect(body.error?.message).toBe('Portal abuse');
  });

  it('accepts a granted seat and threads vendorId onto the session', async () => {
    await seedVendor();
    await seedProfile('user-vendor', VENDOR_ADMIN);
    const token = await mintToken({ sub: 'user-vendor', email: 'ops@autodesk.test' });
    const { status, body } = await call(makeApp(), VENDOR_PATH, 'GET', bearer(token));
    expect(status).toBe(200);
    expect(body.auth).toEqual({
      userId: 'user-vendor',
      email: 'ops@autodesk.test',
      role: 'vendor_admin',
      vendorId: VENDOR_ID,
      // The join ran and found nothing — this vendor has no entitlement row, so
      // it authenticates, passes the guard, reads its dashboard, and writes
      // nothing (AECI-611 fail-closed).
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
  });

  it('never touches the DB when the token fails verification', async () => {
    await seedVendor();
    await seedProfile('user-vendor', VENDOR_ADMIN);
    dbCalls = 0;
    const { status } = await call(makeApp(), VENDOR_PATH, 'GET', bearer('not-a-jwt'));
    expect(status).toBe(401);
    expect(dbCalls).toBe(0);
  });
});

/**
 * AECI-611 — the entitlement on the session (`STAGE_2_PAID_TIERS_SPEC.md` §4.1).
 *
 * The tier is loaded by `requireVendor()`'s profile read, which became a
 * `leftJoin` onto `vendor_entitlements`. Everything below is about ONE property:
 * **the tier fails closed on every axis**. There is no input — a missing row, a
 * lapsed status, an unknown tier, another vendor's row — that yields anything
 * but `'unclaimed'` unless the caller genuinely holds an active entitlement.
 */
describe('requireVendor — the entitlement join', () => {
  const VENDOR_PATH = '/api/vendor/me';

  async function sessionFor(sub: string) {
    const token = await mintToken({ sub });
    const { status, body } = await call(makeApp(), VENDOR_PATH, 'GET', bearer(token));
    return { status, auth: body.auth };
  }

  async function seedSeat(): Promise<void> {
    await seedVendor();
    await seedProfile('user-vendor', VENDOR_ADMIN);
  }

  it('resolves an ACTIVE entitlement to its tier, with the term readout', async () => {
    await seedSeat();
    await seedEntitlement(VENDOR_ID, { periodEnd: '2027-01-01T00:00:00.000Z' });
    const { status, auth } = await sessionFor('user-vendor');
    expect(status).toBe(200);
    expect(auth?.entitlementTier).toBe('verified');
    expect(auth?.entitlement).toEqual({
      status: 'active',
      periodEnd: '2027-01-01T00:00:00.000Z',
    });
  });

  it('resolves a vendor with NO entitlement row to unclaimed, and still lets it in', async () => {
    await seedSeat();
    const { status, auth } = await sessionFor('user-vendor');
    // The guard still passes — the entitlement decides what you may WRITE, never
    // whether you may authenticate or read (§4.3).
    expect(status).toBe(200);
    expect(auth?.entitlementTier).toBe('unclaimed');
    expect(auth?.entitlement).toBeNull();
  });

  // The fail-closed matrix. `pending` is the offline-invoicing limbo (§2.2):
  // arrangement recorded, not yet effective — so it must NOT grant anything.
  it.each([['pending'], ['expired'], ['revoked']])(
    'resolves a %s entitlement to unclaimed while still reporting its status',
    async (status) => {
      await seedSeat();
      await seedEntitlement(VENDOR_ID, { status, periodEnd: '2026-01-01T00:00:00.000Z' });
      const { auth } = await sessionFor('user-vendor');
      expect(auth?.entitlementTier).toBe('unclaimed');
      // The term readout survives the downgrade on purpose: the §8 dashboard
      // needs to say "expired on …", not merely "locked".
      expect(auth?.entitlement).toEqual({ status, periodEnd: '2026-01-01T00:00:00.000Z' });
    },
  );

  it('resolves an ACTIVE row with a tier this build does not know to unclaimed', async () => {
    await seedSeat();
    // `vendor_entitlements.tier` has NO CHECK by design (§2.2) so a new rung is
    // a data edit. The safety of that decision rests entirely on this cell: an
    // unknown tier must buy nothing, not everything.
    await seedEntitlement(VENDOR_ID, { tier: 'platinum-enterprise-max' });
    const { auth } = await sessionFor('user-vendor');
    expect(auth?.entitlementTier).toBe('unclaimed');
  });

  it('never picks up another vendor’s entitlement', async () => {
    await seedSeat();
    await seedEntitlement(OTHER_VENDOR_ID);
    const { auth } = await sessionFor('user-vendor');
    expect(auth?.entitlementTier).toBe('unclaimed');
  });

  it('resolves a BANNED seat with an active entitlement to 403, before any tier question', async () => {
    await seedVendor();
    await seedEntitlement(VENDOR_ID);
    await seedProfile('user-banned-vendor', {
      ...VENDOR_ADMIN,
      bannedAt: '2026-07-01T00:00:00.000Z',
      banReason: 'Portal abuse',
    });
    const token = await mintToken({ sub: 'user-banned-vendor' });
    const { status, body } = await call(makeApp(), VENDOR_PATH, 'GET', bearer(token));
    // AECI-524: the ban is orthogonal to and STRICTLY EARLIER than the
    // entitlement. A paid-up vendor's banned seat is still locked out, and the
    // rejection names the ban rather than the plan.
    expect(status).toBe(403);
    expect(body.error?.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(body.error?.message).toBe('Portal abuse');
  });

  it('takes exactly ONE round-trip — the join replaces the profile read', async () => {
    await seedSeat();
    await seedEntitlement(VENDOR_ID);
    dbCalls = 0;
    const { status } = await sessionFor('user-vendor');
    expect(status).toBe(200);
    // §4.1's whole argument for putting this on the session rather than in a
    // separate middleware: a middleware would need `vendorId` first, so its read
    // would SERIALIZE after the guard's — 2 round-trips per `/api/vendor/*` call.
    expect(dbCalls).toBe(1);
  });
});

/**
 * §4.1's other half, and the reason the join is on ONE branch: `requireAuth()`
 * fronts the review-submit hot path and `requireAdmin()` fronts `/api/admin/*`,
 * where an unconditional join would be a `LEFT JOIN … ON NULL` on every request.
 * Both must keep issuing exactly the read they issued before this issue.
 */
describe('requireAuth / requireAdmin do not run the entitlement join', () => {
  it('reports unclaimed for a vendor_admin WITH an active entitlement, via requireAuth', async () => {
    await seedVendor();
    await seedEntitlement(VENDOR_ID);
    await seedProfile('user-vendor', VENDOR_ADMIN);
    const token = await mintToken({ sub: 'user-vendor' });

    // Same user, same DB, two guards. Through `requireVendor()` the tier is
    // real; through `requireAuth()` it is the fail-closed floor — which is only
    // possible if `requireAuth()` never ran the join.
    const viaVendor = await call(makeApp(), '/api/vendor/me', 'GET', bearer(token));
    expect(viaVendor.body.auth?.entitlementTier).toBe('verified');

    const viaAuth = await call(makeApp(), '/api/account', 'DELETE', bearer(token));
    expect(viaAuth.status).toBe(200);
    expect(viaAuth.body.auth?.entitlementTier).toBe('unclaimed');
    expect(viaAuth.body.auth?.entitlement).toBeNull();
  });

  /**
   * The structural half: a fake `Db` that implements BOTH read shapes and
   * records which one the guard reached for. `requireAuth()`/`requireAdmin()`
   * must call `db.query.profiles.findFirst` and never `db.select()`; the vendor
   * branch must do the opposite. This is the assertion that fails if someone
   * "simplifies" the branch into an unconditional join.
   */
  function fakeDb(row: Record<string, unknown>) {
    const findFirst = vi.fn(async () => row);
    const select = vi.fn(() => ({
      from: () => ({
        leftJoin: () => ({ where: () => ({ limit: async () => [row] }) }),
      }),
    }));
    const db = { query: { profiles: { findFirst } }, select } as unknown as Db;
    const dbFor: DbFactory = () => ({ db, getBookmark: () => null });
    return { findFirst, select, dbFor };
  }

  const VENDOR_ROW = {
    role: 'vendor_admin',
    vendorId: VENDOR_ID,
    bannedAt: null,
    banReason: null,
    entTier: 'verified',
    entStatus: 'active',
    entPeriodEnd: null,
  };

  it.each([
    ['requireAuth', requireAuth, '/api/account', 'DELETE'],
    ['requireAdmin', requireAdmin, '/api/admin/reviews/r1', 'PATCH'],
  ] as const)('%s issues findFirst and never select()', async (_label, guard, path, method) => {
    const role = guard === requireAdmin ? 'admin' : 'reviewer';
    const { findFirst, select, dbFor: fake } = fakeDb({ ...VENDOR_ROW, role, vendorId: null });
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.all(path, guard({ getKey, dbFor: fake }), (c) => c.json({ auth: c.get('auth') }));

    const token = await mintToken({ sub: 'user-x' });
    const res = await app.request(path, { method, headers: bearer(token) }, ENV);
    expect(res.status).toBe(200);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it('requireVendor issues select() (the join) and never findFirst', async () => {
    const { findFirst, select, dbFor: fake } = fakeDb(VENDOR_ROW);
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.get('/api/vendor/me', requireVendor({ getKey, dbFor: fake }), (c) =>
      c.json({ auth: c.get('auth') }),
    );

    const token = await mintToken({ sub: 'user-vendor' });
    const res = await app.request('/api/vendor/me', { headers: bearer(token) }, ENV);
    expect(res.status).toBe(200);
    expect(select).toHaveBeenCalledTimes(1);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

/**
 * `requireCapability` — the DB-free gate (§3.3a / §4.2). No harness, no seam:
 * it reads one field off the session a guard already populated.
 */
describe('requireCapability', () => {
  const ctxFor = (auth: Partial<AuthzVariables['auth']>) =>
    ({
      get: () => ({
        userId: 'u',
        role: 'vendor_admin',
        vendorId: VENDOR_ID,
        entitlementTier: 'unclaimed',
        entitlement: null,
        ...auth,
      }),
    }) as unknown as AuthzContext;

  it('passes when the tier holds the capability', () => {
    expect(() =>
      requireCapability(ctxFor({ entitlementTier: 'verified' }), 'profile.edit'),
    ).not.toThrow();
  });

  it('throws 403 ENTITLEMENT_REQUIRED — not 402, not 404 — when it does not', () => {
    let thrown: unknown;
    try {
      requireCapability(ctxFor({ entitlementTier: 'unclaimed' }), 'profile.edit');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const err = thrown as ApiError;
    // 402 Payment Required is semantically tempting and wrong: it leaks a
    // billing model into a contract that must stay payer-model-agnostic
    // (§8.1(4)), and API_CONTRACTS.md §4.1 has no 402 row.
    expect(err.status).toBe(403);
    expect(err.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    expect(err.details).toEqual({ capability: 'profile.edit', tier: 'unclaimed' });
  });

  it('never mentions ranking or placement — an entitlement buys capability, not position', () => {
    let message = '';
    try {
      requireCapability(ctxFor({}), 'product.edit');
    } catch (e) {
      message = (e as ApiError).message;
    }
    expect(message).not.toMatch(/rank|placement|position|boost|sponsor|priorit|top of/i);
  });

  it('gates every capability the unclaimed tier lacks', () => {
    for (const capability of CAPABILITIES) {
      expect(() => requireCapability(ctxFor({}), capability)).toThrow(ApiError);
      expect(() =>
        requireCapability(ctxFor({ entitlementTier: 'verified' }), capability),
      ).not.toThrow();
    }
  });
});

describe('extractSessionCookieToken', () => {
  it('returns null when no session cookie is present', () => {
    expect(extractSessionCookieToken({ theme: 'dark', other: 'x' })).toBeNull();
  });

  it('returns null for an unparseable cookie value', () => {
    expect(extractSessionCookieToken({ 'sb-ref-auth-token': 'base64-!!!notbase64' })).toBeNull();
    expect(extractSessionCookieToken({ 'sb-ref-auth-token': 'not-json' })).toBeNull();
  });

  it('returns null when the session JSON has no access_token', () => {
    const value = encodeSessionCookie({ refresh_token: 'r' });
    expect(extractSessionCookieToken({ 'sb-ref-auth-token': value })).toBeNull();
  });

  it('parses a raw-JSON (non-base64) cookie value', () => {
    const value = JSON.stringify({ access_token: 'tok' });
    expect(extractSessionCookieToken({ 'sb-ref-auth-token': value })).toBe('tok');
  });

  it('orders chunks numerically (10 after 2)', () => {
    const encoded = encodeSessionCookie({ access_token: 'tok', pad: 'y'.repeat(300) });
    const size = Math.ceil(encoded.length / 11);
    const cookies: Record<string, string> = {};
    for (let i = 0; i < 11; i++) {
      cookies[`sb-ref-auth-token.${i}`] = encoded.slice(i * size, (i + 1) * size);
    }
    expect(extractSessionCookieToken(cookies)).toBe('tok');
  });
});

describe('auditActorType', () => {
  it('maps admin → admin and everything else → user', () => {
    expect(auditActorType({ role: 'admin' })).toBe('admin');
    expect(auditActorType({ role: 'reviewer' })).toBe('user');
    expect(auditActorType({ role: 'vendor' })).toBe('user');
  });

  // AECI-520: deliberate, not an oversight. `audit_log_actor_type_check` is
  // ('user','admin','system','workflow') and the Stage 2 vendor-portal epic
  // ships no migration, so vendor writes are identified by actorId +
  // `metadata.source = 'vendor-portal'` rather than a new actor_type.
  it('maps vendor_admin → user (no new actor_type, no migration)', () => {
    expect(auditActorType({ role: 'vendor_admin' })).toBe('user');
  });
});
