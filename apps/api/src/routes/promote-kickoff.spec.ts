/**
 * `POST /api/promote` — the async kick-off (AECI-563 / ADR 0021).
 *
 * The load-bearing case is **idempotent replay**: the same job id twice must attach to the
 * one instance and commit exactly once. That is the property replacing the rejected
 * `airtable_record_id` column, so it is asserted directly (one `create`, zero second
 * commit) rather than inferred.
 *
 * The commit itself is not exercised here — it lives in the Workflow
 * (`promote-workflow.spec.ts`) and the ingest SQL in `promote.spec.ts`. What matters at
 * this seam is that validation still fails fast, that nothing but the Workflow binding is
 * touched, and that oversize bundles route through KV instead of over-filling the 1 MiB
 * event params.
 */

import type { PromotePayload } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireReviewAppAuth } from '../lib/review-auth';
import {
  PROMOTE_PARAMS_INLINE_MAX_BYTES,
  PROMOTE_PAYLOAD_MAX_BYTES,
  promotePayloadKey,
  type PromoteWorkflowParams,
} from '../lib/promote-jobs';
import { buildAppWithHandler, fakeExecutionContext } from '../test/helpers';
import { createPromoteKickoffHandler } from './promote-kickoff';

const JOB_ID = 'job-aeci-563-0001';
const VALID_BODY = { product: { ref: 'p1', name: 'Revit' } };

/**
 * Minimal stand-in for the `Workflow` binding, faithful to the two behaviours the handler
 * depends on: `create` REJECTS on a duplicate id (the platform's guard, and the mechanism
 * that makes a replayed kick-off safe) and `get` resolves only for an id that exists.
 */
function fakeWorkflow() {
  const instances = new Map<string, PromoteWorkflowParams | undefined>();
  const created: Array<{ id: string; params: PromoteWorkflowParams }> = [];
  return {
    created,
    instances,
    create: vi.fn(async (opts: { id: string; params: PromoteWorkflowParams }) => {
      if (instances.has(opts.id)) {
        throw new Error(`instance.id ${opts.id} already exists`);
      }
      instances.set(opts.id, opts.params);
      created.push({ id: opts.id, params: opts.params });
      return { id: opts.id };
    }),
    get: vi.fn(async (id: string) => {
      if (!instances.has(id)) throw new Error(`instance ${id} not found`);
      return { id };
    }),
  };
}

/** In-memory KV with just the `put`/`get` surface the staging path uses. */
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

type Harness = ReturnType<typeof makeHarness>;
function makeHarness(overrides: Partial<Env> = {}) {
  const workflow = fakeWorkflow();
  const kv = fakeKv();
  const env = {
    ENV: 'preview',
    REVIEW_APP_TOKEN: 'secret-token',
    PROMOTE_WORKFLOW: workflow as unknown as Env['PROMOTE_WORKFLOW'],
    PROMOTE_KV: kv as unknown as Env['PROMOTE_KV'],
    ...overrides,
  } as Env;
  return { workflow, kv, env };
}

function app(withAuth = false) {
  const handler = createPromoteKickoffHandler();
  if (!withAuth) {
    return buildAppWithHandler({ method: 'post', path: '/api/promote', handler });
  }
  // Mirrors `index.ts`'s wiring — the bearer middleware in front of the handler on the
  // same route — so the auth assertions below cover the real route shape.
  const authed = new Hono<{ Bindings: Env }>();
  authed.onError(errorHandler());
  authed.post('/api/promote', requireReviewAppAuth(), handler);
  return authed;
}

function post(h: Harness, body: unknown, headers: Record<string, string> = {}, withAuth = false) {
  return app(withAuth).request(
    '/api/promote',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    h.env,
    fakeExecutionContext(),
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('createPromoteKickoffHandler', () => {
  it('returns 202 with the caller job id, a Location header, and never a commit', async () => {
    const h = makeHarness();
    const res = await post(h, { ...VALID_BODY, jobId: JOB_ID });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: JOB_ID, status: 'queued' });
    expect(res.headers.get('Location')).toBe(`/api/promote/jobs/${JOB_ID}`);
    // Non-cacheable, like every other API response.
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    expect(h.workflow.create).toHaveBeenCalledTimes(1);
    expect(h.workflow.created[0]!.id).toBe(JOB_ID);
    expect(
      (h.workflow.created[0]!.params.payload as PromotePayload | undefined)?.product?.name,
    ).toBe('Revit');
  });

  it('generates a job id when the caller omits one', async () => {
    const h = makeHarness();
    const res = await post(h, VALID_BODY);

    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.workflow.created[0]!.id).toBe(jobId);
  });

  it('is idempotent on a replayed kick-off: same job id twice → one instance, one commit', async () => {
    const h = makeHarness();

    const first = await post(h, { ...VALID_BODY, jobId: JOB_ID });
    const second = await post(h, { ...VALID_BODY, jobId: JOB_ID });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    // The caller gets the SAME handle back, so it keeps polling the one job.
    expect(await second.json()).toEqual({ jobId: JOB_ID, status: 'queued' });
    // Two kick-offs, ONE instance — and since the commit only ever happens inside an
    // instance, exactly one commit. This is the duplicate-safety guarantee.
    expect(h.workflow.create).toHaveBeenCalledTimes(2);
    expect(h.workflow.created).toHaveLength(1);
    expect(h.workflow.instances.size).toBe(1);
  });

  it('rethrows when create fails for a reason other than a duplicate id', async () => {
    const h = makeHarness();
    h.workflow.create.mockRejectedValueOnce(new Error('workflows unavailable'));

    const res = await post(h, { ...VALID_BODY, jobId: JOB_ID });

    // `get` also rejects (no such instance), so this is a real failure, not a replay.
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  it('rejects a malformed body before touching the Workflow', async () => {
    const h = makeHarness();
    const res = await post(h, '{ not json');

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MALFORMED_REQUEST',
    );
    expect(h.workflow.create).not.toHaveBeenCalled();
  });

  it('rejects a schema violation before touching the Workflow (fast 400s unchanged)', async () => {
    const h = makeHarness();
    const res = await post(h, { product: { ref: 'p1' } }); // missing `name`

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(h.workflow.create).not.toHaveBeenCalled();
  });

  it('rejects an empty payload', async () => {
    const h = makeHarness();
    const res = await post(h, {});
    expect(res.status).toBe(400);
    expect(h.workflow.create).not.toHaveBeenCalled();
  });

  it('rejects a jobId that cannot be a Workflow instance id', async () => {
    const h = makeHarness();
    // 101 chars — one over the platform's instance-id ceiling.
    const res = await post(h, { ...VALID_BODY, jobId: 'a'.repeat(101) });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(h.workflow.create).not.toHaveBeenCalled();
  });

  it('503s when the PROMOTE_WORKFLOW binding is missing', async () => {
    const h = makeHarness({ PROMOTE_WORKFLOW: undefined });
    const res = await post(h, { ...VALID_BODY, jobId: JOB_ID });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'DEPENDENCY_FAILURE',
    );
  });

  describe('oversize bundles', () => {
    /** A payload whose serialized form exceeds the inline threshold. */
    function bigBody(jobId = JOB_ID) {
      return {
        jobId,
        product: {
          ref: 'p1',
          name: 'Revit',
          description: 'x'.repeat(PROMOTE_PARAMS_INLINE_MAX_BYTES + 1),
        },
      };
    }

    it('stages the bundle in KV and passes a reference instead of the payload', async () => {
      const h = makeHarness();
      const res = await post(h, bigBody());

      expect(res.status).toBe(202);
      const params = h.workflow.created[0]!.params;
      expect(params.payloadRef).toBe('kv');
      expect(params.payload).toBeUndefined();

      // The staged copy is the validated payload, keyed by job id so a replay overwrites
      // its own entry rather than orphaning one.
      const staged = h.kv.store.get(promotePayloadKey(JOB_ID));
      expect(staged).toBeDefined();
      expect(JSON.parse(staged!).product.name).toBe('Revit');
      expect(h.kv.put).toHaveBeenCalledWith(
        promotePayloadKey(JOB_ID),
        expect.any(String),
        expect.objectContaining({ expirationTtl: expect.any(Number) }),
      );
    });

    it('413s when the bundle needs staging but PROMOTE_KV is not configured', async () => {
      const h = makeHarness({ PROMOTE_KV: undefined });
      const res = await post(h, bigBody());

      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'PAYLOAD_TOO_LARGE',
      );
      expect(h.workflow.create).not.toHaveBeenCalled();
    });

    it('413s a body past the hard ceiling without parsing or staging it', async () => {
      const h = makeHarness();
      const res = await post(h, 'x'.repeat(PROMOTE_PAYLOAD_MAX_BYTES + 1));

      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'PAYLOAD_TOO_LARGE',
      );
      expect(h.kv.put).not.toHaveBeenCalled();
      expect(h.workflow.create).not.toHaveBeenCalled();
    });
  });

  describe('requireReviewAppAuth', () => {
    it('rejects a request with no Authorization header', async () => {
      const h = makeHarness();
      const res = await post(h, VALID_BODY, {}, true);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'UNAUTHENTICATED',
      );
      expect(h.workflow.create).not.toHaveBeenCalled();
    });

    it('rejects a wrong token', async () => {
      const h = makeHarness();
      const res = await post(h, VALID_BODY, { Authorization: 'Bearer wrong' }, true);
      expect(res.status).toBe(401);
    });

    it('accepts the correct token', async () => {
      const h = makeHarness();
      const res = await post(h, VALID_BODY, { Authorization: 'Bearer secret-token' }, true);
      expect(res.status).toBe(202);
    });

    it('fails closed when REVIEW_APP_TOKEN is unset', async () => {
      const h = makeHarness({ REVIEW_APP_TOKEN: undefined });
      const res = await post(h, VALID_BODY, { Authorization: 'Bearer anything' }, true);
      expect(res.status).toBe(401);
    });
  });
});
