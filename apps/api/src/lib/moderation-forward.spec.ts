/**
 * `forwardAuditBatch` (AECI-1112): a write's §26.5 audit rows and transitions leave
 * the Worker as ONE logs-intake request however many there are, and a failed forward
 * warns and is swallowed. Asserted at the `fetch` level, because the connection limit
 * (AECI-666) counts requests, not helper calls.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { stubPosthogIntake } from '../test/posthog-intake';
import { forwardAuditBatch, type ForwardContext } from './moderation-forward';

const KEYED_ENV = { ENV: 'preview', POSTHOG_PROJECT_KEY: 'phc_test' } as Env;

function ctx(env: Env = KEYED_ENV) {
  const waited: Promise<unknown>[] = [];
  const c: ForwardContext = {
    env,
    executionCtx: { waitUntil: (p: Promise<unknown>) => void waited.push(p) },
    req: { raw: new Request('https://aeci-api/api/admin/claims/x') },
  };
  return { c, settle: () => Promise.all(waited) };
}

const audit = (i: number): AuditLogEntry => ({
  actorId: null,
  actorType: 'admin',
  action: 'integration_contest.rerouted',
  entityType: 'integration_contest',
  entityId: `contest-${i}`,
});

const transition = (i: number): WorkflowTransitionEntry => ({
  workflowId: `wf-${i}`,
  fromState: 'open',
  toState: 'resolved',
  actorId: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('forwardAuditBatch', () => {
  it('sends ten audit rows and four transitions as ONE request (past the ~6-connection limit)', async () => {
    const intake = stubPosthogIntake();
    const { c, settle } = ctx();

    forwardAuditBatch(
      c,
      Array.from({ length: 10 }, (_, i) => audit(i)),
      Array.from({ length: 4 }, (_, i) => transition(i)),
      'account',
    );
    await settle();

    expect(intake.requests).toHaveLength(1);
    const messages = intake.requests[0]!.messages;
    expect(messages.filter((m) => m.startsWith('audit '))).toHaveLength(10);
    expect(messages.filter((m) => m.startsWith('workflow '))).toHaveLength(4);
    expect(messages[0]).toBe('audit integration_contest.rerouted contest-0');
    expect(messages[10]).toBe('workflow open→resolved wf-0');
  });

  it("carries an admin row's vendor_id, vendor_tier and vendor_entitlement_status (AECI-1192)", async () => {
    const intake = stubPosthogIntake();
    const { c, settle } = ctx();

    forwardAuditBatch(
      c,
      [
        { ...audit(1), vendorId: 'vendor-1', vendorPlan: { tier: 'verified', status: 'expired' } },
        audit(2),
      ],
      [],
    );
    await settle();

    const [, init] = intake.fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/i/v1/logs'),
    )!;
    type Attr = { key: string; value: { stringValue?: string } };
    const records = (
      JSON.parse(String(init?.body)) as {
        resourceLogs: { scopeLogs: { logRecords: { attributes: Attr[] }[] }[] }[];
      }
    ).resourceLogs[0]!.scopeLogs[0]!.logRecords;
    const attrs = (i: number) =>
      Object.fromEntries(records[i]!.attributes.map((a) => [a.key, a.value.stringValue]));
    expect(attrs(0)).toMatchObject({
      vendor_id: 'vendor-1',
      vendor_tier: 'verified',
      vendor_entitlement_status: 'expired',
    });
    // A row about no vendor carries none of the three keys.
    expect(Object.keys(attrs(1))).not.toContain('vendor_id');
    expect(Object.keys(attrs(1))).not.toContain('vendor_entitlement_status');
  });

  it('skips null entries, and sends nothing at all when every entry is null', async () => {
    const intake = stubPosthogIntake();
    const { c, settle } = ctx();

    forwardAuditBatch(c, [null, audit(1), undefined], [null]);
    forwardAuditBatch(c, [null], [undefined]);
    await settle();

    expect(intake.requests).toHaveLength(1);
    expect(intake.requests[0]!.messages).toEqual(['audit integration_contest.rerouted contest-1']);
  });

  it('sends nothing without POSTHOG_PROJECT_KEY', async () => {
    const intake = stubPosthogIntake();
    const { c, settle } = ctx({ ENV: 'preview' } as Env);

    forwardAuditBatch(c, [audit(1)], [transition(1)]);
    await settle();

    expect(intake.fetchMock).not.toHaveBeenCalled();
  });

  it('warns and swallows a rejected request, so the committed write is unaffected', async () => {
    stubPosthogIntake(() => Promise.reject(new Error('network down')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { c, settle } = ctx();

    expect(() => forwardAuditBatch(c, [audit(1)], [transition(1)])).not.toThrow();
    await expect(settle()).resolves.toBeDefined();

    expect(warn).toHaveBeenCalledWith('logBatchToPosthog: forward failed', expect.any(Error));
  });

  it('warns and swallows a throw while building the batch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { c } = ctx();
    const poisoned = {
      ...audit(1),
      get action(): string {
        throw new Error('bad entry');
      },
    } as AuditLogEntry;

    expect(() => forwardAuditBatch(c, [poisoned], [])).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'forwardAuditBatch: observability forward failed',
      expect.any(Error),
    );
  });
});
