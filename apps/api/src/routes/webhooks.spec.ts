/**
 * Inbound Linear webhook (AECI-212 / Phase 6.5) on the Drizzle/D1 path (ADR 0016 /
 * AECI-253), against the in-memory D1 harness. Seeds a real workflow instance +
 * vendor request and asserts the real status update / instance mirror / transition
 * / audit rows the atomic `db.batch` writes (or the absence of any write on a
 * no-op / rejected request).
 */

import { createHmac } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, vendorRequests, workflowInstances, workflowTransitions } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createLinearWebhookHandler } from './webhooks';

const SECRET = 'whsec_test_linear_signing_secret';
const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const WORKFLOW_ID = '33333333-3333-4333-8333-333333333333';

const env: Env = { ...TEST_ENV, LINEAR_WEBHOOK_SIGNING_SECRET: SECRET };
const envNoSecret: Env = { ...TEST_ENV };

type Rec = Record<string, unknown>;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/** Seed the workflow instance + its vendor request the webhook resolves. */
async function seed(
  opts: {
    workflowType?: string;
    linearIssueId?: string | null;
    currentState?: string;
    requestStatus?: string;
    omitRequest?: boolean;
  } = {},
) {
  if (!opts.omitRequest) {
    await t.db.insert(vendorRequests).values({
      id: REQUEST_ID,
      kind: 'claim',
      targetType: 'vendor',
      targetId: 'tgt-1',
      submitterEmail: 'submitter@vendor.com',
      body: 'A seeded vendor request.',
      status: opts.requestStatus ?? 'open',
    });
  }
  await t.db.insert(workflowInstances).values({
    id: WORKFLOW_ID,
    workflowType: opts.workflowType ?? 'vendor_claim',
    entityId: REQUEST_ID,
    currentState: opts.currentState ?? 'open',
    linearIssueId: opts.linearIssueId === undefined ? ISSUE_ID : opts.linearIssueId,
  });
}

const app = () =>
  buildAppWithHandler({
    method: 'post',
    path: '/api/webhooks/linear',
    handler: createLinearWebhookHandler(t.factory),
  });

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
    data.state = { id: 'state-1', name: opts.stateName ?? 'Done', type: opts.stateType ?? 'completed' };
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

/** POST a payload signed with `SECRET` and return the Response. */
function post(body: Rec, opts: { environment?: Env; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  return app().request(
    '/api/webhooks/linear',
    webhookInit(raw, opts.signature ?? sign(raw)),
    opts.environment ?? env,
    fakeExecutionContext(),
  );
}

const allAudits = () => t.db.select().from(auditLog);
const allTransitions = () => t.db.select().from(workflowTransitions);
const requestRow = () =>
  t.db.query.vendorRequests.findFirst({ where: eq(vendorRequests.id, REQUEST_ID) });
const workflowRow = () =>
  t.db.query.workflowInstances.findFirst({ where: eq(workflowInstances.id, WORKFLOW_ID) });

async function expectNoWrites() {
  expect(await allAudits()).toHaveLength(0);
  expect(await allTransitions()).toHaveLength(0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/linear — HMAC verification', () => {
  it('rejects an invalid signature with 401 and writes nothing', async () => {
    await seed();
    const res = await post(issuePayload(), { signature: 'deadbeef' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
    await expectNoWrites();
  });

  it('rejects a missing Linear-Signature header with 401', async () => {
    await seed();
    const raw = JSON.stringify(issuePayload());
    const res = await app().request(
      '/api/webhooks/linear',
      webhookInit(raw), // no signature
      env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
    await expectNoWrites();
  });

  it('fails closed (401) when the signing secret is unset', async () => {
    await seed();
    const res = await post(issuePayload(), { environment: envNoSecret });
    expect(res.status).toBe(401);
    await expectNoWrites();
  });
});

describe('POST /api/webhooks/linear — state → status mapping', () => {
  it('maps completed → resolved: updates status, mirrors the instance, records transition + audit', async () => {
    await seed();
    const res = await post(issuePayload({ stateType: 'completed', stateName: 'Done' }));

    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ ok: true, applied: true });

    const request = await requestRow();
    expect(request!.status).toBe('resolved');
    expect(request!.resolvedAt).not.toBeNull();

    const wf = await workflowRow();
    expect(wf!.currentState).toBe('resolved');
    expect(wf!.finalOutcome).toBe('completed');
    expect(wf!.completedAt).not.toBeNull();

    const transitions = await allTransitions();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      workflowId: WORKFLOW_ID,
      fromState: 'open',
      toState: 'resolved',
      actorId: null,
    });
    expect(transitions[0]!.metadata).toMatchObject({
      source: 'linear-webhook',
      actor_type: 'workflow',
      linear_action: 'update',
      linear_issue_id: ISSUE_ID,
      linear_state_type: 'completed',
      linear_state_name: 'Done',
    });

    const audits = await allAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'workflow',
      action: 'vendor_request.status_changed',
      entityType: 'vendor_request',
      entityId: REQUEST_ID,
      beforeState: { status: 'open' },
      afterState: { status: 'resolved' },
    });
  });

  it('maps canceled → rejected with finalOutcome rejected', async () => {
    await seed();
    const res = await post(issuePayload({ stateType: 'canceled', stateName: 'Canceled' }));
    expect(res.status).toBe(200);
    expect((await requestRow())!.status).toBe('rejected');
    const wf = await workflowRow();
    expect(wf!.currentState).toBe('rejected');
    expect(wf!.finalOutcome).toBe('rejected');
    expect((await allTransitions())[0]).toMatchObject({ fromState: 'open', toState: 'rejected' });
  });

  it('maps started → in_review without resolving (non-terminal)', async () => {
    await seed();
    const res = await post(issuePayload({ stateType: 'started', stateName: 'In Progress' }));
    expect(res.status).toBe(200);
    const request = await requestRow();
    expect(request!.status).toBe('in_review');
    expect(request!.resolvedAt).toBeNull(); // set/cleared, never left stale
    const wf = await workflowRow();
    expect(wf!.currentState).toBe('in_review');
    expect(wf!.completedAt).toBeNull();
    expect(wf!.finalOutcome).toBeNull();
  });

  it('clears resolvedAt/completedAt/finalOutcome when a resolved request is reopened', async () => {
    // Reverse transition: an admin moves a Done issue back to In Progress
    // (resolved → in_review). The terminal fields must be cleared, not left stale.
    await seed({ currentState: 'resolved', requestStatus: 'resolved' });
    // Pre-set the terminal fields so we can prove they are cleared.
    await t.db
      .update(vendorRequests)
      .set({ resolvedAt: '2026-06-01T00:00:00.000Z' })
      .where(eq(vendorRequests.id, REQUEST_ID));
    await t.db
      .update(workflowInstances)
      .set({ completedAt: '2026-06-01T00:00:00.000Z', finalOutcome: 'completed' })
      .where(eq(workflowInstances.id, WORKFLOW_ID));

    const res = await post(issuePayload({ stateType: 'started', stateName: 'In Progress' }));
    expect(res.status).toBe(200);
    const request = await requestRow();
    expect(request!.status).toBe('in_review');
    expect(request!.resolvedAt).toBeNull();
    const wf = await workflowRow();
    expect(wf!.currentState).toBe('in_review');
    expect(wf!.completedAt).toBeNull();
    expect(wf!.finalOutcome).toBeNull();
    expect((await allTransitions())[0]).toMatchObject({
      fromState: 'resolved',
      toState: 'in_review',
    });
  });
});

describe('POST /api/webhooks/linear — no-ops', () => {
  it('is a no-op for an unknown issue id', async () => {
    await seed({ linearIssueId: 'some-other-issue' });
    const res = await post(issuePayload());
    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false, reason: 'unknown issue' });
    await expectNoWrites();
  });

  it('scopes the lookup to vendor-request workflow types (ignores review_moderation)', async () => {
    // A review_moderation instance with the SAME linear_issue_id must not match.
    await seed({ workflowType: 'review_moderation' });
    const res = await post(issuePayload());
    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false, reason: 'unknown issue' });
    await expectNoWrites();
  });

  it('is a no-op when the workflow instance is orphaned (request missing)', async () => {
    await seed({ omitRequest: true });
    const res = await post(issuePayload());
    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false });
    await expectNoWrites();
  });

  it('is a no-op for a non-Issue payload type', async () => {
    await seed();
    const res = await post(issuePayload({ type: 'Comment' }));
    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false });
    await expectNoWrites();
  });

  it('is a no-op for a create action (only state changes sync)', async () => {
    await seed();
    const res = await post(issuePayload({ action: 'create' }));
    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false });
    await expectNoWrites();
  });

  it('is a no-op when the issue carries no state', async () => {
    await seed();
    const res = await post(issuePayload({ omitState: true }));
    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false });
    await expectNoWrites();
  });

  it('is a no-op when the mapped status already matches', async () => {
    await seed({ requestStatus: 'resolved' });
    const res = await post(issuePayload({ stateType: 'completed' }));
    expect(res.status).toBe(200);
    expect((await res.json()) as Rec).toMatchObject({ applied: false, reason: 'already in sync' });
    await expectNoWrites();
  });
});

describe('POST /api/webhooks/linear — request validation', () => {
  it('returns 400 MALFORMED_REQUEST for a body that is not valid JSON', async () => {
    await seed();
    const raw = '{ not valid json';
    const res = await app().request(
      '/api/webhooks/linear',
      webhookInit(raw, sign(raw)), // signed over the malformed bytes → passes HMAC
      env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MALFORMED_REQUEST');
    await expectNoWrites();
  });

  it('returns 400 VALIDATION_FAILED when the payload misses required fields', async () => {
    await seed();
    const res = await post({ action: 'update', type: 'Issue' } as Rec);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    await expectNoWrites();
  });
});
