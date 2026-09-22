/**
 * Protests to AECi (AECI-1009 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12).
 *
 * Real migrations on in-memory SQLite, `db.batch` shimmed onto one transaction,
 * and an injected clock so each window boundary is tested at the instant it falls.
 * Contests are seeded straight into the table so their timestamps are exact.
 */

import {
  addContestDays,
  ListVendorContestsResponseSchema,
  ListVendorNotificationsResponseSchema,
  VendorContestResponseSchema,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
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
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createAdminContestsListHandler } from './admin-contests';
import { createDecideContestProtestHandler } from './admin-contest-protests';
import {
  createFileContestProtestHandler,
  createReplyContestProtestHandler,
  createWithdrawContestProtestHandler,
} from './vendor-contest-protests';
import {
  createDecideContestHandler,
  createListVendorContestsHandler,
  createSubmitContestHandler,
} from './vendor-contests';
import { createListVendorNotificationsHandler } from './vendor-notifications';
import { createVendorUpdatesHandler } from './vendor-updates';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A files contests on the integration B owns (claimed). C is a third vendor.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);
const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const P_FOREIGN = uuid(12);
const I_MAIN = uuid(20);
const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const SEAT_C = uuid(102);
const ADMIN_ID = uuid(200);
const CONTEST = uuid(300);
const CONTEST_WF = uuid(301);

const seat = (userId: string, vendorId: string | null, role = 'vendor_admin') =>
  ({
    userId,
    email: `${userId}@example.test`,
    role,
    vendorId,
    entitlementTier: 'unclaimed',
    entitlement: null,
  }) as AuthzVariables['auth'];

const AUTH_A = seat(SEAT_A, VENDOR_A);
const AUTH_B = seat(SEAT_B, VENDOR_B);
const AUTH_C = seat(SEAT_C, VENDOR_C);
const ADMIN = seat(ADMIN_ID, null, 'admin');

const CREATED = '2026-08-01T00:00:00.000Z';
const DECIDED = '2026-08-10T00:00:00.000Z';
const LIVE_NAME = 'Revit for MicroStation';

let t: TestDb;
let nowIso = '2026-08-11T00:00:00.000Z';
const clock = () => new Date(nowIso);

beforeEach(async () => {
  nowIso = '2026-08-11T00:00:00.000Z';
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
  await t.db.insert(integrations).values({
    id: I_MAIN,
    name: LIVE_NAME,
    sourceProductId: P_SOURCE,
    targetProductId: P_TARGET,
    direction: 'a_to_b',
    builtByVendorId: VENDOR_B,
    claimedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_C, role: 'vendor_admin', vendorId: VENDOR_C },
    { id: ADMIN_ID, role: 'admin' },
  ]);
});
afterEach(() => t.dispose());

/** An owner-routed contest by A on B's integration. Declined by default. */
async function seedContest(
  overrides: Partial<typeof integrationFieldChallenges.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(workflowInstances).values({
    id: CONTEST_WF,
    workflowType: 'correction_request',
    entityId: CONTEST,
    currentState: overrides.status ?? 'declined',
  });
  await t.db.insert(integrationFieldChallenges).values({
    id: CONTEST,
    integrationId: I_MAIN,
    field: 'name',
    currentValue: LIVE_NAME,
    proposedValue: 'Revit Connector for MicroStation',
    reason: 'The listing calls it that.',
    submitterVendorId: VENDOR_A,
    submittedBy: SEAT_A,
    routedTo: 'owner',
    ownerVendorId: VENDOR_B,
    status: 'declined',
    decisionNote: 'We prefer the short name.',
    decidedBy: SEAT_B,
    decidedAt: DECIDED,
    workflowId: CONTEST_WF,
    createdAt: CREATED,
    updatedAt: DECIDED,
    ...overrides,
  });
}

function app(auth: AuthzVariables['auth'], factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/contests/:id/protest', createFileContestProtestHandler(factory, clock));
  a.post(
    '/api/vendor/contests/:id/protest/reply',
    createReplyContestProtestHandler(factory, clock),
  );
  a.post(
    '/api/vendor/contests/:id/protest/withdraw',
    createWithdrawContestProtestHandler(factory, clock),
  );
  a.patch('/api/admin/contests/:id/protest', createDecideContestProtestHandler(factory, clock));
  a.get('/api/admin/contests', createAdminContestsListHandler(factory));
  a.post('/api/vendor/integrations/:id/contests', createSubmitContestHandler(factory));
  a.post('/api/vendor/contests/:id/decision', createDecideContestHandler(factory));
  a.get('/api/vendor/contests', createListVendorContestsHandler(factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(factory));
  a.get('/api/vendor/updates', createVendorUpdatesHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  factory?: DbFactory,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const res = await app(auth, factory).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const PROTEST = {
  reason: 'The product page and the listing both use the longer name.',
  evidence_urls: ['https://example.test/a', 'https://example.test/a', 'https://example.test/b'],
};
const file = (auth = AUTH_A, body: unknown = PROTEST, factory?: DbFactory) =>
  call(auth, 'POST', `/api/vendor/contests/${CONTEST}/protest`, body, factory);
const reply = (auth = AUTH_B, body: unknown = { reply: 'The short name is our brand.' }) =>
  call(auth, 'POST', `/api/vendor/contests/${CONTEST}/protest/reply`, body);
const withdraw = (auth = AUTH_A) =>
  call(auth, 'POST', `/api/vendor/contests/${CONTEST}/protest/withdraw`, {});
const decide = (body: unknown, auth = ADMIN) =>
  call(auth, 'PATCH', `/api/admin/contests/${CONTEST}/protest`, body);

const row = async () =>
  (
    await t.db
      .select()
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.id, CONTEST))
  )[0]!;
const actions = async () => (await t.db.select().from(auditLog)).map((r) => r.action);
const notifications = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));

/** A factory whose next `db.batch` first runs `mutate`, to land a write between
 *  the handler's read and its batch. */
function racingFactory(mutate: () => void): DbFactory {
  const db = new Proxy(t.db, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return async (stmts: unknown) => {
          mutate();
          return (target as unknown as { batch: (s: unknown) => Promise<unknown> }).batch(stmts);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
  return () => ({ db, getBookmark: () => null });
}

// ─── File: the declined basis ────────────────────────────────────────────────

describe('POST /api/vendor/contests/:id/protest — declined basis', () => {
  it('files a protest in one batch and tells the owner', async () => {
    await seedContest();
    const res = await file();
    expect(res.status).toBe(200);
    const contest = VendorContestResponseSchema.parse(res.body).contest;
    expect(contest.status).toBe('declined');
    expect(contest.protest).toMatchObject({
      status: 'open',
      basis: 'declined',
      reason: PROTEST.reason,
      // Deduplicated, order kept.
      evidence_urls: ['https://example.test/a', 'https://example.test/b'],
      protested_at: nowIso,
      reply_due_at: addContestDays(nowIso, 14),
      reply: null,
    });
    // No window once a protest exists.
    expect(contest.protest_opens_at).toBeNull();

    expect(await actions()).toEqual(
      expect.arrayContaining(['integration.contest.protested', NOTIFICATION_SENT_ACTION]),
    );
    const [note] = await notifications();
    expect(note!.metadata).toMatchObject({
      vendorId: VENDOR_B,
      event: 'protested',
      basis: 'declined',
      replyDueAt: addContestDays(nowIso, 14),
    });
    const r = await row();
    expect(r.protestWorkflowId).toBeTruthy();
    const transitions = await t.db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, r.protestWorkflowId!));
    expect(transitions.map((x) => x.toState)).toEqual(['open']);
    // Advice only: nothing public, no purge.
    expect(res.send).not.toHaveBeenCalled();
  });

  it('is open until decided_at + 30 days, exclusive', async () => {
    await seedContest();
    nowIso = new Date(Date.parse(addContestDays(DECIDED, 30)) - 1).toISOString();
    expect((await file()).status).toBe(200);
  });

  it('refuses at exactly decided_at + 30 days', async () => {
    await seedContest();
    nowIso = addContestDays(DECIDED, 30);
    const res = await file();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'PROTEST_NOT_AVAILABLE',
      details: { reason: 'window_closed' },
    });
  });

  it.each([
    ['aeci_routed', { routedTo: 'aeci' }],
    ['owner_unknown', { ownerVendorId: null }],
    ['not_declined', { status: 'accepted' }],
    ['already_protested', { protestStatus: 'withdrawn', protestBasis: 'declined' }],
  ] as const)('refuses %s', async (reason, overrides) => {
    await seedContest(overrides);
    const res = await file();
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe(reason);
    expect(await actions()).toEqual([]);
  });

  it('is a 404 for the owner, a third vendor, and a submitter that lost its endpoint', async () => {
    await seedContest();
    expect((await file(AUTH_B)).status).toBe(404);
    expect((await file(AUTH_C)).status).toBe(404);
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, VENDOR_A));
    expect((await file(AUTH_A)).status).toBe(404);
  });

  it('refuses when the integration changed hands since the decision', async () => {
    await seedContest();
    await t.db
      .update(integrations)
      .set({ builtByVendorId: VENDOR_A })
      .where(eq(integrations.id, I_MAIN));
    const res = await file();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_INTEGRATION_CHANGED');
  });

  it('refuses when the owner changed the field since the decision', async () => {
    await seedContest();
    await t.db.update(integrations).set({ name: 'Other' }).where(eq(integrations.id, I_MAIN));
    const res = await file();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_VALUE_STALE');
  });

  it('catches an owner edit that lands between the read and the batch', async () => {
    await seedContest();
    const racing = racingFactory(() => {
      t.raw.prepare(`UPDATE integrations SET name = 'Moved' WHERE id = ?`).run(I_MAIN);
    });
    const res = await file(AUTH_A, PROTEST, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_VALUE_STALE');
    expect((await row()).protestStatus).toBeNull();
    expect(await actions()).toEqual([]);
  });

  it('catches a reassignment that lands between the read and the batch', async () => {
    await seedContest();
    const racing = racingFactory(() => {
      t.raw.prepare(`UPDATE integrations SET claimed_at = NULL WHERE id = ?`).run(I_MAIN);
    });
    const res = await file(AUTH_A, PROTEST, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_INTEGRATION_CHANGED');
  });

  it('accepts a protest on a retired integration', async () => {
    await seedContest();
    await t.db
      .update(integrations)
      .set({ retiredAt: '2026-08-10T12:00:00.000Z' })
      .where(eq(integrations.id, I_MAIN));
    expect((await file()).status).toBe(200);
  });

  it('rejects a bad body with 400 after the eligibility checks', async () => {
    await seedContest();
    const res = await file(AUTH_A, { reason: 'x', evidence_urls: ['ftp://x'] });
    expect(res.status).toBe(400);
    const tooMany = await file(AUTH_A, {
      reason: 'x',
      evidence_urls: ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'],
    });
    expect(tooMany.status).toBe(400);
  });
});

// ─── File: the silence basis ─────────────────────────────────────────────────

describe('POST /api/vendor/contests/:id/protest — silence basis', () => {
  const silenceAt = addContestDays(CREATED, 30);
  const openContest = {
    status: 'open' as const,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    updatedAt: CREATED,
  };

  it('refuses one millisecond before day 30, saying when it opens', async () => {
    await seedContest(openContest);
    nowIso = new Date(Date.parse(silenceAt) - 1).toISOString();
    const res = await file();
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: 'owner_not_silent_yet', opens_at: silenceAt });
  });

  it('files at day 30 and turns the contest into a decline dated day 30', async () => {
    await seedContest(openContest);
    nowIso = silenceAt;
    const res = await file();
    expect(res.status).toBe(200);
    const r = await row();
    expect(r).toMatchObject({
      status: 'declined',
      decidedAt: silenceAt,
      decidedBy: null,
      decisionNote: null,
      protestStatus: 'open',
      protestBasis: 'silence',
    });
    expect(await actions()).toEqual(
      expect.arrayContaining(['integration.contest.lapsed', 'integration.contest.protested']),
    );
    const [instance] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, CONTEST_WF));
    expect(instance).toMatchObject({ currentState: 'declined', finalOutcome: 'rejected' });
  });

  it('closes at day 60, exclusive', async () => {
    await seedContest(openContest);
    nowIso = addContestDays(silenceAt, 30);
    const res = await file();
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('window_closed');
  });

  it('loses cleanly to the owner deciding first, and writes nothing', async () => {
    await seedContest(openContest);
    nowIso = silenceAt;
    const racing = racingFactory(() => {
      t.raw
        .prepare(`UPDATE integration_field_challenges SET status = 'accepted' WHERE id = ?`)
        .run(CONTEST);
    });
    const res = await file(AUTH_A, PROTEST, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('contest_changed');
    expect(await actions()).toEqual([]);
    expect((await row()).protestStatus).toBeNull();
  });

  it('blocks the owner deciding after a silence protest won', async () => {
    await seedContest(openContest);
    nowIso = silenceAt;
    expect((await file()).status).toBe(200);
    const late = await call(AUTH_B, 'POST', `/api/vendor/contests/${CONTEST}/decision`, {
      decision: 'accept',
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CONTEST_NOT_OPEN');
  });
});

// ─── Reply ───────────────────────────────────────────────────────────────────

describe('POST /api/vendor/contests/:id/protest/reply', () => {
  beforeEach(async () => {
    await seedContest();
    expect((await file()).status).toBe(200);
  });

  it('records one reply and tells the submitter', async () => {
    const res = await reply(AUTH_B, {
      reply: 'The short name is our brand.',
      evidence_urls: ['https://example.test/brand'],
    });
    expect(res.status).toBe(200);
    expect(res.body.contest.protest).toMatchObject({
      reply: 'The short name is our brand.',
      reply_evidence_urls: ['https://example.test/brand'],
      replied_at: nowIso,
    });
    const events = (await notifications()).map((n) => (n.metadata as JsonBody).event);
    expect(events).toContain('protest_replied');
    const again = await reply();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PROTEST_REPLY_EXISTS');
  });

  it('refuses at exactly the due date', async () => {
    nowIso = addContestDays(nowIso, 14);
    const res = await reply();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROTEST_REPLY_CLOSED');
  });

  it('is a 404 for the submitter and a third vendor', async () => {
    expect((await reply(AUTH_A)).status).toBe(404);
    expect((await reply(AUTH_C)).status).toBe(404);
  });

  it('is refused after AECi decides', async () => {
    expect((await decide({ decision: 'uphold', note: 'We agree.' })).status).toBe(200);
    const res = await reply();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROTEST_NOT_OPEN');
  });
});

// ─── Withdraw ────────────────────────────────────────────────────────────────

describe('POST /api/vendor/contests/:id/protest/withdraw', () => {
  it('withdraws with no cooldown and no refile', async () => {
    await seedContest();
    expect((await file()).status).toBe(200);
    expect((await withdraw(AUTH_B)).status).toBe(404);
    const res = await withdraw();
    expect(res.status).toBe(200);
    expect(res.body.contest.protest.status).toBe('withdrawn');
    expect(res.body.contest.cooldown_until).toBeNull();
    const [instance] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, (await row()).protestWorkflowId!));
    expect(instance).toMatchObject({ currentState: 'withdrawn', finalOutcome: 'cancelled' });
    const again = await file();
    expect(again.body.error.details.reason).toBe('already_protested');
    expect((await withdraw()).body.error.code).toBe('PROTEST_NOT_OPEN');
  });
});

// ─── AECi decides ────────────────────────────────────────────────────────────

describe('PATCH /api/admin/contests/:id/protest', () => {
  beforeEach(async () => {
    await seedContest();
    expect((await file()).status).toBe(200);
  });

  it('requires a note', async () => {
    expect((await decide({ decision: 'uphold' })).status).toBe(400);
  });

  it('upholds as advice: tells both sides and writes nothing public', async () => {
    const before = (await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN)))[0];
    const res = await decide({ decision: 'uphold', note: 'The longer name is right.' });
    expect(res.status).toBe(200);
    expect(res.body.protest).toMatchObject({
      status: 'upheld',
      decision_note: 'The longer name is right.',
    });
    const after = (await t.db.select().from(integrations).where(eq(integrations.id, I_MAIN)))[0];
    expect(after).toEqual(before);
    expect(res.send).not.toHaveBeenCalled();
    const decided = (await notifications())
      .map((n) => n.metadata as JsonBody)
      .filter((m) => m.event === 'protest_upheld');
    expect(decided.map((m) => [m.vendorId, m.recipientRole]).sort()).toEqual(
      [
        [VENDOR_A, 'submitter'],
        [VENDOR_B, 'owner'],
      ].sort(),
    );
  });

  it('rejects, starting a 90-day cooldown the submitter is told about', async () => {
    const res = await decide({ decision: 'reject', note: 'The owner is right.' });
    expect(res.status).toBe(200);
    const toSubmitter = (await notifications())
      .map((n) => n.metadata as JsonBody)
      .find((m) => m.event === 'protest_rejected' && m.recipientRole === 'submitter');
    expect(toSubmitter?.cooldownUntil).toBe(addContestDays(nowIso, 90));
    expect((await decide({ decision: 'reject', note: 'again' })).body.error.code).toBe(
      'PROTEST_NOT_OPEN',
    );
  });

  it('skips the owner notification when the owner vendor is gone', async () => {
    await t.db
      .update(integrationFieldChallenges)
      .set({ ownerVendorId: null })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    await decide({ decision: 'uphold', note: 'ok' });
    const decided = (await notifications())
      .map((n) => n.metadata as JsonBody)
      .filter((m) => m.event === 'protest_upheld');
    expect(decided).toHaveLength(1);
  });

  it('lists in the Protests view and counts in the badge until decided', async () => {
    const list = await call(ADMIN, 'GET', '/api/admin/contests?protest_status=open');
    expect(list.body.data.map((c: JsonBody) => c.id)).toEqual([CONTEST]);
    expect(list.body.data[0].protest.status).toBe('open');
    expect(list.body.data[0].owner_changed).toBe(false);
    expect((await readAdminQueueCounts(t.db)).pending_contests).toBe(1);
    await decide({ decision: 'uphold', note: 'ok' });
    expect((await readAdminQueueCounts(t.db)).pending_contests).toBe(0);
  });
});

// ─── The contest submit: open protest and cooldown ───────────────────────────

describe('POST /api/vendor/integrations/:id/contests — protest refusals', () => {
  const contestAgain = () =>
    call(AUTH_A, 'POST', `/api/vendor/integrations/${I_MAIN}/contests`, {
      field: 'name',
      proposed_value: 'Something else',
      reason: 'Again.',
    });

  beforeEach(async () => {
    await seedContest();
  });

  it('refuses a new contest on the field while a protest is open', async () => {
    expect((await file()).status).toBe(200);
    const res = await contestAgain();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONTEST_PROTEST_OPEN',
      details: { contest_id: CONTEST },
    });
  });

  it('refuses inside the cooldown after a lost protest, and lifts it at day 90', async () => {
    const decidedAt = '2026-08-12T00:00:00.000Z';
    await t.db
      .update(integrationFieldChallenges)
      .set({
        protestStatus: 'rejected',
        protestBasis: 'declined',
        protestedAt: nowIso,
        protestDecidedAt: decidedAt,
      })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.parse(addContestDays(decidedAt, 90)) - 1));
      const blocked = await contestAgain();
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.details.until).toBe(addContestDays(decidedAt, 90));
      vi.setSystemTime(new Date(addContestDays(decidedAt, 90)));
      expect((await contestAgain()).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is lifted by any change to the value on record', async () => {
    await t.db
      .update(integrationFieldChallenges)
      .set({
        protestStatus: 'rejected',
        protestBasis: 'declined',
        protestedAt: nowIso,
        protestDecidedAt: new Date().toISOString(),
      })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    expect((await contestAgain()).status).toBe(409);
    await t.db.update(integrations).set({ name: 'Renamed' }).where(eq(integrations.id, I_MAIN));
    expect((await contestAgain()).status).toBe(201);
  });

  it('is not started by an upheld protest', async () => {
    await t.db
      .update(integrationFieldChallenges)
      .set({
        protestStatus: 'upheld',
        protestBasis: 'declined',
        protestedAt: nowIso,
        protestDecidedAt: new Date().toISOString(),
      })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    expect((await contestAgain()).status).toBe(201);
  });
});

// ─── Reads: the list, the feed and the cursor ────────────────────────────────

describe('reads', () => {
  it('sends the window to the submitter only', async () => {
    await seedContest();
    const a = ListVendorContestsResponseSchema.parse(
      (await call(AUTH_A, 'GET', '/api/vendor/contests')).body,
    );
    // The list uses the real clock; the seeded decline is long past its window.
    expect(a.submitted[0]!.protest_opens_at).toBeNull();
    await t.db
      .update(integrationFieldChallenges)
      .set({ decidedAt: new Date().toISOString() })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    const fresh = ListVendorContestsResponseSchema.parse(
      (await call(AUTH_A, 'GET', '/api/vendor/contests')).body,
    );
    expect(fresh.submitted[0]!.protest_basis).toBe('declined');
    expect(fresh.submitted[0]!.protest_closes_at).not.toBeNull();
    const b = ListVendorContestsResponseSchema.parse(
      (await call(AUTH_B, 'GET', '/api/vendor/contests')).body,
    );
    expect(b.received[0]!.protest_opens_at).toBeNull();
  });

  it('puts the protest events in each party feed with their metadata', async () => {
    await seedContest({ decidedAt: new Date().toISOString() });
    nowIso = new Date().toISOString();
    await file();
    const feed = ListVendorNotificationsResponseSchema.parse(
      (await call(AUTH_B, 'GET', '/api/vendor/notifications')).body,
    );
    const protested = feed.notifications.find(
      (n) => n.kind === 'contest' && n.event === 'protested',
    );
    expect(protested).toMatchObject({ reply_due_at: addContestDays(nowIso, 14) });
  });

  it('moves the contests cursor for both parties and not for a third vendor', async () => {
    await seedContest();
    const cursor = async (auth: AuthzVariables['auth']) =>
      (await call(auth, 'GET', '/api/vendor/updates')).body.revisions.contests;
    const [a0, b0, c0] = [await cursor(AUTH_A), await cursor(AUTH_B), await cursor(AUTH_C)];
    await file();
    expect(await cursor(AUTH_A)).not.toBe(a0);
    expect(await cursor(AUTH_B)).not.toBe(b0);
    expect(await cursor(AUTH_C)).toBe(c0);
  });

  it('puts every audit row in the same batch as its write', async () => {
    await seedContest();
    const spy = vi.spyOn(t.db, 'batch');
    await file();
    const stmts = spy.mock.calls[0]![0] as readonly unknown[];
    // instance, UPDATE, 3 sentinels, transition, protested audit, owner notification
    expect(stmts).toHaveLength(8);
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, CONTEST)));
    expect(rows).toHaveLength(2);
  });
});
