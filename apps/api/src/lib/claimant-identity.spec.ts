/**
 * Claimant identity resolution (AECI-527 / `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §2),
 * against the in-memory D1 harness.
 *
 * Two suites:
 *   - `classifyClaimantConflict` — the pure role/vendor exclusivity rule
 *     (`STAGE_2_SPEC.md` §8.3(3)). No harness, no I/O.
 *   - `resolveClaimantIdentity` — the composition AECI-519 consumes. The GoTrue
 *     seams are INJECTED as `vi.fn()`, never fetched: the HTTP contract is pinned
 *     in `supabase-admin.spec.ts`, so this layer tests the decision flow only.
 *
 * The invariants worth naming: absent creds report `unavailable` and attempt no
 * create; a conflict is decided BEFORE any account is provisioned; the `linked`
 * path writes nothing; and a `422 email_exists` race re-resolves exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV } from '../test/helpers';
import {
  classifyClaimantConflict,
  resolveClaimantIdentity,
  type ClaimantProfileSnapshot,
} from './claimant-identity';
import type { createAuthUser, findAuthUserByEmail } from './supabase-admin';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_VENDOR_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const NEW_USER_ID = '44444444-4444-4444-8444-444444444444';
const EMAIL = 'jane@acme.com';

/** Supabase creds are present so the seams are exercised rather than skipped —
 *  the injected stubs decide the outcome, not `adminConfig`. */
const ENV_WITH_CREDS: Env = {
  ...TEST_ENV,
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

function snapshot(over: Partial<ClaimantProfileSnapshot> = {}): ClaimantProfileSnapshot {
  return { id: USER_ID, role: 'reviewer', vendorId: null, bannedAt: null, ...over };
}

// ── Injected seam stubs ──────────────────────────────────────────────────────
type FindUser = typeof findAuthUserByEmail;
type CreateUser = typeof createAuthUser;

const foundUser: FindUser = async () => ({ ok: true, user: { id: USER_ID, email: EMAIL } });
const noUser: FindUser = async () => ({ ok: true, user: null });
const credsAbsent: FindUser = async () => ({ ok: true, skipped: true, user: null });
const lookupFailed: FindUser = async () => ({ ok: false, user: null, status: 503, error: 'boom' });

const createsUser: CreateUser = async () => ({
  ok: true,
  user: { id: NEW_USER_ID, email: EMAIL },
});
const createNeverCalled: CreateUser = async () => {
  throw new Error('createAuthUser must not be called');
};

describe('classifyClaimantConflict', () => {
  it('no profile row → no conflict (the invite / first-grant case)', () => {
    expect(classifyClaimantConflict(null, VENDOR_ID)).toBeNull();
  });

  it('a default reviewer profile with no vendor → no conflict', () => {
    expect(classifyClaimantConflict(snapshot(), VENDOR_ID)).toBeNull();
  });

  it('vendor_admin on the SAME vendor → no conflict (a second seat is expected)', () => {
    const profile = snapshot({ role: 'vendor_admin', vendorId: VENDOR_ID });
    expect(classifyClaimantConflict(profile, VENDOR_ID)).toBeNull();
  });

  it('vendor_admin on a DIFFERENT vendor → other_vendor', () => {
    const profile = snapshot({ role: 'vendor_admin', vendorId: OTHER_VENDOR_ID });
    expect(classifyClaimantConflict(profile, VENDOR_ID)).toBe('other_vendor');
  });

  it('admin → already_admin even when vendor_id is null', () => {
    expect(classifyClaimantConflict(snapshot({ role: 'admin' }), VENDOR_ID)).toBe('already_admin');
  });

  it('admin already on the target vendor → already_admin takes precedence', () => {
    const profile = snapshot({ role: 'admin', vendorId: VENDOR_ID });
    expect(classifyClaimantConflict(profile, VENDOR_ID)).toBe('already_admin');
  });

  it('a non-vendor_admin role carrying a stale vendor_id elsewhere → other_vendor', () => {
    const profile = snapshot({ role: 'reviewer', vendorId: OTHER_VENDOR_ID });
    expect(classifyClaimantConflict(profile, VENDOR_ID)).toBe('other_vendor');
  });

  it('a banned profile is not, by itself, a conflict (§7 owns ban policy)', () => {
    const profile = snapshot({ bannedAt: '2026-07-01T00:00:00.000Z' });
    expect(classifyClaimantConflict(profile, VENDOR_ID)).toBeNull();
  });
});

describe('resolveClaimantIdentity', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await makeTestDb();
    await t.db.insert(vendors).values([
      { id: VENDOR_ID, slug: 'acme', companyName: 'Acme' },
      { id: OTHER_VENDOR_ID, slug: 'globex', companyName: 'Globex' },
    ]);
  });
  afterEach(() => t.dispose());

  const resolve = (findUser: FindUser, createUser: CreateUser = createNeverCalled) =>
    resolveClaimantIdentity(
      t.db,
      ENV_WITH_CREDS,
      { email: EMAIL, vendorId: VENDOR_ID },
      findUser,
      createUser,
    );

  const seedProfile = (over: Partial<typeof profiles.$inferInsert> = {}) =>
    t.db.insert(profiles).values({ id: USER_ID, ...over });

  it('reports unavailable when creds are absent, and attempts no create', async () => {
    const createUser = vi.fn(createsUser);

    expect(await resolve(credsAbsent, createUser)).toEqual({ outcome: 'unavailable' });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('reports unavailable when the create reports absent creds', async () => {
    const createUser = vi.fn<CreateUser>(async () => ({ ok: true, skipped: true, user: null }));

    expect(await resolve(noUser, createUser)).toEqual({ outcome: 'unavailable' });
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it('links an existing auth user and returns its profile snapshot', async () => {
    await seedProfile({ role: 'reviewer', displayName: 'Jane' });
    const createUser = vi.fn(createsUser);

    const res = await resolve(foundUser, createUser);

    expect(res).toEqual({
      outcome: 'linked',
      userId: USER_ID,
      email: EMAIL,
      profile: { id: USER_ID, role: 'reviewer', vendorId: null, bannedAt: null },
    });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('links with profile: null when the auth user has never signed in', async () => {
    const res = await resolve(foundUser);

    expect(res).toEqual({ outcome: 'linked', userId: USER_ID, email: EMAIL, profile: null });
  });

  it('links a second seat on the SAME vendor rather than conflicting', async () => {
    await seedProfile({ role: 'vendor_admin', vendorId: VENDOR_ID });

    const res = await resolve(foundUser);

    expect(res.outcome).toBe('linked');
  });

  it('invites when no auth user exists: creates exactly once, returns the new id', async () => {
    const createUser = vi.fn(createsUser);

    const res = await resolve(noUser, createUser);

    expect(res).toEqual({ outcome: 'invited', userId: NEW_USER_ID, email: EMAIL, profile: null });
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(ENV_WITH_CREDS, EMAIL);
  });

  it('lookup-only (provision:false): no auth user → not_found, and NEVER creates', async () => {
    // The terminal-claim re-approve path: provisioning here would orphan an
    // auth.users row the grant handler immediately 422s (§3).
    const createUser = vi.fn(createsUser);

    const res = await resolveClaimantIdentity(
      t.db,
      ENV_WITH_CREDS,
      { email: EMAIL, vendorId: VENDOR_ID, provision: false },
      noUser,
      createUser,
    );

    expect(res).toEqual({ outcome: 'not_found' });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('lookup-only (provision:false) still links an existing account', async () => {
    const createUser = vi.fn(createsUser);

    const res = await resolveClaimantIdentity(
      t.db,
      ENV_WITH_CREDS,
      { email: EMAIL, vendorId: VENDOR_ID, provision: false },
      foundUser,
      createUser,
    );

    expect(res.outcome).toBe('linked');
    expect(createUser).not.toHaveBeenCalled();
  });

  it('surfaces bannedAt on the snapshot without treating it as a conflict', async () => {
    await seedProfile({ bannedAt: '2026-07-01T00:00:00.000Z', banReason: 'spam' });

    const res = await resolve(foundUser);

    expect(res.outcome).toBe('linked');
    expect(res).toMatchObject({ profile: { bannedAt: '2026-07-01T00:00:00.000Z' } });
  });

  it('conflicts with already_admin before any create, and writes nothing', async () => {
    await seedProfile({ role: 'admin' });
    const createUser = vi.fn(createsUser);

    const res = await resolve(foundUser, createUser);

    expect(res).toEqual({
      outcome: 'conflict',
      reason: 'already_admin',
      userId: USER_ID,
      email: EMAIL,
      profile: { id: USER_ID, role: 'admin', vendorId: null, bannedAt: null },
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('conflicts with other_vendor and carries the snapshot for the AECI-519 audit', async () => {
    await seedProfile({ role: 'vendor_admin', vendorId: OTHER_VENDOR_ID });

    const res = await resolve(foundUser);

    expect(res).toMatchObject({
      outcome: 'conflict',
      reason: 'other_vendor',
      profile: { vendorId: OTHER_VENDOR_ID, role: 'vendor_admin' },
    });
  });

  it('is read-only on the linked path: writes no profiles and no audit rows', async () => {
    await resolve(foundUser);

    expect(await t.db.select().from(profiles)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('handles the create race: 422 email_exists → one re-lookup → linked', async () => {
    // First lookup misses (the case-sensitive substring filter), the create
    // reports the row exists, the re-lookup finds it.
    const findUser = vi
      .fn<FindUser>()
      .mockResolvedValueOnce({ ok: true, user: null })
      .mockResolvedValueOnce({ ok: true, user: { id: USER_ID, email: EMAIL } });
    const createUser = vi.fn<CreateUser>(async () => ({
      ok: false,
      user: null,
      alreadyExists: true,
      status: 422,
    }));

    const res = await resolve(findUser, createUser);

    expect(res).toEqual({ outcome: 'linked', userId: USER_ID, email: EMAIL, profile: null });
    expect(findUser).toHaveBeenCalledTimes(2);
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it('applies exclusivity to the re-resolved user after a 422 race', async () => {
    await seedProfile({ role: 'admin' });
    const findUser = vi
      .fn<FindUser>()
      .mockResolvedValueOnce({ ok: true, user: null })
      .mockResolvedValueOnce({ ok: true, user: { id: USER_ID, email: EMAIL } });
    const createUser: CreateUser = async () => ({
      ok: false,
      user: null,
      alreadyExists: true,
      status: 422,
    });

    expect(await resolve(findUser, createUser)).toMatchObject({
      outcome: 'conflict',
      reason: 'already_admin',
    });
  });

  it('errors when a 422 email_exists re-lookup still misses', async () => {
    const findUser = vi.fn<FindUser>(async () => ({ ok: true, user: null }));
    const createUser: CreateUser = async () => ({
      ok: false,
      user: null,
      alreadyExists: true,
      status: 422,
    });

    const res = await resolve(findUser, createUser);

    expect(res).toEqual({
      outcome: 'error',
      stage: 'create',
      status: 422,
      message: 'email_exists but the user could not be resolved by email',
    });
    expect(findUser).toHaveBeenCalledTimes(2);
  });

  it('errors at the lookup stage without attempting a create', async () => {
    const createUser = vi.fn(createsUser);

    const res = await resolve(lookupFailed, createUser);

    expect(res).toEqual({ outcome: 'error', stage: 'lookup', status: 503, message: 'boom' });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('errors at the create stage on any other create failure', async () => {
    const createUser: CreateUser = async () => ({
      ok: false,
      user: null,
      status: 429,
      error: 'rate limited',
    });

    const res = await resolve(noUser, createUser);

    expect(res).toEqual({
      outcome: 'error',
      stage: 'create',
      status: 429,
      message: 'rate limited',
    });
  });
});
