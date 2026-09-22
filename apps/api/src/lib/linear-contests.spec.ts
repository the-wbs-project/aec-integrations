/**
 * The contest half of `lib/linear.ts` and its §6.7 backstop (AECI-1008):
 * `createLinearIssueForContest`, `drizzleContestLinearStore`, and
 * `runContestIssueReconciliation`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

import { eq } from 'drizzle-orm';

import {
  auditLog,
  integrationFieldChallenges,
  integrations,
  products,
  vendors,
  workflowInstances,
} from '../db/schema';
import { submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  AECI_TEAM_ID,
  ASSIGNEE_IDS,
  buildContestTitle,
  createLinearIssueForContest,
  drizzleContestLinearStore,
  type LinearContestIssueInput,
  type LinearContestStore,
} from './linear';
import { runContestIssueReconciliation } from './reconciliation-sweep';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CONTEST = uuid(50);

const INPUT: LinearContestIssueInput = {
  contestId: CONTEST,
  integrationId: uuid(20),
  integrationName: 'Revit for MicroStation',
  sourceProductName: 'Revit',
  targetProductName: 'MicroStation',
  pairPath: '/products/microstation/integrations/revit',
  field: 'docs_url',
  currentValue: 'https://old.example.test',
  acceptedValue: 'https://new.example.test',
  submitterVendorName: 'Autodesk',
  reason: 'The docs moved.',
  adminNote: 'Confirmed.',
};

function ctx(env: Record<string, unknown> = { LINEAR_API_KEY: 'lin_test' }) {
  return {
    env: { ...TEST_ENV, PUBLIC_SITE_URL: 'https://www.aecintegrations.com', ...env },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://api.test/cron/reconcile') },
  } as Parameters<typeof createLinearIssueForContest>[0];
}

function issueOk(): Response {
  return new Response(
    JSON.stringify({
      data: {
        issueCreate: {
          success: true,
          issue: { id: 'iss_c1', identifier: 'AECI-2000', url: 'https://linear.app/c1' },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fetchWith(res: () => Response) {
  return vi.fn(async () => res()) as unknown as typeof fetch;
}

function memoryStore(existing: string | null = null) {
  const links: Array<[string, string, string]> = [];
  const store: LinearContestStore = {
    getLinkedIssueId: async () => existing,
    linkIssue: async (id, issueId, url) => {
      links.push([id, issueId, url]);
    },
  };
  return { store, links };
}

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
});
afterEach(() => t.dispose());

describe('createLinearIssueForContest', () => {
  it('files a REVIEW - issue on the AECi team with no project, and links it back', async () => {
    const fetchImpl = fetchWith(issueOk);
    const { store, links } = memoryStore();
    const outcome = await createLinearIssueForContest(ctx(), store, INPUT, fetchImpl);

    expect(outcome).toEqual({
      status: 'created',
      issueId: 'iss_c1',
      issueUrl: 'https://linear.app/c1',
    });
    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    const sent = JSON.parse(String(init!.body)) as {
      variables: { input: Record<string, unknown> };
    };
    expect(sent.variables.input).toMatchObject({
      teamId: AECI_TEAM_ID,
      assigneeId: ASSIGNEE_IDS[0],
      title: 'REVIEW - Apply contested field: docs_url on Revit for MicroStation',
    });
    // The routing signal is the title prefix and the ABSENCE of a project.
    expect(sent.variables.input).not.toHaveProperty('projectId');
    const description = String(sent.variables.input.description);
    for (const needle of [
      INPUT.integrationId,
      'https://www.aecintegrations.com/products/microstation/integrations/revit',
      '`docs_url`',
      'https://old.example.test',
      'https://new.example.test',
      'The docs moved.',
      'Confirmed.',
      'https://www.aecintegrations.com/admin/contests',
      'AECI-1025',
      `Contest: ${CONTEST}`,
    ]) {
      expect(description).toContain(needle);
    }
    expect(links).toEqual([[CONTEST, 'iss_c1', 'https://linear.app/c1']]);
    expect(vi.mocked(submitCount).mock.calls.at(-1)?.[5]).toEqual(
      expect.arrayContaining(['outcome:ok', 'kind:contest']),
    );
  });

  it('falls back to the pair in the title when the integration has no name', () => {
    expect(buildContestTitle({ ...INPUT, integrationName: null })).toBe(
      'REVIEW - Apply contested field: docs_url on Revit ↔ MicroStation',
    );
  });

  it('titles an owner written here "Record integration owner" (AECI-1005)', () => {
    expect(buildContestTitle({ ...INPUT, field: 'owner', appliedMode: 'owner-recorded' })).toBe(
      'REVIEW - Record integration owner: Revit for MicroStation',
    );
    // A value applied on a claimed row keeps the contest title.
    expect(buildContestTitle({ ...INPUT, appliedMode: 'applied-here' })).toBe(
      'REVIEW - Apply contested field: docs_url on Revit for MicroStation',
    );
  });

  it('tells the review lane when AECi already applied the value (AECI-1005)', async () => {
    const fetchImpl = fetchWith(issueOk);
    await createLinearIssueForContest(
      ctx(),
      memoryStore().store,
      { ...INPUT, appliedMode: 'applied-here' },
      fetchImpl,
    );
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]!.body)) as {
      variables: { input: { description: string } };
    };
    expect(body.variables.input.description).toContain('AECi already applied it');
    expect(body.variables.input.description).not.toContain('AECi wrote nothing to the catalog');
  });

  it('is a metric-silent no-op without LINEAR_API_KEY', async () => {
    const fetchImpl = fetchWith(issueOk);
    const outcome = await createLinearIssueForContest(
      ctx({ LINEAR_API_KEY: undefined }),
      memoryStore().store,
      INPUT,
      fetchImpl,
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'no_api_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(submitCount).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-linked contest files nothing', async () => {
    const fetchImpl = fetchWith(issueOk);
    const outcome = await createLinearIssueForContest(
      ctx(),
      memoryStore('iss_existing').store,
      INPUT,
      fetchImpl,
    );
    expect(outcome).toEqual({ status: 'skipped_exists' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws: a transport failure and a store failure both resolve', async () => {
    const boom = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      createLinearIssueForContest(ctx(), memoryStore().store, INPUT, boom),
    ).resolves.toMatchObject({ status: 'failed', reason: 'network' });

    const failingStore: LinearContestStore = {
      getLinkedIssueId: async () => {
        throw new Error('d1 down');
      },
      linkIssue: async () => {},
    };
    await expect(
      createLinearIssueForContest(ctx(), failingStore, INPUT, fetchWith(issueOk)),
    ).resolves.toMatchObject({ status: 'failed', reason: 'db_error' });
  });
});

// ─── Store + sweep over a real schema ────────────────────────────────────────

async function seedAccepted(opts: { decidedAt: string; issue?: string | null }) {
  await t.db.insert(vendors).values({ id: uuid(1), slug: 'autodesk', companyName: 'Autodesk' });
  await t.db.insert(products).values([
    { id: uuid(10), slug: 'revit', name: 'Revit' },
    { id: uuid(11), slug: 'microstation', name: 'MicroStation' },
  ]);
  await t.db.insert(integrations).values({
    id: uuid(20),
    name: 'Revit for MicroStation',
    sourceProductId: uuid(10),
    targetProductId: uuid(11),
  });
  await t.db.insert(workflowInstances).values({
    id: uuid(60),
    workflowType: 'correction_request',
    entityId: CONTEST,
    currentState: 'accepted',
  });
  await t.db.insert(integrationFieldChallenges).values({
    id: CONTEST,
    integrationId: uuid(20),
    field: 'docs_url',
    currentValue: 'https://old.example.test',
    proposedValue: 'https://new.example.test',
    reason: 'moved',
    submitterVendorId: uuid(1),
    routedTo: 'aeci',
    status: 'accepted',
    decidedAt: opts.decidedAt,
    upstreamLinearIssueId: opts.issue ?? null,
    workflowId: uuid(60),
  });
}

describe('drizzleContestLinearStore', () => {
  it('compare-and-sets the issue onto the contest and never onto the workflow instance', async () => {
    await seedAccepted({ decidedAt: new Date().toISOString() });
    const store = drizzleContestLinearStore(t.db);
    await store.linkIssue(CONTEST, 'iss_1', 'https://linear.app/1');
    await store.linkIssue(CONTEST, 'iss_2', 'https://linear.app/2');
    expect(await store.getLinkedIssueId(CONTEST)).toBe('iss_1');
    const [instance] = await t.db.select().from(workflowInstances);
    // The Linear webhook resolves issues to requests through this column.
    expect(instance!.linearIssueId).toBeNull();
  });
});

describe('runContestIssueReconciliation', () => {
  const NOW = new Date('2026-09-18T12:00:00.000Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

  it('re-files with the applied mode the decision recorded (AECI-1005)', async () => {
    await seedAccepted({ decidedAt: minutesAgo(30) });
    await t.db.insert(auditLog).values({
      id: uuid(70),
      actorType: 'system',
      action: 'integration.contest.accepted',
      entityType: 'integration_field_challenge',
      entityId: CONTEST,
      metadata: { appliedMode: 'applied-here' },
    });
    const createIssue = vi
      .fn()
      .mockResolvedValue({ status: 'created', issueId: 'i', issueUrl: 'u' });
    await runContestIssueReconciliation(ctx(), t.db, { createIssue, now: NOW });
    expect(createIssue.mock.calls[0]![2]).toMatchObject({ appliedMode: 'applied-here' });
  });

  it('retries an accepted AECi contest with no issue once it is past the threshold', async () => {
    await seedAccepted({ decidedAt: minutesAgo(30) });
    const createIssue = vi
      .fn()
      .mockResolvedValue({ status: 'created', issueId: 'i', issueUrl: 'u' });
    const result = await runContestIssueReconciliation(ctx(), t.db, { createIssue, now: NOW });
    expect(result).toEqual({ stuck: 1, retried: 1, cleared: 1, stillFailing: 0 });
    expect(createIssue.mock.calls[0]![2]).toMatchObject({
      contestId: CONTEST,
      sourceProductName: 'Revit',
      targetProductName: 'MicroStation',
      pairPath: '/products/microstation/integrations/revit',
      acceptedValue: 'https://new.example.test',
      submitterVendorName: 'Autodesk',
    });
  });

  it('leaves a fresh accept to its own waitUntil attempt', async () => {
    await seedAccepted({ decidedAt: minutesAgo(2) });
    const createIssue = vi.fn();
    const result = await runContestIssueReconciliation(ctx(), t.db, { createIssue, now: NOW });
    expect(result.stuck).toBe(0);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('skips a contest that already has its issue', async () => {
    await seedAccepted({ decidedAt: minutesAgo(30), issue: 'iss_done' });
    const createIssue = vi.fn();
    expect(
      (await runContestIssueReconciliation(ctx(), t.db, { createIssue, now: NOW })).stuck,
    ).toBe(0);
  });

  it('skips declined and owner-routed contests', async () => {
    await seedAccepted({ decidedAt: minutesAgo(30) });
    await t.db
      .update(integrationFieldChallenges)
      .set({ routedTo: 'owner', ownerVendorId: uuid(1) })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    const createIssue = vi.fn();
    expect(
      (await runContestIssueReconciliation(ctx(), t.db, { createIssue, now: NOW })).stuck,
    ).toBe(0);
  });

  it('retries a STRANDED owner-routed contest, which AECi decided (AECI-1005)', async () => {
    await seedAccepted({ decidedAt: minutesAgo(30) });
    await t.db
      .update(integrationFieldChallenges)
      .set({ routedTo: 'owner', ownerVendorId: null })
      .where(eq(integrationFieldChallenges.id, CONTEST));
    const createIssue = vi
      .fn()
      .mockResolvedValue({ status: 'created', issueId: 'i', issueUrl: 'u' });
    expect(
      (await runContestIssueReconciliation(ctx(), t.db, { createIssue, now: NOW })).stuck,
    ).toBe(1);
  });

  it('counts a still-failing retry', async () => {
    await seedAccepted({ decidedAt: minutesAgo(30) });
    const createIssue = vi.fn().mockResolvedValue({ status: 'failed', reason: 'no_api_key' });
    const result = await runContestIssueReconciliation(ctx(), t.db, { createIssue, now: NOW });
    expect(result).toMatchObject({ retried: 1, cleared: 0, stillFailing: 1 });
  });
});
