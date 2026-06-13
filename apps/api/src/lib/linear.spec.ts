import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

// Mock the Datadog adapter so we can assert outcome metrics + error logs without
// a real DD_API_KEY (the real helpers no-op without one — we want to see calls).
vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
}));

import { logToDatadog, submitCount, submitDistribution } from '../datadog';
import {
  ASSIGNEE_IDS,
  AECI_TEAM_ID,
  createLinearIssueForRequest,
  LABEL_IDS,
  labelIdsFor,
  type LinearIssueInput,
  type LinearPersistClient,
  type LinearResolutionInput,
  type LinearSyncPersistClient,
  pickAssignee,
  pushRequestResolutionToLinear,
  VENDOR_REQUESTS_PROJECT_ID,
  WORKFLOW_STATE_IDS,
} from './linear';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const INPUT: LinearIssueInput = {
  requestId: REQUEST_ID,
  workflowId: 'wf_1',
  kind: 'correction',
  targetType: 'product',
  targetName: 'Acme Build',
  slug: 'acme-build',
  submitterEmail: 'reporter@example.com',
  body: 'The founding year on this listing is wrong.',
};

function ctx(envOverrides: Record<string, unknown> = {}) {
  return {
    env: { ...TEST_ENV, LINEAR_API_KEY: 'lin_test', ...envOverrides },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://api.test/api/requests/correction') },
  };
}

// In-memory persist client; records every updateMany so we can assert the link-back.
function makePrisma(
  opts: { existingLinearId?: string | null; throwOnRead?: boolean; throwOnWrite?: boolean } = {},
) {
  const updates: Array<{
    model: string;
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  const client = {
    vendorRequest: {
      async findUnique() {
        if (opts.throwOnRead) throw new Error('db read failed');
        return { linearIssueId: opts.existingLinearId ?? null };
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        if (opts.throwOnWrite) throw new Error('db write failed');
        updates.push({ model: 'vendorRequest', where, data });
        return { count: 1 };
      },
    },
    workflowInstance: {
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        if (opts.throwOnWrite) throw new Error('db write failed');
        updates.push({ model: 'workflowInstance', where, data });
        return { count: 1 };
      },
    },
  } as unknown as LinearPersistClient;
  return { client, updates };
}

// ── Fetch mock keyed on the GraphQL operation ──
type FetchHandler = () => Response | Promise<Response>;

function issueOk(id = 'iss_123'): Response {
  return new Response(
    JSON.stringify({
      data: {
        issueCreate: {
          success: true,
          issue: { id, identifier: 'AECI-901', url: 'https://linear.app/x' },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function attachOk(): Response {
  return new Response(
    JSON.stringify({ data: { attachmentCreate: { success: true, attachment: { id: 'att_1' } } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function graphqlErrors(): Response {
  return new Response(JSON.stringify({ errors: [{ message: 'unknown label id' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(handlers: { issue?: FetchHandler; attach?: FetchHandler } = {}) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (parsed.query.includes('issueCreate')) return (handlers.issue ?? issueOk)();
    if (parsed.query.includes('attachmentCreate')) return (handlers.attach ?? attachOk)();
    throw new Error(`unexpected query: ${parsed.query.slice(0, 40)}`);
  }) as unknown as typeof fetch;
}

/** Pull the first `outcome:*` tag from the most recent submitCount call. */
function lastOutcome(): string | undefined {
  const calls = vi.mocked(submitCount).mock.calls;
  const tags = (calls.at(-1)?.[5] ?? []) as string[];
  return tags.find((t) => t.startsWith('outcome:'));
}
function lastTags(): string[] {
  return (vi.mocked(submitCount).mock.calls.at(-1)?.[5] ?? []) as string[];
}

beforeEach(() => vi.clearAllMocks());

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('createLinearIssueForRequest — issue creation', () => {
  it('creates the issue and links the id onto both the request row and workflow instance', async () => {
    const fetchImpl = mockFetch();
    const { client, updates } = makePrisma();

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    // issueCreate was called against the Linear endpoint with the right input.
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe('https://api.linear.app/graphql');
    expect((init!.headers as Record<string, string>).authorization).toBe('lin_test');
    const sent = JSON.parse(String(init!.body)) as {
      variables: { input: Record<string, unknown> };
    };
    expect(sent.variables.input).toMatchObject({
      teamId: AECI_TEAM_ID,
      projectId: VENDOR_REQUESTS_PROJECT_ID,
      title: 'Correction: Acme Build (product)',
      labelIds: [LABEL_IDS.correction],
      assigneeId: ASSIGNEE_IDS[0],
    });
    expect(sent.variables.input.description).toContain(`Request: ${REQUEST_ID}`);
    expect(sent.variables.input.description).toContain(INPUT.submitterEmail);

    // Both rows linked by PK via compare-and-set (linearIssueId:null guard).
    expect(updates).toEqual([
      {
        model: 'vendorRequest',
        where: { id: REQUEST_ID, linearIssueId: null },
        data: { linearIssueId: 'iss_123' },
      },
      {
        model: 'workflowInstance',
        where: { id: 'wf_1', linearIssueId: null },
        data: { linearIssueId: 'iss_123' },
      },
    ]);

    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:ok', 'kind:correction']));
    expect(submitDistribution).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.issue.duration_ms',
      expect.any(Number),
      ['outcome:ok'],
    );
  });

  it('attaches the Source URL when present', async () => {
    const fetchImpl = mockFetch();
    const { client } = makePrisma();

    await createLinearIssueForRequest(
      ctx(),
      client,
      { ...INPUT, sourceUrl: 'https://proof.example' },
      fetchImpl,
    );

    const attachCall = vi
      .mocked(fetchImpl)
      .mock.calls.find((c) => String(c[1]?.body).includes('attachmentCreate'));
    expect(attachCall).toBeDefined();
    const sent = JSON.parse(String(attachCall![1]!.body)) as {
      variables: { input: Record<string, unknown> };
    };
    expect(sent.variables.input).toEqual({
      issueId: 'iss_123',
      title: 'Source URL',
      url: 'https://proof.example',
    });
    expect(lastOutcome()).toBe('outcome:ok');
  });

  it('still links the issue when attachmentCreate fails (best-effort)', async () => {
    const fetchImpl = mockFetch({ attach: graphqlErrors });
    const { client, updates } = makePrisma();

    await createLinearIssueForRequest(
      ctx(),
      client,
      { ...INPUT, sourceUrl: 'https://proof.example' },
      fetchImpl,
    );

    expect(updates).toHaveLength(2); // persisted despite attach failure
    expect(lastOutcome()).toBe('outcome:ok');
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn' }),
    );
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────────

describe('createLinearIssueForRequest — idempotency', () => {
  it('skips creation when the request is already linked (no double-create)', async () => {
    const fetchImpl = mockFetch();
    const { client, updates } = makePrisma({ existingLinearId: 'iss_existing' });

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(lastTags()).toEqual(
      expect.arrayContaining(['outcome:skipped_exists', 'kind:correction']),
    );
  });
});

// ─── Failure paths ──────────────────────────────────────────────────────────

describe('createLinearIssueForRequest — failure handling', () => {
  it('treats a 200-with-errors body as a failure and leaves the row unlinked', async () => {
    const fetchImpl = mockFetch({ issue: graphqlErrors });
    const { client, updates } = makePrisma();

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    expect(updates).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:graphql_error']));
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('treats success:false as a failure', async () => {
    const fetchImpl = mockFetch({
      issue: () =>
        new Response(JSON.stringify({ data: { issueCreate: { success: false, issue: null } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { client, updates } = makePrisma();

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    expect(updates).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:graphql_error']));
  });

  it('treats a non-2xx response as http_error', async () => {
    const fetchImpl = mockFetch({ issue: () => new Response('{}', { status: 500 }) });
    const { client, updates } = makePrisma();

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    expect(updates).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:http_error']));
  });

  it('treats a network rejection as a failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const { client, updates } = makePrisma();

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    expect(updates).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:network']));
  });

  it('treats a timeout abort as a failure', async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;
    const { client } = makePrisma();

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:timeout']));
  });

  it('fails as db_error (and does not call Linear) when the idempotency read throws', async () => {
    const fetchImpl = mockFetch();
    const { client } = makePrisma({ throwOnRead: true });

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:db_error']));
  });

  it('fails as db_error when the link-back write throws (issue created but unlinked)', async () => {
    const fetchImpl = mockFetch();
    const { client } = makePrisma({ throwOnWrite: true });

    await createLinearIssueForRequest(ctx(), client, INPUT, fetchImpl);

    expect(fetchImpl).toHaveBeenCalled(); // issue was created
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:db_error']));
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('is a silent no-op (no fetch, no metric) when LINEAR_API_KEY is absent', async () => {
    const fetchImpl = mockFetch();
    const { client, updates } = makePrisma();

    await createLinearIssueForRequest(ctx({ LINEAR_API_KEY: undefined }), client, INPUT, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(submitCount).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('pickAssignee', () => {
  it('is deterministic and returns Chris for the single-member pool', () => {
    expect(pickAssignee(REQUEST_ID)).toBe(ASSIGNEE_IDS[0]);
    expect(pickAssignee(REQUEST_ID)).toBe(pickAssignee(REQUEST_ID));
  });

  it('balances across a multi-member pool deterministically', () => {
    const pool = ['a', 'b'];
    const first = pickAssignee(REQUEST_ID, pool);
    expect(pool).toContain(first);
    expect(pickAssignee(REQUEST_ID, pool)).toBe(first); // stable across retries
    // A different request id can land on the other member.
    expect(pickAssignee('22222222-2222-4222-8222-222222222222', pool)).toBeDefined();
  });

  it('returns undefined for an empty pool', () => {
    expect(pickAssignee(REQUEST_ID, [])).toBeUndefined();
  });
});

describe('labelIdsFor', () => {
  it('returns the kind label only when there is no domain mismatch', () => {
    expect(labelIdsFor('claim')).toEqual([LABEL_IDS.claim]);
    expect(labelIdsFor('correction', 'pending')).toEqual([LABEL_IDS.correction]);
    expect(labelIdsFor('correction', 'match')).toEqual([LABEL_IDS.correction]);
  });

  it('adds the domain-check-pending label on a mismatch', () => {
    expect(labelIdsFor('claim', 'no_match')).toEqual([
      LABEL_IDS.claim,
      LABEL_IDS.domainCheckPending,
    ]);
  });
});

// ─── Site → Linear sync (AECI-213 / Phase 6.6) ───────────────────────────────

const STATE_DONE = { id: WORKFLOW_STATE_IDS.resolved, name: 'Done', type: 'completed' };
const STATE_CANCELED = { id: WORKFLOW_STATE_IDS.rejected, name: 'Canceled', type: 'canceled' };

const RESOLUTION_INPUT: LinearResolutionInput = {
  requestId: REQUEST_ID,
  workflowId: 'wf_1',
  linearIssueId: 'iss_1',
  kind: 'claim',
  toStatus: 'resolved',
};

function issueUpdateOk(state: { id: string; name: string; type: string } = STATE_DONE): Response {
  return new Response(
    JSON.stringify({
      data: {
        issueUpdate: { success: true, issue: { id: 'iss_1', identifier: 'AECI-901', state } },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function commentOk(): Response {
  return new Response(
    JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'cmt_1' } } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockSyncFetch(handlers: { update?: FetchHandler; comment?: FetchHandler } = {}) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { query: string };
    if (parsed.query.includes('issueUpdate')) return (handlers.update ?? (() => issueUpdateOk()))();
    if (parsed.query.includes('commentCreate')) return (handlers.comment ?? commentOk)();
    throw new Error(`unexpected query: ${parsed.query.slice(0, 40)}`);
  }) as unknown as typeof fetch;
}

/** In-memory persist client; records every workflow_transitions insert. */
function makeSyncPrisma(opts: { throwOnTransition?: boolean } = {}) {
  const transitions: Array<Record<string, unknown>> = [];
  const client = {
    workflowTransition: {
      async create({ data }: { data: Record<string, unknown> }) {
        if (opts.throwOnTransition) throw new Error('db write failed');
        transitions.push(data);
        return data;
      },
    },
  } as unknown as LinearSyncPersistClient;
  return { client, transitions };
}

function findCall(fetchImpl: typeof fetch, op: string) {
  return vi.mocked(fetchImpl).mock.calls.find((c) => String(c[1]?.body).includes(op));
}
function sentVars(init: RequestInit | undefined): {
  id?: string;
  input: Record<string, unknown>;
} {
  return (
    JSON.parse(String(init!.body)) as {
      variables: { id?: string; input: Record<string, unknown> };
    }
  ).variables;
}

describe('pushRequestResolutionToLinear — resolve', () => {
  it('transitions the issue to Done, comments, and records the open→resolved transition', async () => {
    const fetchImpl = mockSyncFetch();
    const { client, transitions } = makeSyncPrisma();

    await pushRequestResolutionToLinear(ctx(), client, RESOLUTION_INPUT, fetchImpl);

    // issueUpdate hit the Linear endpoint with the resolved (Done) state id.
    const updateCall = findCall(fetchImpl, 'issueUpdate')!;
    expect(String(updateCall[0])).toBe('https://api.linear.app/graphql');
    expect((updateCall[1]!.headers as Record<string, string>).authorization).toBe('lin_test');
    const update = sentVars(updateCall[1]);
    expect(update.id).toBe('iss_1');
    expect(update.input).toEqual({ stateId: WORKFLOW_STATE_IDS.resolved });

    // a comment was posted to the same issue, mentioning the resolution.
    const comment = sentVars(findCall(fetchImpl, 'commentCreate')![1]);
    expect(comment.input.issueId).toBe('iss_1');
    expect(String(comment.input.body)).toContain('resolved');

    // exactly one transition, carrying the site-linear-sync provenance.
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      workflowId: 'wf_1',
      fromState: 'open',
      toState: 'resolved',
      actorId: null,
    });
    expect(transitions[0]!.metadata).toMatchObject({
      source: 'site-linear-sync',
      actor_type: 'admin',
      linear_issue_id: 'iss_1',
      linear_state_id: WORKFLOW_STATE_IDS.resolved,
      linear_state_name: 'Done',
      linear_state_type: 'completed',
    });

    expect(lastTags()).toEqual(
      expect.arrayContaining(['outcome:ok', 'kind:claim', 'to_status:resolved']),
    );
    expect(submitDistribution).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.sync.duration_ms',
      expect.any(Number),
      ['outcome:ok'],
    );
  });
});

describe('pushRequestResolutionToLinear — reject', () => {
  it('transitions to Canceled and threads the actor + reason into the comment and transition', async () => {
    const fetchImpl = mockSyncFetch({ update: () => issueUpdateOk(STATE_CANCELED) });
    const { client, transitions } = makeSyncPrisma();

    await pushRequestResolutionToLinear(
      ctx(),
      client,
      {
        ...RESOLUTION_INPUT,
        toStatus: 'rejected',
        fromStatus: 'in_review',
        reason: 'Duplicate of an existing claim.',
        actorId: 'admin_1',
        actorLabel: 'chris@aeci.test',
      },
      fetchImpl,
    );

    expect(sentVars(findCall(fetchImpl, 'issueUpdate')![1]).input).toEqual({
      stateId: WORKFLOW_STATE_IDS.rejected,
    });

    const body = String(sentVars(findCall(fetchImpl, 'commentCreate')![1]).input.body);
    expect(body).toContain('rejected');
    expect(body).toContain('chris@aeci.test');
    expect(body).toContain('Duplicate of an existing claim.');

    expect(transitions[0]).toMatchObject({
      fromState: 'in_review',
      toState: 'rejected',
      actorId: 'admin_1',
      reason: 'Duplicate of an existing claim.',
    });
    expect(transitions[0]!.metadata).toMatchObject({
      linear_state_name: 'Canceled',
      linear_state_type: 'canceled',
    });
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:ok', 'to_status:rejected']));
  });
});

describe('pushRequestResolutionToLinear — tolerance & failure', () => {
  it('skips (skip + info-log, no error, no transition) when linear_issue_id is null', async () => {
    const fetchImpl = mockSyncFetch();
    const { client, transitions } = makeSyncPrisma();

    await pushRequestResolutionToLinear(
      ctx(),
      client,
      { ...RESOLUTION_INPUT, linearIssueId: null },
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(transitions).toHaveLength(0);
    expect(lastTags()).toEqual(
      expect.arrayContaining(['outcome:skipped_no_issue', 'kind:claim', 'to_status:resolved']),
    );
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'info' }),
    );
  });

  it('is a silent no-op (no fetch, no metric, no transition) when LINEAR_API_KEY is absent', async () => {
    const fetchImpl = mockSyncFetch();
    const { client, transitions } = makeSyncPrisma();

    await pushRequestResolutionToLinear(
      ctx({ LINEAR_API_KEY: undefined }),
      client,
      RESOLUTION_INPUT,
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(submitCount).not.toHaveBeenCalled();
    expect(transitions).toHaveLength(0);
  });

  it('treats a 200-with-errors issueUpdate as failed: no comment, no transition', async () => {
    const fetchImpl = mockSyncFetch({ update: graphqlErrors });
    const { client, transitions } = makeSyncPrisma();

    await pushRequestResolutionToLinear(ctx(), client, RESOLUTION_INPUT, fetchImpl);

    expect(transitions).toHaveLength(0);
    expect(findCall(fetchImpl, 'commentCreate')).toBeUndefined();
    expect(lastTags()).toEqual(
      expect.arrayContaining(['outcome:failed', 'reason:graphql_error', 'to_status:resolved']),
    );
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('treats issueUpdate success:false as failed', async () => {
    const fetchImpl = mockSyncFetch({
      update: () =>
        new Response(JSON.stringify({ data: { issueUpdate: { success: false, issue: null } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { client, transitions } = makeSyncPrisma();

    await pushRequestResolutionToLinear(ctx(), client, RESOLUTION_INPUT, fetchImpl);

    expect(transitions).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:graphql_error']));
  });

  it('still records the transition when the comment fails (best-effort)', async () => {
    const fetchImpl = mockSyncFetch({ comment: graphqlErrors });
    const { client, transitions } = makeSyncPrisma();

    await pushRequestResolutionToLinear(ctx(), client, RESOLUTION_INPUT, fetchImpl);

    expect(transitions).toHaveLength(1); // recorded despite the comment failure
    expect(lastOutcome()).toBe('outcome:ok');
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn' }),
    );
  });

  it('fails as db_error (no throw) when the transition write throws', async () => {
    const fetchImpl = mockSyncFetch();
    const { client, transitions } = makeSyncPrisma({ throwOnTransition: true });

    await pushRequestResolutionToLinear(ctx(), client, RESOLUTION_INPUT, fetchImpl);

    expect(transitions).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:db_error']));
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'error' }),
    );
  });
});
