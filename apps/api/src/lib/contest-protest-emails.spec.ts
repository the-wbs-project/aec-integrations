/**
 * The protest and decline emails (AECI-1205 / `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.12.10), end to end: the real routes and the real senders down to a stubbed
 * global `fetch`, with the send ledger on the in-memory D1 harness, so the
 * `notification_sends` UNIQUE index that turns a replay into a `duplicate` is real
 * SQLite. The seat addresses come from an injected `fetchSeatEmails`.
 */

import { addContestDays } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import {
  integrationFieldChallenges,
  integrations,
  notificationSends,
  productVendors,
  products,
  profiles,
  vendors,
  workflowInstances,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { createModerateContestHandler } from '../routes/admin-contests';
import { createFileContestProtestHandler } from '../routes/vendor-contest-protests';
import { createDecideContestHandler } from '../routes/vendor-contests';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import type { AuthzVariables } from './authz';
import {
  emailProtestFiled,
  protestReminderKey,
  runProtestReplyReminderSweep,
} from './contest-protest-emails';
import { formatDeadline } from './email';
import { ledgerDb } from './notifications/send-ledger';

vi.mock('./notifications/send-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notifications/send-ledger')>();
  return { ...actual, ledgerDb: vi.fn(() => null) };
});

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A (Autodesk) contests B's (Bentley's) claimed integration. Each has two seats.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const I_MAIN = uuid(20);
const SEAT_A1 = uuid(100);
const SEAT_A2 = uuid(101);
const SEAT_B1 = uuid(110);
const SEAT_B2 = uuid(111);
const ADMIN_ID = uuid(200);
const CONTEST = uuid(300);
const CONTEST_WF = uuid(301);

const ADDRESS: Record<string, string> = {
  [SEAT_A1]: 'dana@autodesk.com',
  [SEAT_A2]: 'lee@autodesk.com',
  [SEAT_B1]: 'sam@bentley.com',
  [SEAT_B2]: 'kim@bentley.com',
};
const fetchSeatEmails = vi.fn(
  async (_env: Env, ids: readonly string[]) =>
    new Map(ids.filter((id) => ADDRESS[id]).map((id) => [id, ADDRESS[id]!])),
);

/** Production, so the tier policy delivers to the outside test addresses. */
const ENV: Env = {
  ENV: 'production',
  RESEND_API_KEY: 'rk_test',
  EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
  CLAIM_ALERT_EMAIL: 'support@aecintegrations.com',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
};

const seat = (userId: string, vendorId: string | null, role = 'vendor_admin') =>
  ({
    userId,
    email: `${userId}@example.test`,
    role,
    vendorId,
    entitlementTier: 'unclaimed',
    entitlement: null,
  }) as AuthzVariables['auth'];

const CREATED = '2026-08-01T00:00:00.000Z';
const DECIDED = '2026-08-10T00:00:00.000Z';
const NAME = 'Revit for MicroStation';

let t: TestDb;
function spyFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));
}
let fetchSpy: ReturnType<typeof spyFetch>;
let nowIso = '2026-08-11T00:00:00.000Z';
const clock = () => new Date(nowIso);

beforeEach(async () => {
  nowIso = '2026-08-11T00:00:00.000Z';
  t = await makeTestDb();
  fetchSpy = spyFetch();
  vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
  fetchSeatEmails.mockClear();
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
    name: NAME,
    sourceProductId: P_SOURCE,
    targetProductId: P_TARGET,
    direction: 'a_to_b',
    builtByVendorId: VENDOR_B,
    claimedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  await t.db.insert(profiles).values([
    { id: SEAT_A1, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_A2, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B1, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_B2, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: ADMIN_ID, role: 'admin' },
  ]);
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

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
    currentValue: NAME,
    proposedValue: 'Revit Connector for MicroStation',
    reason: 'The listing calls it that.',
    submitterVendorId: VENDOR_A,
    submittedBy: SEAT_A1,
    routedTo: 'owner',
    ownerVendorId: VENDOR_B,
    status: 'declined',
    decisionNote: 'We prefer the short name.',
    decidedBy: SEAT_B1,
    decidedAt: DECIDED,
    workflowId: CONTEST_WF,
    createdAt: CREATED,
    updatedAt: DECIDED,
    ...overrides,
  });
}

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post(
    '/api/vendor/contests/:id/protest',
    createFileContestProtestHandler(t.factory, clock, { fetchSeatEmails }),
  );
  a.post(
    '/api/vendor/contests/:id/decision',
    createDecideContestHandler(t.factory, { fetchSeatEmails }),
  );
  a.patch('/api/admin/contests/:id', createModerateContestHandler(t.factory, vi.fn()));
  return a;
}

async function call(
  auth: AuthzVariables['auth'],
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
): Promise<number> {
  const env: Env = {
    ...ENV,
    CACHE_PURGE_QUEUE: { send: vi.fn() } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const ctx = fakeExecutionContext();
  const res = await app(auth).request(
    path,
    { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    env,
    ctx,
  );
  await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map((c) => c[0]));
  return res.status;
}

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function sent(): Sent[] {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes('api.resend.com'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Sent);
}

const ledger = (notificationId: string) =>
  t.db.select().from(notificationSends).where(eq(notificationSends.notificationId, notificationId));

function cronCtx() {
  return {
    env: ENV,
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://aeci-api/cron/protest-reply-reminder') },
  };
}

const PROTEST = {
  reason: 'The product page and the listing both use the longer name.',
  evidence_urls: ['https://example.test/a'],
};

// ─── Filing a protest ────────────────────────────────────────────────────────

describe('filing a protest (AECI-1205)', () => {
  it('emails every owner seat the reply deadline, and alerts support, once each', async () => {
    await seedContest();
    const status = await call(
      seat(SEAT_A1, VENDOR_A),
      'POST',
      `/api/vendor/contests/${CONTEST}/protest`,
      PROTEST,
    );
    expect(status).toBe(200);

    const replyDueAt = addContestDays(nowIso, 14);
    const due = formatDeadline(replyDueAt);
    const mail = sent();
    expect(mail.map((m) => m.to).sort()).toEqual([
      'kim@bentley.com',
      'sam@bentley.com',
      'support@aecintegrations.com',
    ]);

    const alert = mail.find((m) => m.to === 'support@aecintegrations.com')!;
    expect(alert.subject).toBe(`[AECi] Protest: name on ${NAME}`);
    expect(alert.text).toContain('Filed by: Autodesk');
    expect(alert.text).toContain('Owner: Bentley');
    expect(alert.text).toContain('Basis: The owner declined the contest');
    expect(alert.text).toContain(`Reason given: ${PROTEST.reason}`);
    expect(alert.text).toContain('Evidence links: 1');
    expect(alert.text).toContain(`Owner reply due: ${due}`);
    expect(alert.text).toContain(`Contest id: ${CONTEST}`);
    expect(alert.text).toContain('https://www.aecintegrations.com/admin/contests');

    const owner = mail.find((m) => m.to === 'sam@bentley.com')!;
    expect(owner.subject).toBe(`Reply by ${due}: review requested on ${NAME}`);
    expect(owner.text).toContain('Autodesk disagrees with the decision Bentley made');
    expect(owner.text).toContain(`You can reply once, by ${due}.`);
    expect(owner.text).toContain(`Their reason: ${PROTEST.reason}`);
    expect(owner.text).toContain('Value on record: Revit for MicroStation');
    expect(owner.text).toContain('https://www.aecintegrations.com/vendor/bentley/messages');
    // The deadline carries its time of day (§11b.12.10).
    expect(due).toMatch(/\d{1,2}:\d{2} (AM|PM) UTC$/);

    expect(await ledger('contest-protest-opened')).toHaveLength(2);
    expect((await ledger('protest-submitted-alert'))[0]).toMatchObject({
      outcome: 'sent',
      dedupeKey: `protest-submitted-alert:${CONTEST}:${nowIso}`,
    });
  });

  it('a replay of the same protest sends nothing and records duplicates', async () => {
    await seedContest();
    await call(seat(SEAT_A1, VENDOR_A), 'POST', `/api/vendor/contests/${CONTEST}/protest`, PROTEST);
    expect(sent()).toHaveLength(3);

    const [row] = await t.db
      .select()
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.id, CONTEST));
    await emailProtestFiled(
      cronCtx(),
      t.db as Db,
      row!,
      {
        basis: 'declined',
        reason: PROTEST.reason,
        evidenceCount: 1,
        protestedAt: row!.protestedAt!,
        replyDueAt: row!.protestReplyDueAt!,
      },
      { fetchSeatEmails },
    );
    expect(sent()).toHaveLength(3);
    const outcomes = [
      ...(await ledger('contest-protest-opened')),
      ...(await ledger('protest-submitted-alert')),
    ].map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(3);
  });

  it('says the owner did not answer on a silence-basis protest', async () => {
    await seedContest({ status: 'open', decidedAt: null, decidedBy: null, decisionNote: null });
    nowIso = addContestDays(CREATED, 31);
    expect(
      await call(
        seat(SEAT_A1, VENDOR_A),
        'POST',
        `/api/vendor/contests/${CONTEST}/protest`,
        PROTEST,
      ),
    ).toBe(200);
    const owner = sent().find((m) => m.to === 'sam@bentley.com')!;
    expect(owner.text).toContain('Bentley did not answer within 30 days');
    const alert = sent().find((m) => m.to === 'support@aecintegrations.com')!;
    expect(alert.text).toContain('Basis: The owner did not answer the contest within 30 days');
  });

  it('a refused protest sends nothing', async () => {
    await seedContest({ protestStatus: 'withdrawn', protestedAt: DECIDED });
    const status = await call(
      seat(SEAT_A1, VENDOR_A),
      'POST',
      `/api/vendor/contests/${CONTEST}/protest`,
      PROTEST,
    );
    expect(status).toBe(409);
    expect(sent()).toEqual([]);
  });
});

// ─── Decisions ───────────────────────────────────────────────────────────────

describe('declining a contest (AECI-1205)', () => {
  it("an owner decline emails the submitter's seats the 30-day protest window", async () => {
    await seedContest({ status: 'open', decidedAt: null, decidedBy: null, decisionNote: null });
    const status = await call(
      seat(SEAT_B1, VENDOR_B),
      'POST',
      `/api/vendor/contests/${CONTEST}/decision`,
      {
        decision: 'decline',
        note: 'We prefer the short name.',
      },
    );
    expect(status).toBe(200);

    const mail = sent();
    expect(mail.map((m) => m.to).sort()).toEqual(['dana@autodesk.com', 'lee@autodesk.com']);
    const [row] = await t.db
      .select()
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.id, CONTEST));
    const closes = formatDeadline(addContestDays(row!.decidedAt!, 30));
    const first = mail[0]!;
    expect(first.subject).toBe(`Bentley declined your change request on ${NAME}`);
    expect(first.text).toContain('The value on record stays as it is.');
    expect(first.text).toContain(`ask AEC Integrations to review it until ${closes}`);
    expect(first.text).toContain('Their note: We prefer the short name.');
    expect(first.text).toContain('https://www.aecintegrations.com/vendor/autodesk/messages');
    expect(await ledger('contest-declined-protest-window')).toHaveLength(2);
  });

  it('an owner accept sends no window email', async () => {
    await seedContest({ status: 'open', decidedAt: null, decidedBy: null, decisionNote: null });
    const status = await call(
      seat(SEAT_B1, VENDOR_B),
      'POST',
      `/api/vendor/contests/${CONTEST}/decision`,
      {
        decision: 'accept',
      },
    );
    expect(status).toBe(200);
    expect(sent()).toEqual([]);
  });

  it('an AECi decline sends no window email: it cannot be protested', async () => {
    await seedContest({
      status: 'open',
      routedTo: 'aeci',
      ownerVendorId: null,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
    });
    const status = await call(
      seat(ADMIN_ID, null, 'admin'),
      'PATCH',
      `/api/admin/contests/${CONTEST}`,
      {
        decision: 'decline',
      },
    );
    expect(status).toBe(200);
    expect(sent()).toEqual([]);
    expect(await ledger('contest-declined-protest-window')).toEqual([]);
  });
});

// ─── The daily reply reminder ────────────────────────────────────────────────

describe('runProtestReplyReminderSweep (AECI-1205)', () => {
  const PROTESTED = '2026-08-20T09:30:00.000Z';
  const DUE = addContestDays(PROTESTED, 14); // 2026-09-03T09:30Z
  const openProtest = {
    protestStatus: 'open',
    protestBasis: 'declined',
    protestReason: PROTEST.reason,
    protestedBy: SEAT_A1,
    protestedAt: PROTESTED,
    protestReplyDueAt: DUE,
  } as const;
  const run = (now: string) =>
    runProtestReplyReminderSweep(cronCtx(), t.db as Db, { now: new Date(now), fetchSeatEmails });

  it('reminds every owner seat when the deadline is 3 days out, and only once', async () => {
    await seedContest(openProtest);
    const first = await run(addContestDays(DUE, -3));
    expect(first).toMatchObject({ due: 1, capped: 0 });
    expect(first.emails.sent).toBe(2);

    const mail = sent();
    expect(mail.map((m) => m.to).sort()).toEqual(['kim@bentley.com', 'sam@bentley.com']);
    expect(mail[0]!.subject).toBe(`Reminder: reply by ${formatDeadline(DUE)} on ${NAME}`);
    expect(mail[0]!.text).toContain('Bentley has not replied yet.');
    expect(mail[0]!.text).toContain('https://www.aecintegrations.com/vendor/bentley/messages');
    const keys = (await ledger('contest-protest-reply-reminder')).map((r) => r.dedupeKey).sort();
    expect(keys).toEqual(
      [
        protestReminderKey(CONTEST, PROTESTED, SEAT_B1),
        protestReminderKey(CONTEST, PROTESTED, SEAT_B2),
      ].sort(),
    );

    // The next two daily runs are still inside the window: duplicates, no Resend call.
    const second = await run(addContestDays(DUE, -2));
    expect(second.emails).toMatchObject({ sent: 0, duplicate: 2 });
    await run(addContestDays(DUE, -1));
    expect(sent()).toHaveLength(2);
  });

  it('does not remind before the window opens', async () => {
    await seedContest(openProtest);
    const result = await run(addContestDays(DUE, -4));
    expect(result.due).toBe(0);
    expect(sent()).toEqual([]);
  });

  it('does not remind an owner that already replied', async () => {
    await seedContest({
      ...openProtest,
      protestReply: 'The short name is our brand.',
      protestRepliedBy: SEAT_B1,
      protestRepliedAt: addContestDays(PROTESTED, 2),
    });
    expect((await run(addContestDays(DUE, -2))).due).toBe(0);
    expect(sent()).toEqual([]);
  });

  it('does not remind past the deadline, nor on a withdrawn or decided protest', async () => {
    await seedContest(openProtest);
    expect((await run(DUE)).due).toBe(0);
    await t.db
      .update(integrationFieldChallenges)
      .set({ protestStatus: 'withdrawn' })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    expect((await run(addContestDays(DUE, -1))).due).toBe(0);
    await t.db
      .update(integrationFieldChallenges)
      .set({ protestStatus: 'upheld', protestDecidedAt: addContestDays(PROTESTED, 3) })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    expect((await run(addContestDays(DUE, -1))).due).toBe(0);
    expect(sent()).toEqual([]);
  });

  it('reports a zero run with no reads beyond the protest query', async () => {
    const result = await run('2026-09-01T12:00:00.000Z');
    expect(result).toEqual({
      due: 0,
      capped: 0,
      emails: { sent: 0, failed: 0, unknown: 0, skipped: 0, suppressed: 0, duplicate: 0 },
    });
    expect(fetchSeatEmails).not.toHaveBeenCalled();
  });
});
