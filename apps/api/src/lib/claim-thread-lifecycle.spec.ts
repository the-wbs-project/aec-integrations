/**
 * The thread lifecycle helpers (AECI-1536, `STAGE_2_ATTESTATIONS_SPEC.md` §15.5,
 * §15.10) against the real migrations: the promote-preservation read, the guarded
 * close in both race modes, and the 2-year retention sweep.
 */

import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import {
  auditLog,
  claimThreadMessages,
  claimThreadReads,
  claimThreads,
  claims,
  integrations,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  anyThreadDetachRaced,
  claimRemovedThreadDetachWhere,
  loadThreadsOnClaims,
  noOpenThreadsOnAnchorSentinel,
  openThreadsOnAnchor,
  planClaimRemovedThreadCloses,
  runThreadRetentionSweep,
  THREAD_CLOSED_ACTION,
  THREAD_RETENTION_DELETED_ACTION,
  threadCloseStatements,
  threadRetentionCutoff,
} from './claim-thread-lifecycle';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V_A = uuid(1);
const V_B = uuid(2);
const P_A = uuid(10);
const P_B = uuid(11);
const I_1 = uuid(20);
const DO_1 = uuid(30);
const DO_2 = uuid(31);
const C_1 = uuid(40);
const C_2 = uuid(41);
const SEAT = uuid(100);

const NOW = new Date('2028-10-29T10:00:00.000Z');
const OLD = '2026-10-28T09:00:00.000Z'; // more than 2 years before NOW
const RECENT = '2026-10-30T09:00:00.000Z'; // less than 2 years before NOW

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V_A, slug: 'a', companyName: 'A' },
    { id: V_B, slug: 'b', companyName: 'B' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'pa', name: 'PA' },
    { id: P_B, slug: 'pb', name: 'PB' },
  ]);
  await t.db.insert(integrations).values({ id: I_1, sourceProductId: P_A, targetProductId: P_B });
  await t.db.insert(taxonomyDataObjects).values([
    { id: DO_1, slug: 'rfis', name: 'RFIs', displayOrder: 1 },
    { id: DO_2, slug: 'issues', name: 'Issues', displayOrder: 2 },
  ]);
  await t.db.insert(claims).values([
    { id: C_1, integrationId: I_1, dataObjectId: DO_1, direction: 'a_to_b' },
    { id: C_2, integrationId: I_1, dataObjectId: DO_2, direction: 'a_to_b' },
  ]);
  await t.db.insert(profiles).values({ id: SEAT, vendorId: V_A });
});

afterEach(() => t.dispose());

async function thread(id: string, claimId: string | null, over: { createdAt?: string } = {}) {
  await t.db.insert(claimThreads).values({
    id,
    claimId,
    vendorAId: V_A,
    vendorBId: V_B,
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
  });
}

let msgN = 0;
async function message(threadId: string, createdAt: string, deletedAt: string | null = null) {
  await t.db.insert(claimThreadMessages).values({
    id: uuid(500 + ++msgN),
    threadId,
    authorVendorId: V_A,
    authorProfileId: SEAT,
    body: 'private text',
    createdAt,
    deletedAt,
  });
}

describe('planClaimRemovedThreadCloses (§15.5)', () => {
  const actor = { actorId: null, actorType: 'system' as const };
  const claim = { id: C_1, anchorId: I_1, dataObjectId: DO_1 };

  it('detaches every thread on the claim, closes the open one claim_removed, and keeps messages', async () => {
    await thread(uuid(200), C_1);
    await message(uuid(200), RECENT);
    const plan = planClaimRemovedThreadCloses(t.db, {
      claim,
      threads: await loadThreadsOnClaims(t.db, [C_1, C_2]),
      now: RECENT,
      actor,
      metadata: {},
    });
    const stmts: BatchStmt[] = [
      ...plan.stmts,
      t.db.delete(claims).where(eq(claims.id, C_1)),
      ...plan.audits.map((entry) => auditInsert(t.db, entry)),
    ];
    await t.db.batch(stmts as BatchTuple);
    const [row] = await t.db.select().from(claimThreads);
    expect(row).toMatchObject({
      claimId: null,
      closedAt: RECENT,
      closedReason: 'claim_removed',
      anchorSnapshot: { anchorId: I_1, dataObjectId: DO_1 },
    });
    expect(await t.db.select().from(claimThreadMessages)).toHaveLength(1);
    expect(plan.audits).toHaveLength(1);
    expect(plan.audits[0]).toMatchObject({
      entityId: uuid(200),
      afterState: { closedAt: RECENT, closedReason: 'claim_removed' },
    });
  });

  it('keeps the reason of a thread already closed, or closed earlier in the same batch', async () => {
    await thread(uuid(200), C_1);
    const plan = planClaimRemovedThreadCloses(t.db, {
      claim,
      threads: await loadThreadsOnClaims(t.db, [C_1]),
      now: RECENT,
      actor,
      metadata: {},
      closedInBatch: new Set([uuid(200)]),
    });
    expect(plan.audits).toEqual([]);
    const stmts: BatchStmt[] = [
      t.db
        .update(claimThreads)
        .set({ closedAt: OLD, closedReason: 'not_attestable' })
        .where(eq(claimThreads.id, uuid(200))),
      ...plan.stmts,
    ];
    await t.db.batch(stmts as BatchTuple);
    expect((await t.db.select().from(claimThreads))[0]).toMatchObject({
      claimId: null,
      closedReason: 'not_attestable',
      anchorSnapshot: { anchorId: I_1, dataObjectId: DO_1 },
    });
  });

  it('aborts when a thread opened on the claim after the read, even with none planned', async () => {
    const plan = planClaimRemovedThreadCloses(t.db, {
      claim,
      threads: [],
      now: RECENT,
      actor,
      metadata: {},
    });
    await thread(uuid(200), C_1);
    await expect(t.db.batch(plan.stmts as BatchTuple)).rejects.toThrow(/malformed JSON/i);
    expect(await anyThreadDetachRaced(t.db, [plan.planned])).toBe(true);
  });

  it('aborts when a planned open thread closed after the read', async () => {
    await thread(uuid(200), C_1);
    const plan = planClaimRemovedThreadCloses(t.db, {
      claim,
      threads: await loadThreadsOnClaims(t.db, [C_1]),
      now: RECENT,
      actor,
      metadata: {},
    });
    expect(await anyThreadDetachRaced(t.db, [plan.planned])).toBe(false);
    await t.db
      .update(claimThreads)
      .set({ closedAt: OLD, closedReason: 'withdrawn' })
      .where(eq(claimThreads.id, uuid(200)));
    await expect(t.db.batch(plan.stmts as BatchTuple)).rejects.toThrow(/malformed JSON/i);
    expect(await anyThreadDetachRaced(t.db, [plan.planned])).toBe(true);
  });
});

describe('claimRemovedThreadDetachWhere (§15.5, AECI-1542)', () => {
  it('detaches the threads on the scoped claims, closes the open one with one audit row', async () => {
    await thread(uuid(200), C_1);
    await message(uuid(200), RECENT);
    await thread(uuid(201), C_2);
    await t.db
      .update(claimThreads)
      .set({ closedAt: OLD, closedReason: 'not_attestable' })
      .where(eq(claimThreads.id, uuid(201)));
    const stmts: BatchStmt[] = [
      ...claimRemovedThreadDetachWhere(t.db, {
        claimIds: sql`SELECT ${claims.id} FROM ${claims} WHERE ${claims.integrationId} = ${I_1}`,
        now: RECENT,
        metadata: { integrationId: I_1 },
      }),
      // The anchor DELETE cascades the claims, as the stale-twin delete does.
      t.db.delete(integrations).where(eq(integrations.id, I_1)),
    ];
    await t.db.batch(stmts as BatchTuple);

    const rows = await t.db.select().from(claimThreads).orderBy(claimThreads.id);
    expect(rows[0]).toMatchObject({
      claimId: null,
      closedAt: RECENT,
      closedReason: 'claim_removed',
      anchorSnapshot: { anchorId: I_1, dataObjectId: DO_1 },
    });
    // Already closed: keeps its reason and close time, still gets its snapshot.
    expect(rows[1]).toMatchObject({
      claimId: null,
      closedAt: OLD,
      closedReason: 'not_attestable',
      anchorSnapshot: { anchorId: I_1, dataObjectId: DO_2 },
    });
    expect(await t.db.select().from(claimThreadMessages)).toHaveLength(1);

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      action: THREAD_CLOSED_ACTION,
      entityType: 'claim_thread',
      entityId: uuid(200),
      afterState: { closedAt: RECENT, closedReason: 'claim_removed' },
      metadata: { integrationId: I_1, claimId: C_1, closedReason: 'claim_removed' },
      createdAt: RECENT,
    });
    expect(audits[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('touches nothing outside the scope', async () => {
    await thread(uuid(200), C_1);
    await t.db.batch(
      claimRemovedThreadDetachWhere(t.db, {
        claimIds: sql`SELECT ${claims.id} FROM ${claims} WHERE ${claims.id} = ${C_2}`,
        now: RECENT,
        metadata: {},
      }) as BatchTuple,
    );
    expect((await t.db.select().from(claimThreads))[0]).toMatchObject({
      claimId: C_1,
      closedAt: null,
      anchorSnapshot: null,
    });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

describe('threadCloseStatements (§15.10)', () => {
  const actor = { actorId: null, actorType: 'system' as const };

  it('closes an open thread and writes one thread.closed row with no message text', async () => {
    await thread(uuid(200), C_1);
    await message(uuid(200), RECENT);
    const threads = await openThreadsOnAnchor(t.db, I_1);
    const plan = threadCloseStatements(t.db, {
      threads,
      reason: 'retired',
      now: RECENT,
      actor,
      metadata: { source: 'test' },
      onRace: { abort: 'test-race' },
    });
    const stmts: BatchStmt[] = [
      ...plan.stmts,
      noOpenThreadsOnAnchorSentinel(t.db, I_1, 'test-race'),
    ];
    await t.db.batch(stmts as BatchTuple);
    const [row] = await t.db.select().from(claimThreads);
    expect(row).toMatchObject({ closedAt: RECENT, closedReason: 'retired', claimId: C_1 });
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, THREAD_CLOSED_ACTION));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: 'claim_thread',
      entityId: uuid(200),
      afterState: { closedAt: RECENT, closedReason: 'retired' },
    });
    expect(JSON.stringify(audits[0])).not.toContain('private text');
  });

  it('aborts the batch when the thread closed after the read (abort mode)', async () => {
    await thread(uuid(200), C_1);
    const threads = await openThreadsOnAnchor(t.db, I_1);
    await t.db
      .update(claimThreads)
      .set({ closedAt: OLD, closedReason: 'withdrawn' })
      .where(eq(claimThreads.id, uuid(200)));
    const plan = threadCloseStatements(t.db, {
      threads,
      reason: 'retired',
      now: RECENT,
      actor,
      metadata: {},
      onRace: { abort: 'test-race' },
    });
    await expect(t.db.batch(plan.stmts as BatchTuple)).rejects.toThrow(/malformed JSON/i);
    expect((await t.db.select().from(auditLog)).length).toBe(0);
  });

  it('writes neither the close nor the audit row when the thread already closed (skip mode)', async () => {
    await thread(uuid(200), C_1);
    const threads = await openThreadsOnAnchor(t.db, I_1);
    await t.db
      .update(claimThreads)
      .set({ closedAt: OLD, closedReason: 'retired' })
      .where(eq(claimThreads.id, uuid(200)));
    const plan = threadCloseStatements(t.db, {
      threads,
      reason: 'withdrawn',
      now: RECENT,
      actor,
      metadata: {},
      onRace: 'skip',
    });
    await t.db.batch(plan.stmts as BatchTuple);
    const [row] = await t.db.select().from(claimThreads);
    expect(row).toMatchObject({ closedAt: OLD, closedReason: 'retired' });
    expect((await t.db.select().from(auditLog)).length).toBe(0);
  });

  it('the no-open sentinel aborts when a thread the read did not see is open', async () => {
    await thread(uuid(200), C_1);
    await expect(
      t.db.batch([noOpenThreadsOnAnchorSentinel(t.db, I_1, 'test-race')] as BatchTuple),
    ).rejects.toThrow(/malformed JSON/i);
  });
});

describe('the close notice (AECI-1548, §15.8)', () => {
  const actor = { actorId: null, actorType: 'system' as const };

  async function notices() {
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'notification.sent'))
      .orderBy(auditLog.vendorId);
    return rows;
  }

  it('claim_removed: one notice per company after the detach, naming the row from the snapshot', async () => {
    await thread(uuid(200), C_1);
    await message(uuid(200), RECENT);
    const plan = planClaimRemovedThreadCloses(t.db, {
      claim: { id: C_1, anchorId: I_1, dataObjectId: DO_1 },
      threads: await loadThreadsOnClaims(t.db, [C_1]),
      now: RECENT,
      actor,
      metadata: {},
    });
    await t.db.batch([
      ...plan.stmts,
      t.db.delete(claims).where(eq(claims.id, C_1)),
      ...plan.audits.map((entry) => auditInsert(t.db, entry)),
    ] as BatchTuple);
    const rows = await notices();
    expect(rows.map((r) => [r.vendorId, r.entityType, r.entityId])).toEqual([
      [V_A, 'claim_thread', uuid(200)],
      [V_B, 'claim_thread', uuid(200)],
    ]);
    expect(rows[0]!.metadata).toEqual({
      kind: 'thread_closed',
      notificationId: 'portal-thread-closed',
      vendorId: V_A,
      otherVendorId: V_B,
      otherVendorName: 'B',
      threadId: uuid(200),
      claimId: C_1,
      closedReason: 'claim_removed',
      dataObject: { slug: 'rfis', name: 'RFIs' },
    });
    expect(rows[1]!.metadata).toMatchObject({ vendorId: V_B, otherVendorName: 'A' });
    expect(JSON.stringify(rows)).not.toContain('private text');
  });

  it('claim_removed: no notice for a thread that was already closed', async () => {
    await thread(uuid(200), C_1);
    await t.db
      .update(claimThreads)
      .set({ closedAt: OLD, closedReason: 'retired' })
      .where(eq(claimThreads.id, uuid(200)));
    const plan = planClaimRemovedThreadCloses(t.db, {
      claim: { id: C_1, anchorId: I_1, dataObjectId: DO_1 },
      threads: await loadThreadsOnClaims(t.db, [C_1]),
      now: RECENT,
      actor,
      metadata: {},
    });
    await t.db.batch(plan.stmts as BatchTuple);
    expect(await notices()).toEqual([]);
  });

  it.each(['retired', 'not_attestable'] as const)(
    '%s (abort mode): one notice per company in the close batch',
    async (reason) => {
      await thread(uuid(200), C_1);
      const plan = threadCloseStatements(t.db, {
        threads: await openThreadsOnAnchor(t.db, I_1),
        reason,
        now: RECENT,
        actor,
        metadata: {},
        onRace: { abort: 'test-race' },
      });
      await t.db.batch(plan.stmts as BatchTuple);
      const rows = await notices();
      expect(rows.map((r) => r.vendorId)).toEqual([V_A, V_B]);
      expect(rows[0]!.metadata).toMatchObject({
        closedReason: reason,
        claimId: C_1,
        dataObject: { slug: 'rfis', name: 'RFIs' },
      });
      expect(rows[0]!.createdAt).toBe(RECENT);
    },
  );

  it('withdrawn (skip mode): writes the notices while the thread is open', async () => {
    await thread(uuid(200), C_1);
    const plan = threadCloseStatements(t.db, {
      threads: await openThreadsOnAnchor(t.db, I_1),
      reason: 'withdrawn',
      now: RECENT,
      actor,
      metadata: {},
      onRace: 'skip',
    });
    await t.db.batch(plan.stmts as BatchTuple);
    expect((await notices()).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ vendorId: V_A, closedReason: 'withdrawn' }),
      expect.objectContaining({ vendorId: V_B, closedReason: 'withdrawn' }),
    ]);
  });

  it('withdrawn (skip mode): a lost race writes no notice', async () => {
    await thread(uuid(200), C_1);
    const threads = await openThreadsOnAnchor(t.db, I_1);
    await t.db
      .update(claimThreads)
      .set({ closedAt: OLD, closedReason: 'retired' })
      .where(eq(claimThreads.id, uuid(200)));
    const plan = threadCloseStatements(t.db, {
      threads,
      reason: 'withdrawn',
      now: RECENT,
      actor,
      metadata: {},
      onRace: 'skip',
    });
    await t.db.batch(plan.stmts as BatchTuple);
    expect(await notices()).toEqual([]);
  });
});

describe('runThreadRetentionSweep (§15.10)', () => {
  it('cuts 2 calendar years before now', () => {
    expect(threadRetentionCutoff(NOW)).toBe('2026-10-29T10:00:00.000Z');
  });

  it('deletes a thread whose newest message is older than 2 years, with its messages and read markers', async () => {
    await thread(uuid(200), C_1, { createdAt: OLD });
    await message(uuid(200), OLD);
    await t.db
      .insert(claimThreadReads)
      .values({ threadId: uuid(200), profileId: SEAT, readAt: OLD });
    // A recent message keeps its thread, even though the thread is old.
    await thread(uuid(201), C_2, { createdAt: OLD });
    await message(uuid(201), OLD);
    await message(uuid(201), RECENT);

    const result = await runThreadRetentionSweep(t.db, { now: NOW });
    expect(result).toMatchObject({ deleted: 1, pages: 1, truncated: false, raced: false });
    expect((await t.db.select().from(claimThreads)).map((r) => r.id)).toEqual([uuid(201)]);
    expect(await t.db.select().from(claimThreadReads)).toEqual([]);
    expect(
      (await t.db.select().from(claimThreadMessages)).every((m) => m.threadId === uuid(201)),
    ).toBe(true);

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, THREAD_RETENTION_DELETED_ACTION));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      entityType: 'claim_thread',
      afterState: { count: 1, threadIds: [uuid(200)] },
    });
    expect(result.auditEntries).toHaveLength(1);
  });

  it('counts a soft-deleted message as activity, so a delete does not restart the clock', async () => {
    await thread(uuid(200), C_1, { createdAt: OLD });
    await message(uuid(200), OLD);
    // Posted recently, then deleted: still the newest message.
    await message(uuid(200), RECENT, RECENT);
    expect((await runThreadRetentionSweep(t.db, { now: NOW })).deleted).toBe(0);
    // And a thread whose last message was deleted long ago is due, deleted or not.
    await thread(uuid(201), C_2, { createdAt: OLD });
    await message(uuid(201), OLD, OLD);
    expect((await runThreadRetentionSweep(t.db, { now: NOW })).deleted).toBe(1);
  });

  it('deletes open and closed threads alike, and claim-less ones', async () => {
    await thread(uuid(200), null, { createdAt: OLD });
    await message(uuid(200), OLD);
    await thread(uuid(201), C_1, { createdAt: OLD });
    await message(uuid(201), OLD);
    await t.db
      .update(claimThreads)
      .set({ closedAt: OLD, closedReason: 'retired' })
      .where(eq(claimThreads.id, uuid(201)));
    expect((await runThreadRetentionSweep(t.db, { now: NOW })).deleted).toBe(2);
  });

  it('pages, one summary row per page, and stops at the page cap', async () => {
    for (let i = 0; i < 5; i++) {
      await thread(uuid(300 + i), null, { createdAt: OLD });
      await message(uuid(300 + i), OLD);
    }
    const capped = await runThreadRetentionSweep(t.db, { now: NOW, pageSize: 2, maxPages: 2 });
    expect(capped).toMatchObject({ deleted: 4, pages: 2, truncated: true });
    const rest = await runThreadRetentionSweep(t.db, { now: NOW, pageSize: 2, maxPages: 2 });
    expect(rest).toMatchObject({ deleted: 1, pages: 1, truncated: false });
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, THREAD_RETENTION_DELETED_ACTION));
    expect(audits.map((a) => (a.afterState as { count: number }).count)).toEqual([2, 2, 1]);
  });

  it('writes nothing when nothing is due', async () => {
    await thread(uuid(200), C_1);
    await message(uuid(200), RECENT);
    expect(await runThreadRetentionSweep(t.db, { now: NOW })).toMatchObject({
      deleted: 0,
      pages: 0,
    });
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });
});
