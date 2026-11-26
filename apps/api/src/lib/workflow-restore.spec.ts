/**
 * Re-creating a workflow instance the legal retention prune deleted (AECI-1913), against
 * the in-memory D1 harness: the helper's statements, the reroute that uses it, and the
 * deterministic id that turns a concurrent second restore into a failed batch.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  integrationFieldChallenges,
  integrations,
  products,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { workflowTransitionInsert, type BatchTuple } from './audit';
import { rerouteToAeciStatements, type ContestRow } from './integration-contests';
import { closeWorkflow } from '../routes/vendor-contests';
import { contestWorkflowStmts, restoredWorkflowId } from './workflow-restore';

const NOW = '2034-06-15T03:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: 'v-s', slug: 'v-s', companyName: 'S' });
  await t.db.insert(products).values([
    { id: 'p-x', slug: 'p-x', name: 'p-x' },
    { id: 'p-y', slug: 'p-y', name: 'p-y' },
  ]);
  await t.db
    .insert(integrations)
    .values({ id: 'i-x', sourceProductId: 'p-x', targetProductId: 'p-y' });
});
afterEach(() => t.dispose());

/** An open contest routed to its owner, with the given workflow links. */
async function seedContest(links: { workflowId?: string; protestWorkflowId?: string } = {}) {
  for (const id of [links.workflowId, links.protestWorkflowId]) {
    if (id) {
      await t.db.insert(workflowInstances).values({
        id,
        workflowType: 'correction_request',
        entityId: 'fc-1',
        currentState: 'open',
      });
    }
  }
  await t.db.insert(integrationFieldChallenges).values({
    id: 'fc-1',
    integrationId: 'i-x',
    field: 'name',
    reason: 'r',
    submitterVendorId: 'v-s',
    routedTo: 'owner',
    status: 'open',
    workflowId: links.workflowId ?? null,
    protestWorkflowId: links.protestWorkflowId ?? null,
  });
  const [row] = await t.db
    .select()
    .from(integrationFieldChallenges)
    .where(eq(integrationFieldChallenges.id, 'fc-1'));
  return row as ContestRow;
}
const contestRow = async () =>
  (
    await t.db
      .select()
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.id, 'fc-1'))
  )[0]!;

describe('contestWorkflowStmts', () => {
  it('uses the live link, and writes only the state it is given', async () => {
    const row = await seedContest({ workflowId: 'wf-live' });
    expect(contestWorkflowStmts(t.db, row, 'contest', NOW)).toEqual({
      workflowId: 'wf-live',
      stmts: [],
    });
    const closing = contestWorkflowStmts(t.db, row, 'contest', NOW, { currentState: 'accepted' });
    await t.db.batch(closing.stmts as BatchTuple);
    const [instance] = await t.db.select().from(workflowInstances);
    expect(instance).toMatchObject({ id: 'wf-live', currentState: 'accepted' });
  });

  it('re-creates a pruned instance under its deterministic id and relinks the contest', async () => {
    const row = await seedContest();
    const { workflowId, stmts } = contestWorkflowStmts(t.db, row, 'contest', NOW);
    expect(workflowId).toBe(restoredWorkflowId('contest', 'fc-1'));
    await t.db.batch([
      ...stmts,
      workflowTransitionInsert(t.db, { workflowId, fromState: 'open', toState: 'open' }),
    ] as unknown as BatchTuple);

    expect((await contestRow()).workflowId).toBe(workflowId);
    expect(await t.db.select().from(workflowInstances)).toMatchObject([
      {
        id: workflowId,
        entityId: 'fc-1',
        currentState: 'open',
        initiatedAt: NOW,
        initiatedBy: null,
      },
    ]);
  });

  it('restores the protest link on its own column', async () => {
    const row = await seedContest({ workflowId: 'wf-live' });
    const { workflowId, stmts } = contestWorkflowStmts(t.db, row, 'protest', NOW, {
      currentState: 'withdrawn',
      completedAt: NOW,
      finalOutcome: 'cancelled',
    });
    await t.db.batch(stmts as BatchTuple);
    expect(await contestRow()).toMatchObject({
      workflowId: 'wf-live',
      protestWorkflowId: restoredWorkflowId('protest', 'fc-1'),
    });
    const [restored] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, workflowId));
    expect(restored).toMatchObject({ currentState: 'withdrawn', finalOutcome: 'cancelled' });
  });

  it('a second concurrent restore fails its batch whole: no duplicate instance', async () => {
    const row = await seedContest();
    const first = contestWorkflowStmts(t.db, row, 'contest', NOW);
    const second = contestWorkflowStmts(t.db, row, 'contest', NOW);
    await t.db.batch(first.stmts as BatchTuple);
    await expect(
      t.db.batch([
        ...second.stmts,
        workflowTransitionInsert(t.db, {
          workflowId: second.workflowId,
          fromState: 'open',
          toState: 'open',
        }),
      ] as unknown as BatchTuple),
    ).rejects.toThrow();
    expect(await t.db.select().from(workflowInstances)).toHaveLength(1);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(0);
  });
});

describe('the reroute to AECi after the prune', () => {
  it('re-creates the contest instance and records the transition', async () => {
    const row = await seedContest();
    const { stmts } = rerouteToAeciStatements(
      t.db,
      [row],
      { actorId: null, actorType: 'system' },
      NOW,
      'owner lost the record',
      {},
    );
    await t.db.batch(stmts as BatchTuple);

    const restored = restoredWorkflowId('contest', 'fc-1');
    expect(await contestRow()).toMatchObject({ routedTo: 'aeci', workflowId: restored });
    expect(await t.db.select().from(workflowTransitions)).toMatchObject([
      { workflowId: restored, fromState: 'open', toState: 'open', reason: 'owner lost the record' },
    ]);
  });
});

describe('a contest decision after the prune (closeWorkflow)', () => {
  it('re-creates the instance in its terminal state, relinks the contest and attaches the transition', async () => {
    const row = await seedContest();
    const { stmts, transition } = closeWorkflow(
      t.db,
      row,
      'declined',
      { actorId: null, reason: 'decided', metadata: {} },
      NOW,
    );
    await t.db.batch(stmts as unknown as BatchTuple);

    const restored = restoredWorkflowId('contest', 'fc-1');
    expect(transition.workflowId).toBe(restored);
    expect((await contestRow()).workflowId).toBe(restored);
    expect(await t.db.select().from(workflowInstances)).toMatchObject([
      { id: restored, currentState: 'declined', completedAt: NOW, finalOutcome: 'rejected' },
    ]);
    expect(await t.db.select().from(workflowTransitions)).toMatchObject([
      { workflowId: restored, fromState: 'open', toState: 'declined' },
    ]);
  });
});
