import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createLinearWebhookHandler } from './webhooks';

// ─── In-memory fake ───────────────────────────────────────────────────────────
// Covers the slice the handler touches: `workflowInstance.findFirst`/`update`,
// `vendorRequest.findUnique`/`update`, `workflowTransition.create`,
// `auditLog.create`, and `$transaction` (runs the callback against the same
// models, like the real client). `findFirst`/`findUnique` return preset rows so
// each test drives a specific lookup outcome.
type Rec = Record<string, unknown>;

interface FakeOptions {
  workflow?: Rec | null; // workflowInstance.findFirst result
  request?: Rec | null; // vendorRequest.findUnique result
}

function makeFake(opts: FakeOptions = {}) {
  const findFirstArgs: Rec[] = [];
  const requestUpdates: Rec[] = [];
  const instanceUpdates: Rec[] = [];
  const transitions: Rec[] = [];
  const audit: Rec[] = [];

  const models = {
    workflowInstance: {
      async findFirst(args: Rec) {
        findFirstArgs.push(args);
        return (opts.workflow ?? null) as Rec | null;
      },
      async update({ where, data }: { where: Rec; data: Rec }) {
        instanceUpdates.push({ where, data });
        return { id: where.id };
      },
    },
    vendorRequest: {
      async findUnique(_args: Rec) {
        return (opts.request ?? null) as Rec | null;
      },
      async update({ where, data }: { where: Rec; data: Rec }) {
        requestUpdates.push({ where, data });
        return { id: where.id };
      },
    },
    workflowTransition: {
      async create({ data }: { data: Rec }) {
        transitions.push(data);
        return data;
      },
    },
    auditLog: {
      async create({ data }: { data: Rec }) {
        audit.push(data);
        return data;
      },
    },
    $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(models);
    },
  };

  return { models, findFirstArgs, requestUpdates, instanceUpdates, transitions, audit };
}

// ─── Fixtures + helpers ───────────────────────────────────────────────────────

const SECRET = 'whsec_test_linear_signing_secret';
const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW = { id: 'wf_1', entityId: 'req_1', currentState: 'open' };
const REQUEST = { id: 'req_1', status: 'open' };

const env: Env = { ...TEST_ENV, LINEAR_WEBHOOK_SIGNING_SECRET: SECRET };
const envNoSecret: Env = { ...TEST_ENV };

function app(prisma: unknown) {
  return buildAppWithHandler({
    method: 'post',
    path: '/api/webhooks/linear',
    handler: createLinearWebhookHandler(() => prisma as never),
  });
}

function sign(raw: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

interface PayloadOpts {
  id?: string;
  action?: 'create' | 'update' | 'remove';
  type?: string;
  stateType?: string;
  stateName?: string;
  omitState?: boolean;
}

function issuePayload(opts: PayloadOpts = {}): Rec {
  const data: Rec = { id: opts.id ?? ISSUE_ID, title: 'Claim: Acme' };
  if (!opts.omitState) {
    data.state = {
      id: 'state-1',
      name: opts.stateName ?? 'Done',
      type: opts.stateType ?? 'completed',
    };
  }
  return {
    action: opts.action ?? 'update',
    type: opts.type ?? 'Issue',
    data,
    url: 'https://linear.app/acme/issue/AECI-1',
    createdAt: '2026-06-12T00:00:00.000Z',
    organizationId: 'org-1',
    webhookTimestamp: 1_749_600_000_000,
  };
}

function webhookInit(raw: string, signature?: string): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== undefined) headers['Linear-Signature'] = signature;
  return { method: 'POST', headers, body: raw };
}

/** POST a payload signed with `SECRET` (the valid header) and return the
 *  Response. `environment` lets a test point the Worker at a different secret
 *  (or none) to exercise the fail-closed path. */
function post(prisma: unknown, body: Rec, opts: { environment?: Env } = {}) {
  const raw = JSON.stringify(body);
  return app(prisma).request(
    '/api/webhooks/linear',
    webhookInit(raw, sign(raw)),
    opts.environment ?? env,
    fakeExecutionContext(),
  );
}

function expectNoWrites(fake: ReturnType<typeof makeFake>) {
  expect(fake.requestUpdates).toHaveLength(0);
  expect(fake.instanceUpdates).toHaveLength(0);
  expect(fake.transitions).toHaveLength(0);
  expect(fake.audit).toHaveLength(0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/linear — HMAC verification', () => {
  it('rejects an invalid signature with 401 and writes nothing', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const raw = JSON.stringify(issuePayload());
    const res = await app(fake.models).request(
      '/api/webhooks/linear',
      webhookInit(raw, 'deadbeef'),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expectNoWrites(fake);
  });

  it('rejects a missing Linear-Signature header with 401', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const raw = JSON.stringify(issuePayload());
    const res = await app(fake.models).request(
      '/api/webhooks/linear',
      webhookInit(raw), // no signature
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(401);
    expectNoWrites(fake);
  });

  it('fails closed (401) when the signing secret is unset', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    // Signature is computed with the right secret, but the Worker has none.
    const res = await post(fake.models, issuePayload(), { environment: envNoSecret });

    expect(res.status).toBe(401);
    expectNoWrites(fake);
  });
});

describe('POST /api/webhooks/linear — state → status mapping', () => {
  it('maps completed → resolved: updates status, mirrors the instance, and records transition + audit', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const res = await post(
      fake.models,
      issuePayload({ stateType: 'completed', stateName: 'Done' }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ ok: true, applied: true });

    // Scoped lookup: by Linear issue id, vendor-request workflow types only.
    expect(fake.findFirstArgs[0].where).toMatchObject({
      linearIssueId: ISSUE_ID,
      workflowType: { in: ['vendor_claim', 'correction_request'] },
    });

    expect(fake.requestUpdates).toHaveLength(1);
    expect(fake.requestUpdates[0]).toMatchObject({
      where: { id: 'req_1' },
      data: { status: 'resolved' },
    });
    expect((fake.requestUpdates[0].data as Rec).resolvedAt).toBeInstanceOf(Date);

    expect(fake.instanceUpdates).toHaveLength(1);
    expect(fake.instanceUpdates[0].data).toMatchObject({
      currentState: 'resolved',
      finalOutcome: 'completed',
    });
    expect((fake.instanceUpdates[0].data as Rec).completedAt).toBeInstanceOf(Date);

    expect(fake.transitions).toHaveLength(1);
    expect(fake.transitions[0]).toMatchObject({
      workflowId: 'wf_1',
      fromState: 'open',
      toState: 'resolved',
      actorId: null,
    });
    const tMeta = fake.transitions[0].metadata as Rec;
    expect(tMeta).toMatchObject({
      source: 'linear-webhook',
      actor_type: 'workflow',
      linear_action: 'update',
      linear_issue_id: ISSUE_ID,
      linear_state_type: 'completed',
      linear_state_name: 'Done',
    });

    expect(fake.audit).toHaveLength(1);
    expect(fake.audit[0]).toMatchObject({
      actorType: 'workflow',
      action: 'vendor_request.status_changed',
      entityType: 'vendor_request',
      entityId: 'req_1',
      beforeState: { status: 'open' },
      afterState: { status: 'resolved' },
    });
  });

  it('maps canceled → rejected with finalOutcome rejected', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const res = await post(
      fake.models,
      issuePayload({ stateType: 'canceled', stateName: 'Canceled' }),
    );

    expect(res.status).toBe(200);
    expect(fake.requestUpdates[0].data).toMatchObject({ status: 'rejected' });
    expect(fake.instanceUpdates[0].data).toMatchObject({
      currentState: 'rejected',
      finalOutcome: 'rejected',
    });
    expect(fake.transitions[0]).toMatchObject({ fromState: 'open', toState: 'rejected' });
  });

  it('maps started → in_review without resolving (non-terminal)', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const res = await post(
      fake.models,
      issuePayload({ stateType: 'started', stateName: 'In Progress' }),
    );

    expect(res.status).toBe(200);
    expect(fake.requestUpdates[0].data).toMatchObject({ status: 'in_review' });
    // Non-terminal: resolution fields are written null (set/cleared, never left
    // stale), not omitted.
    expect((fake.requestUpdates[0].data as Rec).resolvedAt).toBeNull();
    expect(fake.instanceUpdates[0].data).toMatchObject({ currentState: 'in_review' });
    expect((fake.instanceUpdates[0].data as Rec).completedAt).toBeNull();
    expect((fake.instanceUpdates[0].data as Rec).finalOutcome).toBeNull();
  });

  it('clears resolvedAt/completedAt/finalOutcome when a resolved request is reopened', async () => {
    // Reverse transition: an admin moves a Done issue back to In Progress, so
    // resolved → in_review. The terminal fields must be cleared, not left stale.
    const fake = makeFake({
      workflow: { ...WORKFLOW, currentState: 'resolved' },
      request: { id: 'req_1', status: 'resolved' },
    });
    const res = await post(
      fake.models,
      issuePayload({ stateType: 'started', stateName: 'In Progress' }),
    );

    expect(res.status).toBe(200);
    expect(fake.requestUpdates[0].data).toMatchObject({ status: 'in_review' });
    expect((fake.requestUpdates[0].data as Rec).resolvedAt).toBeNull();
    expect(fake.instanceUpdates[0].data).toMatchObject({ currentState: 'in_review' });
    expect((fake.instanceUpdates[0].data as Rec).completedAt).toBeNull();
    expect((fake.instanceUpdates[0].data as Rec).finalOutcome).toBeNull();
    expect(fake.transitions[0]).toMatchObject({ fromState: 'resolved', toState: 'in_review' });
  });
});

describe('POST /api/webhooks/linear — no-ops', () => {
  it('is a no-op for an unknown issue id', async () => {
    const fake = makeFake({ workflow: null }); // findFirst misses
    const res = await post(fake.models, issuePayload());

    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false, reason: 'unknown issue' });
    expectNoWrites(fake);
  });

  it('is a no-op when the workflow instance is orphaned (request missing)', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: null });
    const res = await post(fake.models, issuePayload());

    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false });
    expectNoWrites(fake);
  });

  it('is a no-op for a non-Issue payload type', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const res = await post(fake.models, issuePayload({ type: 'Comment' }));

    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false });
    expectNoWrites(fake);
  });

  it('is a no-op for a create action (only state changes sync)', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const res = await post(fake.models, issuePayload({ action: 'create' }));

    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false });
    expectNoWrites(fake);
  });

  it('is a no-op when the issue carries no state', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const res = await post(fake.models, issuePayload({ omitState: true }));

    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false });
    expectNoWrites(fake);
  });

  it('is a no-op when the mapped status already matches', async () => {
    const fake = makeFake({
      workflow: { ...WORKFLOW },
      request: { id: 'req_1', status: 'resolved' },
    });
    const res = await post(fake.models, issuePayload({ stateType: 'completed' }));

    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false, reason: 'already in sync' });
    expectNoWrites(fake);
  });
});

describe('POST /api/webhooks/linear — request validation', () => {
  it('returns 400 MALFORMED_REQUEST for a body that is not valid JSON', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const raw = '{ not valid json';
    const res = await app(fake.models).request(
      '/api/webhooks/linear',
      webhookInit(raw, sign(raw)), // signed over the malformed bytes → passes HMAC
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MALFORMED_REQUEST',
    );
    expectNoWrites(fake);
  });

  it('returns 400 VALIDATION_FAILED when the payload misses required fields', async () => {
    const fake = makeFake({ workflow: { ...WORKFLOW }, request: { ...REQUEST } });
    const res = await post(fake.models, { action: 'update', type: 'Issue' } as Rec);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expectNoWrites(fake);
  });
});
