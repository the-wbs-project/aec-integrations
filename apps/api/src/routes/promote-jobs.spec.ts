/**
 * `GET /api/promote/jobs/:id` — the poll half of the async promote protocol
 * (AECI-563 / ADR 0021).
 *
 * The acceptance criterion this file guards: "the IDs remain fetchable by job ID". So the
 * cases that matter are the boring-looking ones — every platform status maps onto one of
 * the four contract values, a completed job hands back the full ID map, and an instance
 * that has aged out still resolves from the KV mirror rather than 404-ing and telling the
 * review app to re-push a product that is already live.
 */

import type { PromoteJobResponse, PromoteResponse } from '@aeci/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { promoteResultKey } from '../lib/promote-jobs';
import { requireReviewAppAuth } from '../lib/review-auth';
import { fakeExecutionContext } from '../test/helpers';
import { createPromoteJobHandler } from './promote-jobs';

const JOB_ID = 'job-aeci-563-0001';

const RESULT: PromoteResponse = {
  vendors: [{ ref: 'v1', id: 'vendor-1', slug: 'autodesk', operation: 'created' }],
  product: { ref: 'p1', id: 'product-1', slug: 'revit', operation: 'created' },
  integrations: [],
  taxonomy: { categories: [], audiences: [], phases: [], trades: [] },
  skipped: [],
  preserved: [],
};

type InstanceState = {
  status: string;
  error?: { name: string; message: string };
  output?: unknown;
};

/** Workflow binding stand-in: `get` rejects for an unknown id, exactly as the platform does. */
function fakeWorkflow(states: Record<string, InstanceState>) {
  return {
    get: vi.fn(async (id: string) => {
      const state = states[id];
      if (!state) throw new Error(`instance ${id} not found`);
      return { id, status: async () => state };
    }),
  };
}

function fakeKv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn(async (key: string) => {
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    }),
  };
}

function harness(opts: {
  states?: Record<string, InstanceState>;
  kvEntries?: Record<string, string>;
  noWorkflow?: boolean;
  noKv?: boolean;
  env?: Partial<Env>;
}) {
  const workflow = fakeWorkflow(opts.states ?? {});
  const kv = fakeKv(opts.kvEntries);
  const env = {
    ENV: 'preview',
    REVIEW_APP_TOKEN: 'secret-token',
    PROMOTE_WORKFLOW: opts.noWorkflow
      ? undefined
      : (workflow as unknown as Env['PROMOTE_WORKFLOW']),
    PROMOTE_KV: opts.noKv ? undefined : (kv as unknown as Env['PROMOTE_KV']),
    ...opts.env,
  } as Env;
  return { workflow, kv, env };
}

function app(withAuth = false) {
  const handler = createPromoteJobHandler();
  const a = new Hono<{ Bindings: Env }>();
  a.onError(errorHandler());
  if (withAuth) a.get('/api/promote/jobs/:id', requireReviewAppAuth(), handler);
  else a.get('/api/promote/jobs/:id', handler);
  return a;
}

function get(env: Env, jobId = JOB_ID, headers: Record<string, string> = {}, withAuth = false) {
  return app(withAuth).request(
    `/api/promote/jobs/${jobId}`,
    { method: 'GET', headers },
    env,
    fakeExecutionContext(),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('createPromoteJobHandler', () => {
  it('returns the full ID map for a completed job', async () => {
    const { env } = harness({
      states: { [JOB_ID]: { status: 'complete', output: RESULT } },
    });
    const res = await get(env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: JOB_ID, status: 'complete', result: RESULT });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('returns the structured error code for a failed job', async () => {
    const { env } = harness({
      states: {
        [JOB_ID]: {
          status: 'errored',
          error: { name: 'SLUG_CONFLICT', message: 'duplicate slug' },
        },
      },
    });
    const res = await get(env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobId: JOB_ID,
      status: 'errored',
      error: { code: 'SLUG_CONFLICT', message: 'duplicate slug' },
    });
  });

  it('degrades an unrecognized failure name to INTERNAL_ERROR', async () => {
    const { env } = harness({
      states: {
        [JOB_ID]: { status: 'errored', error: { name: 'Error', message: 'step timed out' } },
      },
    });
    const body = (await (await get(env)).json()) as PromoteJobResponse;

    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'step timed out' });
  });

  it.each([
    ['queued', 'queued'],
    ['running', 'running'],
    ['paused', 'running'],
    ['waiting', 'running'],
    ['waitingForPause', 'running'],
    ['unknown', 'running'],
    ['complete', 'complete'],
    ['errored', 'errored'],
    ['terminated', 'errored'],
  ])('maps the platform status %s onto %s', async (platform, expected) => {
    const { env } = harness({ states: { [JOB_ID]: { status: platform } } });
    const body = (await (await get(env)).json()) as PromoteJobResponse;

    expect(body.status).toBe(expected);
    // `result` is present exactly when complete — an in-flight job must not look empty-but-done.
    if (expected !== 'complete') expect(body.result).toBeUndefined();
  });

  it('serves a completed job from the KV mirror once the instance has aged out', async () => {
    const { env, workflow } = harness({
      states: {}, // instance gone
      kvEntries: { [promoteResultKey(JOB_ID)]: JSON.stringify(RESULT) },
    });
    const res = await get(env);

    expect(workflow.get).toHaveBeenCalledWith(JOB_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: JOB_ID, status: 'complete', result: RESULT });
  });

  it('serves the mirror when the Workflow binding is absent entirely', async () => {
    const { env } = harness({
      noWorkflow: true,
      kvEntries: { [promoteResultKey(JOB_ID)]: JSON.stringify(RESULT) },
    });
    const res = await get(env);

    expect(res.status).toBe(200);
    expect(((await res.json()) as PromoteJobResponse).result).toEqual(RESULT);
  });

  it('404s an id with neither an instance nor a mirror', async () => {
    const { env } = harness({ states: {} });
    const res = await get(env, 'job-never-existed');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toMatchObject({ resource: 'promote_job' });
  });

  it('404s (rather than an empty complete) when KV is not configured and the instance is gone', async () => {
    const { env } = harness({ states: {}, noKv: true });
    const res = await get(env);
    expect(res.status).toBe(404);
  });

  it('503s rather than 404s when the mirror read itself faults', async () => {
    const { env, kv } = harness({ states: {} });
    kv.get.mockRejectedValueOnce(new Error('kv down'));
    const res = await get(env);

    // A KV fault must never read as "no such job" — that would tell the review app to
    // re-push a product that is already live.
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'DEPENDENCY_FAILURE',
    );
  });

  describe('requireReviewAppAuth', () => {
    it('rejects a poll with no credentials', async () => {
      const { env } = harness({ states: { [JOB_ID]: { status: 'complete', output: RESULT } } });
      const res = await get(env, JOB_ID, {}, true);

      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('accepts the correct token', async () => {
      const { env } = harness({ states: { [JOB_ID]: { status: 'complete', output: RESULT } } });
      const res = await get(env, JOB_ID, { Authorization: 'Bearer secret-token' }, true);

      expect(res.status).toBe(200);
    });
  });
});
