/**
 * Unit tests for the request→Linear reconciliation sweep (AECI-214 / Phase 6.7).
 * The §6.4 retrier (`createLinearIssueForRequest`) and the §6.2 admin-alert seam
 * (`sendAdminAlert`) are injected as deps so these drive the sweep's logic — a
 * stuck row is retried; a success clears it; a persistent failure alerts + emails
 * — without a real Linear/email transport. Only `../datadog` is mocked (so metric
 * + log calls are observable).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitGauge: vi.fn(),
  submitDistribution: vi.fn(),
}));

import { logToDatadog, submitCount, submitGauge } from '../datadog';
import {
  RECONCILE_BATCH_CAP,
  runReconciliationSweep,
  type ReconcilePrisma,
} from './reconciliation-sweep';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-13T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function makeCtx() {
  return {
    env: { ...TEST_ENV },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://api.test/cron/reconcile') },
  };
}

type Row = {
  id: string;
  kind: 'claim' | 'correction';
  targetType: 'product' | 'vendor';
  targetId: string;
  submitterEmail: string;
  submitterName: string | null;
  submitterRole: string | null;
  body: string;
  sourceUrl: string | null;
  domainMatch: string;
  createdAt: Date;
};

function stuckRow(over: Partial<Row> = {}): Row {
  return {
    id: 'req-1',
    kind: 'correction',
    targetType: 'product',
    targetId: 'tgt-1',
    submitterEmail: 'reporter@example.com',
    submitterName: null,
    submitterRole: null,
    body: 'The founding year is wrong.',
    sourceUrl: null,
    domainMatch: 'pending',
    createdAt: minsAgo(90),
    ...over,
  };
}

/**
 * In-memory Prisma fake. `linkedIds` models "this request now has a Linear issue":
 * the injected `createIssue` adds to it on a successful retry, and the re-read
 * query returns only rows NOT in it — exactly how the real compare-and-set persist
 * makes a swept row drop out of the still-failing set.
 */
function makePrisma(opts: {
  rows: Row[];
  targets?: Record<string, { name: string; slug: string } | undefined>;
  workflows?: Record<string, string | undefined>;
}) {
  const linkedIds = new Set<string>();
  const targets = opts.targets ?? {};
  const workflows = opts.workflows ?? {};
  const client = {
    vendorRequest: {
      async findMany(args: { where: Record<string, unknown>; take?: number }) {
        const where = args.where as { id?: { in?: string[] } };
        if (where.id && typeof where.id === 'object' && Array.isArray(where.id.in)) {
          const ids = where.id.in;
          return opts.rows
            .filter((r) => ids.includes(r.id) && !linkedIds.has(r.id))
            .map((r) => ({ id: r.id }));
        }
        // Initial stuck query — honor `take` so the batch cap is observable.
        return typeof args.take === 'number' ? opts.rows.slice(0, args.take) : opts.rows;
      },
      // Unbounded backlog count for the stuck gauge (every fixture row is stuck).
      async count() {
        return opts.rows.length;
      },
    },
    product: {
      async findUnique(args: { where: { id: string } }) {
        const t = targets[args.where.id];
        return t ? { name: t.name, slug: t.slug } : null;
      },
    },
    vendor: {
      async findUnique(args: { where: { id: string } }) {
        const t = targets[args.where.id];
        return t ? { companyName: t.name, slug: t.slug } : null;
      },
    },
    workflowInstance: {
      async findFirst(args: { where: { entityId: string } }) {
        const id = workflows[args.where.entityId];
        return id ? { id } : null;
      },
    },
  } as unknown as ReconcilePrisma;
  return { client, linkedIds };
}

/** A retrier that links the request (models a successful §6.4 create). */
function linkingCreateIssue(linkedIds: Set<string>) {
  return vi.fn(async (_c: unknown, _p: unknown, input: { requestId: string }) => {
    linkedIds.add(input.requestId);
  });
}
/** A retrier that never links (models a persistent Linear failure). */
function failingCreateIssue() {
  return vi.fn(async () => {});
}

beforeEach(() => vi.clearAllMocks());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runReconciliationSweep', () => {
  it('retries a stuck row with the rebuilt §6.4 input and clears it on success', async () => {
    const row = stuckRow({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(30) });
    const { client, linkedIds } = makePrisma({
      rows: [row],
      targets: { 'tgt-1': { name: 'Acme Build', slug: 'acme-build' } },
      workflows: { 'req-1': 'wf-1' },
    });
    const createIssue = linkingCreateIssue(linkedIds);
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runReconciliationSweep(makeCtx(), client, {
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
    const row = stuckRow({
      id: 'req-2',
      kind: 'claim',
      targetType: 'vendor',
      targetId: 'v-1',
      createdAt: minsAgo(30),
    });
    const { client, linkedIds } = makePrisma({
      rows: [row],
      targets: { 'v-1': { name: 'Globex Inc', slug: 'globex' } },
      workflows: { 'req-2': 'wf-2' },
    });
    const createIssue = linkingCreateIssue(linkedIds);

    await runReconciliationSweep(makeCtx(), client, {
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
    const row = stuckRow({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(90) }); // > 60m
    const { client } = makePrisma({
      rows: [row],
      targets: { 'tgt-1': { name: 'Acme Build', slug: 'acme-build' } },
      workflows: { 'req-1': 'wf-1' },
    });
    const createIssue = failingCreateIssue();
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runReconciliationSweep(makeCtx(), client, {
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
    const row = stuckRow({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(30) }); // 15 < 30 < 60
    const { client } = makePrisma({
      rows: [row],
      targets: { 'tgt-1': { name: 'Acme Build', slug: 'acme-build' } },
      workflows: { 'req-1': 'wf-1' },
    });
    const createIssue = failingCreateIssue();
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runReconciliationSweep(makeCtx(), client, {
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
    const { client } = makePrisma({ rows: [] });
    const createIssue = vi.fn();
    const sendAlert = vi.fn();

    const result = await runReconciliationSweep(makeCtx(), client, {
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
    const rows = Array.from({ length: RECONCILE_BATCH_CAP + 5 }, (_, i) =>
      stuckRow({ id: `req-${i}`, targetId: 'tgt-1', createdAt: minsAgo(30) }),
    );
    const { client, linkedIds } = makePrisma({
      rows,
      targets: { 'tgt-1': { name: 'Acme Build', slug: 'acme-build' } },
      workflows: Object.fromEntries(rows.map((r) => [r.id, `wf-${r.id}`])),
    });
    const createIssue = linkingCreateIssue(linkedIds);

    const result = await runReconciliationSweep(makeCtx(), client, {
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
      RECONCILE_BATCH_CAP + 5,
      [],
    );
    expect(result.stuck).toBe(RECONCILE_BATCH_CAP + 5);
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
    const row = stuckRow({ id: 'req-1', targetId: 'tgt-1', createdAt: minsAgo(90) });
    const { client } = makePrisma({
      rows: [row],
      targets: { 'tgt-1': { name: 'Acme Build', slug: 'acme-build' } },
      workflows: {}, // no workflow instance → cannot rebuild the §6.4 input
    });
    const createIssue = failingCreateIssue();
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runReconciliationSweep(makeCtx(), client, {
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
