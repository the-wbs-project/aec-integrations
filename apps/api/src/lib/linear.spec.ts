import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

// Mock the Datadog adapter so we can assert outcome metrics + error logs without
// a real DD_API_KEY (the real helpers no-op without one — we want to see calls).
vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
}));

import { profiles, workflowInstances, workflowTransitions } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { logToDatadog, submitCount, submitDistribution } from '../datadog';
import {
  ASSIGNEE_IDS,
  AECI_TEAM_ID,
  createLinearIssueForRequest,
  LABEL_IDS,
  labelIdsFor,
  type LinearIssueInput,
  type LinearRequestStore,
  type LinearResolutionInput,
  pickAssignee,
  pushRequestResolutionToLinear,
  VENDOR_REQUESTS_PROJECT_ID,
  WORKFLOW_STATE_IDS,
} from './linear';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';

const INPUT: LinearIssueInput = {
  requestId: REQUEST_ID,
  workflowId: WORKFLOW_ID,
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

// In-memory `LinearRequestStore`; records every `linkIssue` so we can assert the
// link-back. Replaces the old Prisma-shaped fake (the store is ORM-neutral now).
function makeStore(
  opts: { existingLinearId?: string | null; throwOnRead?: boolean; throwOnWrite?: boolean } = {},
) {
  const links: Array<{ requestId: string; workflowId: string; issueId: string }> = [];
  const store: LinearRequestStore = {
    async getLinkedIssueId() {
      if (opts.throwOnRead) throw new Error('db read failed');
      return opts.existingLinearId ?? null;
    },
    async linkIssue(requestId, workflowId, issueId) {
      if (opts.throwOnWrite) throw new Error('db write failed');
      links.push({ requestId, workflowId, issueId });
    },
  };
  return { store, links };
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
function commentOk(): Response {
  return new Response(
    JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'cmt_1' } } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function graphqlErrors(): Response {
  return new Response(JSON.stringify({ errors: [{ message: 'unknown label id' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(
  handlers: { issue?: FetchHandler; attach?: FetchHandler; comment?: FetchHandler } = {},
) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (parsed.query.includes('issueCreate')) return (handlers.issue ?? issueOk)();
    if (parsed.query.includes('attachmentCreate')) return (handlers.attach ?? attachOk)();
    if (parsed.query.includes('commentCreate')) return (handlers.comment ?? commentOk)();
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

// Per-test in-memory D1 (only the pushRequestResolutionToLinear suites use it; the
// issue-creation suites drive the ORM-neutral store fake).
let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
});
afterEach(() => t.dispose());

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('createLinearIssueForRequest — issue creation', () => {
  it('creates the issue and links the id onto both the request row and workflow instance', async () => {
    const fetchImpl = mockFetch();
    const { store, links } = makeStore();

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

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

    // One `linkIssue` call covers both compare-and-set updates (request + workflow).
    expect(links).toEqual([{ requestId: REQUEST_ID, workflowId: WORKFLOW_ID, issueId: 'iss_123' }]);

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

  it('adds the domain-check-pending label when domainMatch is no_match (§7.1)', async () => {
    const fetchImpl = mockFetch();
    const { store } = makeStore();

    await createLinearIssueForRequest(ctx(), store, { ...INPUT, domainMatch: 'no_match' }, fetchImpl);

    const sent = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]!.body)) as {
      variables: { input: { labelIds: string[] } };
    };
    expect(sent.variables.input.labelIds).toEqual([
      LABEL_IDS.correction,
      LABEL_IDS.domainCheckPending,
    ]);
  });

  it('attaches the Source URL when present', async () => {
    const fetchImpl = mockFetch();
    const { store } = makeStore();

    await createLinearIssueForRequest(
      ctx(),
      store,
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
    const { store, links } = makeStore();

    await createLinearIssueForRequest(
      ctx(),
      store,
      { ...INPUT, sourceUrl: 'https://proof.example' },
      fetchImpl,
    );

    expect(links).toHaveLength(1); // persisted despite attach failure
    expect(lastOutcome()).toBe('outcome:ok');
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn' }),
    );
  });
});

// ─── Duplicate note (§7.2) ────────────────────────────────────────────────────

describe('createLinearIssueForRequest — duplicate note', () => {
  const DUP_INPUT: LinearIssueInput = {
    ...INPUT,
    duplicateOfRequestId: 'req_orig',
    duplicateLinearIssueId: 'iss_orig',
  };

  it('posts an informational comment referencing the original, and still links the issue', async () => {
    const fetchImpl = mockFetch();
    const { store, links } = makeStore();

    await createLinearIssueForRequest(ctx(), store, DUP_INPUT, fetchImpl);

    const commentCall = vi
      .mocked(fetchImpl)
      .mock.calls.find((call) => String(call[1]?.body).includes('commentCreate'));
    expect(commentCall).toBeDefined();
    const sent = JSON.parse(String(commentCall![1]!.body)) as {
      variables: { input: { issueId: string; body: string } };
    };
    expect(sent.variables.input.issueId).toBe('iss_123');
    expect(sent.variables.input.body).toContain('req_orig');
    expect(sent.variables.input.body).toContain('iss_orig');

    expect(links).toHaveLength(1); // issue still linked despite the extra call
    expect(lastOutcome()).toBe('outcome:ok');
  });

  it('posts no comment when there is no duplicate', async () => {
    const fetchImpl = mockFetch();
    const { store } = makeStore();

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

    const commentCall = vi
      .mocked(fetchImpl)
      .mock.calls.find((call) => String(call[1]?.body).includes('commentCreate'));
    expect(commentCall).toBeUndefined();
  });

  it('still links the issue when the duplicate comment fails (best-effort)', async () => {
    const fetchImpl = mockFetch({ comment: graphqlErrors });
    const { store, links } = makeStore();

    await createLinearIssueForRequest(ctx(), store, DUP_INPUT, fetchImpl);

    expect(links).toHaveLength(1);
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
    const { store, links } = makeStore({ existingLinearId: 'iss_existing' });

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(links).toHaveLength(0);
    expect(lastTags()).toEqual(
      expect.arrayContaining(['outcome:skipped_exists', 'kind:correction']),
    );
  });
});

// ─── Failure paths ──────────────────────────────────────────────────────────

describe('createLinearIssueForRequest — failure handling', () => {
  it('treats a 200-with-errors body as a failure and leaves the row unlinked', async () => {
    const fetchImpl = mockFetch({ issue: graphqlErrors });
    const { store, links } = makeStore();

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

    expect(links).toHaveLength(0);
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
    const { store, links } = makeStore();

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

    expect(links).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:graphql_error']));
  });

  it('treats a non-2xx response as http_error', async () => {
    const fetchImpl = mockFetch({ issue: () => new Response('{}', { status: 500 }) });
    const { store, links } = makeStore();

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

    expect(links).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:http_error']));
  });

  it('treats a network rejection as a failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const { store, links } = makeStore();

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

    expect(links).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:network']));
  });

  it('treats a timeout abort as a failure', async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;
    const { store } = makeStore();

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:timeout']));
  });

  it('fails as db_error (and does not call Linear) when the idempotency read throws', async () => {
    const fetchImpl = mockFetch();
    const { store } = makeStore({ throwOnRead: true });

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:db_error']));
  });

  it('fails as db_error when the link-back write throws (issue created but unlinked)', async () => {
    const fetchImpl = mockFetch();
    const { store } = makeStore({ throwOnWrite: true });

    await createLinearIssueForRequest(ctx(), store, INPUT, fetchImpl);

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
    const { store, links } = makeStore();

    await createLinearIssueForRequest(ctx({ LINEAR_API_KEY: undefined }), store, INPUT, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(submitCount).not.toHaveBeenCalled();
    expect(links).toHaveLength(0);
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
    expect(pickAssignee('33333333-3333-4333-8333-333333333333', pool)).toBeDefined();
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

// ─── Site → Linear sync (AECI-213 / Phase 6.6) — real transition writes on D1 ──

const STATE_DONE = { id: WORKFLOW_STATE_IDS.resolved, name: 'Done', type: 'completed' };
const STATE_CANCELED = { id: WORKFLOW_STATE_IDS.rejected, name: 'Canceled', type: 'canceled' };

const RESOLUTION_INPUT: LinearResolutionInput = {
  requestId: REQUEST_ID,
  workflowId: WORKFLOW_ID,
  linearIssueId: 'iss_1',
  kind: 'claim',
  toStatus: 'resolved',
};

/** Seed the workflow instance the transition FK references. */
const seedWorkflow = () =>
  t.db.insert(workflowInstances).values({
    id: WORKFLOW_ID,
    workflowType: 'vendor_claim',
    entityId: REQUEST_ID,
    currentState: 'open',
  });

const allTransitions = () => t.db.select().from(workflowTransitions);

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

function mockSyncFetch(handlers: { update?: FetchHandler; comment?: FetchHandler } = {}) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { query: string };
    if (parsed.query.includes('issueUpdate')) return (handlers.update ?? (() => issueUpdateOk()))();
    if (parsed.query.includes('commentCreate')) return (handlers.comment ?? commentOk)();
    throw new Error(`unexpected query: ${parsed.query.slice(0, 40)}`);
  }) as unknown as typeof fetch;
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
    await seedWorkflow();
    const fetchImpl = mockSyncFetch();

    await pushRequestResolutionToLinear(ctx(), t.db, RESOLUTION_INPUT, fetchImpl);

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

    // exactly one transition row, carrying the site-linear-sync provenance.
    const transitions = await allTransitions();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      workflowId: WORKFLOW_ID,
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
    await seedWorkflow();
    // actor_id is a real FK → seed the admin profile.
    await t.db.insert(profiles).values({ id: 'admin_1', role: 'admin' });
    const fetchImpl = mockSyncFetch({ update: () => issueUpdateOk(STATE_CANCELED) });

    await pushRequestResolutionToLinear(
      ctx(),
      t.db,
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

    const transitions = await allTransitions();
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
    await seedWorkflow();
    const fetchImpl = mockSyncFetch();

    await pushRequestResolutionToLinear(
      ctx(),
      t.db,
      { ...RESOLUTION_INPUT, linearIssueId: null },
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await allTransitions()).toHaveLength(0);
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
    await seedWorkflow();
    const fetchImpl = mockSyncFetch();

    await pushRequestResolutionToLinear(
      ctx({ LINEAR_API_KEY: undefined }),
      t.db,
      RESOLUTION_INPUT,
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(submitCount).not.toHaveBeenCalled();
    expect(await allTransitions()).toHaveLength(0);
  });

  it('treats a 200-with-errors issueUpdate as failed: no comment, no transition', async () => {
    await seedWorkflow();
    const fetchImpl = mockSyncFetch({ update: graphqlErrors });

    await pushRequestResolutionToLinear(ctx(), t.db, RESOLUTION_INPUT, fetchImpl);

    expect(await allTransitions()).toHaveLength(0);
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
    await seedWorkflow();
    const fetchImpl = mockSyncFetch({
      update: () =>
        new Response(JSON.stringify({ data: { issueUpdate: { success: false, issue: null } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await pushRequestResolutionToLinear(ctx(), t.db, RESOLUTION_INPUT, fetchImpl);

    expect(await allTransitions()).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:graphql_error']));
  });

  it('still records the transition when the comment fails (best-effort)', async () => {
    await seedWorkflow();
    const fetchImpl = mockSyncFetch({ comment: graphqlErrors });

    await pushRequestResolutionToLinear(ctx(), t.db, RESOLUTION_INPUT, fetchImpl);

    expect(await allTransitions()).toHaveLength(1); // recorded despite the comment failure
    expect(lastOutcome()).toBe('outcome:ok');
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn' }),
    );
  });

  it('fails as db_error (no throw) when the transition write throws (FK violation)', async () => {
    // No workflow instance seeded → the transition FK fails → db_error path.
    const fetchImpl = mockSyncFetch();

    await pushRequestResolutionToLinear(ctx(), t.db, RESOLUTION_INPUT, fetchImpl);

    expect(await allTransitions()).toHaveLength(0);
    expect(lastTags()).toEqual(expect.arrayContaining(['outcome:failed', 'reason:db_error']));
    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'error' }),
    );
  });
});
