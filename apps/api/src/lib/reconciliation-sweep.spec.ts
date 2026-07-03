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

vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitGauge: vi.fn(),
  submitDistribution: vi.fn(),
}));

import { products, vendorRequests, vendors, workflowInstances } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { logToDatadog, submitCount, submitGauge } from '../datadog';
import { RECONCILE_BATCH_CAP, runReconciliationSweep } from './reconciliation-sweep';

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
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(90) }); // > 60m
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
    expect(logToDatadog).toHaveBeenCalledWith(
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
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('cap') }),
    );
  });

  it('skips an un-rebuildable row (missing workflow) and still counts it as failing/persistent', async () => {
    await seedProductTarget('tgt-1', 'Acme Build', 'acme-build');
    // No workflow instance seeded → cannot rebuild the §6.4 input.
    await seedStuckRequest({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(90) });
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
    expect(logToDatadog).toHaveBeenCalledWith(
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
