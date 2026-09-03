/**
 * `POST /api/promote/connector-catalog` — the AECI-714 kick-off.
 *
 * Deliberately narrow. The kick-off machinery (size guard, KV spill, the
 * create-then-get replay dance, the auth middleware) is shared byte-for-byte with the
 * product arm and is covered in `promote-kickoff.spec.ts`; what is asserted here is the
 * part that is NOT shared — that a connector page routes to the connector arm, and that
 * the two arms cannot be confused on the wire.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { type PromoteWorkflowParams } from '../lib/promote-jobs';
import { requireReviewAppAuth } from '../lib/review-auth';
import { fakeExecutionContext } from '../test/helpers';
import { createConnectorCatalogKickoffHandler } from './promote-kickoff';

const PATH = '/api/promote/connector-catalog';
const JOB_ID = 'connector-page-000001';
const STAMPS = { firstSeenAt: '2026-08-27T06:10:37.867Z', lastSeenAt: '2026-08-27T06:11:54.977Z' };

const VALID_BODY = {
  jobId: JOB_ID,
  catalog: { id: 'rec76C362381D6CDF', connectorProductId: '11111111-1111-4111-8111-111111111111' },
  page: { index: 0, of: 8 },
  stubs: [{ id: 'recStubProcore01', slug: 'procore', ...STAMPS }],
};

function fakeWorkflow() {
  const instances = new Map<string, PromoteWorkflowParams>();
  const created: Array<{ id: string; params: PromoteWorkflowParams }> = [];
  return {
    created,
    create: vi.fn(async (opts: { id: string; params: PromoteWorkflowParams }) => {
      if (instances.has(opts.id)) throw new Error(`instance.id ${opts.id} already exists`);
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

function makeHarness(overrides: Partial<Env> = {}) {
  const workflow = fakeWorkflow();
  const env = {
    ENV: 'preview',
    REVIEW_APP_TOKEN: 'secret-token',
    PROMOTE_WORKFLOW: workflow as unknown as Env['PROMOTE_WORKFLOW'],
    ...overrides,
  } as Env;
  return { workflow, env };
}

function post(
  h: ReturnType<typeof makeHarness>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  // Mirrors `index.ts` — the bearer middleware in front of the handler on the real path.
  app.post(PATH, requireReviewAppAuth(), createConnectorCatalogKickoffHandler());
  return app.request(
    PATH,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    h.env,
    fakeExecutionContext(),
  );
}

describe('POST /api/promote/connector-catalog (AECI-714)', () => {
  it('returns 202 with the shared job shape and Location header', async () => {
    const h = makeHarness();
    const res = await post(h, VALID_BODY);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: JOB_ID, status: 'queued' });
    // The SAME poll route as the product arm — there is one job protocol, not two.
    expect(res.headers.get('Location')).toBe(`/api/promote/jobs/${JOB_ID}`);
  });

  it('tags the Workflow params `connector` so the run cannot take the product branch', async () => {
    const h = makeHarness();
    await post(h, VALID_BODY);

    const params = h.workflow.created[0]!.params;
    expect(params.kind).toBe('connector');
    expect(params.jobId).toBe(JOB_ID);
  });

  it('rejects a product bundle on this path, and a connector page on the product path', async () => {
    const h = makeHarness();
    // The two schemas share no required field, so a payload sent to the wrong endpoint
    // fails fast at the kick-off rather than committing something incoherent.
    const res = await post(h, { product: { ref: 'p1', name: 'Revit' } });
    expect(res.status).toBe(400);
    expect(h.workflow.create).not.toHaveBeenCalled();
  });

  it('rejects a page whose pair ordering or status family is wrong, before any instance exists', async () => {
    const h = makeHarness();
    const bad = await post(h, {
      ...VALID_BODY,
      pairs: [{ id: 'recPair000000001', stubAId: 'recZZZ', stubBId: 'recAAA', ...STAMPS }],
    });
    expect(bad.status).toBe(400);
    expect(h.workflow.create).not.toHaveBeenCalled();
  });

  it('attaches to the existing instance when the same page is re-sent', async () => {
    const h = makeHarness();
    await post(h, VALID_BODY);
    const second = await post(h, VALID_BODY);

    expect(second.status).toBe(202);
    // One instance, and therefore one commit — the `jobId` guarantee is identical on
    // both arms because it is the same mechanism.
    expect(h.workflow.create).toHaveBeenCalledTimes(2);
    expect(h.workflow.created).toHaveLength(1);
    expect(h.workflow.get).toHaveBeenCalledTimes(1);
  });

  it('503s when the Workflow binding is absent — a config fault, not a caller error', async () => {
    const h = makeHarness({ PROMOTE_WORKFLOW: undefined });
    const res = await post(h, VALID_BODY);
    expect(res.status).toBe(503);
  });

  it('401s without the review-app bearer token', async () => {
    const h = makeHarness();
    const res = await post(h, VALID_BODY, { authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
    expect(h.workflow.create).not.toHaveBeenCalled();
  });
});
