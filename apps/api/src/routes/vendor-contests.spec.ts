/**
 * Integration field contests, vendor side (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b).
 *
 * Real migrations on in-memory SQLite, with `db.batch` shimmed onto one
 * transaction, so the partial unique index, the FK from the contest to its
 * workflow instance, and the audit-in-batch rule are exercised, not mocked.
 *
 * The owner path is live since AECI-1005 replaced the `isIntegrationClaimed` stub
 * with the real `claimed_at` test. Most cases still drive it by injecting a
 * predicate into the submit handler; `routeContest` below also pins the real one.
 */

import {
  ListVendorContestsResponseSchema,
  ListVendorNotificationsResponseSchema,
  VendorContestResponseSchema,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
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
import { routeContest, vendorContestsWhere } from '../lib/integration-contests';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createDecideContestHandler,
  createListVendorContestsHandler,
  createSubmitContestHandler,
  createWithdrawContestHandler,
} from './vendor-contests';
import { createListVendorNotificationsHandler } from './vendor-notifications';
import { createVendorUpdatesHandler } from './vendor-updates';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns the SOURCE product, B owns the TARGET and BUILT the main integration,
// C owns only a product on another integration.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);

const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const P_FOREIGN = uuid(12);

const I_MAIN = uuid(20); // P_SOURCE (A) → P_TARGET (B), built by B
const I_REVERSE = uuid(21); // P_FOREIGN (C) → P_SOURCE (A), no builder

const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const SEAT_C = uuid(102);

const seat = (userId: string, vendorId: string): AuthzVariables['auth'] => ({
  userId,
  email: `${userId}@example.test`,
  role: 'vendor_admin',
  vendorId,
  // No entitlement at all: a seat is the whole gate (§11b).
  entitlementTier: 'unclaimed',
  entitlement: null,
});

const AUTH_A = seat(SEAT_A, VENDOR_A);
const AUTH_B = seat(SEAT_B, VENDOR_B);
const AUTH_C = seat(SEAT_C, VENDOR_C);

let t: TestDb;
let claimed = false;

beforeEach(async () => {
  claimed = false;
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation' },
    { id: P_FOREIGN, slug: 'archicad', name: 'ArchiCAD' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_FOREIGN, vendorId: VENDOR_C, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_MAIN,
      name: 'Revit for MicroStation',
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      mechanismKind: 'native',
      direction: 'a_to_b',
      listingUrl: 'https://example.test/listing',
      builtByVendorId: VENDOR_B,
      // Claimed by B, so the owner decide path's ownership re-check (AECI-1005
      // review) passes. Routing is still driven by the injected predicate.
      claimedAt: '2026-09-01T00:00:00.000Z',
    },
    { id: I_REVERSE, sourceProductId: P_FOREIGN, targetProductId: P_SOURCE, direction: 'both' },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_C, role: 'vendor_admin', vendorId: VENDOR_C },
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
  a.get('/api/vendor/contests', createListVendorContestsHandler(t.factory));
  a.post('/api/vendor/contests/:id/withdraw', createWithdrawContestHandler(t.factory));
  a.post('/api/vendor/contests/:id/decision', createDecideContestHandler(t.factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  a.get('/api/vendor/updates', createVendorUpdatesHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  path: string,
  body?: unknown,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body === undefined
      ? {}
      : {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        };
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const submit = (auth: AuthzVariables['auth'], integrationId: string, body: unknown) =>
  call(auth, `/api/vendor/integrations/${integrationId}/contests`, body);

const contestRows = () => t.db.select().from(integrationFieldChallenges);
const auditRows = () => t.db.select().from(auditLog);
const notificationRows = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));

const NAME_CONTEST = {
  field: 'name',
  proposed_value: 'Revit Connector for MicroStation',
  reason: 'That is what the listing calls it.',
};

// ─── Routing ─────────────────────────────────────────────────────────────────

describe('routeContest', () => {
  const row = { id: I_MAIN, builtByVendorId: VENDOR_B, claimedAt: null };

  it('routes to AECi while the integration is unclaimed', () => {
    expect(routeContest(row, 'name')).toEqual({ routedTo: 'aeci', ownerVendorId: VENDOR_B });
  });

  it('routes to the owner once claimed_at is set, with the real predicate (AECI-1005)', () => {
    const claimedRow = { ...row, claimedAt: '2026-09-21T00:00:00.000Z' };
    expect(routeContest(claimedRow, 'name')).toEqual({
      routedTo: 'owner',
      ownerVendorId: VENDOR_B,
    });
    // The owner field still goes to AECi on a claimed row: the owner cannot judge
    // whether it is the owner.
    expect(routeContest(claimedRow, 'owner').routedTo).toBe('aeci');
  });

  it('routes to the owner once the integration is claimed', () => {
    expect(routeContest(row, 'name', () => true)).toEqual({
      routedTo: 'owner',
      ownerVendorId: VENDOR_B,
    });
  });

  it('always routes an owner contest to AECi, claimed or not', () => {
    expect(routeContest(row, 'owner', () => true).routedTo).toBe('aeci');
  });

  it('routes to AECi when no builder is on file', () => {
    expect(
      routeContest({ id: I_MAIN, builtByVendorId: null, claimedAt: null }, 'name', () => true),
    ).toEqual({
      routedTo: 'aeci',
      ownerVendorId: null,
    });
  });
});

// ─── POST /api/vendor/integrations/:id/contests ──────────────────────────────

describe('POST /api/vendor/integrations/:id/contests', () => {
  it('files an AECi-routed contest in ONE batch: instance, contest, transition, audit', async () => {
    const batchSpy = vi.spyOn(t.db, 'batch');
    const { status, body, send } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);

    expect(status).toBe(201);
    expect(() => VendorContestResponseSchema.parse(body)).not.toThrow();
    expect(body.contest).toMatchObject({
      integration_id: I_MAIN,
      field: 'name',
      current_value: 'Revit for MicroStation',
      proposed_value: 'Revit Connector for MicroStation',
      routed_to: 'aeci',
      status: 'open',
      submitter_vendor: { id: VENDOR_A, name: 'Autodesk' },
      owner_vendor: { id: VENDOR_B, name: 'Bentley' },
      context_product: { id: P_SOURCE },
    });

    // One write batch, five statements, and no notification (nobody but AECi decides).
    // Instance, contest, the AECI-1010 live sentinel, transition, audit.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(5);
    batchSpy.mockRestore();

    const [row] = await contestRows();
    expect(row).toMatchObject({
      routedTo: 'aeci',
      ownerVendorId: VENDOR_B,
      submittedBy: SEAT_A,
      currentValue: 'Revit for MicroStation',
    });
    const [instance] = await t.db.select().from(workflowInstances);
    expect(instance).toMatchObject({
      id: row!.workflowId,
      workflowType: 'correction_request',
      entityId: row!.id,
      currentState: 'open',
      // Never set for a contest: the webhook resolves Linear issues through it.
      linearIssueId: null,
    });
    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions).toEqual([
      expect.objectContaining({ fromState: null, toState: 'open', actorId: SEAT_A }),
    ]);
    const audits = await auditRows();
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'integration.contest.submitted',
        entityType: 'integration_field_challenge',
        entityId: row!.id,
        actorType: 'user',
      }),
    ]);
    expect(audits[0]!.metadata).toMatchObject({ source: 'vendor-portal' });
    expect(await notificationRows()).toHaveLength(0);
    // Nothing public changed, so nothing is purged.
    expect(send).not.toHaveBeenCalled();
    // The catalog is untouched.
    const [integration] = await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN));
    expect(integration!.name).toBe('Revit for MicroStation');
  });

  it('answers 404 — identically — for a non-endpoint vendor and an unknown id', async () => {
    const foreign = await submit(AUTH_C, I_MAIN, NAME_CONTEST);
    const unknown = await submit(AUTH_C, uuid(99), NAME_CONTEST);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body.error.details.resource).toBe(unknown.body.error.details.resource);
    expect(await contestRows()).toHaveLength(0);
  });

  it('answers 404 before it reads the body', async () => {
    const { status } = await submit(AUTH_C, I_MAIN, { field: 'nope' });
    expect(status).toBe(404);
  });

  it('refuses the builder with 403 CONTEST_OWN_INTEGRATION', async () => {
    const { status, body } = await submit(AUTH_B, I_MAIN, NAME_CONTEST);
    expect(status).toBe(403);
    expect(body.error.code).toBe('CONTEST_OWN_INTEGRATION');
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers 409 CONTEST_DUPLICATE for a second open contest on the same field', async () => {
    const first = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const second = await submit(AUTH_A, I_MAIN, { ...NAME_CONTEST, proposed_value: 'Other' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONTEST_DUPLICATE');
    expect(second.body.error.details.contest_id).toBe(first.body.contest.id);
    expect(await contestRows()).toHaveLength(1);
  });

  it('allows a fresh contest once the earlier one is closed', async () => {
    const first = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    await call(AUTH_A, `/api/vendor/contests/${first.body.contest.id}/withdraw`, {});
    const again = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    expect(again.status).toBe(201);
  });

  it('answers 422 CONTEST_NO_CHANGE when the value is the current one', async () => {
    const { status, body } = await submit(AUTH_A, I_MAIN, {
      ...NAME_CONTEST,
      proposed_value: 'Revit for MicroStation',
    });
    expect(status).toBe(422);
    expect(body.error.code).toBe('CONTEST_NO_CHANGE');
  });

  it.each([
    ['listing_url', 'not a url'],
    ['docs_url', 'ftp://example.test/docs'],
    ['mechanism_kind', 'carrier-pigeon'],
    ['direction', 'sideways'],
    ['name', null],
  ])('answers 422 CONTEST_INVALID_VALUE for %s = %j', async (field, value) => {
    const { status, body } = await submit(AUTH_A, I_MAIN, {
      field,
      proposed_value: value,
      reason: 'because',
    });
    expect(status).toBe(422);
    expect(body.error.code).toBe('CONTEST_INVALID_VALUE');
    expect(body.error.field).toBe('proposed_value');
  });

  it('answers 400 for an unknown field or an empty reason', async () => {
    expect((await submit(AUTH_A, I_MAIN, { ...NAME_CONTEST, field: 'notes' })).status).toBe(400);
    expect((await submit(AUTH_A, I_MAIN, { ...NAME_CONTEST, reason: '  ' })).status).toBe(400);
  });

  it('stores direction canonically from the caller’s frame', async () => {
    // A owns endpoint A of I_MAIN: "inbound" to Revit is B → A.
    const onSource = await submit(AUTH_A, I_MAIN, {
      field: 'direction',
      proposed_value: 'inbound',
      reason: 'MicroStation pushes to Revit',
    });
    expect(onSource.status).toBe(201);
    expect(onSource.body.contest.proposed_value).toBe('inbound');
    expect(onSource.body.contest.current_value).toBe('outbound');

    // A owns endpoint B of I_REVERSE: "outbound" from Revit is B → A too.
    const onTarget = await submit(AUTH_A, I_REVERSE, {
      field: 'direction',
      proposed_value: 'outbound',
      reason: 'Revit sends to ArchiCAD',
    });
    expect(onTarget.status).toBe(201);
    expect(onTarget.body.contest.context_product.id).toBe(P_SOURCE);

    const stored = new Map((await contestRows()).map((r) => [r.integrationId, r.proposedValue]));
    expect(stored.get(I_MAIN)).toBe('b_to_a');
    expect(stored.get(I_REVERSE)).toBe('b_to_a');
  });

  it('accepts an owner proposal only among the endpoint vendors, and null for "neither"', async () => {
    const outsider = await submit(AUTH_A, I_MAIN, {
      field: 'owner',
      proposed_value: VENDOR_C,
      reason: 'x',
    });
    expect(outsider.status).toBe(422);

    const endpoint = await submit(AUTH_A, I_MAIN, {
      field: 'owner',
      proposed_value: VENDOR_A,
      reason: 'We built it',
    });
    expect(endpoint.status).toBe(201);
    expect(endpoint.body.contest).toMatchObject({
      current_value: VENDOR_B,
      current_label: 'Bentley',
      proposed_value: VENDOR_A,
      proposed_label: 'Autodesk',
    });

    await call(AUTH_A, `/api/vendor/contests/${endpoint.body.contest.id}/withdraw`, {});
    const neither = await submit(AUTH_A, I_MAIN, {
      field: 'owner',
      proposed_value: null,
      reason: 'An SI built it',
    });
    expect(neither.status).toBe(201);
    expect(neither.body.contest.proposed_value).toBeNull();
  });

  it('routes an owner contest to AECi even on a claimed integration', async () => {
    claimed = true;
    const { body } = await submit(AUTH_A, I_MAIN, {
      field: 'owner',
      proposed_value: VENDOR_A,
      reason: 'We built it',
    });
    expect(body.contest.routed_to).toBe('aeci');
    expect(await notificationRows()).toHaveLength(0);
  });

  it('routes to the owner once claimed, and tells the owner in the same batch', async () => {
    claimed = true;
    const batchSpy = vi.spyOn(t.db, 'batch');
    const { status, body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    expect(status).toBe(201);
    expect(body.contest.routed_to).toBe('owner');
    // instance + contest + live sentinel (AECI-1010) + transition + audit + notification
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(6);
    batchSpy.mockRestore();

    const [notice] = await notificationRows();
    expect(notice!.metadata).toMatchObject({
      kind: 'contest',
      vendorId: VENDOR_B,
      contestId: body.contest.id,
      event: 'submitted',
      field: 'name',
    });
  });

  it('routes to AECi, stamped and with no owner notice, while the owner has no active seat (AECI-989)', async () => {
    claimed = true;
    await t.db
      .update(profiles)
      .set({ bannedAt: '2026-09-23T00:00:00.000Z' })
      .where(eq(profiles.id, SEAT_B));
    const { status, body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    expect(status).toBe(201);
    expect(body.contest.routed_to).toBe('aeci');
    const [row] = await contestRows();
    expect(row).toMatchObject({ routedTo: 'aeci', ownerVendorId: VENDOR_B });
    // The stamp is what lets the unban route it back (`lib/vendor-handback.ts`).
    expect(row!.ownerSeatLapsedAt).not.toBeNull();
    expect(await notificationRows()).toHaveLength(0);
  });

  it('leaves the stamp NULL on every ordinary contest', async () => {
    claimed = true;
    await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const [row] = await contestRows();
    expect(row!.routedTo).toBe('owner');
    expect(row!.ownerSeatLapsedAt).toBeNull();
  });
});

// ─── GET /api/vendor/contests ────────────────────────────────────────────────

describe('GET /api/vendor/contests', () => {
  it('scopes to submitted ∪ received, and frames direction per caller', async () => {
    claimed = true;
    await submit(AUTH_A, I_MAIN, {
      field: 'direction',
      proposed_value: 'inbound',
      reason: 'x',
    });
    claimed = false;
    await submit(AUTH_A, I_MAIN, NAME_CONTEST); // AECi-routed; B is NOT its decider

    const a = await call(AUTH_A, '/api/vendor/contests');
    expect(a.status).toBe(200);
    expect(() => ListVendorContestsResponseSchema.parse(a.body)).not.toThrow();
    expect(a.body.submitted).toHaveLength(2);
    expect(a.body.received).toHaveLength(0);

    const b = await call(AUTH_B, '/api/vendor/contests');
    expect(b.body.submitted).toHaveLength(0);
    expect(b.body.received).toHaveLength(1);
    // B's frame is the target: A's "inbound to Revit" is "outbound from MicroStation".
    expect(b.body.received[0]).toMatchObject({
      field: 'direction',
      context_product: { id: P_TARGET },
      proposed_value: 'outbound',
    });

    const c = await call(AUTH_C, '/api/vendor/contests');
    expect(c.body).toEqual({ submitted: [], received: [] });
  });
});

// ─── POST /api/vendor/contests/:id/withdraw ──────────────────────────────────

describe('POST /api/vendor/contests/:id/withdraw', () => {
  it('withdraws, closes the workflow as cancelled, and tells the owner', async () => {
    claimed = true;
    const { body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const id = body.contest.id as string;

    const res = await call(AUTH_A, `/api/vendor/contests/${id}/withdraw`, {});
    expect(res.status).toBe(200);
    expect(res.body.contest.status).toBe('withdrawn');

    const [instance] = await t.db.select().from(workflowInstances);
    expect(instance).toMatchObject({ currentState: 'withdrawn', finalOutcome: 'cancelled' });
    expect(instance!.completedAt).not.toBeNull();
    const events = (await notificationRows()).map(
      (r) => (r.metadata as { event: string; vendorId: string }).event,
    );
    expect(events).toEqual(['submitted', 'withdrawn']);
    expect((await auditRows()).some((r) => r.action === 'integration.contest.withdrawn')).toBe(
      true,
    );
  });

  it('is the submitter’s alone: the owner and strangers get 404', async () => {
    claimed = true;
    const { body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const path = `/api/vendor/contests/${body.contest.id}/withdraw`;
    expect((await call(AUTH_B, path, {})).status).toBe(404);
    expect((await call(AUTH_C, path, {})).status).toBe(404);
  });

  it('answers 409 CONTEST_NOT_OPEN a second time', async () => {
    const { body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const path = `/api/vendor/contests/${body.contest.id}/withdraw`;
    await call(AUTH_A, path, {});
    const again = await call(AUTH_A, path, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONTEST_NOT_OPEN');
  });
});

// ─── POST /api/vendor/contests/:id/decision ──────────────────────────────────

describe('POST /api/vendor/contests/:id/decision (owner path, predicate injected on)', () => {
  async function ownerContest(body: object = NAME_CONTEST): Promise<string> {
    claimed = true;
    const res = await submit(AUTH_A, I_MAIN, body);
    expect(res.body.contest.routed_to).toBe('owner');
    return res.body.contest.id as string;
  }

  it('refuses the old owner once the row is no longer claimed by it (AECI-1005 review)', async () => {
    const id = await ownerContest();
    // AECi reassigned the row away from B (or it was never claimed): B must not decide.
    await t.db
      .update(integrations)
      .set({ builtByVendorId: VENDOR_C, claimedAt: null })
      .where(eq(integrations.id, I_MAIN));
    const res = await call(AUTH_B, `/api/vendor/contests/${id}/decision`, { decision: 'accept' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_INTEGRATION_CHANGED');
    const [contest] = await contestRows();
    expect(contest!.status).toBe('open');
    expect((await auditRows()).some((r) => r.action === 'integration.contest.accepted')).toBe(
      false,
    );
  });

  it('aborts when the row is reassigned between the re-check and the batch', async () => {
    const id = await ownerContest();
    const racing = createDecideContestHandler((env, opts) => {
      const ctx = t.factory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db);
      (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
        t.raw
          .prepare('UPDATE integrations SET built_by_vendor_id = ?, claimed_at = NULL WHERE id = ?')
          .run(VENDOR_C, I_MAIN);
        return batch(stmts);
      }) as typeof batch;
      return ctx;
    });
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', AUTH_B);
      await next();
    });
    a.post('/api/vendor/contests/:id/decision', racing);
    const res = await a.request(
      `/api/vendor/contests/${id}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'accept' }),
        headers: { 'content-type': 'application/json' },
      },
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as JsonBody).error.code).toBe('CONTEST_INTEGRATION_CHANGED');
    const [integration] = await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN));
    expect(integration!.name).toBe('Revit for MicroStation');
    const [contest] = await contestRows();
    expect(contest!.status).toBe('open');
  });

  it('accept writes the column, transfers maintenance, notifies, and purges', async () => {
    const id = await ownerContest();
    const res = await call(AUTH_B, `/api/vendor/contests/${id}/decision`, {
      decision: 'accept',
      note: 'Fair.',
    });
    expect(res.status).toBe(200);
    expect(res.body.contest).toMatchObject({ status: 'accepted', decision_note: 'Fair.' });

    const [integration] = await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN));
    expect(integration!.name).toBe('Revit Connector for MicroStation');
    expect(integration!.maintainedBy).toBe('vendor');
    expect(integration!.lastReviewedAt).not.toBeNull();

    const updated = (await auditRows()).find((r) => r.action === 'integration.updated');
    expect(updated).toMatchObject({ entityType: 'integration', entityId: I_MAIN });
    expect(updated!.beforeState).toMatchObject({ name: 'Revit for MicroStation' });
    expect(updated!.metadata).toMatchObject({ maintenanceTransfer: true });

    const accepted = (await notificationRows()).find(
      (r) => (r.metadata as { event: string }).event === 'accepted',
    );
    expect(accepted!.metadata).toMatchObject({ vendorId: VENDOR_A });

    expect(res.send).toHaveBeenCalledWith({
      tags: ['pair:microstation__revit', 'product:revit', 'product:microstation'],
      source: 'vendor',
    });

    const [instance] = await t.db.select().from(workflowInstances);
    expect(instance).toMatchObject({ currentState: 'accepted', finalOutcome: 'approved' });
  });

  it('stores an accepted direction canonically', async () => {
    const id = await ownerContest({ field: 'direction', proposed_value: 'inbound', reason: 'x' });
    await call(AUTH_B, `/api/vendor/contests/${id}/decision`, { decision: 'accept' });
    const [integration] = await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN));
    expect(integration!.direction).toBe('b_to_a');
  });

  it('omits maintenanceTransfer on a row the vendor already maintains', async () => {
    await t.db
      .update(integrations)
      .set({ maintainedBy: 'vendor' })
      .where(eq(integrations.id, I_MAIN));
    const id = await ownerContest();
    await call(AUTH_B, `/api/vendor/contests/${id}/decision`, { decision: 'accept' });
    const updated = (await auditRows()).find((r) => r.action === 'integration.updated');
    expect(updated!.metadata).not.toHaveProperty('maintenanceTransfer');
  });

  it('decline writes no catalog data and purges nothing', async () => {
    const id = await ownerContest();
    const res = await call(AUTH_B, `/api/vendor/contests/${id}/decision`, {
      decision: 'decline',
      note: 'The listing is out of date.',
    });
    expect(res.status).toBe(200);
    expect(res.body.contest.status).toBe('declined');
    const [integration] = await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN));
    expect(integration!.name).toBe('Revit for MicroStation');
    expect(integration!.maintainedBy).toBe('aeci');
    expect(res.send).not.toHaveBeenCalled();
    const declined = (await notificationRows()).find(
      (r) => (r.metadata as { event: string }).event === 'declined',
    );
    expect(declined!.metadata).toMatchObject({ vendorId: VENDOR_A });
  });

  it('is the owner’s alone: the submitter gets 404', async () => {
    const id = await ownerContest();
    const res = await call(AUTH_A, `/api/vendor/contests/${id}/decision`, { decision: 'accept' });
    expect(res.status).toBe(404);
  });

  it('refuses an AECi-routed contest to the builder with 404', async () => {
    const { body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const res = await call(AUTH_B, `/api/vendor/contests/${body.contest.id}/decision`, {
      decision: 'accept',
    });
    expect(res.status).toBe(404);
  });

  it('answers 409 once decided, and writes the catalog only once', async () => {
    const id = await ownerContest();
    await call(AUTH_B, `/api/vendor/contests/${id}/decision`, { decision: 'accept' });
    const again = await call(AUTH_B, `/api/vendor/contests/${id}/decision`, {
      decision: 'decline',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONTEST_NOT_OPEN');
    expect((await auditRows()).filter((r) => r.action === 'integration.updated')).toHaveLength(1);
  });
});

// ─── Lost races roll back entirely ───────────────────────────────────────────

/**
 * Close the contest between the handler's preload (which saw it open) and its
 * batch — the only window a real race lives in. The next `db.batch` call first
 * lands a competing decision, then runs the handler's statements.
 */
function closeBeforeNextBatch(id: string, status: 'accepted' | 'declined' | 'withdrawn') {
  const original = t.db.batch.bind(t.db);
  return vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
    await t.db
      .update(integrationFieldChallenges)
      .set({ status, updatedAt: new Date(Date.now() + 1000).toISOString() })
      .where(eq(integrationFieldChallenges.id, id));
    return original(stmts);
  }) as never);
}

async function ledgerCounts() {
  return {
    audit: (await auditRows()).length,
    transitions: (await t.db.select().from(workflowTransitions)).length,
    notices: (await notificationRows()).length,
  };
}

describe('a lost race writes nothing and answers 409', () => {
  it('owner decision after a concurrent withdraw', async () => {
    claimed = true;
    const { body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const id = body.contest.id as string;
    const before = await ledgerCounts();

    const spy = closeBeforeNextBatch(id, 'withdrawn');
    const res = await call(AUTH_B, `/api/vendor/contests/${id}/decision`, { decision: 'accept' });
    spy.mockRestore();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_NOT_OPEN');
    expect(await ledgerCounts()).toEqual(before);
    const [integration] = await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN));
    expect(integration!.name).toBe('Revit for MicroStation');
    expect(integration!.maintainedBy).toBe('aeci');
    expect(res.send).not.toHaveBeenCalled();
  });

  it('withdraw after a concurrent owner decision', async () => {
    claimed = true;
    const { body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const id = body.contest.id as string;
    const before = await ledgerCounts();

    const spy = closeBeforeNextBatch(id, 'declined');
    const res = await call(AUTH_A, `/api/vendor/contests/${id}/withdraw`, {});
    spy.mockRestore();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_NOT_OPEN');
    expect(await ledgerCounts()).toEqual(before);
    const [row] = await contestRows();
    expect(row!.status).toBe('declined');
  });
});

// ─── The notification feed ───────────────────────────────────────────────────

describe('GET /api/vendor/notifications carries contest rows', () => {
  it('returns contest events as kind:contest beside unchanged attestation rows', async () => {
    claimed = true;
    const { body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    // A §7 detector row addressed to B, exactly as the sweep writes it.
    await t.db.insert(auditLog).values({
      actorType: 'system',
      action: NOTIFICATION_SENT_ACTION,
      entityType: 'claim',
      entityId: uuid(40),
      metadata: {
        detector: 'silent-counterparty',
        vendorId: VENDOR_B,
        integrationId: I_MAIN,
        dataObject: { slug: 'rfis', name: 'RFIs' },
        counterpartProduct: { slug: 'revit', name: 'Revit' },
        pairSlugs: ['revit', 'microstation'],
      },
    });

    const res = await call(AUTH_B, '/api/vendor/notifications');
    expect(() => ListVendorNotificationsResponseSchema.parse(res.body)).not.toThrow();
    const byKind = new Map(
      (res.body.notifications as JsonBody[]).map((n) => [n.kind as string, n]),
    );
    expect(byKind.get('contest')).toMatchObject({
      event: 'submitted',
      contest_id: body.contest.id,
      integration_id: I_MAIN,
      integration_name: 'Revit for MicroStation',
      field: 'name',
      pair_path: '/products/microstation/integrations/revit',
    });
    expect(byKind.get('attestation')).toMatchObject({
      detector: 'silent-counterparty',
      claim_id: uuid(40),
    });

    // The submitter was not told about its own submission.
    const a = await call(AUTH_A, '/api/vendor/notifications');
    expect(a.body.notifications).toEqual([]);
  });
});

// ─── The `contests` cursor ───────────────────────────────────────────────────

describe('GET /api/vendor/updates — the `contests` scope', () => {
  it('reports MAX(updated_at) over exactly the rows the list returns, per vendor', async () => {
    claimed = true;
    await submit(AUTH_A, I_MAIN, NAME_CONTEST); // owner-routed: A submitted, B received
    claimed = false;
    await submit(AUTH_A, I_REVERSE, { ...NAME_CONTEST, field: 'description' }); // A only

    for (const [auth, vendorId] of [
      [AUTH_A, VENDOR_A],
      [AUTH_B, VENDOR_B],
      [AUTH_C, VENDOR_C],
    ] as const) {
      const list = await call(auth, '/api/vendor/contests');
      const shown = [...list.body.submitted, ...list.body.received].map(
        (row: JsonBody) => row.updated_at as string,
      );
      const expected = shown.length ? shown.sort().at(-1) : null;
      const cursor = await call(auth, '/api/vendor/updates');
      expect(cursor.body.revisions.contests, `vendor ${vendorId}`).toBe(expected);

      // …and the cursor's predicate is the shared one, not a restatement.
      const direct = await t.db
        .select({ updatedAt: integrationFieldChallenges.updatedAt })
        .from(integrationFieldChallenges)
        .where(and(vendorContestsWhere(vendorId)));
      expect(direct).toHaveLength(shown.length);
    }
  });

  it('moves when a contest is withdrawn', async () => {
    const { body } = await submit(AUTH_A, I_MAIN, NAME_CONTEST);
    const before = (await call(AUTH_A, '/api/vendor/updates')).body.revisions.contests;
    await new Promise((r) => setTimeout(r, 5));
    await call(AUTH_A, `/api/vendor/contests/${body.contest.id}/withdraw`, {});
    const after = (await call(AUTH_A, '/api/vendor/updates')).body.revisions.contests;
    expect(after).not.toBe(before);
  });
});
