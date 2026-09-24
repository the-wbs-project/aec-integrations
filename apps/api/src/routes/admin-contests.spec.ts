/**
 * Integration field contests, AECi side (AECI-1008). The Linear seam is injected,
 * so the post-commit `waitUntil` is asserted without a transport. The real
 * creator has its own spec (`lib/linear-contests.spec.ts`).
 */

import { AdminContestSchema, ListAdminContestsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createAdminContestsListHandler, createModerateContestHandler } from './admin-contests';
import { createSubmitContestHandler } from './vendor-contests';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const I_MAIN = uuid(20);
const SEAT_A = uuid(100);
/** The owner's seat. An owner with no active seat gets no owner-routed contest
 *  (AECI-989), so the owner routes below need one. */
const SEAT_B = uuid(101);
const ADMIN_ID = uuid(200);

const AUTH_A: AuthzVariables['auth'] = {
  userId: SEAT_A,
  email: 'a@example.test',
  role: 'vendor_admin',
  vendorId: VENDOR_A,
  entitlementTier: 'unclaimed',
  entitlement: null,
};
const ADMIN: AuthzVariables['auth'] = {
  userId: ADMIN_ID,
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;
let claimed = false;
const fileIssue = vi.fn();

beforeEach(async () => {
  claimed = false;
  fileIssue.mockReset().mockResolvedValue({ status: 'created', issueId: 'x', issueUrl: 'y' });
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db.insert(integrations).values({
    id: I_MAIN,
    name: 'Revit for MicroStation',
    sourceProductId: P_SOURCE,
    targetProductId: P_TARGET,
    direction: 'a_to_b',
    builtByVendorId: VENDOR_B,
  });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: ADMIN_ID, role: 'admin' },
  ]);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post(
    '/api/vendor/integrations/:id/contests',
    createSubmitContestHandler(t.factory, () => claimed),
  );
  a.get('/api/admin/contests', createAdminContestsListHandler(t.factory));
  a.patch('/api/admin/contests/:id', createModerateContestHandler(t.factory, fileIssue));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: JsonBody; waitUntil: ReturnType<typeof vi.fn> }> {
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const res = await app(auth).request(path, init, TEST_ENV as Env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return {
    status: res.status,
    body: (await res.json()) as JsonBody,
    waitUntil: vi.mocked(execCtx.waitUntil),
  };
}

async function fileContest(
  field = 'name',
  proposed: string | null = 'Revit Link',
): Promise<string> {
  const res = await call(AUTH_A, 'POST', `/api/vendor/integrations/${I_MAIN}/contests`, {
    field,
    proposed_value: proposed,
    reason: 'Per the vendor listing.',
  });
  expect(res.status).toBe(201);
  return res.body.contest.id as string;
}

describe('GET /api/admin/contests', () => {
  it('lists the open AECi queue by default, with both endpoints and the pair path', async () => {
    await fileContest();
    const res = await call(ADMIN, 'GET', '/api/admin/contests');
    expect(res.status).toBe(200);
    expect(() => ListAdminContestsResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      field: 'name',
      current_value: 'Revit for MicroStation',
      proposed_value: 'Revit Link',
      routed_to: 'aeci',
      status: 'open',
      submitter_vendor: { id: VENDOR_A, name: 'Autodesk' },
      owner_vendor: { id: VENDOR_B, name: 'Bentley' },
      upstream_linear_issue_id: null,
      integration: {
        id: I_MAIN,
        source_product: { slug: 'revit' },
        target_product: { slug: 'microstation' },
        pair_path: '/products/microstation/integrations/revit',
      },
    });
  });

  it('shows owner-routed rows only when asked, and filters by status', async () => {
    claimed = true;
    await fileContest();
    expect((await call(ADMIN, 'GET', '/api/admin/contests')).body.total).toBe(0);
    expect((await call(ADMIN, 'GET', '/api/admin/contests?routed_to=owner')).body.total).toBe(1);
    expect(
      (await call(ADMIN, 'GET', '/api/admin/contests?routed_to=owner&status=accepted')).body.total,
    ).toBe(0);
  });
});

describe('PATCH /api/admin/contests/:id', () => {
  it('accept records the decision, writes NO catalog data, and files the Linear issue', async () => {
    const id = await fileContest();
    const res = await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, {
      decision: 'accept',
      note: 'Checked against the listing.',
    });
    expect(res.status).toBe(200);
    expect(() => AdminContestSchema.parse(res.body)).not.toThrow();
    expect(res.body).toMatchObject({
      status: 'accepted',
      decision_note: 'Checked against the listing.',
    });

    const [row] = await t.db.select().from(integrationFieldChallenges);
    expect(row).toMatchObject({ status: 'accepted', decidedBy: ADMIN_ID });
    const [integration] = await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN));
    expect(integration!.name).toBe('Revit for MicroStation');
    expect(integration!.maintainedBy).toBe('aeci');

    expect(fileIssue).toHaveBeenCalledTimes(1);
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({
      contestId: id,
      integrationId: I_MAIN,
      field: 'name',
      currentValue: 'Revit for MicroStation',
      acceptedValue: 'Revit Link',
      submitterVendorName: 'Autodesk',
      adminNote: 'Checked against the listing.',
      pairPath: '/products/microstation/integrations/revit',
    });

    const audits = await t.db.select().from(auditLog);
    expect(audits.find((r) => r.action === 'integration.contest.accepted')).toMatchObject({
      actorType: 'admin',
      actorId: ADMIN_ID,
    });
    const notice = audits.find(
      (r) =>
        r.action === NOTIFICATION_SENT_ACTION &&
        (r.metadata as { event: string }).event === 'accepted',
    );
    expect(notice!.metadata).toMatchObject({ kind: 'contest', vendorId: VENDOR_A });
    expect(audits.some((r) => r.action === 'integration.updated')).toBe(false);

    const [instance] = await t.db.select().from(workflowInstances);
    expect(instance).toMatchObject({ currentState: 'accepted', finalOutcome: 'approved' });
    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions.map((r) => r.toState)).toEqual(['open', 'accepted']);
  });

  it('decline files no Linear issue', async () => {
    const id = await fileContest();
    const res = await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'decline' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('declined');
    expect(fileIssue).not.toHaveBeenCalled();
    const [instance] = await t.db.select().from(workflowInstances);
    expect(instance).toMatchObject({ currentState: 'declined', finalOutcome: 'rejected' });
  });

  it('answers 409 CONTEST_ROUTED_TO_OWNER on an owner-routed contest', async () => {
    claimed = true;
    const id = await fileContest();
    const res = await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'accept' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_ROUTED_TO_OWNER');
    expect(fileIssue).not.toHaveBeenCalled();
  });

  it('answers 409 CONTEST_NOT_OPEN a second time, and files once', async () => {
    const id = await fileContest();
    await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'accept' });
    const again = await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'decline' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONTEST_NOT_OPEN');
    expect(fileIssue).toHaveBeenCalledTimes(1);
  });

  it('a lost race (withdrawn under it) writes nothing, files nothing, answers 409', async () => {
    const id = await fileContest();
    const count = async () => ({
      audit: (await t.db.select().from(auditLog)).length,
      transitions: (await t.db.select().from(workflowTransitions)).length,
    });
    const before = await count();
    const original = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db
        .update(integrationFieldChallenges)
        .set({ status: 'withdrawn', updatedAt: new Date(Date.now() + 1000).toISOString() })
        .where(eq(integrationFieldChallenges.id, id));
      return original(stmts);
    }) as never);
    const res = await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'accept' });
    spy.mockRestore();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_NOT_OPEN');
    expect(await count()).toEqual(before);
    expect(fileIssue).not.toHaveBeenCalled();
    const [row] = await t.db.select().from(integrationFieldChallenges);
    expect(row).toMatchObject({ status: 'withdrawn', decidedBy: null });
  });

  it('answers 404 for an unknown id', async () => {
    const res = await call(ADMIN, 'PATCH', `/api/admin/contests/${uuid(999)}`, {
      decision: 'accept',
    });
    expect(res.status).toBe(404);
  });

  it('passes vendor names as labels for an owner contest', async () => {
    const id = await fileContest('owner', VENDOR_A);
    await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'accept' });
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({
      field: 'owner',
      currentValue: VENDOR_B,
      currentLabel: 'Bentley',
      acceptedValue: VENDOR_A,
      acceptedLabel: 'Autodesk',
    });
  });
});

// ─── Authorization, against the real guard ───────────────────────────────────

describe('/api/admin/contests — authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'preview', SUPABASE_URL } as Env;
  const REVIEWER_ID = uuid(300);

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guarded() {
    const guard = { getKey: jwks.getKey, dbFor: t.factory };
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.get('/api/admin/contests', requireAdmin(guard), createAdminContestsListHandler(t.factory));
    a.patch(
      '/api/admin/contests/:id',
      requireAdmin(guard),
      createModerateContestHandler(t.factory, fileIssue),
    );
    return a;
  }

  const request = (path: string, method: 'GET' | 'PATCH', token?: string) =>
    guarded().request(
      path,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(method === 'PATCH' ? { body: JSON.stringify({ decision: 'decline' }) } : {}),
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  it('401s an anonymous caller on both verbs', async () => {
    expect((await request('/api/admin/contests', 'GET')).status).toBe(401);
    expect((await request(`/api/admin/contests/${uuid(999)}`, 'PATCH')).status).toBe(401);
  });

  it('403s a signed-in non-admin on both verbs, and decides nothing', async () => {
    const id = await fileContest();
    await t.db.insert(profiles).values({ id: REVIEWER_ID, role: 'reviewer' });
    const token = await jwks.mintToken({ sub: REVIEWER_ID, supabaseUrl: SUPABASE_URL });
    expect((await request('/api/admin/contests', 'GET', token)).status).toBe(403);
    expect((await request(`/api/admin/contests/${id}`, 'PATCH', token)).status).toBe(403);
    const [row] = await t.db
      .select()
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.id, id));
    expect(row!.status).toBe('open');
  });

  it('403s a vendor seat, which is signed in but not an admin', async () => {
    const token = await jwks.mintToken({ sub: SEAT_A, supabaseUrl: SUPABASE_URL });
    expect((await request('/api/admin/contests', 'GET', token)).status).toBe(403);
  });

  it('lets an admin through', async () => {
    const token = await jwks.mintToken({ sub: ADMIN_ID, supabaseUrl: SUPABASE_URL });
    expect((await request('/api/admin/contests', 'GET', token)).status).toBe(200);
  });
});

// ─── AECI-1005: what an AECi accept writes once ownership exists ─────────────

const CLAIMED_AT = '2026-09-20T00:00:00.000Z';

async function setIntegration(values: Partial<typeof integrations.$inferInsert>) {
  await t.db.update(integrations).set(values).where(eq(integrations.id, I_MAIN));
}
const integrationRow = async () =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, I_MAIN) }))!;
const accept = (id: string) =>
  call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'accept' });
const auditActions = async () => (await t.db.select().from(auditLog)).map((r) => r.action);

describe('PATCH /api/admin/contests/:id — accepts on owned rows (AECI-1005)', () => {
  it('applies a content value here when the row is claimed, and says so on the issue', async () => {
    const id = await fileContest('name', 'Revit Link');
    // Filed while unclaimed (so routed to AECi), then the owner claimed it.
    await setIntegration({ claimedAt: CLAIMED_AT, maintainedBy: 'vendor' });
    const res = await accept(id);
    expect(res.status).toBe(200);
    expect((await integrationRow()).name).toBe('Revit Link');
    const updated = (await t.db.select().from(auditLog)).find(
      (r) => r.action === 'integration.updated',
    );
    expect(updated).toMatchObject({ actorId: ADMIN_ID, entityId: I_MAIN });
    expect(updated!.metadata).toMatchObject({ reason: 'contest-accepted', contestId: id });
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({ appliedMode: 'applied-here' });
    const decision = (await t.db.select().from(auditLog)).find(
      (r) => r.action === 'integration.contest.accepted',
    );
    expect(decision!.metadata).toMatchObject({ appliedMode: 'applied-here' });
  });

  it('writes nothing here for a content accept on an unclaimed row (unchanged)', async () => {
    const id = await fileContest('name', 'Revit Link');
    await accept(id);
    expect((await integrationRow()).name).toBe('Revit for MicroStation');
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({ appliedMode: 'upstream-only' });
  });

  it('approves an owner-unknown claim: owner + claimed_at + transfer, one batch (decision 11)', async () => {
    await setIntegration({ builtByVendorId: null });
    const id = await fileContest('owner', VENDOR_A);
    const res = await accept(id);
    expect(res.status).toBe(200);
    const row = await integrationRow();
    expect(row).toMatchObject({ builtByVendorId: VENDOR_A, maintainedBy: 'vendor' });
    expect(row.claimedAt).not.toBeNull();
    expect(row.lastReviewedAt).toBe(row.claimedAt);
    const audits = await t.db.select().from(auditLog);
    const claimedAudit = audits.find((r) => r.action === 'integration.claimed');
    expect(claimedAudit!.metadata).toMatchObject({ reason: 'owner-approved', contestId: id });
    // The other endpoint vendor is told, like an owner's own claim.
    const claimNotice = audits.find(
      (r) =>
        r.action === NOTIFICATION_SENT_ACTION &&
        (r.metadata as { kind: string }).kind === 'integration_claim',
    );
    expect(claimNotice!.metadata).toMatchObject({ vendorId: VENDOR_B, ownerVendorId: VENDOR_A });
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({
      field: 'owner',
      appliedMode: 'owner-recorded',
    });
  });

  it('records the owner and the claim on a connector-powered row too (AECI-1092 ruling C)', async () => {
    // Decision 9's v1 exception is retired: an admin owner-approval writes the owner
    // and `claimed_at` on a connector-powered row exactly as on any other row.
    await setIntegration({ builtByVendorId: null, mechanismKind: 'iPaaS' });
    const id = await fileContest('owner', VENDOR_A);
    const res = await accept(id);
    expect(res.status).toBe(200);
    const row = await integrationRow();
    expect(row.builtByVendorId).toBe(VENDOR_A);
    expect(row.claimedAt).not.toBeNull();
    expect(row.maintainedBy).toBe('vendor');
    expect(await auditActions()).toContain('integration.claimed');
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({ appliedMode: 'owner-recorded' });
  });

  it('reassigns a claimed row to someone else and clears claimed_at', async () => {
    await setIntegration({ claimedAt: CLAIMED_AT });
    // Owned by B and claimed; A says "neither endpoint vendor offers it".
    const id = await fileContest('owner', null);
    const res = await accept(id);
    expect(res.status).toBe(200);
    const row = await integrationRow();
    expect(row.builtByVendorId).toBeNull();
    expect(row.claimedAt).toBeNull();
    const updated = (await t.db.select().from(auditLog)).find(
      (r) => r.action === 'integration.updated',
    );
    expect(updated!.metadata).toMatchObject({ reason: 'owner-reassigned' });
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({ appliedMode: 'owner-recorded' });
  });

  it("re-routes the old owner's open contests to AECi when it reassigns the row (AECI-1005 review)", async () => {
    await setIntegration({ claimedAt: CLAIMED_AT });
    claimed = true;
    const ownerRouted = await fileContest('name', 'Revit Link');
    const [first] = await t.db.select().from(integrationFieldChallenges);
    expect(first!.routedTo).toBe('owner');
    // The owner field always routes to AECi; accepting "neither" reassigns the row.
    const reassign = await fileContest('owner', null);
    expect((await accept(reassign)).status).toBe(200);

    const rerouted = await t.db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, ownerRouted),
    });
    expect(rerouted).toMatchObject({ routedTo: 'aeci', status: 'open' });
    const audits = await t.db.select().from(auditLog);
    expect(
      audits.find((r) => r.action === 'integration.contest.rerouted' && r.entityId === ownerRouted),
    ).toBeDefined();
    const transitions = await t.db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, rerouted!.workflowId!));
    expect(transitions.map((r) => r.toState)).toEqual(['open', 'open']);
    // And it now sits in the AECi queue.
    expect((await readAdminQueueCounts(t.db)).pending_contests).toBe(1);
  });

  it('writes nothing for an owner reassignment on an unclaimed row (promote carries it)', async () => {
    const id = await fileContest('owner', null);
    await accept(id);
    expect((await integrationRow()).builtByVendorId).toBe(VENDOR_B);
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({ appliedMode: 'upstream-only' });
  });

  it('lets AECi decide a STRANDED owner-routed contest (owner vendor gone)', async () => {
    claimed = true;
    const id = await fileContest('name', 'Revit Link');
    await t.db
      .update(integrationFieldChallenges)
      .set({ ownerVendorId: null })
      .where(eq(integrationFieldChallenges.id, id));
    // It badges the queue, because AECi is now its decider.
    expect((await readAdminQueueCounts(t.db)).pending_contests).toBe(1);
    const res = await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'decline' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('declined');
    const decision = (await t.db.select().from(auditLog)).find(
      (r) => r.action === 'integration.contest.declined',
    );
    expect(decision).toBeDefined();
  });

  it('aborts the whole decision when the row is claimed between read and commit', async () => {
    const id = await fileContest('name', 'Revit Link');
    const racing: DbFactory = (env, opts) => {
      const ctx = t.factory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db);
      (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
        t.raw
          .prepare('UPDATE integrations SET claimed_at = ? WHERE id = ?')
          .run(CLAIMED_AT, I_MAIN);
        return batch(stmts);
      }) as typeof batch;
      return ctx;
    };
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', ADMIN);
      await next();
    });
    a.patch('/api/admin/contests/:id', createModerateContestHandler(racing, fileIssue));
    const res = await a.request(
      `/api/admin/contests/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ decision: 'accept' }),
        headers: { 'content-type': 'application/json' },
      },
      TEST_ENV as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as JsonBody).error.code).toBe('CONTEST_INTEGRATION_CHANGED');
    const [contest] = await t.db.select().from(integrationFieldChallenges);
    expect(contest!.status).toBe('open');
    expect(await auditActions()).not.toContain('integration.contest.accepted');
    expect(fileIssue).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/contests/:id — a stale accept on a claimed row (AECI-1006)', () => {
  it('refuses with 409 CONTEST_VALUE_STALE when the owner edited the field since submit, and writes nothing', async () => {
    const id = await fileContest('name', 'Revit Link');
    // Claimed, then the owner edited the name itself.
    await setIntegration({ claimedAt: CLAIMED_AT, name: 'Owner’s own name' });
    const res = await accept(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_VALUE_STALE');
    expect((await integrationRow()).name).toBe('Owner’s own name');
    const [contest] = await t.db.select().from(integrationFieldChallenges);
    expect(contest!.status).toBe('open');
    expect(await auditActions()).not.toContain('integration.contest.accepted');
    expect(fileIssue).not.toHaveBeenCalled();
  });

  it('still lets the admin decline a stale contest', async () => {
    const id = await fileContest('name', 'Revit Link');
    await setIntegration({ claimedAt: CLAIMED_AT, name: 'Owner’s own name' });
    const res = await call(ADMIN, 'PATCH', `/api/admin/contests/${id}`, { decision: 'decline' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('declined');
  });

  it('treats a recorded null as a value: a null that became set is stale', async () => {
    const id = await fileContest('website', 'https://revit.example/link');
    await setIntegration({ claimedAt: CLAIMED_AT, website: 'https://owner.example' });
    expect((await accept(id)).body.error.code).toBe('CONTEST_VALUE_STALE');
  });

  it('is not stale on an unclaimed row, which writes nothing here on accept', async () => {
    const id = await fileContest('name', 'Revit Link');
    await setIntegration({ name: 'Changed by promote' });
    expect((await accept(id)).status).toBe(200);
  });

  it('refuses in the batch when the owner edits between the pre-read and the batch', async () => {
    const id = await fileContest('name', 'Revit Link');
    await setIntegration({ claimedAt: CLAIMED_AT });
    const factory = t.factory;
    let fired = false;
    const racing = createModerateContestHandler((env, opts) => {
      const ctx = factory(env, opts);
      if (!fired) {
        const batch = ctx.db.batch.bind(ctx.db);
        (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
          fired = true;
          t.raw
            .prepare(`UPDATE integrations SET name = ? WHERE id = ?`)
            .run('Late owner edit', I_MAIN);
          return batch(stmts);
        }) as typeof batch;
      }
      return ctx;
    }, fileIssue);
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', ADMIN);
      await next();
    });
    a.patch('/api/admin/contests/:id', racing);
    const res = await a.request(
      `/api/admin/contests/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ decision: 'accept' }),
        headers: { 'content-type': 'application/json' },
      },
      TEST_ENV as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as JsonBody).error.code).toBe('CONTEST_VALUE_STALE');
    expect((await integrationRow()).name).toBe('Late owner edit');
    const [contest] = await t.db.select().from(integrationFieldChallenges);
    expect(contest!.status).toBe('open');
  });

  it('shows the live value beside the recorded one, and flags it stale, on the queue', async () => {
    const id = await fileContest('name', 'Revit Link');
    await setIntegration({ claimedAt: CLAIMED_AT, name: 'Owner’s own name' });
    const res = await call(ADMIN, 'GET', '/api/admin/contests');
    expect(() => ListAdminContestsResponseSchema.parse(res.body)).not.toThrow();
    const row = res.body.data.find((c: JsonBody) => c.id === id);
    expect(row).toMatchObject({
      current_value: 'Revit for MicroStation',
      live_value: 'Owner’s own name',
      value_stale: true,
    });
  });

  it('reports a fresh contest as not stale, with the live value equal to the recorded one', async () => {
    const id = await fileContest('name', 'Revit Link');
    await setIntegration({ claimedAt: CLAIMED_AT });
    const row = (await call(ADMIN, 'GET', '/api/admin/contests')).body.data.find(
      (c: JsonBody) => c.id === id,
    );
    expect(row).toMatchObject({ live_value: 'Revit for MicroStation', value_stale: false });
  });
});
