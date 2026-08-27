/**
 * Vendor-portal post-commit tail — connection hygiene (AECI-666).
 *
 * `afterVendorWrite` runs after EVERY vendor write. It used to be
 * `Promise.all([purgeTags(…), ...entries.map(forwardAuditLog)])`, and because
 * the §3.1 dual-run fans `logToPosthog` out to PostHog AND Datadog, a write that
 * emits N audit rows — AECI-301's `POST /api/vendor/claims` writes a
 * `claim.created` plus one `attestation.created` per owned slot — opened 2N
 * simultaneous connections from one invocation, alongside the queue send sitting
 * in the same array. A Worker invocation may hold only a bounded number; past
 * the limit the runtime cancels the stalled responses into `fetch` promises that
 * never settle, so the forwards are lost with no error at all.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { logBatchToPosthog } from '../posthog';
import { fakeExecutionContext } from '../test/helpers';
import { afterVendorWrite, AUDIT_SOURCE, type VendorContext } from './vendor-shared';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

function entry(n: number): AuditLogEntry {
  return {
    actorId: null,
    actorType: 'user',
    action: n === 0 ? 'claim.created' : 'attestation.created',
    entityType: n === 0 ? 'claim' : 'attestation',
    entityId: `entity-${n}`,
  };
}

function makeCtx(env: Partial<Env> = {}) {
  const execCtx = fakeExecutionContext();
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const c = {
    env: { ENV: 'preview', ...env } as Env,
    executionCtx: execCtx,
    req: { raw: new Request('http://localhost:8787/api/vendor/claims') },
  } as unknown as VendorContext;
  return { c, execCtx, send, sendBatch };
}

beforeEach(() => vi.mocked(logBatchToPosthog).mockClear());

describe('afterVendorWrite', () => {
  it('forwards N audit entries in ONE batched call, not N', () => {
    const { c } = makeCtx();

    afterVendorWrite(c, [], [entry(0), entry(1), entry(2), entry(3)]);

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logBatchToPosthog).mock.calls[0][3]).toHaveLength(4);
  });

  it('accepts a bare entry as well as an array', () => {
    const { c } = makeCtx();

    afterVendorWrite(c, [], entry(0));

    expect(vi.mocked(logBatchToPosthog).mock.calls[0][3]).toEqual([
      {
        level: 'info',
        message: 'audit claim.created entity-0',
        action: 'claim.created',
        entity_type: 'claim',
        entity_id: 'entity-0',
        source: AUDIT_SOURCE,
      },
    ]);
  });

  it('dispatches with no vendor key configured — each leg self-gates', () => {
    // The old forwarder returned `undefined` (dropping every forward) unless
    // `DD_API_KEY || POSTHOG_PROJECT_KEY` was set. The transport gates itself
    // now, so the call site must not re-add that.
    const { c } = makeCtx();

    afterVendorWrite(c, [], entry(0));

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });

  it('still enqueues the cache purge, on its own waitUntil task', async () => {
    const { c, execCtx, sendBatch, send } = makeCtx();
    (c.env as Env).CACHE_PURGE_QUEUE = { send, sendBatch } as unknown as Env['CACHE_PURGE_QUEUE'];

    afterVendorWrite(c, ['product:revit'], entry(0));
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    expect(send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'vendor' });
  });

  it('no-ops the purge without a queue binding, and still forwards', async () => {
    const { c, execCtx } = makeCtx();

    afterVendorWrite(c, ['product:revit'], entry(0));
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });
});
