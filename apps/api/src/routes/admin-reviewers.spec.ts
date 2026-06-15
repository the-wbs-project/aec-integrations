/**
 * Unit coverage for the Phase 6.11 reviewer ban-management API (AECI-218):
 *
 *   GET   /api/admin/reviewers
 *   PATCH /api/admin/reviewers/:id
 *
 * Mirrors `admin-requests.spec.ts`: a middleware sets the `auth` Variable that
 * `requireAdmin()` would, and a hand-rolled fake Prisma surface stands in for the
 * accelerated client. The AC matrix: ban sets the columns + audit + an
 * `active→banned` transition; unban clears them (`banned→active`); the reviewer-ban
 * workflow is reversible (no terminal outcome); already-banned / not-banned → 422;
 * admin/self → 403; unknown id → 404; concurrent race → 422; the banned list maps
 * rows + resolves emails (degrading to null).
 *
 * One integration block wires the REAL `requireAdmin()` (offline ES256 JWKS) to pin
 * the non-admin → 403 path.
 */

import {
  ApiErrorCode,
  BanReviewerResponseSchema,
  ListBannedReviewersResponseSchema,
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
import { createBanReviewerHandler, createBannedReviewersListHandler } from './admin-reviewers';
import type { FetchReviewerEmails } from './admin-reviews';

vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

/** The tag arrays recorded for `aeci.moderation.ban` this test. */
function banActions(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.moderation.ban')
    .map((call) => call[5] as string[]);
}

beforeEach(() => {
  vi.mocked(submitCount).mockClear();
});

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const REVIEWER_ID = '11111111-1111-4111-8111-111111111111';
const REVIEWER_ID_2 = '22222222-2222-4222-8222-222222222222';

const ADMIN_AUTH: AuthzVariables['auth'] = {
  userId: ADMIN_ID,
  email: 'admin@aeci.test',
  role: 'admin',
};

const ENV = { DD_API_KEY: undefined } as Env;

function executionCtxStub() {
  const waitUntil = vi.fn((_p: Promise<unknown>) => {});
  const ctx = {
    waitUntil,
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, waitUntil };
}

// ─── PATCH /api/admin/reviewers/:id ──────────────────────────────────────────

function profileRow(overrides: Record<string, unknown> = {}) {
  return { id: REVIEWER_ID, role: 'reviewer', bannedAt: null, banReason: null, ...overrides };
}

function banPrisma(
  opts: { existing?: unknown; updateCount?: number; workflowMissing?: boolean } = {},
) {
  const findUnique = vi.fn(async (_args: unknown) =>
    opts.existing === undefined ? profileRow() : opts.existing,
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
    profile: { updateMany },
    auditLog: { create: auditCreate },
    workflowInstance: {
      findFirst: workflowFindFirst,
      create: workflowCreate,
      update: workflowUpdate,
    },
    workflowTransition: { create: transitionCreate },
  };
  const prisma = {
    profile: { findUnique },
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

function banApp(prisma: unknown, opts: { auth?: AuthzVariables['auth'] } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/reviewers/:id', async (c, next) => {
    c.set('auth', opts.auth ?? ADMIN_AUTH);
    await next();
  });
  app.patch(
    '/api/admin/reviewers/:id',
    createBanReviewerHandler(() => prisma as never),
  );
  return app;
}

function patchReq(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  body: unknown,
  id = REVIEWER_ID,
) {
  const res = app.request(
    `/api/admin/reviewers/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    ENV,
    executionCtxStub().ctx,
  );
  return { res };
}

describe('PATCH /api/admin/reviewers/:id', () => {
  it('bans an un-banned reviewer: columns, audit, active→banned transition, telemetry', async () => {
    const { prisma, updateMany, auditCreate, workflowFindFirst, workflowUpdate, transitionCreate } =
      banPrisma();
    const { res } = patchReq(banApp(prisma), { action: 'ban', reason: 'Coordinated spam.' });
    const response = await res;

    expect(response.status).toBe(200);
    const body = BanReviewerResponseSchema.parse(await response.json());
    expect(body.reviewer_id).toBe(REVIEWER_ID);
    expect(body.banned_at).toEqual(expect.any(String));
    expect(body.ban_reason).toBe('Coordinated spam.');

    const updateArgs = updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: REVIEWER_ID, bannedAt: null });
    expect(updateArgs.data).toMatchObject({ banReason: 'Coordinated spam.' });
    expect(updateArgs.data.bannedAt).toBeInstanceOf(Date);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect((auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'reviewer.banned',
      entityType: 'profile',
      entityId: REVIEWER_ID,
      beforeState: { banned_at: null, ban_reason: null },
      afterState: { banned_at: expect.any(String), ban_reason: 'Coordinated spam.' },
      metadata: { source: 'admin-moderation', reason: 'Coordinated spam.' },
    });

    expect(workflowFindFirst).toHaveBeenCalledTimes(1);
    expect((workflowFindFirst.mock.calls[0][0] as { where: unknown }).where).toEqual({
      workflowType: 'reviewer_ban',
      entityId: REVIEWER_ID,
    });
    expect(
      (transitionCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      workflowId: 'wf-1',
      fromState: 'active',
      toState: 'banned',
      actorId: ADMIN_ID,
      reason: 'Coordinated spam.',
    });
    // Reversible workflow: only `current_state` toggles — no completedAt/finalOutcome.
    expect((workflowUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toEqual({
      currentState: 'banned',
    });

    expect(banActions()).toEqual([['action:ban', 'outcome:ok']]);
  });

  it('unbans a banned reviewer: clears columns, banned→active transition', async () => {
    const { prisma, updateMany, auditCreate, transitionCreate, workflowUpdate } = banPrisma({
      existing: profileRow({ bannedAt: new Date('2026-06-10T00:00:00.000Z'), banReason: 'Spam' }),
    });
    const { res } = patchReq(banApp(prisma), { action: 'unban' });
    const response = await res;

    expect(response.status).toBe(200);
    const body = BanReviewerResponseSchema.parse(await response.json());
    expect(body.banned_at).toBeNull();
    expect(body.ban_reason).toBeNull();

    const updateArgs = updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArgs.where).toEqual({ id: REVIEWER_ID, bannedAt: { not: null } });
    expect(updateArgs.data).toEqual({ bannedAt: null, banReason: null });

    expect((auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      action: 'reviewer.unbanned',
      beforeState: { banned_at: '2026-06-10T00:00:00.000Z', ban_reason: 'Spam' },
      afterState: { banned_at: null, ban_reason: null },
    });
    expect(
      (transitionCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({ fromState: 'banned', toState: 'active', reason: null });
    expect((workflowUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toEqual({
      currentState: 'active',
    });
    expect(banActions()).toEqual([['action:unban', 'outcome:ok']]);
  });

  it('creates the reviewer_ban workflow instance on the fly when missing (seeded at prior state)', async () => {
    const { prisma, workflowCreate } = banPrisma({ workflowMissing: true });
    const { res } = patchReq(banApp(prisma), { action: 'ban', reason: 'Spam.' });
    expect((await res).status).toBe(200);
    expect(
      (workflowCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({
      workflowType: 'reviewer_ban',
      entityId: REVIEWER_ID,
      currentState: 'active',
    });
  });

  it('requires a reason to ban → 400 VALIDATION_FAILED keyed to reason', async () => {
    const { prisma, findUnique, updateMany } = banPrisma();
    const { res } = patchReq(banApp(prisma), { action: 'ban' });
    const response = await res;

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect(body.error.field).toBe('reason');
    // Validation fails before any DB work.
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('returns 422 when banning an already-banned reviewer (no audit/transition)', async () => {
    const { prisma, updateMany, auditCreate, transitionCreate } = banPrisma({
      existing: profileRow({ bannedAt: new Date('2026-06-10T00:00:00.000Z'), banReason: 'Spam' }),
    });
    const { res } = patchReq(banApp(prisma), { action: 'ban', reason: 'Again.' });
    const response = await res;

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(transitionCreate).not.toHaveBeenCalled();
    expect(banActions()).toEqual([['action:ban', 'outcome:invalid_state']]);
  });

  it('returns 422 when unbanning a reviewer who is not banned', async () => {
    const { prisma, updateMany } = banPrisma({ existing: profileRow() });
    const { res } = patchReq(banApp(prisma), { action: 'unban' });
    const response = await res;

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(banActions()).toEqual([['action:unban', 'outcome:invalid_state']]);
  });

  it('refuses to ban an admin account → 403 FORBIDDEN', async () => {
    const { prisma, updateMany } = banPrisma({ existing: profileRow({ role: 'admin' }) });
    const { res } = patchReq(banApp(prisma), { action: 'ban', reason: 'No.' });
    const response = await res;

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.FORBIDDEN,
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(banActions()).toEqual([['action:ban', 'outcome:forbidden']]);
  });

  it('refuses to ban yourself → 403 FORBIDDEN', async () => {
    const { prisma, updateMany } = banPrisma({ existing: profileRow({ id: ADMIN_ID }) });
    const { res } = patchReq(banApp(prisma), { action: 'ban', reason: 'No.' }, ADMIN_ID);
    const response = await res;

    expect(response.status).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('returns the canonical 404 envelope for an unknown reviewer id', async () => {
    const { prisma, updateMany } = banPrisma({ existing: null });
    const { res } = patchReq(banApp(prisma), { action: 'ban', reason: 'Spam.' });
    const response = await res;

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; details?: { resource?: string; id?: string } };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'profile', id: REVIEWER_ID });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('returns 422 when the row flips ban state at update time (concurrent race)', async () => {
    const { prisma, auditCreate, transitionCreate, workflowCreate, workflowUpdate } = banPrisma({
      updateCount: 0,
    });
    const { res } = patchReq(banApp(prisma), { action: 'ban', reason: 'Spam.' });
    const response = await res;

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    // Rolled back before the audit / workflow writes.
    expect(auditCreate).not.toHaveBeenCalled();
    expect(transitionCreate).not.toHaveBeenCalled();
    expect(workflowCreate).not.toHaveBeenCalled();
    expect(workflowUpdate).not.toHaveBeenCalled();
    expect(banActions()).toEqual([['action:ban', 'outcome:invalid_state']]);
  });

  it('rejects a reason over 500 chars → 400 VALIDATION_FAILED', async () => {
    const { prisma } = banPrisma();
    const { res } = patchReq(banApp(prisma), { action: 'ban', reason: 'x'.repeat(501) });
    const response = await res;
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.VALIDATION_FAILED,
    );
  });
});

// ─── GET /api/admin/reviewers ────────────────────────────────────────────────

function bannedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEWER_ID,
    bannedAt: new Date('2026-06-10T00:00:00.000Z'),
    banReason: 'Coordinated spam.',
    ...overrides,
  };
}

function listPrisma(opts: { rows?: unknown[]; total?: number } = {}) {
  const rows = opts.rows ?? [bannedRow()];
  const findMany = vi.fn(async (_args: unknown) => rows);
  const count = vi.fn(async (_args: unknown) => opts.total ?? rows.length);
  return { prisma: { profile: { findMany, count } }, findMany, count };
}

function listApp(prisma: unknown, fetchEmails: FetchReviewerEmails) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/reviewers', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  app.get(
    '/api/admin/reviewers',
    createBannedReviewersListHandler(() => prisma as never, fetchEmails),
  );
  return app;
}

function getList(app: Hono<{ Bindings: Env; Variables: AuthzVariables }>, qs = '') {
  return app.request(`/api/admin/reviewers${qs}`, {}, ENV, executionCtxStub().ctx);
}

describe('GET /api/admin/reviewers', () => {
  const emailsOk: FetchReviewerEmails = async (_p, ids) =>
    new Map(ids.map((id) => [id, `${id}@example.test`]));

  it('lists banned reviewers, newest ban first, resolving emails', async () => {
    const { prisma, findMany, count } = listPrisma({
      rows: [bannedRow(), bannedRow({ id: REVIEWER_ID_2, banReason: null })],
    });
    const res = await getList(listApp(prisma, emailsOk));

    expect(res.status).toBe(200);
    const parsed = ListBannedReviewersResponseSchema.parse(await res.json());
    expect(parsed.total).toBe(2);
    expect(parsed.data[0]?.reviewer_id).toBe(REVIEWER_ID);
    expect(parsed.data[0]?.reviewer_email).toBe(`${REVIEWER_ID}@example.test`);
    expect(parsed.data[0]?.banned_at).toBe('2026-06-10T00:00:00.000Z');
    expect(parsed.data[0]?.ban_reason).toBe('Coordinated spam.');
    expect(parsed.data[1]?.ban_reason).toBeNull();

    const call = findMany.mock.calls[0][0] as { where: unknown; orderBy: unknown };
    expect(call.where).toEqual({ bannedAt: { not: null } });
    expect(call.orderBy).toEqual([{ bannedAt: 'desc' }, { id: 'asc' }]);
    expect((count.mock.calls[0][0] as { where: unknown }).where).toEqual({
      bannedAt: { not: null },
    });
  });

  it('degrades reviewer_email to null when the auth.users lookup fails', async () => {
    const { prisma } = listPrisma({ rows: [bannedRow()] });
    const emailsFail: FetchReviewerEmails = async () => {
      throw new Error('auth schema unreachable');
    };
    const parsed = ListBannedReviewersResponseSchema.parse(
      await (await getList(listApp(prisma, emailsFail))).json(),
    );
    expect(parsed.data[0]?.reviewer_email).toBeNull();
  });

  it('returns an empty page when nobody is banned', async () => {
    const { prisma } = listPrisma({ rows: [], total: 0 });
    const parsed = ListBannedReviewersResponseSchema.parse(
      await (await getList(listApp(prisma, emailsOk))).json(),
    );
    expect(parsed.data).toEqual([]);
    expect(parsed.total).toBe(0);
  });
});

// ─── Integration: real requireAdmin() in front of the ban handler ─────────────

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

describe('PATCH /api/admin/reviewers/:id (with requireAdmin middleware)', () => {
  const GUARD_ENV = { SUPABASE_URL, DD_API_KEY: undefined } as Env;

  function guardedApp(profiles: Record<string, ProfileRow>, prisma: unknown) {
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.patch(
      '/api/admin/reviewers/:id',
      requireAdmin({ getKey, getClient: () => authProfileClient(profiles) }),
      createBanReviewerHandler(() => prisma as never),
    );
    return app;
  }

  it('rejects a non-admin (reviewer) with 403 FORBIDDEN before the handler runs', async () => {
    const { prisma, findUnique } = banPrisma();
    const app = guardedApp(
      { 'user-reviewer': { role: 'reviewer', bannedAt: null, banReason: null } },
      prisma,
    );
    const token = await mintToken('user-reviewer');
    const res = await app.request(
      `/api/admin/reviewers/${REVIEWER_ID}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ban', reason: 'Spam.' }),
      },
      GUARD_ENV,
      executionCtxStub().ctx,
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.FORBIDDEN,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('admits an admin end-to-end (200)', async () => {
    const { prisma } = banPrisma();
    const app = guardedApp(
      { 'user-admin': { role: 'admin', bannedAt: null, banReason: null } },
      prisma,
    );
    const token = await mintToken('user-admin');
    const res = await app.request(
      `/api/admin/reviewers/${REVIEWER_ID}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ban', reason: 'Spam.' }),
      },
      GUARD_ENV,
      executionCtxStub().ctx,
    );
    expect(res.status).toBe(200);
  });
});
