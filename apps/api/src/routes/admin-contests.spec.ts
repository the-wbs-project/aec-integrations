/**
 * Integration field contests, AECi side (AECI-1008). The Linear seam is injected,
 * so the post-commit `waitUntil` is asserted without a transport. The real
 * creator has its own spec (`lib/linear-contests.spec.ts`).
 */

import { AdminContestSchema, ListAdminContestsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { AuthzVariables } from '../lib/authz';
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
