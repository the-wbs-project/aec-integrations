/**
 * The §7.4 retention prune (AECI-584 / P3.2) against the in-memory D1 harness.
 *
 * Every assertion here is one of the AC's, observed rather than assumed. Two are
 * worth naming because they are the ones that lose data if they regress:
 *
 *   - **`metrics_daily` is never touched, and neither are the three §26.6 audit /
 *     workflow tables.** Asserted against rows deliberately older than every
 *     cutoff, so "untouched" means "the prune considered and rejected them", not
 *     "there was nothing to delete".
 *   - **A day inside the cut window with no `metrics_daily` row stops the WHOLE
 *     run** — including the `job_runs` half, which has no snapshot dependency of
 *     its own. That coupling is deliberate (§7.4 / the AECI-573 gate); a test is
 *     the only thing that keeps it.
 *
 * Row counts are read back with `select`, never from a batch return value: the
 * harness's `db.batch` shim returns `[]` (`src/test/d1.ts`) and D1 does not
 * report `meta.changes` reliably for batched writes either, so a spec that
 * trusted the return would be testing the shim.
 */

import {
  JOB_RUNS_RETENTION_DAYS,
  NOTIFICATION_DELIVERY_EVENTS_RETENTION_DAYS,
  NOTIFICATION_SENDS_RETENTION_DAYS,
  PAGE_VIEWS_RETENTION_DAYS,
  USER_ACTIVITY_RETENTION_DAYS,
} from '@aeci/shared';
import { count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  jobRuns,
  metricsDaily,
  notificationDeliveryEvents,
  notificationSends,
  pageViews,
  recrawlSubmissions,
  userActivityDaily,
  vendorActivityDaily,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { shiftDay } from './admin-analytics';
import {
  cutoffFor,
  emitRetentionPruneMetrics,
  MAX_CHUNKS_PER_TABLE,
  PRUNABLE,
  PRUNE_CHUNK_ROWS,
  resolveRetentionDays,
  resolveRetentionWindows,
  runRetentionPrune,
  type RetentionPruneResult,
} from './retention-prune';

/** A fixed "now" so every cutoff in this file is a stable literal. */
const NOW = new Date('2027-08-01T03:00:00.000Z');
const TODAY = '2027-08-01';

/** The default windows, as the cron resolves them with no env override. */
const WINDOWS = {
  page_views: PAGE_VIEWS_RETENTION_DAYS,
  job_runs: JOB_RUNS_RETENTION_DAYS,
  notification_sends: NOTIFICATION_SENDS_RETENTION_DAYS,
  notification_delivery_events: NOTIFICATION_DELIVERY_EVENTS_RETENTION_DAYS,
  user_activity_daily: USER_ACTIVITY_RETENTION_DAYS,
};

/** Last day the `page_views` prune removes, and the first it keeps. */
const PV_CUTOFF_DAY = shiftDay(TODAY, -PAGE_VIEWS_RETENTION_DAYS); // 2026-06-27
const PV_LAST_PRUNED_DAY = shiftDay(PV_CUTOFF_DAY, -1); // 2026-06-26
const JR_CUTOFF_DAY = shiftDay(TODAY, -JOB_RUNS_RETENTION_DAYS); // 2027-05-03
const NS_CUTOFF_DAY = shiftDay(TODAY, -NOTIFICATION_SENDS_RETENTION_DAYS); // 2026-06-27
const UA_CUTOFF_DAY = shiftDay(TODAY, -USER_ACTIVITY_RETENTION_DAYS); // 2026-06-27

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const at = (day: string, time = '12:00:00.000Z') => `${day}T${time}`;

async function seedPageViews(days: string[]): Promise<void> {
  await t.db.insert(pageViews).values(days.map((day) => ({ path: '/x', createdAt: at(day) })));
}

async function seedJobRuns(days: string[]): Promise<void> {
  await t.db
    .insert(jobRuns)
    .values(days.map((day) => ({ job: 'home-stats' as const, startedAt: at(day) })));
}

async function seedNotificationSends(days: string[]): Promise<void> {
  await t.db.insert(notificationSends).values(
    days.map((day) => ({
      notificationId: 'review-submitted',
      recipientHash: 'h',
      tier: 'production',
      outcome: 'sent' as const,
      createdAt: at(day),
      updatedAt: at(day),
    })),
  );
}

async function seedDeliveryEvents(days: string[]): Promise<void> {
  await t.db.insert(notificationDeliveryEvents).values(
    days.map((day, i) => ({
      svixId: `msg_${day}_${i}`,
      providerMessageId: 'em_1',
      eventType: 'delivered' as const,
      notificationId: 'review-submitted',
      tier: 'production',
      recipientHash: 'h',
      occurredAt: at(day),
      createdAt: at(day),
    })),
  );
}

/** One `user_activity_daily` row per entry. Each needs a distinct `(user, day)`,
 *  so the user id carries the index. */
async function seedUserActivity(days: string[], offset = 0): Promise<void> {
  if (days.length === 0) return;
  await t.db.insert(userActivityDaily).values(
    days.map((day, i) => ({
      userId: `u-${offset + i}`,
      day,
      role: 'vendor_admin',
      firstSeenAt: at(day),
      lastSeenAt: at(day),
    })),
  );
}

/** One `metrics_daily` row per day — the gate only asks that a day was captured
 *  at all, not that all 20 keys landed (stocks are never backfilled). */
async function seedSnapshots(days: string[]): Promise<void> {
  if (days.length === 0) return;
  await t.db
    .insert(metricsDaily)
    .values(days.map((day) => ({ day, metric: 'page_views_total', value: 0 })));
}

/** Every day in `[from, to]` inclusive. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) out.push(day);
  return out;
}

/** `select count(*)` for a table, as a plain number. */
async function tally(
  table:
    | typeof pageViews
    | typeof jobRuns
    | typeof notificationSends
    | typeof notificationDeliveryEvents
    | typeof userActivityDaily,
): Promise<number> {
  const [row] = await t.db.select({ value: count() }).from(table);
  return row?.value ?? 0;
}

// ---------------------------------------------------------------------------

describe('cutoffFor', () => {
  it('snaps to a UTC midnight exactly N days back', () => {
    expect(cutoffFor(NOW, 400)).toEqual({
      day: '2026-06-27',
      iso: '2026-06-27T00:00:00.000Z',
    });
  });

  it('ignores the time of day, so a run at 03:00 and one at 23:59 cut the same day', () => {
    const early = cutoffFor(new Date('2027-08-01T00:00:01.000Z'), 90);
    const late = cutoffFor(new Date('2027-08-01T23:59:59.000Z'), 90);
    expect(early).toEqual(late);
  });
});

describe('resolveRetentionDays', () => {
  it('uses the reviewed default when unset or blank', () => {
    expect(resolveRetentionDays(undefined, 400)).toBe(400);
    expect(resolveRetentionDays('   ', 400)).toBe(400);
  });

  it('accepts a valid override', () => {
    expect(resolveRetentionDays('120', 400)).toBe(120);
  });

  it('IGNORES a below-floor override rather than clamping it — the direction that deletes nothing', () => {
    const onInvalid = vi.fn();
    expect(resolveRetentionDays('4', 400, onInvalid)).toBe(400);
    expect(onInvalid).toHaveBeenCalledWith(expect.stringContaining('30-day floor'));
  });

  it('ignores a non-integer override', () => {
    const onInvalid = vi.fn();
    expect(resolveRetentionDays('90.5', 400, onInvalid)).toBe(400);
    expect(resolveRetentionDays('soon', 400, onInvalid)).toBe(400);
    expect(onInvalid).toHaveBeenCalledTimes(2);
  });

  it('resolves both windows from env, independently', () => {
    expect(resolveRetentionWindows({})).toEqual(WINDOWS);
    expect(resolveRetentionWindows({ JOB_RUNS_RETENTION_DAYS: '45' })).toEqual({
      ...WINDOWS,
      job_runs: 45,
    });
    expect(resolveRetentionWindows({ NOTIFICATION_SENDS_RETENTION_DAYS: '60' })).toEqual({
      ...WINDOWS,
      notification_sends: 60,
    });
  });

  it('keeps user_activity_daily for 400 days, overridable with the same floor', () => {
    expect(USER_ACTIVITY_RETENTION_DAYS).toBe(400);
    expect(resolveRetentionWindows({ USER_ACTIVITY_RETENTION_DAYS: '90' })).toEqual({
      ...WINDOWS,
      user_activity_daily: 90,
    });
    const onInvalid = vi.fn();
    expect(resolveRetentionWindows({ USER_ACTIVITY_RETENTION_DAYS: '29' }, onInvalid)).toEqual(
      WINDOWS,
    );
    expect(onInvalid).toHaveBeenCalledWith('user_activity_daily', expect.stringContaining('floor'));
  });

  it('keeps notification_sends for 400 days, and reports a refused override by table', () => {
    expect(NOTIFICATION_SENDS_RETENTION_DAYS).toBe(400);
    const onInvalid = vi.fn();
    expect(resolveRetentionWindows({ NOTIFICATION_SENDS_RETENTION_DAYS: '7' }, onInvalid)).toEqual(
      WINDOWS,
    );
    expect(onInvalid).toHaveBeenCalledWith('notification_sends', expect.stringContaining('floor'));
  });

  it('keeps notification_delivery_events for 400 days, the ledger rule, with its own override', () => {
    expect(NOTIFICATION_DELIVERY_EVENTS_RETENTION_DAYS).toBe(400);
    expect(resolveRetentionWindows({ NOTIFICATION_DELIVERY_EVENTS_RETENTION_DAYS: '90' })).toEqual({
      ...WINDOWS,
      notification_delivery_events: 90,
    });
    const onInvalid = vi.fn();
    resolveRetentionWindows({ NOTIFICATION_DELIVERY_EVENTS_RETENTION_DAYS: '7' }, onInvalid);
    expect(onInvalid).toHaveBeenCalledWith(
      'notification_delivery_events',
      expect.stringContaining('floor'),
    );
  });
});

describe('runRetentionPrune', () => {
  it('deletes nothing and writes no audit row when everything is inside the windows', async () => {
    await seedPageViews([shiftDay(TODAY, -1), shiftDay(TODAY, -30)]);
    await seedJobRuns([shiftDay(TODAY, -1)]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result).toMatchObject({ status: 'pruned', rowsDeleted: 0 });
    expect(result.status === 'pruned' && result.auditEntry).toBeUndefined();
    expect(await tally(pageViews)).toBe(2);
    expect(await tally(jobRuns)).toBe(1);
    // No delete → no batch → no audit row. A no-op run has no fact to preserve,
    // and `audit_log` is kept indefinitely (§26.6).
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('reports every table at zero so the rows_deleted series stays continuous', async () => {
    const result = await runRetentionPrune(t.db, NOW, WINDOWS);
    expect(result.tables.map((x) => x.table)).toEqual([...PRUNABLE]);
    expect(result.tables.every((x) => x.rowsDeleted === 0)).toBe(true);
  });

  it('deletes page_views strictly older than the cutoff and keeps the boundary day', async () => {
    await seedSnapshots(daysBetween(shiftDay(PV_LAST_PRUNED_DAY, -2), PV_LAST_PRUNED_DAY));
    await seedPageViews([
      shiftDay(PV_LAST_PRUNED_DAY, -2),
      PV_LAST_PRUNED_DAY,
      PV_CUTOFF_DAY, // the first retained day — must survive
      TODAY,
    ]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result).toMatchObject({ status: 'pruned', rowsDeleted: 2 });
    const survivors = await t.db.select({ createdAt: pageViews.createdAt }).from(pageViews);
    expect(survivors.map((r) => r.createdAt.slice(0, 10)).sort()).toEqual([PV_CUTOFF_DAY, TODAY]);
  });

  it('prunes job_runs on its own 90-day window, with no snapshot dependency', async () => {
    await seedJobRuns([shiftDay(JR_CUTOFF_DAY, -1), JR_CUTOFF_DAY, TODAY]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.rowsDeleted).toBe(1);
    expect(await tally(jobRuns)).toBe(2);
    // No `metrics_daily` rows exist at all here, and that is fine: the gate is
    // about `page_views`, which has none either.
    expect(await t.db.select().from(metricsDaily)).toHaveLength(0);
  });

  it('prunes notification_sends on its own 400-day window and keeps the boundary day', async () => {
    await seedNotificationSends([shiftDay(NS_CUTOFF_DAY, -1), NS_CUTOFF_DAY, TODAY]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result).toMatchObject({ status: 'pruned', rowsDeleted: 1 });
    expect(result.tables.find((x) => x.table === 'notification_sends')).toMatchObject({
      cutoff: `${NS_CUTOFF_DAY}T00:00:00.000Z`,
      rowsDeleted: 1,
      truncated: false,
    });
    const survivors = await t.db
      .select({ createdAt: notificationSends.createdAt })
      .from(notificationSends);
    expect(survivors.map((r) => r.createdAt.slice(0, 10)).sort()).toEqual([NS_CUTOFF_DAY, TODAY]);
    // The deletion is recorded in the same batch, like the other tables.
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'retention.pruned'));
    expect(audit?.metadata).toEqual({
      rowsDeleted: 1,
      tables: [
        {
          table: 'notification_sends',
          cutoff: `${NS_CUTOFF_DAY}T00:00:00.000Z`,
          rowsDeleted: 1,
        },
      ],
    });
  });

  it('prunes notification_delivery_events on the ledger window (AECI-1222)', async () => {
    await seedDeliveryEvents([shiftDay(NS_CUTOFF_DAY, -1), NS_CUTOFF_DAY, TODAY]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.tables.find((x) => x.table === 'notification_delivery_events')).toMatchObject({
      cutoff: `${NS_CUTOFF_DAY}T00:00:00.000Z`,
      rowsDeleted: 1,
      truncated: false,
    });
    expect(await tally(notificationDeliveryEvents)).toBe(2);
  });

  it('chunks a notification_sends prune that spans several chunks', async () => {
    const day = shiftDay(NS_CUTOFF_DAY, -1);
    const rows = PRUNE_CHUNK_ROWS + 10;
    for (let i = 0; i < rows; i += 100) {
      await seedNotificationSends(Array.from({ length: Math.min(100, rows - i) }, () => day));
    }
    await seedNotificationSends([TODAY]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.rowsDeleted).toBe(rows);
    expect(await tally(notificationSends)).toBe(1);
  });

  it('a snapshot gap stops the notification_sends prune too', async () => {
    await seedPageViews([PV_LAST_PRUNED_DAY]);
    await seedSnapshots([]);
    await seedNotificationSends([shiftDay(NS_CUTOFF_DAY, -1)]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.status).toBe('skipped');
    expect(result.tables.map((x) => x.table)).toEqual([...PRUNABLE]);
    expect(await tally(notificationSends)).toBe(1);
  });

  // ── user_activity_daily: a day column and a rowid cursor (AECI-1208) ────

  it('prunes user_activity_daily days older than the cutoff and keeps the boundary day', async () => {
    await seedUserActivity([shiftDay(UA_CUTOFF_DAY, -30), shiftDay(UA_CUTOFF_DAY, -1)]);
    await seedUserActivity([UA_CUTOFF_DAY, TODAY], 10);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result).toMatchObject({ status: 'pruned', rowsDeleted: 2 });
    expect(result.tables.find((x) => x.table === 'user_activity_daily')).toMatchObject({
      cutoff: `${UA_CUTOFF_DAY}T00:00:00.000Z`,
      rowsDeleted: 2,
      truncated: false,
    });
    const survivors = await t.db.select({ day: userActivityDaily.day }).from(userActivityDaily);
    expect(survivors.map((r) => r.day).sort()).toEqual([UA_CUTOFF_DAY, TODAY]);
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'retention.pruned'));
    expect(audit?.metadata).toEqual({
      rowsDeleted: 2,
      tables: [
        { table: 'user_activity_daily', cutoff: `${UA_CUTOFF_DAY}T00:00:00.000Z`, rowsDeleted: 2 },
      ],
    });
  });

  it('chunks a user_activity_daily prune by rowid, counting exactly', async () => {
    const day = shiftDay(UA_CUTOFF_DAY, -1);
    const rows = PRUNE_CHUNK_ROWS + 25;
    for (let i = 0; i < rows; i += 100) {
      await seedUserActivity(
        Array.from({ length: Math.min(100, rows - i) }, () => day),
        i,
      );
    }
    await seedUserActivity([TODAY], rows);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.rowsDeleted).toBe(rows);
    expect(await tally(userActivityDaily)).toBe(1);
  });

  it('stops user_activity_daily at the per-table budget and reports truncated', async () => {
    const day = shiftDay(UA_CUTOFF_DAY, -1);
    const rows = PRUNE_CHUNK_ROWS * MAX_CHUNKS_PER_TABLE + 1;
    for (let i = 0; i < rows; i += 500) {
      await seedUserActivity(
        Array.from({ length: Math.min(500, rows - i) }, () => day),
        i,
      );
    }

    const first = await runRetentionPrune(t.db, NOW, WINDOWS);
    expect(first.tables.find((x) => x.table === 'user_activity_daily')).toMatchObject({
      rowsDeleted: PRUNE_CHUNK_ROWS * MAX_CHUNKS_PER_TABLE,
      truncated: true,
    });
    expect(await tally(userActivityDaily)).toBe(1);
  });

  it('a snapshot gap stops the user_activity_daily prune too', async () => {
    await seedPageViews([PV_LAST_PRUNED_DAY]);
    await seedSnapshots([]);
    await seedUserActivity([shiftDay(UA_CUTOFF_DAY, -1)]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.status).toBe('skipped');
    expect(await tally(userActivityDaily)).toBe(1);
  });

  // ── §7.4 rule 2: the gate ────────────────────────────────────────────────

  it('REFUSES to prune when a day inside the cut window has no metrics_daily row', async () => {
    const window = daysBetween(shiftDay(PV_LAST_PRUNED_DAY, -3), PV_LAST_PRUNED_DAY);
    await seedPageViews(window);
    // Capture every day but one.
    await seedSnapshots(window.filter((d) => d !== window[1]));

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'metrics_daily_gap',
      rowsDeleted: 0,
      missingCount: 1,
      missingDays: [window[1]],
      window: { fromDay: window[0], toDay: PV_LAST_PRUNED_DAY },
    });
    expect(await tally(pageViews)).toBe(window.length);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('a snapshot gap stops the job_runs prune too — the whole run, not half of it', async () => {
    const window = daysBetween(shiftDay(PV_LAST_PRUNED_DAY, -1), PV_LAST_PRUNED_DAY);
    await seedPageViews(window);
    await seedSnapshots([]); // nothing captured
    await seedJobRuns([shiftDay(JR_CUTOFF_DAY, -1)]); // squarely prunable on its own

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.status).toBe('skipped');
    expect(await tally(jobRuns)).toBe(1);
  });

  it('accepts a day captured by a SINGLE metrics_daily row — stocks are never backfilled', async () => {
    await seedPageViews([PV_LAST_PRUNED_DAY]);
    await seedSnapshots([PV_LAST_PRUNED_DAY]); // one row, not all 20 keys

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result).toMatchObject({ status: 'pruned', rowsDeleted: 1 });
  });

  it('caps the reported missing days but not the count', async () => {
    const window = daysBetween(shiftDay(PV_LAST_PRUNED_DAY, -19), PV_LAST_PRUNED_DAY);
    await seedPageViews([window[0] as string]);
    await seedSnapshots([]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.status).toBe('skipped');
    if (result.status !== 'skipped') throw new Error('unreachable');
    expect(result.missingCount).toBe(window.length);
    expect(result.missingDays).toHaveLength(10);
  });

  // ── §7.4 rule 3: hard exclusions ─────────────────────────────────────────

  it('never touches metrics_daily, audit_log, workflow_instances or workflow_transitions', async () => {
    // Every one of these is older than BOTH cutoffs, so surviving means the
    // prune rejected them — not that there was nothing old enough to delete.
    const ancient = '2025-01-01';
    await seedSnapshots(daysBetween(shiftDay(PV_LAST_PRUNED_DAY, -1), PV_LAST_PRUNED_DAY));
    await seedSnapshots([ancient]);
    await seedPageViews([shiftDay(PV_LAST_PRUNED_DAY, -1), PV_LAST_PRUNED_DAY]);
    await seedJobRuns([shiftDay(JR_CUTOFF_DAY, -1)]);
    await t.db
      .insert(auditLog)
      .values({ actorType: 'system', action: 'seed.old', createdAt: at(ancient) });
    await t.db.insert(workflowInstances).values({
      id: 'wf-1',
      workflowType: 'vendor_claim',
      entityId: 'e-1',
      currentState: 'open',
      initiatedAt: at(ancient),
    });
    await t.db
      .insert(workflowTransitions)
      .values({ workflowId: 'wf-1', toState: 'open', createdAt: at(ancient) });

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);
    expect(result.rowsDeleted).toBe(3);

    expect(await t.db.select().from(metricsDaily)).toHaveLength(3);
    expect(await t.db.select().from(workflowInstances)).toHaveLength(1);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);
    // `audit_log` gained the run's own summary row and lost nothing.
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(2);
    expect(audits.filter((a) => a.action === 'seed.old')).toHaveLength(1);
  });

  it('keeps vendor_activity_daily indefinitely — it is not prunable (AECI-1210)', async () => {
    expect(PRUNABLE as readonly string[]).not.toContain('vendor_activity_daily');
    await seedSnapshots(daysBetween(shiftDay(PV_LAST_PRUNED_DAY, -1), PV_LAST_PRUNED_DAY));
    await t.db.insert(vendorActivityDaily).values({
      day: '2025-01-01',
      vendorId: 'v-acme',
      seats: 1,
      pendingInvites: 0,
      activeUsers1d: 0,
      activeUsers7d: 0,
      activeUsers30d: 0,
      effectiveTier: 'unclaimed',
      openContestsOwned: 0,
      openContestsFiled: 0,
      dataFlowsConfirmed: 0,
      productsTotal: 0,
      productsConfirmed: 0,
      computedAt: at('2025-01-02'),
    });

    await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(await t.db.select().from(vendorActivityDaily)).toHaveLength(1);
  });

  it('keeps recrawl_submissions forever — it is not prunable (AECI-1183)', async () => {
    // The search-engine submission log is evidence a vendor reads. ADR 0022's
    // 2026-10-04 amendment exempts it from the audit invariant only on the
    // condition that it is never deleted, so it must never join PRUNABLE.
    expect(PRUNABLE as readonly string[]).not.toContain('recrawl_submissions');
    await seedSnapshots(daysBetween(shiftDay(PV_LAST_PRUNED_DAY, -1), PV_LAST_PRUNED_DAY));
    await t.db.insert(recrawlSubmissions).values({
      url: 'https://www.aecintegrations.com/products/revit',
      channel: 'indexnow',
      outcome: 'accepted',
      httpStatus: 200,
      batchId: 'b-ancient',
      priority: 1,
      submittedAt: at('2025-01-01'),
    });

    await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(await t.db.select().from(recrawlSubmissions)).toHaveLength(1);
  });

  // ── §7.4 rule 4: exactly one summary audit row ───────────────────────────

  it('emits exactly ONE retention.pruned row for a multi-day, multi-table run', async () => {
    const window = daysBetween(shiftDay(PV_LAST_PRUNED_DAY, -4), PV_LAST_PRUNED_DAY);
    await seedSnapshots(window);
    await seedPageViews(window);
    await seedJobRuns([shiftDay(JR_CUTOFF_DAY, -2), shiftDay(JR_CUTOFF_DAY, -1)]);

    const before = { pv: await tally(pageViews), jr: await tally(jobRuns) };
    const result = await runRetentionPrune(t.db, NOW, WINDOWS);
    const actuallyDeleted =
      before.pv - (await tally(pageViews)) + (before.jr - (await tally(jobRuns)));

    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'retention.pruned'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'system', entityType: 'retention' });
    // `rowsDeleted` matches what the tables actually lost, not what we planned.
    expect(rows[0]?.metadata).toEqual({
      rowsDeleted: actuallyDeleted,
      tables: [
        { table: 'page_views', cutoff: `${PV_CUTOFF_DAY}T00:00:00.000Z`, rowsDeleted: 5 },
        { table: 'job_runs', cutoff: `${JR_CUTOFF_DAY}T00:00:00.000Z`, rowsDeleted: 2 },
      ],
    });
    expect(result.rowsDeleted).toBe(actuallyDeleted);
  });

  it('omits a table that deleted nothing from the audit metadata', async () => {
    await seedJobRuns([shiftDay(JR_CUTOFF_DAY, -1)]);
    await runRetentionPrune(t.db, NOW, WINDOWS);

    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'retention.pruned'));
    expect((row?.metadata as { tables: { table: string }[] }).tables.map((x) => x.table)).toEqual([
      'job_runs',
    ]);
  });

  // ── §7.4 rule 1: chunking + the run budget ───────────────────────────────

  it('chunks the deletes and finishes a window that spans several chunks', async () => {
    const day = PV_LAST_PRUNED_DAY;
    await seedSnapshots([day]);
    const rows = PRUNE_CHUNK_ROWS * 2 + 50;
    // Seed in slices: a single multi-VALUES insert of 1,050 rows exceeds
    // SQLite's bound-parameter limit in the harness.
    for (let i = 0; i < rows; i += 200) {
      await t.db.insert(pageViews).values(
        Array.from({ length: Math.min(200, rows - i) }, () => ({
          path: '/x',
          createdAt: at(day),
        })),
      );
    }
    await seedPageViews([TODAY]);

    const result = await runRetentionPrune(t.db, NOW, WINDOWS);

    expect(result.rowsDeleted).toBe(rows);
    expect(result.tables[0]).toMatchObject({ table: 'page_views', truncated: false });
    expect(await tally(pageViews)).toBe(1);
  });

  it('stops at the per-table budget, reports truncated, and the next run finishes the job', async () => {
    const day = PV_LAST_PRUNED_DAY;
    await seedSnapshots([day]);
    // One row past what a single run may delete.
    const rows = PRUNE_CHUNK_ROWS * MAX_CHUNKS_PER_TABLE + 1;
    for (let i = 0; i < rows; i += 500) {
      await t.db.insert(pageViews).values(
        Array.from({ length: Math.min(500, rows - i) }, () => ({
          path: '/x',
          createdAt: at(day),
        })),
      );
    }

    const first = await runRetentionPrune(t.db, NOW, WINDOWS);
    expect(first.rowsDeleted).toBe(PRUNE_CHUNK_ROWS * MAX_CHUNKS_PER_TABLE);
    expect(first.tables[0]).toMatchObject({ truncated: true });
    expect(await tally(pageViews)).toBe(1);

    const second = await runRetentionPrune(t.db, NOW, WINDOWS);
    expect(second).toMatchObject({ rowsDeleted: 1 });
    expect(await tally(pageViews)).toBe(0);
    // Two runs that deleted → two summary rows. One per RUN, not one per chunk.
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'retention.pruned')),
    ).toHaveLength(2);
  });

  it('honours a shortened window from configuration without a schema change', async () => {
    await seedSnapshots(daysBetween(shiftDay(TODAY, -40), TODAY));
    await seedPageViews([shiftDay(TODAY, -40), shiftDay(TODAY, -20)]);

    const result = await runRetentionPrune(t.db, NOW, {
      page_views: 30,
      job_runs: 30,
      notification_sends: 30,
      notification_delivery_events: 30,
      user_activity_daily: 30,
    });

    expect(result.rowsDeleted).toBe(1);
    expect(await tally(pageViews)).toBe(1);
  });
});

describe('emitRetentionPruneMetrics', () => {
  const sink = () => {
    const counts: Array<[string, number, string[]]> = [];
    const distributions: Array<[string, number, string[]]> = [];
    return {
      counts,
      distributions,
      count: (m: string, v: number, tags: string[]) => counts.push([m, v, tags]),
      distribution: (m: string, v: number, tags: string[]) => distributions.push([m, v, tags]),
    };
  };

  it('emits rows_deleted for every table even at zero, so a threshold monitor is possible', () => {
    const s = sink();
    const result: RetentionPruneResult = {
      status: 'pruned',
      rowsDeleted: 0,
      tables: [
        { table: 'page_views', cutoff: 'x', rowsDeleted: 0, truncated: false },
        { table: 'job_runs', cutoff: 'y', rowsDeleted: 0, truncated: false },
      ],
    };
    emitRetentionPruneMetrics(s, result, 12);
    expect(s.counts.filter(([m]) => m === 'aeci.retention.rows_deleted')).toHaveLength(2);
    expect(s.counts).toContainEqual(['aeci.retention.prune', 1, ['trigger:cron', 'outcome:ok']]);
    expect(s.distributions).toContainEqual([
      'aeci.retention.prune.duration_ms',
      12,
      ['trigger:cron'],
    ]);
  });

  it('tags a skipped run with its reason', () => {
    const s = sink();
    emitRetentionPruneMetrics(
      s,
      {
        status: 'skipped',
        reason: 'metrics_daily_gap',
        window: { fromDay: 'a', toDay: 'b' },
        missingCount: 1,
        missingDays: ['a'],
        tables: [],
        rowsDeleted: 0,
      },
      3,
    );
    expect(s.counts).toContainEqual([
      'aeci.retention.prune',
      1,
      ['trigger:cron', 'outcome:skipped', 'reason:metrics_daily_gap'],
    ]);
  });
});
