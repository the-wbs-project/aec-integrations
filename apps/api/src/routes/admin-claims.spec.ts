/**
 * Admin claim → verified-account grant API (AECI-519 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §3) on the in-memory D1 harness.
 *
 *   PATCH /api/admin/claims/:id
 *
 * A stub middleware sets the `auth` Variable `requireAdmin()` would; the AECI-527
 * identity-resolution seam and the AECI-528 email seam are injected so the grant
 * is exercised without a live Supabase or Resend. The AC matrix: grant builds the
 * atomic batch (seat + verified + request + audit); `updated_at` bumped; the
 * no-clobber upsert preserves owned columns; a second seat doesn't re-flip
 * verified or churn `updated_at`; idempotent re-grant is a 200 no-op; both
 * conflict cases → 409 `GRANT_CONFLICT`; `unavailable`/`error` → 503; reject
 * mutates no vendor and enqueues no purge; a `target_type='product'` claim grants
 * the product's primary vendor; and the revoke mechanic leaves `verified`
 * untouched.
 */

import { ApiErrorCode, ListVendorClaimsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  products,
  productVendors,
  profiles,
  vendorRequests,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { submitCount } from '../datadog';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { type BatchTuple } from '../lib/audit';
import type { resolveClaimantIdentity } from '../lib/claimant-identity';
import type { fetchAuthAccountsByEmail } from '../lib/supabase-admin';
import { revokeSeatStatements } from '../lib/vendor-grant';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createAdminClaimsListHandler,
  createModerateClaimHandler,
  type SendClaimDecisionEmail,
} from './admin-claims';

// The moderation metric rides the shared transport; mock it so we can assert the
// per-action count. The handler also imports `logToDatadog`.
vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

function claimModerationActions(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.claim.moderation.action')
    .map((call) => call[5] as string[]);
}

// Valid UUIDs — the response schema validates request/target/resolver + grant ids.
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_VENDOR_ID = '22222222-2222-4222-8222-222222222222';
const PRODUCT_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const REQUEST2_ID = '66666666-6666-4666-8666-666666666666';
const CLAIMANT_ID = '77777777-7777-4777-8777-777777777777';
const CLAIMANT2_ID = '88888888-8888-4888-8888-888888888888';
const CLAIMANT_EMAIL = 'submitter@vendor.com';
const OLD_TS = '2020-01-01T00:00:00.000Z';

const ADMIN_AUTH: AuthzVariables['auth'] = {
  userId: ADMIN_ID,
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
  vi.mocked(submitCount).mockClear();
});
afterEach(() => t.dispose());

// ─── Seed helpers ────────────────────────────────────────────────────────────

const seedVendor = (o: Partial<typeof vendors.$inferInsert> = {}) =>
  t.db.insert(vendors).values({
    id: VENDOR_ID,
    slug: 'autodesk',
    companyName: 'Autodesk, Inc.',
    verified: false,
    updatedAt: OLD_TS,
    ...o,
  });

function reqRow(
  o: Partial<typeof vendorRequests.$inferInsert> = {},
): typeof vendorRequests.$inferInsert {
  return {
    id: REQUEST_ID,
    kind: 'claim',
    status: 'open',
    targetType: 'vendor',
    targetId: VENDOR_ID,
    submitterEmail: CLAIMANT_EMAIL,
    submitterName: 'Sam Submitter',
    submitterRole: 'Product Manager',
    domainMatch: 'pending',
    body: 'We build this and would like to claim the listing.',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...o,
  };
}

const seedRequest = (o: Partial<typeof vendorRequests.$inferInsert> = {}) =>
  t.db.insert(vendorRequests).values(reqRow(o));

const seedWorkflow = (entityId = REQUEST_ID, currentState = 'open') =>
  t.db
    .insert(workflowInstances)
    .values({ id: crypto.randomUUID(), workflowType: 'vendor_claim', entityId, currentState });

// ─── Injected seams ──────────────────────────────────────────────────────────

type Resolver = typeof resolveClaimantIdentity;

const resolveLinked = (
  profile: { id: string; role: string; vendorId: string | null; bannedAt: string | null } | null,
  userId = CLAIMANT_ID,
): Resolver =>
  vi.fn<Resolver>(async () => ({ outcome: 'linked', userId, email: CLAIMANT_EMAIL, profile }));

const resolveInvited = (userId = CLAIMANT_ID): Resolver =>
  vi.fn<Resolver>(async () => ({
    outcome: 'invited',
    userId,
    email: CLAIMANT_EMAIL,
    profile: null,
  }));

const resolveConflict = (reason: 'already_admin' | 'other_vendor'): Resolver =>
  vi.fn<Resolver>(async () => ({
    outcome: 'conflict',
    reason,
    userId: CLAIMANT_ID,
    email: CLAIMANT_EMAIL,
    profile: {
      id: CLAIMANT_ID,
      role: reason === 'already_admin' ? 'admin' : 'vendor_admin',
      vendorId: reason === 'other_vendor' ? OTHER_VENDOR_ID : null,
      bannedAt: null,
    },
  }));

const resolveUnavailable = (): Resolver =>
  vi.fn<Resolver>(async () => ({ outcome: 'unavailable' }));
const resolveError = (): Resolver =>
  vi.fn<Resolver>(async () => ({ outcome: 'error', stage: 'lookup', status: 500 }));

/** Never invoked on the paths that must not resolve (reject / non-claim). */
const resolveThrows = (): Resolver =>
  vi.fn<Resolver>(async () => {
    throw new Error('resolveIdentity must not be called on this path');
  });

// ─── App + request drivers ───────────────────────────────────────────────────

function moderateApp(resolve: Resolver, email?: SendClaimDecisionEmail) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/claims/:id', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  app.patch('/api/admin/claims/:id', createModerateClaimHandler(t.factory, resolve, email));
  return app;
}

async function patchClaim(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  body: unknown,
  id = REQUEST_ID,
) {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app.request(
    `/api/admin/claims/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
    execCtx,
  );
  // Drain the post-commit `waitUntil` work so purge/email assertions are stable.
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any, send };
}

const profileOf = async (id: string) =>
  (await t.db.select().from(profiles).where(eq(profiles.id, id)))[0];
const vendorOf = async (id: string) =>
  (await t.db.select().from(vendors).where(eq(vendors.id, id)))[0];
const requestOf = async (id: string) =>
  (await t.db.select().from(vendorRequests).where(eq(vendorRequests.id, id)))[0];

// ─── Grant (approve) ─────────────────────────────────────────────────────────

describe('PATCH /api/admin/claims/:id — grant', () => {
  it('links the seat, flips verified (+ bumps updated_at), resolves the claim, audits — atomically', async () => {
    await seedVendor();
    await seedRequest();
    await seedWorkflow();
    const email = vi.fn<SendClaimDecisionEmail>(async () => {});

    const { status, body, send } = await patchClaim(moderateApp(resolveLinked(null), email), {
      action: 'approve',
      entitlement: { payer: 'Autodesk AP', amount: 'USD 5,000/yr' },
    });

    expect(status).toBe(200);
    expect(body.grant).toMatchObject({
      user_id: CLAIMANT_ID,
      vendor_id: VENDOR_ID,
      verified: true,
      identity_outcome: 'linked',
      seat_created: true,
    });
    expect(body.request.status).toBe('resolved');
    expect(body.request.resolved_by).toBe(ADMIN_ID);

    // Seat linked.
    const seat = await profileOf(CLAIMANT_ID);
    expect(seat!.role).toBe('vendor_admin');
    expect(seat!.vendorId).toBe(VENDOR_ID);

    // Verified flipped + updated_at bumped off the seeded value.
    const vendor = await vendorOf(VENDOR_ID);
    expect(vendor!.verified).toBe(true);
    expect(vendor!.updatedAt).not.toBe(OLD_TS);

    // Request resolved.
    const req = await requestOf(REQUEST_ID);
    expect(req!.status).toBe('resolved');
    expect(req!.resolvedById).toBe(ADMIN_ID);

    // One audit row in the same batch, with the entitlement recorded in metadata.
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('vendor_claim.granted');
    expect(audits[0]!.actorId).toBe(ADMIN_ID);
    expect(audits[0]!.metadata).toMatchObject({
      source: 'admin-moderation',
      vendor_id: VENDOR_ID,
      identity_outcome: 'linked',
      verified_flipped: true,
      entitlement: { payer: 'Autodesk AP', amount: 'USD 5,000/yr' },
    });

    // Workflow completed + transition.
    const [wf] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.entityId, REQUEST_ID));
    expect(wf!.currentState).toBe('resolved');
    expect(wf!.finalOutcome).toBe('completed');
    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.toState).toBe('resolved');

    // Post-commit: vendor + product purge enqueued (no products here → vendor tag only).
    expect(send).toHaveBeenCalledWith({ tags: ['vendor:autodesk'], source: 'moderation' });
    // Claim-approved email fired to the resolved address.
    expect(email).toHaveBeenCalledTimes(1);
    expect(email.mock.calls[0]![1]).toMatchObject({ decision: 'approved', to: CLAIMANT_EMAIL });

    expect(claimModerationActions()).toEqual([['action:approve', 'outcome:ok']]);
  });

  it('provisions a seat for an invited claimant (no prior profile row)', async () => {
    await seedVendor();
    await seedRequest();
    const { status, body } = await patchClaim(moderateApp(resolveInvited()), { action: 'approve' });

    expect(status).toBe(200);
    expect(body.grant).toMatchObject({ identity_outcome: 'invited', seat_created: true });
    const seat = await profileOf(CLAIMANT_ID);
    expect(seat!.role).toBe('vendor_admin');
    expect(seat!.vendorId).toBe(VENDOR_ID);
  });

  it('upgrades an existing profile without clobbering display_name / theme_preference (no-clobber)', async () => {
    await seedVendor();
    await t.db.insert(profiles).values({
      id: CLAIMANT_ID,
      role: 'reviewer',
      displayName: 'Jane Doe',
      themePreference: 'dark',
    });
    await seedRequest();

    const snapshot = { id: CLAIMANT_ID, role: 'reviewer', vendorId: null, bannedAt: null };
    const { status, body } = await patchClaim(moderateApp(resolveLinked(snapshot)), {
      action: 'approve',
    });

    expect(status).toBe(200);
    expect(body.grant).toMatchObject({ seat_created: false });
    const seat = await profileOf(CLAIMANT_ID);
    expect(seat!.role).toBe('vendor_admin');
    expect(seat!.vendorId).toBe(VENDOR_ID);
    // Owned columns preserved.
    expect(seat!.displayName).toBe('Jane Doe');
    expect(seat!.themePreference).toBe('dark');
  });

  it('grants a second seat without re-flipping verified or churning updated_at (multi-seat safe)', async () => {
    await seedVendor({ verified: true, updatedAt: OLD_TS });
    // Existing seat A.
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID });
    // A second, open claim for the same vendor from a different submitter.
    await seedRequest({ id: REQUEST2_ID, submitterEmail: 'second@vendor.com' });

    const { status } = await patchClaim(
      moderateApp(resolveLinked(null, CLAIMANT2_ID)),
      { action: 'approve' },
      REQUEST2_ID,
    );

    expect(status).toBe(200);
    // Second seat granted.
    expect((await profileOf(CLAIMANT2_ID))!.role).toBe('vendor_admin');
    // Verified untouched, updated_at NOT churned (guarded flip was a no-op).
    const vendor = await vendorOf(VENDOR_ID);
    expect(vendor!.verified).toBe(true);
    expect(vendor!.updatedAt).toBe(OLD_TS);
    // The grant is still audited, but records that it did not flip verification.
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ verified_flipped: false });
  });

  it('is idempotent: re-granting an already-granted claim is a 200 no-op (no audit noise)', async () => {
    await seedVendor({ verified: true });
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID });
    await seedRequest({ status: 'resolved', resolvedById: ADMIN_ID, resolvedAt: OLD_TS });
    const email = vi.fn<SendClaimDecisionEmail>(async () => {});

    const snapshot = { id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID, bannedAt: null };
    const { status, body, send } = await patchClaim(moderateApp(resolveLinked(snapshot), email), {
      action: 'approve',
    });

    expect(status).toBe(200);
    expect(body.grant).toMatchObject({ verified: true, seat_created: false });
    // No new audit / transition rows, no purge, no email.
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(claimModerationActions()).toEqual([['action:approve', 'outcome:noop']]);
  });

  it('resolves the product’s primary vendor for a target_type=product claim', async () => {
    await seedVendor(); // primary vendor
    await t.db
      .insert(vendors)
      .values({ id: OTHER_VENDOR_ID, slug: 'other', companyName: 'Other Co' });
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'revit', name: 'Revit' });
    await t.db.insert(productVendors).values([
      { productId: PRODUCT_ID, vendorId: OTHER_VENDOR_ID, isPrimary: false },
      { productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: true },
    ]);
    await seedRequest({ targetType: 'product', targetId: PRODUCT_ID });
    const resolve = resolveLinked(null);

    const { status, body, send } = await patchClaim(moderateApp(resolve), { action: 'approve' });

    expect(status).toBe(200);
    expect(body.grant.vendor_id).toBe(VENDOR_ID);
    // Resolution was asked about the PRIMARY vendor, not the product id.
    expect(vi.mocked(resolve).mock.calls[0]![2]).toMatchObject({ vendorId: VENDOR_ID });
    expect((await profileOf(CLAIMANT_ID))!.vendorId).toBe(VENDOR_ID);
    expect((await vendorOf(VENDOR_ID))!.verified).toBe(true);
    // Purge covers the vendor + its product page.
    expect(send).toHaveBeenCalledWith({
      tags: ['vendor:autodesk', 'product:revit', 'index:products'],
      source: 'moderation',
    });
  });
});

// ─── Conflicts & dependency failures (nothing written) ───────────────────────

describe('PATCH /api/admin/claims/:id — conflicts', () => {
  it.each([['already_admin' as const], ['other_vendor' as const]])(
    'returns 409 GRANT_CONFLICT (%s) and writes nothing',
    async (reason) => {
      await seedVendor();
      await seedRequest();
      const email = vi.fn<SendClaimDecisionEmail>(async () => {});

      const { status, body, send } = await patchClaim(moderateApp(resolveConflict(reason), email), {
        action: 'approve',
      });

      expect(status).toBe(409);
      expect(body.error.code).toBe(ApiErrorCode.GRANT_CONFLICT);
      expect(body.error.details).toEqual({ reason });
      // Nothing written.
      expect((await vendorOf(VENDOR_ID))!.verified).toBe(false);
      expect((await requestOf(REQUEST_ID))!.status).toBe('open');
      expect(await profileOf(CLAIMANT_ID)).toBeUndefined();
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
      expect(email).not.toHaveBeenCalled();
      expect(claimModerationActions()).toEqual([['action:approve', 'outcome:conflict']]);
    },
  );

  it.each([
    ['unavailable', resolveUnavailable],
    ['error', resolveError],
  ])('returns 503 DEPENDENCY_FAILURE when resolution is %s', async (_label, resolver) => {
    await seedVendor();
    await seedRequest();

    const { status, body } = await patchClaim(moderateApp(resolver()), { action: 'approve' });

    expect(status).toBe(503);
    expect(body.error.code).toBe(ApiErrorCode.DEPENDENCY_FAILURE);
    expect((await vendorOf(VENDOR_ID))!.verified).toBe(false);
    expect((await requestOf(REQUEST_ID))!.status).toBe('open');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(claimModerationActions()).toEqual([['action:approve', 'outcome:unavailable']]);
  });

  it('returns 422 for an already-terminal claim whose seat is gone', async () => {
    await seedVendor({ verified: true });
    await seedRequest({ status: 'resolved' });
    // Claimant resolves but is no longer a seat (revoked) — a re-grant of a
    // terminal claim is a genuine invalid transition, not idempotency.
    const snapshot = { id: CLAIMANT_ID, role: 'reviewer', vendorId: null, bannedAt: null };
    const { status, body } = await patchClaim(moderateApp(resolveLinked(snapshot)), {
      action: 'approve',
    });
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('returns 422 for an already-rejected claim without resolving identity (no orphan create)', async () => {
    await seedVendor();
    // A rejected claim was never granted, so a re-approve must refuse BEFORE
    // resolveIdentity — otherwise its invite path would provision an orphan auth user.
    await seedRequest({ status: 'rejected' });
    const resolve = resolveThrows();

    const { status, body } = await patchClaim(moderateApp(resolve), { action: 'approve' });

    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(resolve).not.toHaveBeenCalled();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(claimModerationActions()).toEqual([['action:approve', 'outcome:invalid_state']]);
  });

  it('returns 422 for a non-claim (correction) without resolving identity', async () => {
    await seedVendor();
    await seedRequest({ kind: 'correction' });
    const resolve = resolveThrows();

    const { status, body } = await patchClaim(moderateApp(resolve), { action: 'approve' });

    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns the canonical 404 for an unknown claim id', async () => {
    const { status, body } = await patchClaim(moderateApp(resolveThrows()), { action: 'approve' });
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'vendor_request', id: REQUEST_ID });
  });
});

// ─── Reject ──────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/claims/:id — reject', () => {
  it('rejects the claim, mutates no vendor, enqueues no purge, and emails', async () => {
    await seedVendor();
    await seedRequest();
    await seedWorkflow();
    const email = vi.fn<SendClaimDecisionEmail>(async () => {});
    const resolve = resolveThrows(); // reject must not resolve identity

    const { status, body, send } = await patchClaim(moderateApp(resolve, email), {
      action: 'reject',
      reason: 'Unverifiable',
    });

    expect(status).toBe(200);
    expect(body.request.status).toBe('rejected');
    expect(body.grant).toBeNull();
    expect(resolve).not.toHaveBeenCalled();

    expect((await requestOf(REQUEST_ID))!.status).toBe('rejected');
    // Vendor untouched.
    expect((await vendorOf(VENDOR_ID))!.verified).toBe(false);
    const audits = await t.db.select().from(auditLog);
    expect(audits[0]!.action).toBe('vendor_claim.rejected');
    expect(audits[0]!.metadata).toMatchObject({
      source: 'admin-moderation',
      reason: 'Unverifiable',
    });
    const [wf] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.entityId, REQUEST_ID));
    expect(wf!.finalOutcome).toBe('rejected');

    // No purge on reject; email fired.
    expect(send).not.toHaveBeenCalled();
    expect(email.mock.calls[0]![1]).toMatchObject({ decision: 'rejected', to: CLAIMANT_EMAIL });
    expect(claimModerationActions()).toEqual([['action:reject', 'outcome:ok']]);
  });

  it('returns 422 when rejecting an already-terminal claim', async () => {
    await seedVendor();
    await seedRequest({ status: 'rejected' });
    const { status, body } = await patchClaim(moderateApp(resolveThrows()), { action: 'reject' });
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

// ─── Revoke mechanic (no endpoint yet — AECI-524 wires it) ───────────────────

describe('revokeSeatStatements', () => {
  it('drops the seat to reviewer + unlinks vendor_id, audited, WITHOUT touching verified', async () => {
    await seedVendor({ verified: true });
    await t.db.insert(profiles).values({
      id: CLAIMANT_ID,
      role: 'vendor_admin',
      vendorId: VENDOR_ID,
      displayName: 'Keep Me',
    });

    const { stmts } = revokeSeatStatements(t.db, {
      userId: CLAIMANT_ID,
      vendorId: VENDOR_ID,
      actorId: ADMIN_ID,
      actorType: 'admin',
      now: new Date().toISOString(),
      profileBefore: { role: 'vendor_admin', vendorId: VENDOR_ID },
    });
    await t.db.batch(stmts as BatchTuple);

    const seat = await profileOf(CLAIMANT_ID);
    expect(seat!.role).toBe('reviewer');
    expect(seat!.vendorId).toBeNull();
    expect(seat!.displayName).toBe('Keep Me'); // untouched
    // Verified is a vendor-level paid state — a seat revoke never un-verifies (§8.3(2)).
    expect((await vendorOf(VENDOR_ID))!.verified).toBe(true);

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('vendor_claim.seat_revoked');
    expect(audits[0]!.metadata).toMatchObject({ verified_untouched: true, vendor_id: VENDOR_ID });
  });
});

// ─── GET /api/admin/claims — the reviewer-assist LIST (AECI-521 / §5) ─────────

/** Stub-middleware app for the claims LIST (the `requireAdmin()` guard is covered
 *  in `authz.spec.ts`). `fetchAuthAccounts` (the GoTrue signal seam) and `dbFor`
 *  (to exercise the fail-soft enrichment) are injectable. */
function claimsListApp(
  opts: {
    fetchAuthAccounts?: typeof fetchAuthAccountsByEmail;
    dbFor?: typeof t.factory;
  } = {},
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/claims', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  app.get(
    '/api/admin/claims',
    createAdminClaimsListHandler(opts.dbFor ?? t.factory, opts.fetchAuthAccounts),
  );
  return app;
}

const getClaims = (opts: Parameters<typeof claimsListApp>[0] = {}, qs = '') =>
  claimsListApp(opts).request(`/api/admin/claims${qs}`, {}, TEST_ENV, fakeExecutionContext());

/** Parse a LIST response against the real Zod schema (validates the whole envelope
 *  incl. the three claim-only signal fields). */
async function parseClaims(res: Response) {
  return ListVendorClaimsResponseSchema.parse(await res.json());
}

/** A `DbFactory` whose `select().from(profiles)` throws, to exercise the LIST's
 *  fail-soft seat enrichment (everything else delegates to the real test db). */
function factoryFailingProfilesSelect(): typeof t.factory {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const real: any = t.db;
  const dbProxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'query') return target.query; // real relational builder (bound to real db)
      if (prop === 'select') {
        return (...args: any[]) => {
          const builder = target.select(...args);
          return new Proxy(builder, {
            get(b, bProp) {
              if (bProp === 'from') {
                return (tbl: unknown) => {
                  if (tbl === profiles) throw new Error('seat lookup boom');
                  return b.from(tbl);
                };
              }
              const v = Reflect.get(b, bProp);
              return typeof v === 'function' ? v.bind(b) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return (() => ({ db: dbProxy })) as unknown as typeof t.factory;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

describe('GET /api/admin/claims — reviewer-assist LIST', () => {
  it('returns only claims (not corrections), newest-first, in the paginated envelope', async () => {
    await seedVendor();
    await seedRequest({
      id: REQUEST_ID,
      domainMatch: 'match',
      createdAt: '2026-06-02T00:00:00.000Z',
    });
    await seedRequest({
      id: REQUEST2_ID,
      kind: 'correction',
      submitterEmail: 'corr@example.com',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    const res = await getClaims();
    expect(res.status).toBe(200);
    const body = await parseClaims(res);
    expect(body).toMatchObject({ page: 1, perPage: 24, total: 1 });
    expect(body.data.map((d) => d.id)).toEqual([REQUEST_ID]);
    expect(body.data[0]!.kind).toBe('claim');
    // `domain_match` is surfaced verbatim from the stored column.
    expect(body.data[0]!.domain_match).toBe('match');
  });

  it('surfaces the claimed vendor’s active seats, excluding banned ones', async () => {
    await seedVendor();
    await seedRequest();
    await t.db.insert(profiles).values([
      {
        id: CLAIMANT_ID,
        role: 'vendor_admin',
        vendorId: VENDOR_ID,
        displayName: 'Existing Admin',
        workEmailVerified: true,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: CLAIMANT2_ID,
        role: 'vendor_admin',
        vendorId: VENDOR_ID,
        displayName: 'Banned Admin',
        bannedAt: '2026-05-02T00:00:00.000Z',
        createdAt: '2026-05-02T00:00:00.000Z',
      },
    ]);

    const body = await parseClaims(await getClaims());
    const seats = body.data[0]!.existing_seats!;
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({ display_name: 'Existing Admin', work_email_verified: true });
  });

  it('reports an empty seat roster (not null) for a first claim', async () => {
    await seedVendor();
    await seedRequest();
    const body = await parseClaims(await getClaims());
    expect(body.data[0]!.existing_seats).toEqual([]);
  });

  it('surfaces prior requests from the same email + the duplicate chain, excluding self', async () => {
    await seedVendor();
    // An earlier resolved correction from the SAME email — must appear in related.
    await seedRequest({
      id: REQUEST2_ID,
      kind: 'correction',
      status: 'resolved',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    // The open claim, flagged as a duplicate of that earlier request.
    await seedRequest({
      id: REQUEST_ID,
      duplicateOfRequestId: REQUEST2_ID,
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    const body = await parseClaims(await getClaims());
    const claim = body.data.find((d) => d.id === REQUEST_ID)!;
    expect(claim.duplicate_of_request_id).toBe(REQUEST2_ID);
    const relatedIds = claim.related_requests!.map((r) => r.id);
    expect(relatedIds).toContain(REQUEST2_ID);
    expect(relatedIds).not.toContain(REQUEST_ID); // self excluded
  });

  it('computes has_auth_account from the injected GoTrue seam, null without creds', async () => {
    await seedVendor();
    await seedRequest();

    const fetchAuthAccounts = vi.fn(
      async () => new Map([[CLAIMANT_EMAIL, true]]),
    ) as unknown as typeof fetchAuthAccountsByEmail;
    const withSeam = await parseClaims(await getClaims({ fetchAuthAccounts }));
    expect(withSeam.data[0]!.has_auth_account).toBe(true);
    expect(fetchAuthAccounts).toHaveBeenCalledWith(TEST_ENV, [CLAIMANT_EMAIL]);

    // Default seam + no Supabase creds in TEST_ENV → empty map → null (unknown).
    const noSeam = await parseClaims(await getClaims());
    expect(noSeam.data[0]!.has_auth_account).toBeNull();
  });

  it('resolves a target_type=product claim to its primary vendor for the seat roster', async () => {
    await seedVendor(); // VENDOR_ID (the primary)
    await t.db
      .insert(vendors)
      .values({ id: OTHER_VENDOR_ID, slug: 'other', companyName: 'Other Co' });
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'revit', name: 'Revit' });
    await t.db.insert(productVendors).values([
      { productId: PRODUCT_ID, vendorId: OTHER_VENDOR_ID, isPrimary: false },
      { productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: true },
    ]);
    await seedRequest({ targetType: 'product', targetId: PRODUCT_ID });
    await t.db.insert(profiles).values({
      id: CLAIMANT_ID,
      role: 'vendor_admin',
      vendorId: VENDOR_ID,
      displayName: 'Primary Seat',
    });

    const body = await parseClaims(await getClaims());
    // Seats came from the PRIMARY vendor, not the product id or the non-primary vendor.
    expect(body.data[0]!.existing_seats!.map((s) => s.display_name)).toEqual(['Primary Seat']);
  });

  it('degrades a failed seat lookup to null without failing the list (graceful degrade)', async () => {
    await seedVendor();
    await seedRequest();
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID, displayName: 'A' });

    const res = await getClaims({ dbFor: factoryFailingProfilesSelect() });
    expect(res.status).toBe(200);
    const body = await parseClaims(res);
    // The seat query threw → `existing_seats` is null (UI renders "unavailable")…
    expect(body.data[0]!.existing_seats).toBeNull();
    // …but the row itself, and the independent related-requests signal, still return.
    expect(body.data[0]!.id).toBe(REQUEST_ID);
    expect(body.data[0]!.related_requests).not.toBeNull();
  });

  it('paginates with a stable order', async () => {
    await seedVendor();
    await seedRequest({ id: REQUEST_ID, createdAt: '2026-06-02T00:00:00.000Z' });
    await seedRequest({ id: REQUEST2_ID, createdAt: '2026-06-01T00:00:00.000Z' });

    const page1 = await parseClaims(await getClaims({}, '?page=1&perPage=1'));
    expect(page1.total).toBe(2);
    expect(page1.data.map((d) => d.id)).toEqual([REQUEST_ID]); // newest first
    const page2 = await parseClaims(await getClaims({}, '?page=2&perPage=1'));
    expect(page2.data.map((d) => d.id)).toEqual([REQUEST2_ID]);
  });
});
