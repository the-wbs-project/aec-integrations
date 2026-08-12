/**
 * The promote Workflow run (AECI-563 / ADR 0021), driven over the in-memory D1 harness
 * with a fake `step` — the Workflows engine has no Node implementation, which is exactly
 * why `runPromoteWorkflow` is a plain function and `PromoteWorkflow.run` is a one-line
 * delegate to it.
 *
 * What this covers is the wiring the ingest spec cannot: that the commit happens once in a
 * non-retried step, that the ID map becomes the instance output AND a KV mirror, that the
 * post-commit hooks fire after the step rather than inside it, that a staged payload is
 * read back, and — the part a caller depends on — that a failure arrives as
 * `NonRetryableError` whose `name` carries the structured `ApiErrorCode`.
 */

import { PromotePayloadSchema, type PromotePayload } from '@aeci/shared';
import { NonRetryableError } from 'cloudflare:workflows';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { promotePayloadKey, promoteResultKey } from '../lib/promote-jobs';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  runPromoteWorkflow,
  type PromoteStepRunner,
  type PromoteWorkflowDeps,
  type PromoteWorkflowParams,
} from './promote-workflow';

const JOB_ID = 'job-aeci-563-0001';
const SOURCE_URL = 'http://localhost:8787/api/promote';

const BUNDLE = {
  vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
  product: { ref: 'p1', name: 'Revit' },
  integrations: [],
};

function payload(body: unknown = BUNDLE): PromotePayload {
  return PromotePayloadSchema.parse(body);
}

/**
 * `step.do` that simply runs its callback and records the name + config. Faithful to the
 * only engine behaviour the run relies on: a step's callback executes once and its return
 * value flows on. Retry/replay semantics are the platform's, not ours to simulate.
 */
function fakeStep() {
  const calls: Array<{ name: string; config?: unknown }> = [];
  const step: PromoteStepRunner = {
    do: (async (name: string, second: unknown, third?: unknown) => {
      const hasConfig = typeof second !== 'function';
      calls.push({ name, config: hasConfig ? second : undefined });
      const callback = (hasConfig ? third : second) as () => Promise<unknown>;
      return callback();
    }) as PromoteStepRunner['do'],
  };
  return { step, calls };
}

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

let t: TestDb;
let kv: ReturnType<typeof fakeKv>;
let env: Env;

beforeEach(async () => {
  t = await makeTestDb();
  kv = fakeKv();
  env = {
    ENV: 'preview',
    PROMOTE_KV: kv as unknown as Env['PROMOTE_KV'],
  } as Env;
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

/** All seams no-op'd by default so no real transport (Cloudflare, Algolia, IndexNow,
 *  Google) is ever reachable from a spec; `dbFor` is the in-memory D1. */
function deps(overrides: PromoteWorkflowDeps = {}): PromoteWorkflowDeps {
  return {
    dbFor: t.factory,
    syncAlgolia: async () => {},
    notifyIndexNow: async () => {},
    notifyGoogleIndexing: async () => {},
    refreshHomeStats: async () => {},
    ...overrides,
  };
}

function run(
  params: Partial<PromoteWorkflowParams> = {},
  overrides: PromoteWorkflowDeps = {},
  step = fakeStep(),
) {
  const ctx = fakeExecutionContext();
  const event = {
    payload: {
      jobId: JOB_ID,
      sourceUrl: SOURCE_URL,
      payload: payload(),
      ...params,
    } as PromoteWorkflowParams,
    instanceId: JOB_ID,
  };
  return { promise: runPromoteWorkflow(env, ctx, event, step.step, deps(overrides)), ctx, step };
}

describe('runPromoteWorkflow', () => {
  it('commits once inside a non-retried step and returns the ID map as the output', async () => {
    const { promise, step } = run();
    const response = await promise;

    expect(response.product).toMatchObject({ ref: 'p1', slug: 'revit', operation: 'created' });
    expect(response.vendors[0]).toMatchObject({ ref: 'v1', slug: 'autodesk' });
    expect(await t.db.select().from(products)).toHaveLength(1);
    expect(await t.db.select().from(vendors)).toHaveLength(1);

    // One commit step, and it opts out of the engine's default retry schedule — a replayed
    // create is the one failure mode this design refuses to risk.
    const commit = step.calls.filter((c) => c.name === 'commit-promote');
    expect(commit).toHaveLength(1);
    expect(commit[0]!.config).toMatchObject({ retries: { limit: 1 } });
  });

  it('mirrors the ID map to KV so the IDs outlive the instance retention window', async () => {
    const { promise } = run();
    const response = await promise;

    const mirrored = kv.store.get(promoteResultKey(JOB_ID));
    expect(mirrored).toBeDefined();
    expect(JSON.parse(mirrored!)).toEqual(response);
    expect(kv.put).toHaveBeenCalledWith(
      promoteResultKey(JOB_ID),
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });

  it('still commits when PROMOTE_KV is absent (the mirror is best-effort)', async () => {
    env = { ENV: 'preview' } as Env;
    const response = await run().promise;

    expect(response.product?.operation).toBe('created');
    expect(await t.db.select().from(products)).toHaveLength(1);
  });

  it('does not fail the job when the KV mirror write throws', async () => {
    kv.put.mockRejectedValueOnce(new Error('kv down'));
    const response = await run().promise;

    expect(response.product?.operation).toBe('created');
    expect(await t.db.select().from(products)).toHaveLength(1);
  });

  it('dispatches the post-commit hooks once, after the commit step, with the write bookmark', async () => {
    const dispatchHooks = vi.fn();
    const { promise } = run({}, { dispatchHooks });
    const response = await promise;

    expect(dispatchHooks).toHaveBeenCalledTimes(1);
    const [rc, result] = dispatchHooks.mock.calls[0]!;
    expect(result.response).toEqual(response);
    expect(result.wrote).toBe(true);
    // The bookmark is only knowable after the commit, so the run fills the ctx holder in
    // before dispatching — otherwise the hooks' re-reads could hit a lagging replica.
    expect(rc.bookmark()).toBe(result.bookmark);
    // Datadog `hostname` continuity: the synthetic request carries the kick-off's origin.
    expect(rc.request.url).toBe(SOURCE_URL);
  });

  it('reads a staged payload back from KV when the params carry a reference', async () => {
    kv.store.set(promotePayloadKey(JOB_ID), JSON.stringify(BUNDLE));

    const { promise, step } = run({ payload: undefined, payloadRef: 'kv' });
    const response = await promise;

    expect(step.calls.map((c) => c.name)).toEqual(['load-staged-payload', 'commit-promote']);
    expect(response.product?.slug).toBe('revit');
    expect(await t.db.select().from(products)).toHaveLength(1);
  });

  it('retries (plain Error) when a staged payload is not readable yet — KV is eventually consistent', async () => {
    // Nothing staged: the step must throw a RETRYABLE error, because a read moments after
    // the write can legitimately miss and the engine's backoff is the right answer.
    const { promise } = run({ payload: undefined, payloadRef: 'kv' });

    await expect(promise).rejects.toThrow(/not readable yet/);
    await expect(promise).rejects.not.toBeInstanceOf(NonRetryableError);
  });

  it('does not retry an unusable staged payload', async () => {
    kv.store.set(promotePayloadKey(JOB_ID), '{ not json');
    const { promise } = run({ payload: undefined, payloadRef: 'kv' });

    await expect(promise).rejects.toBeInstanceOf(NonRetryableError);
    await expect(promise).rejects.toMatchObject({ name: 'INTERNAL_ERROR' });
  });

  it('emits errored job telemetry when the staged-payload load fails (§6.3 invariant)', async () => {
    // With Datadog configured, the errored emit dispatches through `ctx.waitUntil`. The
    // staged-load failure is the only thing that runs before the throw on this path, so a
    // waitUntil dispatch proves the `errored` outcome telemetry fired rather than the error
    // escaping the run silently — the gap the emit-then-rethrow guard closes.
    env.DD_API_KEY = 'dd-test-key';
    kv.store.set(promotePayloadKey(JOB_ID), '{ not json');
    const { promise, ctx } = run({ payload: undefined, payloadRef: 'kv' });

    await expect(promise).rejects.toBeInstanceOf(NonRetryableError);
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it('surfaces an ApiError as a NonRetryableError whose name carries the code', async () => {
    const ingest = vi.fn().mockRejectedValue(
      new ApiError(409, 'SLUG_CONFLICT', 'A concurrent promote generated a duplicate slug', {
        details: { target: ['slug'] },
      }),
    );
    const { promise } = run({}, { ingest });

    // The poll maps this `name` back to `error.code`, so the structured code the
    // synchronous endpoint used to return in its envelope survives the async hop.
    await expect(promise).rejects.toMatchObject({
      name: 'SLUG_CONFLICT',
      message: 'A concurrent promote generated a duplicate slug',
    });
    await expect(promise).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('surfaces an unexpected fault as INTERNAL_ERROR and never dispatches hooks', async () => {
    const dispatchHooks = vi.fn();
    const ingest = vi.fn().mockRejectedValue(new Error('D1 exploded'));
    const { promise } = run({}, { ingest, dispatchHooks });

    await expect(promise).rejects.toMatchObject({
      name: 'INTERNAL_ERROR',
      message: 'D1 exploded',
    });
    expect(dispatchHooks).not.toHaveBeenCalled();
    expect(kv.store.get(promoteResultKey(JOB_ID))).toBeUndefined();
  });

  it('fails the job when the params carry neither a payload nor a reference', async () => {
    const { promise } = run({ payload: undefined });

    await expect(promise).rejects.toMatchObject({ name: 'INTERNAL_ERROR' });
    await expect(promise).rejects.toThrow(/carries no payload/);
  });

  it('emits the job outcome + duration metrics through waitUntil', async () => {
    const { promise, ctx } = run();
    await promise;
    // Both metrics dispatch fire-and-forget, so the only observable at this level is that
    // the transport was handed work (the tag payloads are asserted by the datadog spec).
    expect(ctx.waitUntil).toHaveBeenCalled();
  });
});
