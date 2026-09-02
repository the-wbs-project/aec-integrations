/**
 * Promote post-commit hook dispatch — connection hygiene (AECI-666).
 *
 * The regression these lock down: `dispatchPromoteHooks` used to loop
 * `logToPosthog` once per `audit_log` row and hand every transport straight to
 * `waitUntil`. A fat bundle therefore opened a dozen-plus simultaneous
 * connections from one invocation, the runtime cancelled the stalled responses
 * to break the deadlock, and a cancelled `fetch` returns a promise that NEVER
 * settles — so the hook was lost with no log line, and the invocation itself was
 * eventually killed as hung, taking every other in-flight hook with it. In
 * production that silently dropped Algolia upserts and cache purges on ~8% of
 * promotes.
 *
 * Two invariants close it: N audit entries cost ONE request, and no single hook
 * can wedge the invocation.
 */

import type { AuditLogEntry, PromoteResponse } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logBatchToPosthog } from '../posthog';
import type { Env } from '../env';
import { fakeExecutionContext } from '../test/helpers';
import {
  dispatchPromoteHooks,
  type PromoteAlgoliaSync,
  type PromoteIngestResult,
  type PromoteRunCtx,
} from './promote';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const emptyResponse: PromoteResponse = {
  vendors: [],
  product: null,
  integrations: [],
  taxonomy: { categories: [], audiences: [], phases: [], trades: [] },
  skipped: [],
  // stage-2 only: AECI-301 added `preserved[]` to the response contract.
  preserved: [],
};

function auditEntry(n: number): AuditLogEntry {
  return {
    actorId: null,
    actorType: 'system',
    action: 'product.created',
    entityType: 'product',
    entityId: `entity-${n}`,
  } as AuditLogEntry;
}

function makeResult(overrides: Partial<PromoteIngestResult> = {}): PromoteIngestResult {
  return {
    response: emptyResponse,
    removedTradeSlugs: [],
    wrote: true,
    bookmark: null,
    auditEntries: [],
    staleSupabaseIds: [],
    ...overrides,
  };
}

/**
 * Inert defaults for every hook this file is not asserting on. `dbFor` is only
 * used to build the trade-URL read, which self-gates off when neither ping is
 * configured, so a bare stub is enough; the rest would otherwise reach for the
 * real D1 binding / transports.
 */
type Deps = NonNullable<Parameters<typeof dispatchPromoteHooks>[2]>;
function makeDeps(overrides: Deps = {}): Deps {
  const noop = async () => {};
  return {
    dbFor: (() => ({ db: {} })) as unknown as Deps['dbFor'],
    syncAlgolia: noop,
    notifyIndexNow: noop,
    refreshHomeStats: noop,
    ...overrides,
  };
}

function makeRc(env: Env): { rc: PromoteRunCtx; settled: () => Promise<void> } {
  const execCtx = fakeExecutionContext();
  const tasks: Promise<unknown>[] = [];
  const rc: PromoteRunCtx = {
    env,
    request: new Request('http://localhost:8787/api/promote'),
    waitUntil: (promise) => {
      tasks.push(promise);
      execCtx.waitUntil(promise);
    },
    bookmark: () => null,
  };
  return { rc, settled: async () => void (await Promise.all(tasks)) };
}

beforeEach(() => vi.mocked(logBatchToPosthog).mockClear());
afterEach(() => vi.useRealTimers());

describe('dispatchPromoteHooks — audit forwards', () => {
  it('forwards N audit entries in ONE batched call, not N', () => {
    const { rc } = makeRc({ ENV: 'preview', POSTHOG_PROJECT_KEY: 'phc_test_token' });
    const auditEntries = Array.from({ length: 14 }, (_, i) => auditEntry(i));

    dispatchPromoteHooks(rc, makeResult({ auditEntries }), makeDeps());

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    const events = vi.mocked(logBatchToPosthog).mock.calls[0][3];
    expect(events).toHaveLength(14);
  });

  it('keeps the §26.5 envelope for each entry', () => {
    const { rc } = makeRc({ ENV: 'preview', POSTHOG_PROJECT_KEY: 'phc_test_token' });

    dispatchPromoteHooks(rc, makeResult({ auditEntries: [auditEntry(1)] }), makeDeps());

    expect(vi.mocked(logBatchToPosthog).mock.calls[0][3][0]).toEqual({
      level: 'info',
      message: 'audit product.created entity-1',
      action: 'product.created',
      entity_type: 'product',
      entity_id: 'entity-1',
      source: 'review-app-promote',
    });
  });

  // stage-2 only: the pre-fix code gated the whole forward on
  // `POSTHOG_PROJECT_KEY`. Batching removed it because the transport
  // self-gates — this locks that in, so a re-added gate
  // (which would silently drop every forward on a key-less tier) fails here.
  it('dispatches the batch without any vendor key configured — each leg self-gates', () => {
    const { rc } = makeRc({ ENV: 'preview' });

    dispatchPromoteHooks(rc, makeResult({ auditEntries: [auditEntry(1)] }), makeDeps());

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchPromoteHooks — a wedged hook cannot hang the invocation', () => {
  it('abandons a hook that never settles, and warns', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rc, settled } = makeRc({
      ENV: 'preview',
      ALGOLIA_APP_ID: 'app',
      ALGOLIA_ADMIN_KEY: 'key',
    });
    // A `fetch` the runtime cancelled for holding a connection too long: the
    // promise neither resolves nor rejects, ever.
    const neverSettles: PromoteAlgoliaSync = () => new Promise<void>(() => {});

    dispatchPromoteHooks(rc, makeResult(), makeDeps({ syncAlgolia: neverSettles }));
    await vi.advanceTimersByTimeAsync(20_000);

    // The promise handed to `waitUntil` resolves anyway — that is what keeps the
    // runtime from killing the invocation as hung.
    await expect(settled()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('algolia-sync'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not settle'));
  });

  it('does not wait out the timeout for a hook that settles normally', async () => {
    vi.useFakeTimers();
    const { rc, settled } = makeRc({
      ENV: 'preview',
      ALGOLIA_APP_ID: 'app',
      ALGOLIA_ADMIN_KEY: 'key',
    });
    const syncAlgolia: PromoteAlgoliaSync = () => Promise.resolve();

    dispatchPromoteHooks(rc, makeResult(), makeDeps({ syncAlgolia }));

    // No timer advance: the watchdog must not add latency to the happy path.
    await expect(settled()).resolves.toBeUndefined();
  });

  it('swallows a hook that throws instead of leaking an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rc, settled } = makeRc({
      ENV: 'preview',
      ALGOLIA_APP_ID: 'app',
      ALGOLIA_ADMIN_KEY: 'key',
    });
    const syncAlgolia: PromoteAlgoliaSync = () => Promise.reject(new Error('algolia exploded'));

    dispatchPromoteHooks(rc, makeResult(), makeDeps({ syncAlgolia }));

    await expect(settled()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('algolia-sync'),
      expect.objectContaining({ message: 'algolia exploded' }),
    );
  });
});
