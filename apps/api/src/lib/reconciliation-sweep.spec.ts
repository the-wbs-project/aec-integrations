/**
 * Unit tests for the request→Linear reconciliation sweep (AECI-214 / Phase 6.7)
 * on the Drizzle/D1 path (ADR 0016 / AECI-253), against the in-memory D1 harness.
 * Real `vendor_requests` / `products` / `vendors` / `workflow_instances` rows are
 * seeded so the stuck-query, target resolution, and the still-failing re-read run
 * over real SQL. The §6.4 retrier (`createLinearIssueForRequest`) and the §6.2
 * admin-alert seam (`sendAdminAlert`) are injected as deps so these drive the
 * sweep's logic — a stuck row is retried; a success clears it; a persistent failure
 * alerts + emails — without a real Linear/email transport. A "cleared" outcome is
 * modeled by the `createIssue` fake actually writing `linear_issue_id` onto the
 * seeded row (exactly how the real compare-and-set persist makes a swept row drop
 * out of the still-failing set); a "failing" outcome is modeled by a no-op fake.
 * Only `../datadog` is mocked (so metric + log calls are observable).
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitGauge: vi.fn(),
  submitDistribution: vi.fn(),
}));

import { products, vendorRequests, vendors, workflowInstances } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { logToPosthog, submitCount, submitGauge } from '../posthog';
import {
  ALERT_BANDS_MINUTES,
  ALERT_REPEAT_MINUTES,
  crossedAlertBand,
  RECONCILE_BATCH_CAP,
  RECONCILE_SWEEP_INTERVAL_MINUTES,
  runReconciliationSweep,
} from './reconciliation-sweep';
import { RECONCILE_CRON } from './cron-schedules';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-13T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
});
afterEach(() => t.dispose());

function makeCtx() {
  return {
    env: { ...TEST_ENV },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://api.test/cron/reconcile') },
  };
}

/** Insert a stuck (`open` / `linear_issue_id = null`) vendor_request row. */
async function seedStuckRequest(
  over: Partial<typeof vendorRequests.$inferInsert> & { id: string },
) {
  await t.db.insert(vendorRequests).values({
    kind: 'correction',
    targetType: 'product',
    targetId: 'tgt-1',
    submitterEmail: 'reporter@example.com',
    domainMatch: 'pending',
    body: 'The founding year is wrong.',
    status: 'open',
    createdAt: minsAgo(90),
    ...over,
  });
}

/** Seed a product target (resolved via `name`). */
async function seedProductTarget(id: string, name: string, slug: string) {
  await t.db.insert(products).values({ id, slug, name });
}
/** Seed a vendor target (resolved via `company_name`). */
async function seedVendorTarget(id: string, companyName: string, slug: string) {
  await t.db.insert(vendors).values({ id, slug, companyName });
}

/** Seed the request's workflow instance (resolved by `entity_id`). */
async function seedWorkflow(id: string, entityId: string) {
  await t.db.insert(workflowInstances).values({
    id,
    workflowType: 'correction_request',
    entityId,
    currentState: 'open',
  });
}

/**
 * A retrier that links the request — models a successful §6.4 create by writing
 * `linear_issue_id` onto the real seeded row, so the sweep's still-failing re-read
 * (a real SQL query) sees it drop out of the failing set.
 */
function linkingCreateIssue() {
  return vi.fn(async (_c: unknown, _store: unknown, input: { requestId: string }) => {
    await t.db
      .update(vendorRequests)
      .set({ linearIssueId: `iss-${input.requestId}` })
      .where(eq(vendorRequests.id, input.requestId));
  });
}
/** A retrier that never links (models a persistent Linear failure). */
function failingCreateIssue() {
  return vi.fn(async () => {});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runReconciliationSweep', () => {
  it('sends the claim operator alert when the sweep is what finally created the issue (AECI-861)', async () => {
    // Before this, a claim rescued here notified nobody: the submit-time alert had
    // already gone out with no issue link, and the successful retry was silent.
    await seedProductTarget('tgt-1', 'Procore', 'procore');
    await seedWorkflow('wf-1', 'req-1');
    await seedStuckRequest({
      id: 'req-1',
      kind: 'claim',
      targetId: 'tgt-1',
      createdAt: minsAgo(30),
    });
    const sendClaimAlert = vi.fn(async () => 'sent' as const);
    const createIssue = vi.fn(async (_c: unknown, _s: unknown, input: { requestId: string }) => {
      await t.db
        .update(vendorRequests)
        .set({ linearIssueId: `iss-${input.requestId}` })
        .where(eq(vendorRequests.id, input.requestId));
      return {
        status: 'created' as const,
        issueId: 'iss-req-1',
        issueUrl: 'https://linear.app/aec/issue/AECI-901/claim',
      };
    });

    await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: vi.fn(async () => 'skipped' as const) as never,
      sendClaimAlert: sendClaimAlert as never,
      now: NOW,
    });

    expect(sendClaimAlert).toHaveBeenCalledOnce();
    const [, payload] = sendClaimAlert.mock.calls[0] as unknown as [
      unknown,
      { requestId: string; linearIssueUrl: string | null; targetName: string },
    ];
    expect(payload).toMatchObject({
      requestId: 'req-1',
      targetName: 'Procore',
      linearIssueUrl: 'https://linear.app/aec/issue/AECI-901/claim',
    });
  });

  it('does NOT send the claim alert for a recovered CORRECTION', async () => {
    // Same scope rule as the submit path: `NOTIFIED_REQUEST_KINDS` is claims only.
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    await seedWorkflow('wf-1', 'req-1');
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(30) });
    const sendClaimAlert = vi.fn(async () => 'sent' as const);
    const createIssue = vi.fn(async (_c: unknown, _s: unknown, input: { requestId: string }) => {
      await t.db
        .update(vendorRequests)
        .set({ linearIssueId: `iss-${input.requestId}` })
        .where(eq(vendorRequests.id, input.requestId));
      return { status: 'created' as const, issueId: 'i', issueUrl: 'https://linear.app/x' };
    });

    await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: vi.fn(async () => 'skipped' as const) as never,
      sendClaimAlert: sendClaimAlert as never,
      now: NOW,
    });

    expect(sendClaimAlert).not.toHaveBeenCalled();
  });

  it('does NOT send the claim alert when the retry failed again', async () => {
    await seedProductTarget('tgt-1', 'Procore', 'procore');
    await seedWorkflow('wf-1', 'req-1');
    await seedStuckRequest({
      id: 'req-1',
      kind: 'claim',
      targetId: 'tgt-1',
      createdAt: minsAgo(30),
    });
    const sendClaimAlert = vi.fn(async () => 'sent' as const);

    await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: vi.fn(async () => ({
        status: 'failed' as const,
        reason: 'no_api_key' as const,
      })) as never,
      sendAlert: vi.fn(async () => 'skipped' as const) as never,
      sendClaimAlert: sendClaimAlert as never,
      now: NOW,
    });

    expect(sendClaimAlert).not.toHaveBeenCalled();
  });

  it('retries a stuck row with the rebuilt §6.4 input and clears it on success', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    await seedWorkflow('wf-1', 'req-1');
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(30) });
    const createIssue = linkingCreateIssue();
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        requestId: 'req-1',
        workflowId: 'wf-1',
        kind: 'correction',
        targetType: 'product',
        targetName: 'Acme Build',
        slug: 'acme-build',
      }),
    );
    expect(result).toMatchObject({
      stuck: 1,
      retried: 1,
      cleared: 1,
      stillFailing: 0,
      persistent: 0,
      alerted: false,
    });
    expect(submitGauge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.stuck',
      1,
      [],
    );
    expect(submitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.attempt',
      1,
      ['outcome:cleared'],
    );
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('resolves a vendor target via company_name', async () => {
    await seedVendorTarget('v-1', 'Globex Inc', 'globex');
    await seedWorkflow('wf-2', 'req-2');
    await seedStuckRequest({
      id: 'req-2',
      kind: 'claim',
      targetType: 'vendor',
      targetId: 'v-1',
      createdAt: minsAgo(30),
    });
    const createIssue = linkingCreateIssue();

    await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: vi.fn(async () => 'skipped' as const) as never,
      now: NOW,
    });

    expect(createIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ targetType: 'vendor', targetName: 'Globex Inc', slug: 'globex' }),
    );
  });

  it('alerts + emails when a failing row is older than the persistent threshold', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    await seedWorkflow('wf-1', 'req-1');
    // 65m: past the 60m persistent threshold AND crossing the AECI-854 60m alert
    // band in this sweep's 15-minute window (previous age 50m), so the email fires.
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(65) });
    const createIssue = failingCreateIssue();
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toMatchObject({
      stuck: 1,
      retried: 1,
      cleared: 0,
      stillFailing: 1,
      persistent: 1,
      alerted: true,
    });
    expect(submitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.attempt',
      1,
      ['outcome:still_failing'],
    );
    expect(submitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.persistent_failure',
      1,
      [],
    );
    expect(logToPosthog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('persistent_failure'),
      }),
    );
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'stuck_requests',
        rows: [expect.objectContaining({ requestId: 'req-1', targetName: 'Acme Build' })],
      }),
    );
  });

  it('retries a recently-stuck failing row but does NOT alert before the persistent threshold', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    await seedWorkflow('wf-1', 'req-1');
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(30) }); // 15 < 30 < 60
    const createIssue = failingCreateIssue();
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      stuck: 1,
      retried: 1,
      cleared: 0,
      stillFailing: 1,
      persistent: 0,
      alerted: false,
    });
    expect(submitCount).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.persistent_failure',
      expect.anything(),
      expect.anything(),
    );
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('emits a 0 backlog gauge and does nothing on a clean run (no stuck rows)', async () => {
    const createIssue = vi.fn();
    const sendAlert = vi.fn();

    const result = await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toMatchObject({ stuck: 0, retried: 0, alerted: false });
    expect(submitGauge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.stuck',
      0,
      [],
    );
    expect(createIssue).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('reports the true backlog on the stuck gauge when more rows are stuck than the batch cap', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    const total = RECONCILE_BATCH_CAP + 5;
    for (let i = 0; i < total; i++) {
      await seedWorkflow(`wf-req-${i}`, `req-${i}`);
      await seedStuckRequest({ id: `req-${i}`, targetId: 'tgt-1', createdAt: minsAgo(30) });
    }
    const createIssue = linkingCreateIssue();

    const result = await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: vi.fn(async () => 'skipped' as const) as never,
      now: NOW,
    });

    // Gauge + result report the full backlog, not the clamped batch.
    expect(submitGauge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.stuck',
      total,
      [],
    );
    expect(result.stuck).toBe(total);
    // Only the cap's worth is processed this sweep; the next tick continues.
    expect(createIssue).toHaveBeenCalledTimes(RECONCILE_BATCH_CAP);
    expect(logToPosthog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('cap') }),
    );
  });

  it('skips an un-rebuildable row (missing workflow) and still counts it as failing/persistent', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    // No workflow instance seeded → cannot rebuild the §6.4 input.
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(65) });
    const createIssue = failingCreateIssue();
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(createIssue).not.toHaveBeenCalled(); // skipped before the retry
    expect(result).toMatchObject({
      stuck: 1,
      retried: 0,
      stillFailing: 1,
      persistent: 1,
      alerted: true,
    });
    expect(logToPosthog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('cannot rebuild'),
      }),
    );
    expect(sendAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rows: [expect.objectContaining({ requestId: 'req-1', targetName: 'Acme Build' })],
      }),
    );
  });
});

// ─── AECI-854: the email throttle ─────────────────────────────────────────────

describe('crossedAlertBand', () => {
  const SWEEP = RECONCILE_SWEEP_INTERVAL_MINUTES;

  it('fires on the sweep that crosses 60m, and not on the ones around it', () => {
    expect(crossedAlertBand(59, SWEEP)).toBe(false); // not yet persistent
    expect(crossedAlertBand(62, SWEEP)).toBe(true); // the observed first alert
    expect(crossedAlertBand(75, SWEEP)).toBe(false); // next sweep, already reported
    expect(crossedAlertBand(90, SWEEP)).toBe(false);
  });

  it('fires again at the 6h band', () => {
    expect(crossedAlertBand(345, SWEEP)).toBe(false);
    expect(crossedAlertBand(362, SWEEP)).toBe(true);
    expect(crossedAlertBand(375, SWEEP)).toBe(false);
  });

  it('then repeats daily, not per sweep', () => {
    expect(crossedAlertBand(ALERT_REPEAT_MINUTES + 5, SWEEP)).toBe(true);
    expect(crossedAlertBand(ALERT_REPEAT_MINUTES + 20, SWEEP)).toBe(false);
    expect(crossedAlertBand(2 * ALERT_REPEAT_MINUTES + 5, SWEEP)).toBe(true);
  });

  it('sends a bounded number of emails over a week, not one per sweep', () => {
    // The regression this exists to prevent: 96 sweeps a day x 7 days = 672 emails
    // for a single stuck row, against a Resend account shared with the Supabase
    // magic-link sender (docs/email.md).
    const sweepsPerWeek = (7 * 24 * 60) / RECONCILE_SWEEP_INTERVAL_MINUTES;
    let emails = 0;
    for (let i = 1; i <= sweepsPerWeek; i++) {
      if (
        crossedAlertBand(i * RECONCILE_SWEEP_INTERVAL_MINUTES, RECONCILE_SWEEP_INTERVAL_MINUTES)
      ) {
        emails++;
      }
    }
    // 60m + 6h, then one per day: 1440, 2880 … 10080 inclusive = 7 more.
    const dailyRepeats = (7 * 24 * 60) / ALERT_REPEAT_MINUTES;
    expect(sweepsPerWeek).toBe(672);
    expect(emails).toBe(ALERT_BANDS_MINUTES.length + dailyRepeats);
    expect(emails).toBe(9);
  });

  it('is computed from the real cron cadence', () => {
    // The throttle tiles the timeline with windows of exactly one sweep interval.
    // If the cron changes and this constant does not, rows either double-send or
    // skip a band entirely, silently. Nothing else couples the two.
    const everyNMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(RECONCILE_CRON);
    expect(everyNMinutes).not.toBeNull();
    expect(Number(everyNMinutes?.[1])).toBe(RECONCILE_SWEEP_INTERVAL_MINUTES);
  });
});

describe('runReconciliationSweep — AECI-854 alert throttle and cause reporting', () => {
  it('suppresses the email between bands but never the metric or the error log', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    await seedWorkflow('wf-1', 'req-1');
    // 90m: persistent, but its 60m email already went out two sweeps ago.
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(90) });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: failingCreateIssue() as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toMatchObject({ persistent: 1, alerted: false });
    expect(sendAlert).not.toHaveBeenCalled();
    // The §6.2 guaranteed backstop is untouched — this is the whole safety argument
    // for throttling the email at all.
    expect(submitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.persistent_failure',
      1,
      [],
    );
    expect(logToPosthog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'error', request_ids: ['req-1'] }),
    );
  });

  it('carries the retrier failure reason into the alert', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    await seedWorkflow('wf-1', 'req-1');
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(65) });
    const sendAlert = vi.fn(async () => 'sent' as const);
    // The exact shape the absent-key path returns — the cause that was invisible
    // in both the email and PostHog before AECI-854 (AECI-851).
    const createIssue = vi.fn(async () => ({ status: 'failed', reason: 'no_api_key' }) as const);

    await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: createIssue as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(sendAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'stuck_requests',
        rows: [
          expect.objectContaining({
            requestId: 'req-1',
            reason: 'no_api_key',
            retried: true,
            targetSlug: 'acme-build',
          }),
        ],
      }),
    );
  });

  it('reports an un-rebuildable row as NOT retried, with the blocker as the reason', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    // No workflow instance → the sweep skips before any retry.
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(65) });
    const sendAlert = vi.fn(async () => 'sent' as const);

    await runReconciliationSweep(makeCtx(), t.db, {
      createIssue: failingCreateIssue() as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(sendAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rows: [expect.objectContaining({ retried: false, reason: 'workflow_missing' })],
      }),
    );
  });
});
