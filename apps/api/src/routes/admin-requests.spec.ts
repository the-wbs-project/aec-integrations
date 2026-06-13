/**
 * Unit coverage for the Phase 6.9 admin requests API (AECI-216):
 *
 *   GET   /api/admin/requests
 *   PATCH /api/admin/requests/:id
 *
 * Mirrors `admin-reviews.spec.ts`: a middleware sets the `auth` Variable that
 * `requireAdmin()` would, a hand-rolled fake Prisma surface stands in for the
 * accelerated client, and the site→Linear sync seam is injected so it can be
 * asserted without a network. The AC matrix: list filters (kind/status) /
 * pagination / read-time duplicate flag / verbatim domain_match; resolve & reject
 * set status + resolver fields + audit + transition + invoke the sync; terminal →
 * 422; not-found → 404; concurrent race → 422.
 *
 * One integration block wires the REAL `requireAdmin()` (offline ES256 JWKS via
 * the `getKey` seam, same as `authz.spec.ts`) to pin the non-admin → 403 path.
 */

import {
  ApiErrorCode,
  AdminVendorRequestSchema,
  ListVendorRequestsResponseSchema,
} from '@aeci/shared';
import { Hono } from 'hono';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { submitCount } from '../datadog';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzProfileClient, type AuthzVariables } from '../lib/authz';
import {
  createAdminRequestsListHandler,
  createModerateRequestHandler,
  type SyncRequestToLinear,
} from './admin-requests';

// `aeci.request.moderation.action` rides the shared transport; mock it so we can
// assert the per-action metric. The handler also imports `logToDatadog`.
vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

/** The tag arrays recorded for `aeci.request.moderation.action` this test. */
function requestModerationActions(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.request.moderation.action')
    .map((call) => call[5] as string[]);
}

beforeEach(() => {
  vi.mocked(submitCount).mockClear();
});

// Valid UUIDs — the response schema validates `id`, `target_id`, `resolved_by`.
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

const ADMIN_AUTH: AuthzVariables['auth'] = {
  userId: ADMIN_ID,
  email: 'admin@aeci.test',
  role: 'admin',
};

const ENV = { DD_API_KEY: undefined } as Env;

/** ExecutionContext stub whose `waitUntil` is a spy, so the post-commit sync
 *  trigger can be asserted (and the telemetry branches don't throw). */
function executionCtxStub() {
  const waitUntil = vi.fn((_p: Promise<unknown>) => {});
  const ctx = {
    waitUntil,
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, waitUntil };
}

/** A full row as `adminVendorRequestSelect` would return it (camelCase, Date). */
function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    kind: 'claim',
    status: 'open',
    targetType: 'product',
    targetId: TARGET_ID,
    submitterEmail: 'submitter@vendor.com',
    submitterName: 'Sam Submitter',
    submitterRole: 'Product Manager',
    domainMatch: 'pending',
    body: 'We build this product and would like to claim the listing.',
    sourceUrl: null,
    linearIssueId: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    resolvedAt: null,
    resolvedById: null,
    ...overrides,
  };
}

/** A `(kind, target_type, target_id)` groupBy bucket. */
function kindGroup(count: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'claim',
    targetType: 'product',
    targetId: TARGET_ID,
    _count: { _all: count },
    ...overrides,
  };
}

/** A `(submitter_email, target_type, target_id)` groupBy bucket. */
function emailGroup(count: number, overrides: Record<string, unknown> = {}) {
  return {
    submitterEmail: 'submitter@vendor.com',
    targetType: 'product',
    targetId: TARGET_ID,
    _count: { _all: count },
    ...overrides,
  };
}

// ─── GET /api/admin/requests ─────────────────────────────────────────────────

function listPrisma(
  opts: {
    rows?: unknown[];
    total?: number;
    kindGroups?: unknown[];
    emailGroups?: unknown[];
  } = {},
) {
  const rows = opts.rows ?? [];
  const findMany = vi.fn(async (_args: unknown) => rows);
  const count = vi.fn(async (_args: unknown) => opts.total ?? rows.length);
  // The handler calls groupBy twice — keyed on the first `by` column.
  const groupBy = vi.fn(async (args: { by: readonly string[] }) =>
    args.by[0] === 'submitterEmail' ? (opts.emailGroups ?? []) : (opts.kindGroups ?? []),
  );
  return { prisma: { vendorRequest: { findMany, count, groupBy } }, findMany, count, groupBy };
}

function listApp(prisma: unknown, auth: AuthzVariables['auth'] = ADMIN_AUTH) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/requests', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.get(
    '/api/admin/requests',
    createAdminRequestsListHandler(() => prisma as never),
  );
  return app;
}

function getList(app: Hono<{ Bindings: Env; Variables: AuthzVariables }>, qs = '') {
  return app.request(`/api/admin/requests${qs}`, {}, ENV, executionCtxStub().ctx);
}

describe('GET /api/admin/requests', () => {
  it('defaults to status=open, newest-first, page 1, perPage 24', async () => {
    const { prisma, findMany, count } = listPrisma({ rows: [requestRow()] });
    const res = await getList(listApp(prisma));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const parsed = ListVendorRequestsResponseSchema.parse(await res.json());
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
    expect(parsed.total).toBe(1);
    expect(parsed.data[0]?.id).toBe(REQUEST_ID);
    expect(parsed.data[0]?.kind).toBe('claim');
    expect(parsed.data[0]?.target_type).toBe('product');
    expect(parsed.data[0]?.linear_issue_id).toBeNull();

    const call = findMany.mock.calls[0][0] as {
      where: unknown;
      orderBy: unknown;
      skip: number;
      take: number;
    };
    expect(call.where).toEqual({ status: 'open' });
    expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    expect(call.skip).toBe(0);
    expect(call.take).toBe(24);
    expect((count.mock.calls[0][0] as { where: unknown }).where).toEqual({ status: 'open' });
  });

  it('filters by status=resolved', async () => {
    const { prisma, findMany, count } = listPrisma({ rows: [requestRow({ status: 'resolved' })] });
    await getList(listApp(prisma), '?status=resolved');
    expect((findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({ status: 'resolved' });
    expect((count.mock.calls[0][0] as { where: unknown }).where).toEqual({ status: 'resolved' });
  });

  it('filters by kind=claim', async () => {
    const { prisma, findMany } = listPrisma({ rows: [requestRow()] });
    await getList(listApp(prisma), '?kind=claim');
    expect((findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({
      status: 'open',
      kind: 'claim',
    });
  });

  it('filters by kind=correction and status=rejected together', async () => {
    const { prisma, findMany } = listPrisma({
      rows: [requestRow({ kind: 'correction', status: 'rejected' })],
    });
    await getList(listApp(prisma), '?kind=correction&status=rejected');
    expect((findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({
      status: 'rejected',
      kind: 'correction',
    });
  });

  it('honors page/perPage with the correct skip/take', async () => {
    const { prisma, findMany } = listPrisma({ rows: [], total: 40 });
    await getList(listApp(prisma), '?page=3&perPage=10');
    const call = findMany.mock.calls[0][0] as { skip: number; take: number };
    expect(call.skip).toBe(20);
    expect(call.take).toBe(10);
  });

  it('flags is_duplicate via a shared (kind, target) open group', async () => {
    // Two open rows share (claim, product, TARGET_ID): count 2, minus self 1 → dup.
    const { prisma } = listPrisma({
      rows: [requestRow(), requestRow({ id: '55555555-5555-4555-8555-555555555555' })],
      kindGroups: [kindGroup(2)],
      emailGroups: [emailGroup(2)],
    });
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList(listApp(prisma))).json(),
    );
    expect(parsed.data.every((r) => r.is_duplicate)).toBe(true);
  });

  it('flags is_duplicate via a shared (submitter_email, target) open group', async () => {
    // Distinct kinds (each kind group count 1) but same submitter+target (count 2).
    const { prisma } = listPrisma({
      rows: [requestRow()],
      kindGroups: [kindGroup(1)],
      emailGroups: [emailGroup(2)],
    });
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList(listApp(prisma))).json(),
    );
    expect(parsed.data[0]?.is_duplicate).toBe(true);
  });

  it('does not flag a lone open request (count 1 minus self)', async () => {
    const { prisma } = listPrisma({
      rows: [requestRow()],
      kindGroups: [kindGroup(1)],
      emailGroups: [emailGroup(1)],
    });
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList(listApp(prisma))).json(),
    );
    expect(parsed.data[0]?.is_duplicate).toBe(false);
  });

  it('flags a resolved row when an open sibling still exists (terminal semantics)', async () => {
    // Listing resolved rows: the row is NOT in the open set (self 0), so a single
    // open sibling (count 1) → dup. Zero open siblings → not dup.
    const { prisma } = listPrisma({
      rows: [
        requestRow({ status: 'resolved' }),
        requestRow({
          id: '66666666-6666-4666-8666-666666666666',
          status: 'resolved',
          targetId: '22222222-2222-4222-8222-222222222222',
        }),
      ],
      kindGroups: [kindGroup(1)], // one open sibling at TARGET_ID; none at the other target
      emailGroups: [],
    });
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList(listApp(prisma))).json(),
    );
    expect(parsed.data[0]?.is_duplicate).toBe(true);
    expect(parsed.data[1]?.is_duplicate).toBe(false);
  });

  it('surfaces domain_match verbatim from the DB value', async () => {
    const { prisma } = listPrisma({ rows: [requestRow({ domainMatch: 'no_match' })] });
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList(listApp(prisma))).json(),
    );
    expect(parsed.data[0]?.domain_match).toBe('no_match');
  });

  it('returns an empty page when no requests match', async () => {
    const { prisma } = listPrisma({ rows: [], total: 0 });
    const res = await getList(listApp(prisma));
    expect(res.status).toBe(200);
    const parsed = ListVendorRequestsResponseSchema.parse(await res.json());
    expect(parsed.data).toEqual([]);
    expect(parsed.total).toBe(0);
  });
});

// ─── PATCH /api/admin/requests/:id ───────────────────────────────────────────

function moderatePrisma(
  opts: { existing?: unknown; updateCount?: number; workflowMissing?: boolean } = {},
) {
  const findUnique = vi.fn(async (_args: unknown) =>
    opts.existing === undefined ? requestRow() : opts.existing,
  );
  const updateMany = vi.fn(async (_args: unknown) => ({ count: opts.updateCount ?? 1 }));
  const auditCreate = vi.fn(async (_args: unknown) => ({}));
  const workflowFindFirst = vi.fn(async (_args: unknown) =>
    opts.workflowMissing ? null : { id: 'wf-1' },
  );
  const workflowCreate = vi.fn(async (_args: unknown) => ({ id: 'wf-1' }));
  const workflowUpdate = vi.fn(async (_args: unknown) => ({}));
  const transitionCreate = vi.fn(async (_args: unknown) => ({}));
  const tx = {
    vendorRequest: { updateMany },
    auditLog: { create: auditCreate },
    workflowInstance: {
      findFirst: workflowFindFirst,
      create: workflowCreate,
      update: workflowUpdate,
    },
    workflowTransition: { create: transitionCreate },
  };
  const prisma = {
    vendorRequest: { findUnique },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  return {
    prisma,
    findUnique,
    updateMany,
    auditCreate,
    workflowFindFirst,
    workflowCreate,
    workflowUpdate,
    transitionCreate,
  };
}

function moderateApp(prisma: unknown, opts: { auth?: AuthzVariables['auth']; env?: Env } = {}) {
  // Typed with the seam signature so `sync.mock.calls[0][2]` (the args object) is
  // statically the right shape.
  const sync = vi.fn<SyncRequestToLinear>(async () => {});
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/requests/:id', async (c, next) => {
    c.set('auth', opts.auth ?? ADMIN_AUTH);
    await next();
  });
  app.patch(
    '/api/admin/requests/:id',
    createModerateRequestHandler(() => prisma as never, sync),
  );
  return { app, sync, env: opts.env ?? ENV };
}

function patchReq(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  body: unknown,
  env: Env = ENV,
  id = REQUEST_ID,
) {
  const { ctx, waitUntil } = executionCtxStub();
  const res = app.request(
    `/api/admin/requests/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
    ctx,
  );
  return { res, waitUntil };
}

describe('PATCH /api/admin/requests/:id', () => {
  it('resolves an open request: status, resolver fields, audit, transition, sync', async () => {
    const { prisma, updateMany, auditCreate, workflowFindFirst, workflowUpdate, transitionCreate } =
      moderatePrisma();
    const { app, sync } = moderateApp(prisma);
    const { res, waitUntil } = patchReq(app, { action: 'resolve' });
    const response = await res;

    expect(response.status).toBe(200);
    const body = AdminVendorRequestSchema.parse(await response.json());
    expect(body.status).toBe('resolved');
    expect(body.resolved_by).toBe(ADMIN_ID);
    expect(body.resolved_at).toEqual(expect.any(String));
    expect(body.is_duplicate).toBe(false);

    const updateArgs = updateMany.mock.calls[0][0] as {
      where: { id: string; status: unknown };
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: REQUEST_ID, status: { in: ['open', 'in_review'] } });
    expect(updateArgs.data).toMatchObject({ status: 'resolved', resolvedById: ADMIN_ID });
    expect(updateArgs.data.resolvedAt).toBeInstanceOf(Date);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect((auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'vendor_request.resolved',
      entityType: 'vendor_request',
      entityId: REQUEST_ID,
      beforeState: { status: 'open' },
      afterState: { status: 'resolved' },
      metadata: {
        source: 'admin-moderation',
        kind: 'claim',
        target_type: 'product',
        target_id: TARGET_ID,
      },
    });

    expect(workflowFindFirst).toHaveBeenCalledTimes(1);
    expect((workflowFindFirst.mock.calls[0][0] as { where: unknown }).where).toEqual({
      workflowType: 'vendor_claim',
      entityId: REQUEST_ID,
    });
    expect(
      (transitionCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      workflowId: 'wf-1',
      fromState: 'open',
      toState: 'resolved',
      actorId: ADMIN_ID,
      reason: null,
    });
    const wfUpdate = workflowUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(wfUpdate.data).toMatchObject({ currentState: 'resolved', finalOutcome: 'completed' });
    expect(wfUpdate.data.completedAt).toBeInstanceOf(Date);

    // Site→Linear sync fired post-commit via waitUntil.
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][2]).toEqual({
      requestId: REQUEST_ID,
      status: 'resolved',
      reason: null,
      linearIssueId: null,
    });

    expect(requestModerationActions()).toEqual([['action:resolve', 'outcome:ok']]);
  });

  it('rejects an open request: reason recorded in transition/audit, finalOutcome rejected', async () => {
    const { prisma, updateMany, auditCreate, transitionCreate, workflowUpdate } = moderatePrisma();
    const { app, sync } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'reject', reason: 'Not a real claim' });
    const response = await res;

    expect(response.status).toBe(200);
    const body = AdminVendorRequestSchema.parse(await response.json());
    expect(body.status).toBe('rejected');

    expect((updateMany.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      status: 'rejected',
      resolvedById: ADMIN_ID,
    });
    expect((auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      action: 'vendor_request.rejected',
      metadata: { source: 'admin-moderation', reason: 'Not a real claim' },
    });
    expect(
      (transitionCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      fromState: 'open',
      toState: 'rejected',
      reason: 'Not a real claim',
    });
    expect(
      (workflowUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      currentState: 'rejected',
      finalOutcome: 'rejected',
    });
    expect(sync.mock.calls[0][2]).toMatchObject({ status: 'rejected', reason: 'Not a real claim' });
    expect(requestModerationActions()).toEqual([['action:reject', 'outcome:ok']]);
  });

  it('allows reject with no reason (reason optional for requests) → reason null', async () => {
    const { prisma, transitionCreate } = moderatePrisma();
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'reject' });
    const response = await res;

    expect(response.status).toBe(200);
    expect(
      (transitionCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      toState: 'rejected',
      reason: null,
    });
  });

  it('resolves from in_review, recording the real prior state', async () => {
    const { prisma, updateMany, transitionCreate } = moderatePrisma({
      existing: requestRow({ status: 'in_review' }),
    });
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'resolve' });
    const response = await res;

    expect(response.status).toBe(200);
    // The guard still admits in_review.
    expect((updateMany.mock.calls[0][0] as { where: { status: unknown } }).where.status).toEqual({
      in: ['open', 'in_review'],
    });
    expect(
      (transitionCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      fromState: 'in_review',
      toState: 'resolved',
    });
  });

  it('creates the workflow instance on the fly when one is missing', async () => {
    const { prisma, workflowCreate, transitionCreate } = moderatePrisma({ workflowMissing: true });
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'resolve' });
    const response = await res;

    expect(response.status).toBe(200);
    expect(workflowCreate).toHaveBeenCalledTimes(1);
    expect(
      (workflowCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      workflowType: 'vendor_claim',
      entityId: REQUEST_ID,
      currentState: 'open',
    });
    expect(
      (transitionCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      workflowId: 'wf-1',
      toState: 'resolved',
    });
  });

  it('returns the canonical 404 envelope for an unknown request id', async () => {
    const { prisma, updateMany } = moderatePrisma({ existing: null });
    const { app, sync } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'resolve' });
    const response = await res;

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; details?: { resource?: string; id?: string } };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'vendor_request', id: REQUEST_ID });
    expect(updateMany).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('returns 422 INVALID_STATE_TRANSITION for an already-terminal request', async () => {
    const { prisma, updateMany } = moderatePrisma({ existing: requestRow({ status: 'resolved' }) });
    const { app, sync } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'reject' });
    const response = await res;

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(requestModerationActions()).toEqual([['action:reject', 'outcome:invalid_state']]);
  });

  it('returns 422 when the row is no longer open at update time (concurrent race)', async () => {
    const { prisma, auditCreate, transitionCreate, workflowCreate, workflowUpdate } =
      moderatePrisma({
        updateCount: 0,
      });
    const { app, sync } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'resolve' });
    const response = await res;

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    // The transaction rolled back before the audit / workflow writes, and the
    // post-commit sync never fired.
    expect(auditCreate).not.toHaveBeenCalled();
    expect(transitionCreate).not.toHaveBeenCalled();
    expect(workflowCreate).not.toHaveBeenCalled();
    expect(workflowUpdate).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(requestModerationActions()).toEqual([['action:resolve', 'outcome:invalid_state']]);
  });

  it('rejects with 400 VALIDATION_FAILED for a missing/unknown action', async () => {
    const { prisma, findUnique, updateMany } = moderatePrisma();
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'frobnicate' });
    const response = await res;

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.VALIDATION_FAILED,
    );
    // Validation fails before any DB work.
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects with 400 VALIDATION_FAILED when reason exceeds 500 chars', async () => {
    const { prisma } = moderatePrisma();
    const { app } = moderateApp(prisma);
    const { res } = patchReq(app, { action: 'reject', reason: 'x'.repeat(501) });
    const response = await res;

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect(body.error.field).toBe('reason');
  });
});

// ─── Integration: real requireAdmin() in front of the real list handler ───────

const SUPABASE_URL = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' };
  getKey = createLocalJWKSet({ keys: [publicJwk] });
});

async function mintToken(sub: string): Promise<string> {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(privateKey);
}

type ProfileRow = { role: string; bannedAt: Date | null; banReason: string | null };

function authProfileClient(profiles: Record<string, ProfileRow>): AuthzProfileClient {
  return {
    profile: {
      findUnique: ({ where }) => Promise.resolve(profiles[where.id] ?? null),
    },
  };
}

function adminGuardedApp(profiles: Record<string, ProfileRow>, prisma: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get(
    '/api/admin/requests',
    requireAdmin({ getKey, getClient: () => authProfileClient(profiles) }),
    createAdminRequestsListHandler(() => prisma as never),
  );
  return app;
}

describe('GET /api/admin/requests (with requireAdmin middleware)', () => {
  const GUARD_ENV = { SUPABASE_URL, DD_API_KEY: undefined } as Env;

  it('rejects a non-admin (reviewer) with 403 FORBIDDEN before the handler runs', async () => {
    const { prisma, findMany, groupBy } = listPrisma({ rows: [requestRow()] });
    const app = adminGuardedApp(
      { 'user-reviewer': { role: 'reviewer', bannedAt: null, banReason: null } },
      prisma,
    );
    const token = await mintToken('user-reviewer');
    const res = await app.request(
      '/api/admin/requests',
      { headers: { Authorization: `Bearer ${token}` } },
      GUARD_ENV,
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.FORBIDDEN,
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('admits an admin end-to-end (200)', async () => {
    const { prisma } = listPrisma({ rows: [requestRow()] });
    const app = adminGuardedApp(
      { 'user-admin': { role: 'admin', bannedAt: null, banReason: null } },
      prisma,
    );
    const token = await mintToken('user-admin');
    const res = await app.request(
      '/api/admin/requests',
      { headers: { Authorization: `Bearer ${token}` } },
      GUARD_ENV,
    );
    expect(res.status).toBe(200);
  });

  it('rejects a missing token with 401 UNAUTHENTICATED', async () => {
    const { prisma } = listPrisma({ rows: [requestRow()] });
    const app = adminGuardedApp(
      { 'user-admin': { role: 'admin', bannedAt: null, banReason: null } },
      prisma,
    );
    const res = await app.request('/api/admin/requests', {}, GUARD_ENV);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.UNAUTHENTICATED,
    );
  });
});
