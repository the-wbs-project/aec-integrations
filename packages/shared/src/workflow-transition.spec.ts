import { describe, expect, it, vi } from 'vitest';

import {
  appendWorkflowTransition,
  type WorkflowTransitionClient,
  type WorkflowTransitionEntry,
} from './workflow-transition';

function fakeDb(): { db: WorkflowTransitionClient; created: Record<string, unknown>[] } {
  const created: Record<string, unknown>[] = [];
  const db: WorkflowTransitionClient = {
    workflowTransition: {
      create: async ({ data }) => {
        created.push(data);
        return data;
      },
    },
  };
  return { db, created };
}

const GENESIS: WorkflowTransitionEntry = {
  workflowId: '11111111-1111-1111-1111-111111111111',
  fromState: null,
  toState: 'open',
  reason: 'request submitted',
};

describe('appendWorkflowTransition', () => {
  it('writes a row with the entry fields', async () => {
    const { db, created } = fakeDb();

    await appendWorkflowTransition(db, GENESIS);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      workflowId: '11111111-1111-1111-1111-111111111111',
      fromState: null,
      toState: 'open',
      reason: 'request submitted',
    });
  });

  it('defaults a missing actorId to null (anonymous/system/workflow)', async () => {
    const { db, created } = fakeDb();

    await appendWorkflowTransition(db, GENESIS);

    expect(created[0].actorId).toBeNull();
  });

  it('defaults missing fromState/reason to null', async () => {
    const { db, created } = fakeDb();

    await appendWorkflowTransition(db, { workflowId: 'w1', toState: 'resolved' });

    expect(created[0].fromState).toBeNull();
    expect(created[0].reason).toBeNull();
  });

  it('omits metadata when unset (so Prisma stores DB NULL, not invalid null)', async () => {
    const { db, created } = fakeDb();

    await appendWorkflowTransition(db, GENESIS);

    expect(created[0].metadata).toBeUndefined();
  });

  it('passes through metadata when provided', async () => {
    const { db, created } = fakeDb();

    await appendWorkflowTransition(db, {
      ...GENESIS,
      actorId: '22222222-2222-2222-2222-222222222222',
      metadata: { source: 'request-form', kind: 'claim' },
    });

    expect(created[0]).toMatchObject({
      actorId: '22222222-2222-2222-2222-222222222222',
      metadata: { source: 'request-form', kind: 'claim' },
    });
  });

  it('forwards the entry when a forwarder is supplied', async () => {
    const { db } = fakeDb();
    const forward = vi.fn();

    await appendWorkflowTransition(db, GENESIS, forward);

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(GENESIS);
  });

  it('swallows a forwarder rejection — the transition write still succeeds', async () => {
    const { db, created } = fakeDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forward = vi.fn().mockRejectedValue(new Error('datadog down'));

    await expect(appendWorkflowTransition(db, GENESIS, forward)).resolves.toBeUndefined();
    expect(created).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('propagates a DB write failure (rolls the caller transaction back)', async () => {
    const db: WorkflowTransitionClient = {
      workflowTransition: { create: () => Promise.reject(new Error('insert failed')) },
    };

    await expect(appendWorkflowTransition(db, GENESIS)).rejects.toThrow('insert failed');
  });
});
