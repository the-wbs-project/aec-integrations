/**
 * Admin claim → verified-account grant API (AECI-519 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §3) on the in-memory D1 harness.
 *
 *   PATCH /api/admin/claims/:id
 *
 * A stub middleware sets the `auth` Variable `requireAdmin()` would; the AECI-527
 * identity-resolution seam and the AECI-528 email seam are injected so the grant
 * is exercised without a live Supabase or Resend. The AC matrix: grant builds the
 * atomic batch (seat + request + workflow + billing account + audit); the
 * no-clobber upsert preserves owned columns; a second seat leaves `verified` and
 * `updated_at` alone; idempotent re-grant is a 200 no-op; both
 * conflict cases → 409 `GRANT_CONFLICT`; `unavailable`/`error` → 503; reject
 * mutates no vendor and enqueues no purge; a `target_type='product'` claim grants
 * the product's primary vendor; and the revoke mechanic leaves `verified`
 * untouched.
 *
 * AECI-1367 made every approval land on Free: the grant composes the seat batch,
 * the billing account and the acceptance link into ONE `db.batch`, and never an
 * entitlement. The matrix covers the 400 on a body that still names a plan, the
 * owner rule (first unbanned owner only), the acceptance link, no purge, and a
 * Managed vendor from before keeping its entitlement on a second seat.
 */

import {
  AdminClaimAuditResponseSchema,
  AdminClaimDetailSchema,
  ApiErrorCode,
  ListVendorClaimsResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  billingAccounts,
  connectorEvidencedPairs,
  integrations,
  licenses,
  products,
  productVendors,
  profiles,
  vendorEntitlements,
  vendorRequests,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { logBatchToPosthog, logToPosthog, submitCount } from '../posthog';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { FetchAuthEmails } from '../lib/admin-audit-page';
import type { AuthzVariables } from '../lib/authz';
import { type BatchTuple } from '../lib/audit';
import type { resolveClaimantIdentity } from '../lib/claimant-identity';
import { ensureProfileRow } from '../lib/profile-provisioning';
import type { fetchAuthAccountsByEmail } from '../lib/supabase-admin';
import { revokeSeatStatements } from '../lib/vendor-grant';
import { makeTestDb, type TestDb } from '../test/d1';
import { FLAGS_AFTER_GRANT, readCancelFlags, seedCancelFlags, seedLicense } from '../test/licenses';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createAdminClaimAuditHandler,
  createAdminClaimDetailHandler,
  createAdminClaimsListHandler,
  createModerateClaimHandler,
  createSaveClaimNotesHandler,
  type FetchSeatEmails,
  type SendClaimDecisionEmail,
} from './admin-claims';

// The moderation metric rides the shared transport; mock it so we can assert the
// per-action count. The handler also imports `logToPosthog`.
vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
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

/** Audit or workflow forwards sent one row per request through `logToPosthog`. Must
 *  stay empty: every §26.5 forward goes through the batched sender (AECI-1112). */
function perRowAuditForwards(): unknown[] {
  return vi
    .mocked(logToPosthog)
    .mock.calls.filter((call) =>
      /^(audit|workflow) /.test(String((call[3] as { message?: string }).message ?? '')),
    );
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
  entitlementTier: 'unclaimed',
  entitlement: null,
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

/** Seed the vendor's `vendor_entitlements` row directly (bypassing the builders) to
 *  set up a §2.3 matrix state. `updated_at` is pinned to `OLD_TS` so a test can prove
 *  the second-seat path did not churn it. */
const seedEntitlement = (status: string) =>
  t.db.insert(vendorEntitlements).values({
    vendorId: VENDOR_ID,
    tier: 'verified',
    status,
    grantedAt: OLD_TS,
    endedAt: status === 'active' ? null : OLD_TS,
    expiryNoticeSentAt: status === 'active' ? null : OLD_TS,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
  });

/** Seed the vendor's billing account directly, the state a seated vendor is in once
 *  E1's back-fill has run (AECI-1351). `updated_at` is pinned to `OLD_TS` so a test
 *  can prove a second seat left it alone. */
const BILLING_ACCOUNT_ID = '99999999-9999-4999-8999-999999999999';
const seedBillingAccount = () =>
  t.db.insert(billingAccounts).values({
    id: BILLING_ACCOUNT_ID,
    vendorId: VENDOR_ID,
    name: 'Autodesk, Inc.',
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
  });

const seedWorkflow = (entityId = REQUEST_ID, currentState = 'open') =>
  t.db
    .insert(workflowInstances)
    .values({ id: crypto.randomUUID(), workflowType: 'vendor_claim', entityId, currentState });

// ─── Injected seams ──────────────────────────────────────────────────────────

type Resolver = typeof resolveClaimantIdentity;

const resolveLinked = (
  profile: {
    id: string;
    role: string;
    vendorId: string | null;
    bannedAt: string | null;
    displayName?: string | null;
  } | null,
  userId = CLAIMANT_ID,
): Resolver =>
  vi.fn<Resolver>(async () => ({
    outcome: 'linked',
    userId,
    email: CLAIMANT_EMAIL,
    profile: profile && { displayName: null, ...profile },
  }));

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
      displayName: null,
    },
  }));

const resolveUnavailable = (): Resolver =>
  vi.fn<Resolver>(async () => ({ outcome: 'unavailable' }));
const resolveError = (): Resolver =>
  vi.fn<Resolver>(async () => ({ outcome: 'error', stage: 'lookup', status: 500 }));

/** Lookup-only outcome: the email owns no auth user and none was created. Only
 *  returned when the handler resolves with `provision: false` (terminal claims). */
const resolveNotFound = (): Resolver => vi.fn<Resolver>(async () => ({ outcome: 'not_found' }));

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
//
// AECI-1367: every approval lands on Free. The batch is the seat, the request
// resolve, the workflow, the billing account when absent and the acceptance link.
// No entitlement row, no `vendors.verified` flip, no purge.

/** A claim-time terms acceptance on the claim, the row E3.3 will write. */
const seedAcceptance = (id: string, vendorRequestId = REQUEST_ID) =>
  t.db.insert(agreementAcceptances).values({
    id,
    document: 'vendor_terms',
    version: '1.0',
    source: 'claim',
    email: CLAIMANT_EMAIL,
    vendorRequestId,
    acceptedAt: '2026-06-01T00:00:00.000Z',
  });

describe('PATCH /api/admin/claims/:id — grant', () => {
  it('lands on Free: seat, resolve, workflow, billing account and audit in one batch; no entitlement, no flip, no purge', async () => {
    await seedVendor();
    await seedRequest();
    await seedWorkflow();
    const email = vi.fn<SendClaimDecisionEmail>(async () => {});
    const batchSpy = vi.spyOn(t.db, 'batch');

    const { status, body, send } = await patchClaim(moderateApp(resolveLinked(null), email), {
      action: 'approve',
    });

    expect(status).toBe(200);
    expect(body.grant).toEqual({
      user_id: CLAIMANT_ID,
      vendor_id: VENDOR_ID,
      verified: false,
      identity_outcome: 'linked',
      seat_created: true,
      tier: 'unclaimed',
    });
    expect(body.request.status).toBe('resolved');
    expect(body.request.resolved_by).toBe(ADMIN_ID);

    // The seat, an owner: the vendor had no owner seat.
    const seat = await profileOf(CLAIMANT_ID);
    expect(seat).toMatchObject({ role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });

    // No entitlement row, and the vendor row is exactly as seeded.
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
    const vendor = await vendorOf(VENDOR_ID);
    expect(vendor!.verified).toBe(false);
    expect(vendor!.updatedAt).toBe(OLD_TS);

    // ONE batch: `grantSeatStatements`' six statements (the AECI-1333 sentinel first)
    // and the billing account's two.
    // The claim has no acceptances, so the link adds nothing.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(8);
    batchSpy.mockRestore();

    const req = await requestOf(REQUEST_ID);
    expect(req).toMatchObject({ status: 'resolved', resolvedById: ADMIN_ID });

    // The billing account, named for the vendor, no billing email until checkout.
    const accounts = await t.db.select().from(billingAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      vendorId: VENDOR_ID,
      name: 'Autodesk, Inc.',
      billingEmail: null,
      createdBy: ADMIN_ID,
    });

    // TWO audit rows: the claim decision and the billing account.
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action).sort()).toEqual([
      'billing_account.created',
      'vendor_claim.granted',
    ]);
    const claimAudit = audits.find((a) => a.action === 'vendor_claim.granted')!;
    // AECI-1192 / AECI-1193: the column, and the plan BEFORE the grant.
    expect(claimAudit).toMatchObject({
      actorId: ADMIN_ID,
      vendorId: VENDOR_ID,
      vendorTier: 'none',
      vendorEntitlementStatus: 'none',
    });
    expect(claimAudit.metadata).toMatchObject({
      source: 'admin-moderation',
      vendorId: VENDOR_ID,
      identity_outcome: 'linked',
      verified_flipped: false,
      billing_account_created: true,
    });
    expect(claimAudit.metadata).not.toHaveProperty('plan');
    expect(claimAudit.afterState).toMatchObject({ vendor_verified: false });
    const accountAudit = audits.find((a) => a.action === 'billing_account.created')!;
    expect(accountAudit).toMatchObject({
      entityType: 'billing_account',
      entityId: accounts[0]!.id,
      vendorId: VENDOR_ID,
    });
    expect(accountAudit.metadata).toMatchObject({ source_request_id: REQUEST_ID });

    // Workflow completed + transition.
    const [wf] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.entityId, REQUEST_ID));
    expect(wf).toMatchObject({ currentState: 'resolved', finalOutcome: 'completed' });
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);

    // Approve purges nothing: no cacheable page renders a seat or an account.
    expect(send).not.toHaveBeenCalled();
    // The approved email names the vendor, with no plan in the seam.
    expect(email).toHaveBeenCalledTimes(1);
    expect(email.mock.calls[0]![1]).toMatchObject({
      decision: 'approved',
      to: CLAIMANT_EMAIL,
      targetName: 'Autodesk, Inc.',
      vendorName: 'Autodesk, Inc.',
      identityOutcome: 'linked',
    });
    expect(email.mock.calls[0]![1]).not.toHaveProperty('plan');

    expect(claimModerationActions()).toEqual([['action:approve', 'outcome:ok']]);
  });

  it.each([
    ['plan', { plan: 'free' }],
    ['plan', { plan: 'managed' }],
    ['entitlement', { entitlement: { notes: 'PO 4417' } }],
  ])(
    'refuses an approve that names %s as 400 VALIDATION_FAILED, writing nothing',
    async (field, extra) => {
      await seedVendor();
      await seedRequest();
      const resolve = resolveThrows();

      const { status, body } = await patchClaim(moderateApp(resolve), {
        action: 'approve',
        ...extra,
      });

      expect(status).toBe(400);
      expect(body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
      expect(body.error.field).toBe(field);
      expect(resolve).not.toHaveBeenCalled();
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
      expect((await requestOf(REQUEST_ID))!.status).toBe('open');
    },
  );

  it('links the claim’s terms acceptances to the seat, vendor and new billing account in the same batch', async () => {
    await seedVendor();
    await seedRequest();
    await seedRequest({ id: REQUEST2_ID, submitterEmail: 'other@vendor.com' });
    const MINE = 'abababab-abab-4bab-8bab-abababababab';
    const THEIRS = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    await seedAcceptance(MINE);
    await seedAcceptance(THEIRS, REQUEST2_ID);
    const batchSpy = vi.spyOn(t.db, 'batch');

    const { status } = await patchClaim(moderateApp(resolveLinked(null)), { action: 'approve' });

    expect(status).toBe(200);
    // 6 seat (with the AECI-1333 sentinel) + 2 billing account + 2 acceptance link.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(10);
    batchSpy.mockRestore();

    const account = (await t.db.select().from(billingAccounts))[0]!;
    const rows = new Map(
      (await t.db.select().from(agreementAcceptances)).map((r) => [r.id, r] as const),
    );
    expect(rows.get(MINE)).toMatchObject({
      profileId: CLAIMANT_ID,
      vendorId: VENDOR_ID,
      billingAccountId: account.id,
    });
    expect(rows.get(THEIRS)).toMatchObject({ profileId: null, billingAccountId: null });

    const link = (await t.db.select().from(auditLog)).find((a) => a.action === 'agreement.linked')!;
    expect(link).toMatchObject({
      entityType: 'vendor_request',
      entityId: REQUEST_ID,
      vendorId: VENDOR_ID,
      actorId: ADMIN_ID,
    });
  });

  it('links acceptances to the EXISTING billing account on a vendor that has one', async () => {
    await seedVendor();
    await seedBillingAccount();
    await seedRequest();
    const MINE = 'abababab-abab-4bab-8bab-abababababab';
    await seedAcceptance(MINE);

    const { status } = await patchClaim(moderateApp(resolveLinked(null)), { action: 'approve' });

    expect(status).toBe(200);
    expect(await t.db.select().from(billingAccounts)).toHaveLength(1);
    const row = (await t.db.select().from(agreementAcceptances))[0]!;
    expect(row.billingAccountId).toBe(BILLING_ACCOUNT_ID);
  });

  it("forwards the grant's audit rows and transition in ONE batched request (connection limit)", async () => {
    await seedVendor();
    await seedRequest();
    vi.mocked(logBatchToPosthog).mockClear();
    vi.mocked(logToPosthog).mockClear();
    const { status } = await patchClaim(moderateApp(resolveInvited()), { action: 'approve' });
    expect(status).toBe(200);
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    const events = vi.mocked(logBatchToPosthog).mock.calls[0]![3] as { message: string }[];
    const messages = events.map((e) => e.message);
    // The claim row, the billing-account row and the workflow transition.
    expect(messages.filter((m) => m.startsWith('audit '))).toHaveLength(2);
    expect(messages.filter((m) => m.startsWith('workflow '))).toHaveLength(1);
    expect(perRowAuditForwards()).toEqual([]);
  });

  it('provisions a seat for an invited claimant (no prior profile row)', async () => {
    await seedVendor();
    await seedRequest();
    const resolve = resolveInvited();
    const email = vi.fn<SendClaimDecisionEmail>(async () => {});
    const { status, body } = await patchClaim(moderateApp(resolve, email), { action: 'approve' });

    expect(status).toBe(200);
    expect(body.grant).toMatchObject({ identity_outcome: 'invited', seat_created: true });
    const seat = await profileOf(CLAIMANT_ID);
    expect(seat!.role).toBe('vendor_admin');
    expect(seat!.vendorId).toBe(VENDOR_ID);
    // A fresh (non-terminal) claim resolves WITH provisioning — the invite path.
    expect(resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ provision: true }),
    );
    expect(email.mock.calls[0]![1]).toMatchObject({ identityOutcome: 'invited' });
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

    const snapshot = {
      id: CLAIMANT_ID,
      role: 'reviewer',
      vendorId: null,
      bannedAt: null,
      displayName: 'Jane Doe',
    };
    const { status, body } = await patchClaim(moderateApp(resolveLinked(snapshot)), {
      action: 'approve',
    });

    expect(status).toBe(200);
    expect(body.grant).toMatchObject({ seat_created: false });
    const seat = await profileOf(CLAIMANT_ID);
    expect(seat!.role).toBe('vendor_admin');
    expect(seat!.vendorId).toBe(VENDOR_ID);
    // Owned columns preserved. The claim's 'Sam Submitter' never replaces a set name.
    expect(seat!.displayName).toBe('Jane Doe');
    expect(seat!.themePreference).toBe('dark');
    const grantAudit = (await t.db.select().from(auditLog)).find(
      (a) => a.action === 'vendor_claim.granted',
    )!;
    expect(grantAudit.metadata).toMatchObject({ display_name_filled: false });
  });

  // AECI-1280: a seat with no name takes the claim's submitter_name.
  it('fills an empty display_name from the claim on an existing profile', async () => {
    await seedVendor();
    await t.db.insert(profiles).values({ id: CLAIMANT_ID, role: 'reviewer', displayName: null });
    await seedRequest();

    const snapshot = { id: CLAIMANT_ID, role: 'reviewer', vendorId: null, bannedAt: null };
    const { status } = await patchClaim(moderateApp(resolveLinked(snapshot)), {
      action: 'approve',
    });

    expect(status).toBe(200);
    expect((await profileOf(CLAIMANT_ID))!.displayName).toBe('Sam Submitter');
    const grantAudit = (await t.db.select().from(auditLog)).find(
      (a) => a.action === 'vendor_claim.granted',
    )!;
    expect(grantAudit.metadata).toMatchObject({ display_name_filled: true });
    expect(grantAudit.beforeState).toMatchObject({ seat_display_name: null });
    expect(grantAudit.afterState).toMatchObject({ seat_display_name: 'Sam Submitter' });
  });

  it('names a provisioned seat, and the first sign-in keeps that name', async () => {
    await seedVendor();
    await seedRequest();
    const { status } = await patchClaim(moderateApp(resolveInvited()), { action: 'approve' });
    expect(status).toBe(200);
    expect((await profileOf(CLAIMANT_ID))!.displayName).toBe('Sam Submitter');

    // The claimant's first sign-in runs the profile-ensure insert (ON CONFLICT DO NOTHING).
    const { created } = await ensureProfileRow(t.db, CLAIMANT_ID, 'auth-callback');
    expect(created).toBe(false);
    expect((await profileOf(CLAIMANT_ID))!.displayName).toBe('Sam Submitter');
  });

  it('does not fill or truncate a claim name longer than the account cap', async () => {
    await seedVendor();
    await seedRequest({ submitterName: 'N'.repeat(81) });
    const { status } = await patchClaim(moderateApp(resolveInvited()), { action: 'approve' });
    expect(status).toBe(200);
    expect((await profileOf(CLAIMANT_ID))!.displayName).toBeNull();
    const grantAudit = (await t.db.select().from(auditLog)).find(
      (a) => a.action === 'vendor_claim.granted',
    )!;
    expect(grantAudit.metadata).toMatchObject({ display_name_filled: false });
  });

  it('a second seat on a seated vendor is a non-owner; verified, entitlement and account untouched', async () => {
    await seedVendor({ verified: true, updatedAt: OLD_TS });
    // A Managed vendor from before AECI-1367: an active entitlement and an account.
    await seedEntitlement('active');
    // The live license the plan snapshot reads (AECI-1355).
    await seedBillingAccount();
    await seedLicense(t.db, VENDOR_ID);
    // Existing owner seat A.
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    await seedRequest({ id: REQUEST2_ID, submitterEmail: 'second@vendor.com' });

    const { status, body } = await patchClaim(
      moderateApp(resolveLinked(null, CLAIMANT2_ID)),
      { action: 'approve' },
      REQUEST2_ID,
    );

    expect(status).toBe(200);
    // Owner rule (Portal §11a.4): the vendor already had an unbanned owner.
    expect(await profileOf(CLAIMANT2_ID)).toMatchObject({
      role: 'vendor_admin',
      vendorId: VENDOR_ID,
      seatOwner: false,
    });
    expect((await profileOf(CLAIMANT_ID))!.seatOwner).toBe(true);
    const vendor = await vendorOf(VENDOR_ID);
    expect(vendor!.verified).toBe(true);
    expect(vendor!.updatedAt).toBe(OLD_TS);
    const ents = await t.db.select().from(vendorEntitlements);
    expect(ents).toHaveLength(1);
    expect(ents[0]).toMatchObject({ status: 'active', updatedAt: OLD_TS });
    // `tier` is the vendor's live state: still Managed.
    expect(body.grant).toMatchObject({ tier: 'verified', verified: true });
    const accounts = await t.db.select().from(billingAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: BILLING_ACCOUNT_ID, updatedAt: OLD_TS });
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(['vendor_claim.granted']);
    expect(audits[0]!.metadata).toMatchObject({ billing_account_created: false });
    // AECI-1355: the plan BEFORE the grant comes from the vendor's licenses.
    expect(audits[0]).toMatchObject({ vendorTier: 'verified', vendorEntitlementStatus: 'active' });
  });

  it('a claimant on a vendor whose only owner is banned becomes the owner', async () => {
    await seedVendor();
    await t.db.insert(profiles).values({
      id: CLAIMANT2_ID,
      role: 'vendor_admin',
      vendorId: VENDOR_ID,
      seatOwner: true,
      bannedAt: OLD_TS,
    });
    await seedRequest();

    const { status } = await patchClaim(moderateApp(resolveLinked(null)), { action: 'approve' });

    expect(status).toBe(200);
    expect((await profileOf(CLAIMANT_ID))!.seatOwner).toBe(true);
  });

  it('a claim granted on a banned vendor clears only the vendor-banned license flags (ruled 2026-10-15)', async () => {
    await seedVendor();
    await t.db.insert(profiles).values({
      id: CLAIMANT2_ID,
      role: 'vendor_admin',
      vendorId: VENDOR_ID,
      seatOwner: true,
      bannedAt: OLD_TS,
    });
    const seeds = await seedCancelFlags(t.db, VENDOR_ID);
    await seedRequest();
    const batchSpy = vi.spyOn(t.db, 'batch');

    const { status } = await patchClaim(moderateApp(resolveLinked(null)), { action: 'approve' });

    expect(status).toBe(200);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    batchSpy.mockRestore();
    expect(await readCancelFlags(t.db, seeds)).toEqual(FLAGS_AFTER_GRANT);
    const cleared = (await t.db.select().from(auditLog)).filter(
      (a) => a.action === 'license.cancel_at_term_end_cleared',
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ actorId: ADMIN_ID, entityType: 'billing_account' });
    expect(cleared[0]!.metadata).toMatchObject({
      license_id: seeds.banned,
      seat_user_id: CLAIMANT_ID,
    });
  });

  it('a seated vendor with no billing account yet gets one with the next seat (pre-back-fill)', async () => {
    // A vendor seated before AECI-1351 has no account until the back-fill runs. The
    // next approval creates it: the builder keys on the account, not on the seat count.
    await seedVendor({ verified: true, updatedAt: OLD_TS });
    await seedEntitlement('active');
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID });
    await seedRequest({ id: REQUEST2_ID, submitterEmail: 'second@vendor.com' });

    const { status } = await patchClaim(
      moderateApp(resolveLinked(null, CLAIMANT2_ID)),
      { action: 'approve' },
      REQUEST2_ID,
    );

    expect(status).toBe(200);
    expect(await t.db.select().from(billingAccounts)).toHaveLength(1);
    expect((await t.db.select().from(auditLog)).map((a) => a.action).sort()).toEqual([
      'billing_account.created',
      'vendor_claim.granted',
    ]);
    // AECI-1355: the plan snapshot reads licenses, and this vendor has none yet, so
    // the active `vendor_entitlements` row does not make it read as Managed.
    const granted = (await t.db.select().from(auditLog)).filter(
      (a) => a.action === 'vendor_claim.granted' || a.action === 'billing_account.created',
    );
    for (const a of granted) {
      expect(a).toMatchObject({ vendorTier: 'none', vendorEntitlementStatus: 'none' });
    }
    // Still no `vendors` write: the account row does not touch the vendor.
    expect((await vendorOf(VENDOR_ID))!.updatedAt).toBe(OLD_TS);
  });

  it('leaves an ended entitlement ended rather than reactivating it', async () => {
    await seedVendor();
    await seedEntitlement('revoked');
    await seedRequest();

    const { status, body } = await patchClaim(moderateApp(resolveLinked(null)), {
      action: 'approve',
    });

    expect(status).toBe(200);
    const ents = await t.db.select().from(vendorEntitlements);
    expect(ents).toHaveLength(1);
    expect(ents[0]).toMatchObject({ status: 'revoked', updatedAt: OLD_TS });
    expect((await vendorOf(VENDOR_ID))!.verified).toBe(false);
    expect(body.grant).toMatchObject({ tier: 'unclaimed', verified: false });
  });

  it('grants no license, even on a vendor that owns products', async () => {
    await seedVendor();
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'revit', name: 'Revit' });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: true });
    await seedRequest();

    const { status, send } = await patchClaim(moderateApp(resolveLinked(null)), {
      action: 'approve',
    });

    expect(status).toBe(200);
    expect(await t.db.select().from(licenses)).toHaveLength(0);
    expect(await t.db.select().from(billingAccounts)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
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
    // §6.5: this path returns BEFORE any batch is built, so the summary is a pure
    // readout. This fixture is the drifted pre-backfill state (`verified = 1`, no
    // entitlement row) and `tierFor` fails closed rather than inferring a tier from
    // the mirror — `unclaimed`, not a flattering `verified`.
    expect(body.grant).toEqual({
      user_id: CLAIMANT_ID,
      vendor_id: VENDOR_ID,
      verified: true,
      identity_outcome: 'linked',
      seat_created: false,
      tier: 'unclaimed',
    });
    // No new audit / transition rows, no purge, no email.
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(claimModerationActions()).toEqual([['action:approve', 'outcome:noop']]);
  });

  it('resolves the product’s primary vendor for a target_type=product claim, and names the vendor in the email', async () => {
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
    const email = vi.fn<SendClaimDecisionEmail>(async () => {});

    const { status, body, send } = await patchClaim(moderateApp(resolve, email), {
      action: 'approve',
    });

    expect(status).toBe(200);
    expect(body.grant.vendor_id).toBe(VENDOR_ID);
    // Resolution was asked about the PRIMARY vendor, not the product id.
    expect(vi.mocked(resolve).mock.calls[0]![2]).toMatchObject({ vendorId: VENDOR_ID });
    expect((await profileOf(CLAIMANT_ID))!.vendorId).toBe(VENDOR_ID);
    expect((await vendorOf(VENDOR_ID))!.verified).toBe(false);
    expect(send).not.toHaveBeenCalled();
    // The claim named the product. The account belongs to the vendor.
    expect(email.mock.calls[0]![1]).toMatchObject({
      targetName: 'Revit',
      vendorName: 'Autodesk, Inc.',
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

    const { status, body } = await patchClaim(moderateApp(resolver()), {
      action: 'approve',
    });

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

  it('resolves a terminal claim LOOKUP-ONLY so a gone claimant 422s without an orphan create', async () => {
    await seedVendor({ verified: true });
    await seedRequest({ status: 'resolved' });
    // The claimant's auth user was deleted (e.g. GDPR erasure). Previously the
    // invite path would provision a fresh orphan auth user before 422-ing; the fix
    // resolves terminal claims with `provision: false`, so resolution returns
    // `not_found` and nothing is created.
    const resolve = resolveNotFound();

    const { status, body } = await patchClaim(moderateApp(resolve), {
      action: 'approve',
    });

    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    // The load-bearing guarantee against orphans: the handler asked to NOT provision.
    expect(resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ provision: false }),
    );
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(claimModerationActions()).toEqual([['action:approve', 'outcome:invalid_state']]);
  });

  it('returns 422 for an already-rejected claim without resolving identity (no orphan create)', async () => {
    await seedVendor();
    // A rejected claim was never granted, so a re-approve must refuse BEFORE
    // resolveIdentity — otherwise its invite path would provision an orphan auth user.
    await seedRequest({ status: 'rejected' });
    const resolve = resolveThrows();

    const { status, body } = await patchClaim(moderateApp(resolve), {
      action: 'approve',
    });

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

    const { status, body } = await patchClaim(moderateApp(resolve), {
      action: 'approve',
    });

    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns the canonical 404 for an unknown claim id', async () => {
    const { status, body } = await patchClaim(moderateApp(resolveThrows()), {
      action: 'approve',
    });
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

    // No purge on reject; email fired with the claimed vendor's name (AECI-528).
    expect(send).not.toHaveBeenCalled();
    expect(email.mock.calls[0]![1]).toMatchObject({
      decision: 'rejected',
      to: CLAIMANT_EMAIL,
      targetName: 'Autodesk, Inc.',
    });
    // The internal `reason` is recorded in the audit metadata above but is NEVER
    // handed to the claimant email — closes the reviewer-note leak (§9).
    expect(email.mock.calls[0]![1]).not.toHaveProperty('reason');
    expect(claimModerationActions()).toEqual([['action:reject', 'outcome:ok']]);
  });

  it('forwards the audit row and the transition in ONE batched request (AECI-1112)', async () => {
    await seedVendor();
    await seedRequest();
    await seedWorkflow();
    vi.mocked(logBatchToPosthog).mockClear();
    vi.mocked(logToPosthog).mockClear();

    const { status } = await patchClaim(moderateApp(resolveThrows()), { action: 'reject' });

    expect(status).toBe(200);
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    const events = vi.mocked(logBatchToPosthog).mock.calls[0]![3] as {
      message: string;
      source: string;
    }[];
    expect(events.map((e) => e.message)).toEqual([
      `audit vendor_claim.rejected ${REQUEST_ID}`,
      expect.stringMatching(/^workflow open→rejected /),
    ]);
    expect(events.every((e) => e.source === 'admin-moderation')).toBe(true);
    expect(perRowAuditForwards()).toEqual([]);
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

// ─── The decision race (AECI-1333) ───────────────────────────────────────────
//
// The handler passes its status read, then a competing decision commits right
// before its batch. The batch opens with `claimUndecidedSentinel`, so the loser
// answers 409 CLAIM_ALREADY_DECIDED, writes nothing and sends no email.

describe('PATCH /api/admin/claims/:id — decision race (AECI-1333)', () => {
  /** Run `first` right before the next `db.batch`, then let that batch run. */
  function beforeNextBatch(first: () => Promise<unknown>) {
    const batch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: Parameters<typeof batch>[0]) => {
      await first();
      return batch(stmts);
    }) as unknown as typeof batch);
  }
  const actions = async () => (await t.db.select().from(auditLog)).map((a) => a.action).sort();

  it('approve after a reject committed: no seat, billing account, second audit or transition, no email', async () => {
    await seedVendor();
    await seedRequest();
    await seedWorkflow();
    const email = vi.fn<SendClaimDecisionEmail>(async () => {});
    beforeNextBatch(() => patchClaim(moderateApp(resolveThrows(), email), { action: 'reject' }));

    const { status, body } = await patchClaim(moderateApp(resolveLinked(null), email), {
      action: 'approve',
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.CLAIM_ALREADY_DECIDED);
    expect(body.error.details).toEqual({ status: 'rejected' });
    expect((await requestOf(REQUEST_ID))!.status).toBe('rejected');
    expect(await profileOf(CLAIMANT_ID)).toBeUndefined();
    expect(await t.db.select().from(billingAccounts)).toHaveLength(0);
    expect(await actions()).toEqual(['vendor_claim.rejected']);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);
    const [wf] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.entityId, REQUEST_ID));
    expect(wf!.currentState).toBe('rejected');
    // Only the winning reject mailed.
    expect(email.mock.calls.map((call) => call[1].decision)).toEqual(['rejected']);
    expect(claimModerationActions()).toContainEqual(['action:approve', 'outcome:conflict']);
  });

  it('reject after an approve committed: the claim stays granted, no reject row, no email', async () => {
    await seedVendor();
    await seedRequest();
    await seedWorkflow();
    const email = vi.fn<SendClaimDecisionEmail>(async () => {});
    beforeNextBatch(() =>
      patchClaim(moderateApp(resolveLinked(null), email), { action: 'approve' }),
    );

    const { status, body } = await patchClaim(moderateApp(resolveThrows(), email), {
      action: 'reject',
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.CLAIM_ALREADY_DECIDED);
    expect(body.error.details).toEqual({ status: 'resolved' });
    expect((await requestOf(REQUEST_ID))!.status).toBe('resolved');
    expect((await profileOf(CLAIMANT_ID))!.vendorId).toBe(VENDOR_ID);
    expect(await actions()).toEqual(['billing_account.created', 'vendor_claim.granted']);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);
    expect(email.mock.calls.map((call) => call[1].decision)).toEqual(['approved']);
    expect(claimModerationActions()).toContainEqual(['action:reject', 'outcome:conflict']);
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
      vendorPlan: { tier: 'none', status: 'none' as const },
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
    expect(audits[0]!.metadata).toMatchObject({ verified_untouched: true, vendorId: VENDOR_ID });
    expect(audits[0]!.vendorId).toBe(VENDOR_ID);
  });
});

// ─── GET /api/admin/claims — the reviewer-assist LIST (AECI-521 / §5) ─────────

/** Stub-middleware app for the claims LIST (the `requireAdmin()` guard is covered
 *  in `authz.spec.ts`). `fetchAuthAccounts` (the GoTrue signal seam) and `dbFor`
 *  (to exercise the fail-soft enrichment) are injectable. */
/** The seat-email seam (AECI-1277), stubbed to "available, nobody has an address"
 *  unless a test injects its own, so no test reaches GoTrue. */
const noSeatEmails: FetchSeatEmails = vi.fn(async () => ({
  available: true,
  emails: new Map<string, string>(),
  reason: 'ok' as const,
}));

function claimsListApp(
  opts: {
    fetchAuthAccounts?: typeof fetchAuthAccountsByEmail;
    fetchEmails?: FetchSeatEmails;
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
    createAdminClaimsListHandler(
      opts.dbFor ?? t.factory,
      opts.fetchAuthAccounts,
      opts.fetchEmails ?? noSeatEmails,
    ),
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

/**
 * Same trick for the AECI-738 role query, which reads `product_vendors`.
 *
 * Only usable with a `target_type='vendor'` claim, and that is the point:
 * `resolveClaimVendorIds` also selects from `product_vendors`, but it SKIPS that
 * query entirely when no row targets a product. So on a vendor claim the role
 * lookup is the sole reader and this isolates it — throwing on a product claim
 * would degrade the vendor resolution instead and prove nothing about this signal.
 */
function factoryFailingProductRoleSelect(failOn: unknown = productVendors): typeof t.factory {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const real: any = t.db;
  const dbProxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'query') return target.query;
      if (prop === 'select') {
        return (...args: any[]) => {
          const builder = target.select(...args);
          return new Proxy(builder, {
            get(b, bProp) {
              if (bProp === 'from') {
                return (tbl: unknown) => {
                  if (tbl === failOn) throw new Error('role lookup boom');
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
    // An open claim was never granted.
    expect(body.data[0]!.granted).toBe(false);
  });

  // AECI-1322: `granted` separates the grant from a Linear Done (no resolver).
  it('reports granted only for a claim resolved with a resolving admin', async () => {
    await seedVendor();
    await seedRequest({
      id: REQUEST_ID,
      status: 'resolved',
      resolvedById: ADMIN_ID,
      resolvedAt: OLD_TS,
      createdAt: '2026-06-02T00:00:00.000Z',
    });
    await seedRequest({
      id: REQUEST2_ID,
      status: 'resolved',
      resolvedById: null,
      resolvedAt: OLD_TS,
      submitterEmail: 'webhook@vendor.com',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    const body = await parseClaims(await getClaims({}, '?status=resolved'));
    const byId = new Map(body.data.map((d) => [d.id, d.granted] as const));
    expect(byId.get(REQUEST_ID)).toBe(true);
    expect(byId.get(REQUEST2_ID)).toBe(false);
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

  it('lists existing seats A to Z by display name, unnamed last (AECI-1243)', async () => {
    await seedVendor();
    await seedRequest();
    await t.db.insert(profiles).values([
      {
        id: CLAIMANT_ID,
        role: 'vendor_admin',
        vendorId: VENDOR_ID,
        displayName: null,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: CLAIMANT2_ID,
        role: 'vendor_admin',
        vendorId: VENDOR_ID,
        displayName: 'zed',
        createdAt: '2026-05-02T00:00:00.000Z',
      },
      {
        id: '00000000-0000-4000-8000-0000000009a1',
        role: 'vendor_admin',
        vendorId: VENDOR_ID,
        displayName: 'Amy',
        createdAt: '2026-05-03T00:00:00.000Z',
      },
    ]);

    const body = await parseClaims(await getClaims());
    expect(body.data[0]!.existing_seats!.map((s) => s.display_name)).toEqual(['Amy', 'zed', null]);
  });

  // ── AECI-1277: a seat is labelled by its name, else its email ──────────────
  it('attaches each seat’s email from ONE seam call over the distinct seat ids (AECI-1277)', async () => {
    await seedVendor();
    // Two claims on the same vendor share its roster: the seam must still see each
    // seat id once, not once per claim.
    await seedRequest();
    await seedRequest({ id: '88888888-8888-4888-8888-888888888888' });
    await t.db.insert(profiles).values([
      { id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID, displayName: null },
      { id: CLAIMANT2_ID, role: 'vendor_admin', vendorId: VENDOR_ID, displayName: 'Named' },
    ]);
    const fetchEmails = vi.fn<FetchSeatEmails>(async () => ({
      available: true,
      emails: new Map([[CLAIMANT_ID, 'holder@acme.com']]),
      reason: 'ok' as const,
    }));

    const body = await parseClaims(await getClaims({ fetchEmails }));

    expect(fetchEmails).toHaveBeenCalledTimes(1);
    expect([...fetchEmails.mock.calls[0]![1]].sort()).toEqual([CLAIMANT_ID, CLAIMANT2_ID].sort());
    for (const claim of body.data) {
      expect(claim.seat_emails_available).toBe(true);
      expect(claim.existing_seats).toEqual([
        expect.objectContaining({ display_name: 'Named', email: null }),
        expect.objectContaining({ display_name: null, email: 'holder@acme.com' }),
      ]);
    }
  });

  it('reports seat emails unavailable when the seam cannot answer (AECI-1277)', async () => {
    await seedVendor();
    await seedRequest();
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID, displayName: null });
    const fetchEmails = vi.fn<FetchSeatEmails>(async () => ({
      available: false,
      emails: new Map<string, string>(),
      reason: 'no_credentials' as const,
    }));

    const body = await parseClaims(await getClaims({ fetchEmails }));

    expect(body.data[0]!.seat_emails_available).toBe(false);
    expect(body.data[0]!.existing_seats).toEqual([expect.objectContaining({ email: null })]);
  });

  it('does not call the seat-email seam when no claim has a seat (AECI-1277)', async () => {
    await seedVendor();
    await seedRequest();
    const fetchEmails = vi.fn<FetchSeatEmails>();

    const body = await parseClaims(await getClaims({ fetchEmails }));

    expect(fetchEmails).not.toHaveBeenCalled();
    expect(body.data[0]!.existing_seats).toEqual([]);
    expect(body.data[0]!.seat_emails_available).toBe(true);
  });

  // ── The entitlement column (AECI-532 / STAGE_2_PAID_TIERS_SPEC.md §5) ──────

  it('resolves the entitlement vendor + readout for a vendor claim', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement('active');
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    // The control addresses `PATCH /api/admin/vendors/:id/entitlement`, so it needs a
    // VENDOR id — `target_id` happens to be one here, but not on a product claim.
    expect(row.entitlement_vendor).toEqual({
      id: VENDOR_ID,
      name: 'Autodesk, Inc.',
      slug: 'autodesk',
    });
    expect(row.entitlement).toMatchObject({
      vendor_id: VENDOR_ID,
      tier: 'verified',
      status: 'active',
      verified: true,
    });
  });

  it('resolves a PRODUCT claim to the primary vendor, not the product', async () => {
    await seedVendor();
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'revit', name: 'Revit' });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: true });
    await seedRequest({ targetType: 'product', targetId: PRODUCT_ID });

    const row = (await parseClaims(await getClaims())).data[0]!;
    // Same resolution `resolveTargetVendor` runs on the grant path — otherwise the
    // queue would offer an entitlement control pointed at a product id.
    expect(row.entitlement_vendor?.id).toBe(VENDOR_ID);
    expect(row.entitlement).toBeNull();
  });

  // AECI-1364: a product-page claim is stored on the company with the product as context.
  it('hydrates context_product for a company claim sent from a product page', async () => {
    await seedVendor();
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'revit', name: 'Revit' });
    await seedRequest({ contextProductId: PRODUCT_ID });

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.target_type).toBe('vendor');
    expect(row.target?.id).toBe(VENDOR_ID);
    expect(row.context_product).toEqual({ id: PRODUCT_ID, name: 'Revit', slug: 'revit' });
  });

  it('reports context_product: null for a company-page claim and a gone product', async () => {
    await seedVendor();
    await seedRequest({ contextProductId: '99999999-9999-4999-8999-999999999999' });

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.context_product).toBeNull();
  });

  it('reports entitlement: null (not an error) for a vendor that has never been entitled', async () => {
    await seedVendor();
    await seedRequest();
    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.entitlement_vendor?.id).toBe(VENDOR_ID);
    expect(row.entitlement).toBeNull();
  });

  it('surfaces a CLEARED entitlement as its terminal status with verified false', async () => {
    await seedVendor({ verified: false });
    await seedEntitlement('revoked');
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.entitlement).toMatchObject({ status: 'revoked', verified: false });
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

  // ── The §5.2 payer test (AECI-738) ────────────────────────────────────────
  //
  // `STAGE_2_SPEC.md` §8.8(1): does the vendor own ANY product with
  // `product_role IN ('application','hybrid')`? Only a vendor all of whose
  // products are `'connector'` routes to the partnership track.

  /** Give VENDOR_ID one product per supplied role. */
  async function seedOwnedProducts(...roles: string[]): Promise<void> {
    let n = 0;
    for (const role of roles) {
      const id = `9999999${n}-9999-4999-8999-99999999999${n}`;
      await t.db.insert(products).values({ id, slug: `p-${n}`, name: `P${n}`, productRole: role });
      await t.db.insert(productVendors).values({ productId: id, vendorId: VENDOR_ID });
      n += 1;
    }
  }

  it('flags a vendor whose every product is a connector', async () => {
    await seedVendor();
    await seedOwnedProducts('connector', 'connector');
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.product_roles).toEqual({ application: 0, connector: 2, hybrid: 0, total: 2 });
    expect(row.is_pure_connector_vendor).toBe(true);
  });

  it('does NOT flag a vendor that also owns an application product', async () => {
    await seedVendor();
    await seedOwnedProducts('application', 'connector');
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.product_roles).toEqual({ application: 1, connector: 1, hybrid: 0, total: 2 });
    // The Autodesk/Trimble/Deltek/Sage case: owning connector-role products does
    // not make a large endpoint account a connector vendor.
    expect(row.is_pure_connector_vendor).toBe(false);
  });

  it('treats `hybrid` as an endpoint, so a hybrid+connector vendor is not flagged', async () => {
    await seedVendor();
    await seedOwnedProducts('hybrid', 'connector');
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.product_roles).toEqual({ application: 0, connector: 1, hybrid: 1, total: 2 });
    // §8.8(1)'s hybrid rule: a hybrid IS an endpoint as well as a connector, so it
    // is chargeable on its endpoint side and confers no exemption.
    expect(row.is_pure_connector_vendor).toBe(false);
  });

  it('reports a vendor with no products as unknown (zeroed), never as exempt', async () => {
    await seedVendor();
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    // NOT null — "owns nothing" is a computed answer the operator must see, and
    // it must not read as "every product is a connector".
    expect(row.product_roles).toEqual({ application: 0, connector: 0, hybrid: 0, total: 0 });
    expect(row.is_pure_connector_vendor).toBe(false);
  });

  it('scopes the breakdown to the claimed product’s PRIMARY vendor', async () => {
    await seedVendor(); // primary
    await t.db
      .insert(vendors)
      .values({ id: OTHER_VENDOR_ID, slug: 'other', companyName: 'Other Co' });
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'revit', name: 'Revit' });
    await t.db.insert(productVendors).values([
      { productId: PRODUCT_ID, vendorId: OTHER_VENDOR_ID, isPrimary: false },
      { productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: true },
    ]);
    await seedRequest({ targetType: 'product', targetId: PRODUCT_ID });

    const row = (await parseClaims(await getClaims())).data[0]!;
    // One product, counted once, against the vendor a grant would actually touch.
    expect(row.product_roles).toEqual({ application: 1, connector: 0, hybrid: 0, total: 1 });
    expect(row.entitlement_vendor?.id).toBe(VENDOR_ID);
  });

  it('degrades a failed role lookup to null on both fields', async () => {
    await seedVendor();
    await seedOwnedProducts('connector');
    await seedRequest();

    const res = await getClaims({ dbFor: factoryFailingProductRoleSelect() });
    expect(res.status).toBe(200);
    const row = (await parseClaims(res)).data[0]!;
    expect(row.product_roles).toBeNull();
    expect(row.is_pure_connector_vendor).toBeNull();
    // The row and the independent signals still return.
    expect(row.id).toBe(REQUEST_ID);
    expect(row.related_requests).not.toBeNull();
  });

  // ── The §5.2 step 1a owner test (AECI-1041) ─────────────────────────────
  //
  // `STAGE_2_SPEC.md` §8.10(1): a pure connector vendor that owns live
  // integrations (`built_by_vendor_id`) is a paying third-party owner. Counted
  // over BOTH delivered-tier tables, live rows only.

  /** Two endpoint products owned by nobody, plus a connector, for edges to join. */
  async function seedEdgeEndpoints(): Promise<[string, string, string]> {
    const a = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const b = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const conn = 'cccccccc-0000-4000-8000-00000000000c';
    await t.db.insert(products).values([
      { id: a, slug: 'end-a', name: 'End A' },
      { id: b, slug: 'end-b', name: 'End B' },
      { id: conn, slug: 'conn', name: 'Conn', productRole: 'connector' },
    ]);
    return [a, b, conn];
  }

  it('counts owned integrations across both tables and drops a retired row', async () => {
    await seedVendor();
    await seedOwnedProducts('connector');
    const [a, b, conn] = await seedEdgeEndpoints();
    await t.db.insert(integrations).values([
      { id: 'i-live', sourceProductId: a, targetProductId: b, builtByVendorId: VENDOR_ID },
      {
        id: 'i-retired',
        sourceProductId: b,
        targetProductId: a,
        builtByVendorId: VENDOR_ID,
        claimedAt: OLD_TS,
        retiredAt: OLD_TS,
      },
    ]);
    await t.db.insert(connectorEvidencedPairs).values([
      {
        id: 'e1',
        connectorProductId: conn,
        productAId: a,
        productBId: b,
        builtByVendorId: VENDOR_ID,
      },
    ]);
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.is_pure_connector_vendor).toBe(true);
    expect(row.owned_integrations).toEqual({ integrations: 1, connector_evidenced: 1, total: 2 });
  });

  it('reports a vendor that owns no integrations as zeroed, not null', async () => {
    await seedVendor();
    await seedOwnedProducts('connector');
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.owned_integrations).toEqual({ integrations: 0, connector_evidenced: 0, total: 0 });
  });

  it('counts only the resolved vendor, not another vendor’s integrations', async () => {
    await seedVendor();
    await t.db.insert(vendors).values({ id: OTHER_VENDOR_ID, slug: 'other', companyName: 'Other' });
    const [a, b, conn] = await seedEdgeEndpoints();
    await t.db.insert(connectorEvidencedPairs).values([
      {
        id: 'e1',
        connectorProductId: conn,
        productAId: a,
        productBId: b,
        builtByVendorId: OTHER_VENDOR_ID,
      },
    ]);
    await seedRequest();

    const row = (await parseClaims(await getClaims())).data[0]!;
    expect(row.owned_integrations?.total).toBe(0);
  });

  it('degrades a failed owner lookup to null without touching the role signal', async () => {
    await seedVendor();
    await seedOwnedProducts('connector');
    await seedRequest();

    const res = await getClaims({
      dbFor: factoryFailingProductRoleSelect(connectorEvidencedPairs),
    });
    expect(res.status).toBe(200);
    const row = (await parseClaims(res)).data[0]!;
    expect(row.owned_integrations).toBeNull();
    expect(row.is_pure_connector_vendor).toBe(true);
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

// ─── AECI-739: claim DETAIL + the operator note ──────────────────────────────

const CORRECTION_ID = '99999999-9999-4999-8999-999999999999';

/** The GoTrue signal seam, stubbed to "no account on record" — these tests are
 *  about the note and the duplicate explanation, not `has_auth_account`. */
const noAuthAccounts = vi.fn(
  async () => new Map<string, boolean>(),
) as unknown as typeof fetchAuthAccountsByEmail;

function claimDetailApp(
  dbFor: typeof t.factory = t.factory,
  fetchEmails: FetchSeatEmails = noSeatEmails,
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/claims/*', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  app.get(
    '/api/admin/claims/:id',
    createAdminClaimDetailHandler(dbFor, noAuthAccounts, fetchEmails),
  );
  app.patch(
    '/api/admin/claims/:id/notes',
    createSaveClaimNotesHandler(dbFor, noAuthAccounts, fetchEmails),
  );
  return app;
}

const getClaim = (id: string) =>
  claimDetailApp().request(`/api/admin/claims/${id}`, {}, TEST_ENV, fakeExecutionContext());

const patchNotes = (id: string, body: unknown) =>
  claimDetailApp().request(
    `/api/admin/claims/${id}/notes`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

async function parseDetail(res: Response) {
  return AdminClaimDetailSchema.parse(await res.json());
}

describe('GET /api/admin/claims/:id — detail (AECI-739 / §5.2 step 6)', () => {
  it('returns the claim with every queue signal plus the note', async () => {
    await seedVendor();
    await seedRequest({ domainMatch: 'match', adminNotes: 'Parked: connector vendor.' });

    const res = await getClaim(REQUEST_ID);
    expect(res.status).toBe(200);
    const body = await parseDetail(res);
    expect(body.id).toBe(REQUEST_ID);
    expect(body.admin_notes).toBe('Parked: connector vendor.');
    expect(body.domain_match).toBe('match');
    expect(body.entitlement_vendor?.id).toBe(VENDOR_ID);
    // A resolved vendor owning no products is a ZEROED breakdown, not `null`.
    expect(body.product_roles?.total).toBe(0);
    expect(body.is_pure_connector_vendor).toBe(false);
    // Same convention for the owner test (AECI-1041).
    expect(body.owned_integrations).toEqual({
      integrations: 0,
      connector_evidenced: 0,
      total: 0,
    });
  });

  it('carries the "Came from" product (AECI-1364)', async () => {
    await seedVendor();
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'revit', name: 'Revit' });
    await seedRequest({ contextProductId: PRODUCT_ID });

    const body = await parseDetail(await getClaim(REQUEST_ID));
    expect(body.context_product).toEqual({ id: PRODUCT_ID, name: 'Revit', slug: 'revit' });
  });

  it('404s on an unknown id', async () => {
    const res = await getClaim(REQUEST2_ID);
    expect(res.status).toBe(404);
  });

  it('422s (not 404s) on a CORRECTION, matching the PATCH sibling on the same path', async () => {
    await seedVendor();
    await seedRequest({ id: CORRECTION_ID, kind: 'correction' });

    const res = await getClaim(CORRECTION_ID);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(body.error.message).toContain('/api/admin/requests');
  });

  it('is addressable at in_review — the status the LIST could not filter for before', async () => {
    await seedVendor();
    await seedRequest({ status: 'in_review' });

    const body = await parseDetail(await getClaim(REQUEST_ID));
    expect(body.status).toBe('in_review');
    // And the LIST can now find it, so the detail route implies no unreachable status.
    const list = await parseClaims(await getClaims({}, '?status=in_review'));
    expect(list.data.map((d) => d.id)).toEqual([REQUEST_ID]);
  });

  it('emits no audit row — it is a read (§9.3 / ADR 0022)', async () => {
    await seedVendor();
    await seedRequest();
    await getClaim(REQUEST_ID);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('names the open siblings behind the duplicate chip, and agrees with the LIST', async () => {
    await seedVendor();
    await seedRequest({ id: REQUEST_ID, createdAt: '2026-06-02T00:00:00.000Z' });
    // A DELIBERATELY parked sibling on the same target — the §5.2 step 5 trap.
    await seedRequest({
      id: REQUEST2_ID,
      submitterEmail: 'other@vendor.com',
      createdAt: '2026-06-01T00:00:00.000Z',
      adminNotes: 'Connector vendor — routed to the partnership track.',
    });

    const body = await parseDetail(await getClaim(REQUEST_ID));
    expect(body.is_duplicate).toBe(true);
    expect(body.duplicate_siblings).toHaveLength(1);
    expect(body.duplicate_siblings[0]).toMatchObject({
      id: REQUEST2_ID,
      match_reason: 'target',
      // The signal that separates a parked claim from an unattended one.
      has_notes: true,
    });

    // The two surfaces cannot disagree: the LIST's group-by arithmetic and the
    // detail's sibling SELECT are the same predicate.
    const listed = (await parseClaims(await getClaims())).data.find((d) => d.id === REQUEST_ID);
    expect(listed?.is_duplicate).toBe(body.is_duplicate);
  });

  it('reports no siblings, and is_duplicate false, for a lone claim', async () => {
    await seedVendor();
    await seedRequest();

    const body = await parseDetail(await getClaim(REQUEST_ID));
    expect(body.duplicate_siblings).toEqual([]);
    expect(body.is_duplicate).toBe(false);
  });

  it('excludes TERMINAL siblings — the chip is an open-claim signal', async () => {
    await seedVendor();
    await seedRequest({ id: REQUEST_ID });
    await seedRequest({ id: REQUEST2_ID, status: 'rejected', submitterEmail: 'other@vendor.com' });

    const body = await parseDetail(await getClaim(REQUEST_ID));
    expect(body.duplicate_siblings).toEqual([]);
  });

  it('labels an unnamed seat by its email on the detail too (AECI-1277)', async () => {
    await seedVendor();
    await seedRequest({ id: REQUEST_ID });
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID, displayName: null });
    const fetchEmails = vi.fn<FetchSeatEmails>(async () => ({
      available: true,
      emails: new Map([[CLAIMANT_ID, 'holder@acme.com']]),
      reason: 'ok' as const,
    }));

    const res = await claimDetailApp(t.factory, fetchEmails).request(
      `/api/admin/claims/${REQUEST_ID}`,
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = await parseDetail(res);

    expect(fetchEmails).toHaveBeenCalledWith(TEST_ENV, [CLAIMANT_ID]);
    expect(body.seat_emails_available).toBe(true);
    expect(body.existing_seats).toEqual([
      expect.objectContaining({ display_name: null, email: 'holder@acme.com' }),
    ]);
  });
});

describe('PATCH /api/admin/claims/:id/notes — the operator note (AECI-739)', () => {
  it('writes the note and its audit row in ONE db.batch (§26.1)', async () => {
    await seedVendor();
    await seedRequest();

    const batchSpy = vi.spyOn(t.db, 'batch');
    const res = await patchNotes(REQUEST_ID, { notes: '  Routed to the partnership track.  ' });
    expect(res.status).toBe(200);

    // ONE batch, carrying both statements.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect((batchSpy.mock.calls[0]![0] as BatchTuple).length).toBe(2);
    batchSpy.mockRestore();

    const body = await parseDetail(res);
    expect(body.admin_notes).toBe('Routed to the partnership track.'); // trimmed
    const [row] = await t.db.select().from(vendorRequests).where(eq(vendorRequests.id, REQUEST_ID));
    expect(row!.adminNotes).toBe('Routed to the partnership track.');

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('vendor_claim.note_updated');
    expect(audits[0]!.entityType).toBe('vendor_request');
    expect(audits[0]!.entityId).toBe(REQUEST_ID);
    expect(audits[0]!.beforeState).toEqual({ admin_notes: null });
    expect(audits[0]!.afterState).toEqual({ admin_notes: 'Routed to the partnership track.' });
    expect(claimModerationActions()).toContainEqual(['action:note', 'outcome:ok']);
  });

  it('forwards the note audit row through the batched sender (AECI-1112)', async () => {
    await seedVendor();
    await seedRequest();
    vi.mocked(logBatchToPosthog).mockClear();
    vi.mocked(logToPosthog).mockClear();

    expect((await patchNotes(REQUEST_ID, { notes: 'Parked.' })).status).toBe(200);

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    const events = vi.mocked(logBatchToPosthog).mock.calls[0]![3] as { message: string }[];
    expect(events.map((e) => e.message)).toEqual([`audit vendor_claim.note_updated ${REQUEST_ID}`]);
    expect(perRowAuditForwards()).toEqual([]);
  });

  it('keeps the audit trail as the note HISTORY — an edit records both versions', async () => {
    await seedVendor();
    await seedRequest({ adminNotes: 'First pass.' });

    await patchNotes(REQUEST_ID, { notes: 'Second pass.' });
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.beforeState).toEqual({ admin_notes: 'First pass.' });
    expect(audits[0]!.afterState).toEqual({ admin_notes: 'Second pass.' });
  });

  it('writes NO workflow instance or transition — a note is not a status change', async () => {
    await seedVendor();
    await seedRequest();
    await patchNotes(REQUEST_ID, { notes: 'Parked.' });

    expect(await t.db.select().from(workflowInstances)).toHaveLength(0);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(0);
    const [row] = await t.db.select().from(vendorRequests).where(eq(vendorRequests.id, REQUEST_ID));
    expect(row!.status).toBe('open'); // status untouched
  });

  it('is writable at EVERY status, including the terminal ones', async () => {
    await seedVendor();
    for (const status of ['open', 'in_review', 'resolved', 'rejected'] as const) {
      await t.db.delete(vendorRequests);
      await t.db.delete(auditLog);
      await seedRequest({ status });
      const res = await patchNotes(REQUEST_ID, { notes: `Note at ${status}.` });
      expect(res.status).toBe(200);
      expect((await parseDetail(res)).admin_notes).toBe(`Note at ${status}.`);
    }
  });

  it('clears the note on null, and treats blank as null', async () => {
    await seedVendor();
    await seedRequest({ adminNotes: 'Something.' });

    expect(
      (await parseDetail(await patchNotes(REQUEST_ID, { notes: null }))).admin_notes,
    ).toBeNull();

    await t.db
      .update(vendorRequests)
      .set({ adminNotes: 'Something.' })
      .where(eq(vendorRequests.id, REQUEST_ID));
    const res = await patchNotes(REQUEST_ID, { notes: '   ' });
    expect((await parseDetail(res)).admin_notes).toBeNull();
    const audits = await t.db.select().from(auditLog);
    expect(audits.at(-1)!.afterState).toEqual({ admin_notes: null });
    expect(audits.at(-1)!.metadata).toMatchObject({ cleared: true });
  });

  it('an unchanged note is a 200 NO-OP that writes nothing', async () => {
    await seedVendor();
    await seedRequest({ adminNotes: 'Parked.' });

    const batchSpy = vi.spyOn(t.db, 'batch');
    const res = await patchNotes(REQUEST_ID, { notes: '  Parked.  ' }); // same after trimming
    expect(res.status).toBe(200);
    expect(batchSpy).not.toHaveBeenCalled();
    batchSpy.mockRestore();

    // No row: a trail of identical states is not a history.
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect((await parseDetail(res)).admin_notes).toBe('Parked.');
    expect(claimModerationActions()).toContainEqual(['action:note', 'outcome:noop']);
  });

  it('404s on an unknown id and 422s on a correction', async () => {
    await seedVendor();
    await seedRequest({ id: CORRECTION_ID, kind: 'correction' });

    expect((await patchNotes(REQUEST2_ID, { notes: 'x' })).status).toBe(404);
    expect((await patchNotes(CORRECTION_ID, { notes: 'x' })).status).toBe(422);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('rejects a note over the 2000-char cap', async () => {
    await seedVendor();
    await seedRequest();
    const res = await patchNotes(REQUEST_ID, { notes: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

// ─── AECI-1276: the claim's audit trail ──────────────────────────────────────

const AUDIT_IDS = [
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003',
  'a0000000-0000-4000-8000-000000000004',
  'a0000000-0000-4000-8000-000000000005',
] as const;

const emailsUp: FetchAuthEmails = async (_env, ids) => ({
  available: true,
  emails: new Map(ids.map((id) => [id, `${id.slice(0, 4)}@aeci.test`])),
  reason: 'ok',
});
const emailsDown: FetchAuthEmails = async () => ({
  available: false,
  emails: new Map(),
  reason: 'error',
});

function claimAuditApp(fetchEmails: FetchAuthEmails = emailsUp) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/claims/*', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  app.get('/api/admin/claims/:id/audit', createAdminClaimAuditHandler(t.factory, fetchEmails));
  return app;
}

const getClaimAudit = (id: string, qs = '', fetchEmails?: FetchAuthEmails) =>
  claimAuditApp(fetchEmails).request(
    `/api/admin/claims/${id}/audit${qs}`,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );

/** The claim's own history, plus the two rows that must NOT show: another claim's
 *  note and the vendor-entity Managed entitlement row. */
async function seedClaimTrail() {
  await seedVendor();
  await seedRequest();
  await seedRequest({ id: REQUEST2_ID, submitterEmail: 'other@vendor.com' });
  await t.db.insert(auditLog).values([
    {
      id: AUDIT_IDS[0],
      actorId: null,
      actorType: 'user',
      action: 'vendor_request.created',
      entityType: 'vendor_request',
      entityId: REQUEST_ID,
      afterState: { status: 'open' },
      createdAt: '2026-06-01T00:00:00.000Z',
    },
    {
      id: AUDIT_IDS[1],
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'vendor_claim.note_updated',
      entityType: 'vendor_request',
      entityId: REQUEST_ID,
      beforeState: { admin_notes: null },
      afterState: { admin_notes: 'Parked.' },
      createdAt: '2026-06-02T00:00:00.000Z',
    },
    {
      id: AUDIT_IDS[2],
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'vendor_claim.granted',
      entityType: 'vendor_request',
      entityId: REQUEST_ID,
      createdAt: '2026-06-03T00:00:00.000Z',
    },
    {
      id: AUDIT_IDS[3],
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'vendor_claim.note_updated',
      entityType: 'vendor_request',
      entityId: REQUEST2_ID,
      createdAt: '2026-06-02T00:00:00.000Z',
    },
    {
      id: AUDIT_IDS[4],
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'vendor_entitlement.granted',
      entityType: 'vendor_entitlement',
      entityId: VENDOR_ID,
      createdAt: '2026-06-03T00:00:00.000Z',
    },
  ]);
}

describe('GET /api/admin/claims/:id/audit — the claim trail (AECI-1276)', () => {
  it("returns only this claim's rows, newest first", async () => {
    await seedClaimTrail();

    const res = await getClaimAudit(REQUEST_ID);
    expect(res.status).toBe(200);
    const body = AdminClaimAuditResponseSchema.parse(await res.json());
    expect(body.data.map((r) => r.action)).toEqual([
      'vendor_claim.granted',
      'vendor_claim.note_updated',
      'vendor_request.created',
    ]);
    expect(body.data.every((r) => r.entity_id === REQUEST_ID)).toBe(true);
    expect(body.total).toBe(3);
    expect(body.actor_emails_available).toBe(true);
    expect(body.data[0]?.actor).toEqual({
      id: ADMIN_ID,
      display_name: null,
      email: '4444@aeci.test',
    });
  });

  it('reports actor null for a user row with no actor id (the public submission)', async () => {
    await seedClaimTrail();
    const body = AdminClaimAuditResponseSchema.parse(
      await (await getClaimAudit(REQUEST_ID)).json(),
    );
    const created = body.data.find((r) => r.action === 'vendor_request.created');
    expect(created?.actor).toBeNull();
    expect(created?.actor_type).toBe('user');
  });

  it('paginates with the total of the whole trail', async () => {
    await seedClaimTrail();
    const body = AdminClaimAuditResponseSchema.parse(
      await (await getClaimAudit(REQUEST_ID, '?page=2&perPage=2')).json(),
    );
    expect(body.page).toBe(2);
    expect(body.perPage).toBe(2);
    expect(body.total).toBe(3);
    expect(body.data.map((r) => r.action)).toEqual(['vendor_request.created']);
  });

  it('reports actor_emails_available false when the email seam fails', async () => {
    await seedClaimTrail();
    const body = AdminClaimAuditResponseSchema.parse(
      await (await getClaimAudit(REQUEST_ID, '', emailsDown)).json(),
    );
    expect(body.actor_emails_available).toBe(false);
    expect(body.data[0]?.actor?.email).toBeNull();
  });

  it('404s on an unknown id and 422s on a correction, like the detail GET', async () => {
    await seedVendor();
    await seedRequest({ id: CORRECTION_ID, kind: 'correction' });

    expect((await getClaimAudit(REQUEST2_ID)).status).toBe(404);
    const res = await getClaimAudit(CORRECTION_ID);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
  });

  it('writes no audit row of its own', async () => {
    await seedClaimTrail();
    await getClaimAudit(REQUEST_ID);
    expect(await t.db.select().from(auditLog)).toHaveLength(AUDIT_IDS.length);
  });
});
