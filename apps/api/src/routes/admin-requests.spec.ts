/**
 * Phase 6.9 admin requests API (AECI-216) on the Drizzle/D1 path (ADR 0016 /
 * AECI-253), against the in-memory D1 harness.
 *
 *   GET   /api/admin/requests
 *   PATCH /api/admin/requests/:id
 *
 * A stub middleware sets the `auth` Variable `requireAdmin()` would (the guard
 * itself is covered in `authz.spec.ts`); the site→Linear sync seam is injected so
 * it can be asserted without a network. The AC matrix: list filters (kind/status)
 * / pagination / read-time duplicate flag (now over REAL `groupBy`) / verbatim
 * domain_match; resolve & reject set status + resolver fields + audit + transition
 * + invoke the sync; terminal → 422; not-found → 404; bad input → 400.
 */

import {
  ApiErrorCode,
  AdminVendorRequestSchema,
  ListVendorRequestsResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  products,
  profiles,
  vendors,
  vendorRequests,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { submitCount } from '../datadog';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
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

// Valid UUIDs — the response schema validates `id`, `target_id`, `resolved_by`.
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TARGET = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

const ADMIN_AUTH: AuthzVariables['auth'] = {
  userId: ADMIN_ID,
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
  vi.mocked(submitCount).mockClear();
});
afterEach(() => t.dispose());

/** A `vendor_requests` insert payload (camelCase), defaults overridable. */
function reqRow(
  o: Partial<typeof vendorRequests.$inferInsert> = {},
): typeof vendorRequests.$inferInsert {
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
    linearIssueUrl: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    resolvedAt: null,
    resolvedById: null,
    ...o,
  };
}

const seed = (...rows: Array<typeof vendorRequests.$inferInsert>) =>
  t.db.insert(vendorRequests).values(rows);

// ─── GET /api/admin/requests ─────────────────────────────────────────────────

function listApp(auth: AuthzVariables['auth'] = ADMIN_AUTH) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/requests', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.get('/api/admin/requests', createAdminRequestsListHandler(t.factory));
  return app;
}

const getList = (qs = '') =>
  listApp().request(`/api/admin/requests${qs}`, {}, TEST_ENV, fakeExecutionContext());

describe('GET /api/admin/requests', () => {
  it('defaults to status=open, newest-first, page 1, perPage 24', async () => {
    await seed(reqRow());
    const res = await getList();

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
    expect(parsed.data[0]?.linear_issue_url).toBeNull();
  });

  it('surfaces linear_issue_url when persisted (AECI-261)', async () => {
    await seed(
      reqRow({
        linearIssueId: 'iss_123',
        linearIssueUrl: 'https://linear.app/aec-integrations/issue/AECI-901',
      }),
    );
    const parsed = ListVendorRequestsResponseSchema.parse(await (await getList()).json());
    expect(parsed.data[0]?.linear_issue_url).toBe(
      'https://linear.app/aec-integrations/issue/AECI-901',
    );
  });

  it('filters by status=resolved', async () => {
    await seed(reqRow({ status: 'open' }), reqRow({ id: OTHER_TARGET, status: 'resolved' }));
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList('?status=resolved')).json(),
    );
    expect(parsed.total).toBe(1);
    expect(parsed.data.every((r) => r.status === 'resolved')).toBe(true);
  });

  it('filters by kind=claim', async () => {
    await seed(
      reqRow({ kind: 'claim' }),
      reqRow({ id: OTHER_TARGET, kind: 'correction', targetId: OTHER_TARGET }),
    );
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList('?kind=claim')).json(),
    );
    expect(parsed.total).toBe(1);
    expect(parsed.data.every((r) => r.kind === 'claim')).toBe(true);
  });

  it('filters by kind=correction and status=rejected together', async () => {
    await seed(
      reqRow({ kind: 'correction', status: 'rejected' }),
      reqRow({ id: OTHER_TARGET, kind: 'claim', status: 'rejected' }),
      reqRow({ id: '55555555-5555-4555-8555-555555555555', kind: 'correction', status: 'open' }),
    );
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList('?kind=correction&status=rejected')).json(),
    );
    expect(parsed.total).toBe(1);
    expect(parsed.data[0]?.kind).toBe('correction');
    expect(parsed.data[0]?.status).toBe('rejected');
  });

  it('honors page/perPage with the correct slice', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      reqRow({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        createdAt: `2026-06-0${i + 1}T00:00:00.000Z`,
      }),
    );
    await seed(...rows);
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList('?page=2&perPage=2')).json(),
    );
    expect(parsed.total).toBe(5);
    expect(parsed.data).toHaveLength(2);
    // Newest-first: page 2 of [05,04,03,02,01] is [03,02].
    expect(parsed.data[0]?.created_at).toBe('2026-06-03T00:00:00.000Z');
    expect(parsed.data[1]?.created_at).toBe('2026-06-02T00:00:00.000Z');
  });

  it('flags is_duplicate via a shared (kind, target) open group (distinct emails)', async () => {
    await seed(
      reqRow({ submitterEmail: 'a@vendor.com' }),
      reqRow({ id: '55555555-5555-4555-8555-555555555555', submitterEmail: 'b@vendor.com' }),
    );
    const parsed = ListVendorRequestsResponseSchema.parse(await (await getList()).json());
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data.every((r) => r.is_duplicate)).toBe(true);
  });

  it('flags is_duplicate via a shared (submitter_email, target) open group (distinct kinds)', async () => {
    await seed(
      reqRow({ kind: 'claim' }),
      reqRow({ id: '55555555-5555-4555-8555-555555555555', kind: 'correction' }),
    );
    const parsed = ListVendorRequestsResponseSchema.parse(await (await getList()).json());
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data.every((r) => r.is_duplicate)).toBe(true);
  });

  it('does not flag a lone open request (count 1 minus self)', async () => {
    await seed(reqRow());
    const parsed = ListVendorRequestsResponseSchema.parse(await (await getList()).json());
    expect(parsed.data[0]?.is_duplicate).toBe(false);
  });

  it('flags a resolved row when an open sibling still exists (terminal semantics)', async () => {
    await seed(
      reqRow({ id: REQUEST_ID, status: 'resolved', createdAt: '2026-06-03T00:00:00.000Z' }),
      // The open sibling at TARGET_ID — excluded from a status=resolved page, but
      // counted in the open groupBy.
      reqRow({
        id: '77777777-7777-4777-8777-777777777777',
        status: 'open',
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
      // A resolved row at a different target with no open sibling.
      reqRow({
        id: '66666666-6666-4666-8666-666666666666',
        status: 'resolved',
        targetId: OTHER_TARGET,
        submitterEmail: 'other@vendor.com',
        createdAt: '2026-06-02T00:00:00.000Z',
      }),
    );
    const parsed = ListVendorRequestsResponseSchema.parse(
      await (await getList('?status=resolved')).json(),
    );
    expect(parsed.data[0]?.id).toBe(REQUEST_ID);
    expect(parsed.data[0]?.is_duplicate).toBe(true);
    expect(parsed.data[1]?.id).toBe('66666666-6666-4666-8666-666666666666');
    expect(parsed.data[1]?.is_duplicate).toBe(false);
  });

  it('surfaces domain_match verbatim from the DB value', async () => {
    await seed(reqRow({ domainMatch: 'no_match' }));
    const parsed = ListVendorRequestsResponseSchema.parse(await (await getList()).json());
    expect(parsed.data[0]?.domain_match).toBe('no_match');
  });

  it('hydrates target from the products table for a product request (AECI-217)', async () => {
    await t.db.insert(products).values({ id: TARGET_ID, slug: 'procore', name: 'Procore' });
    await seed(reqRow()); // targetType 'product', targetId TARGET_ID
    const parsed = ListVendorRequestsResponseSchema.parse(await (await getList()).json());
    expect(parsed.data[0]?.target).toEqual({ id: TARGET_ID, name: 'Procore', slug: 'procore' });
  });

  it('hydrates target from the vendors table, name from company_name (AECI-217)', async () => {
    const VENDOR_ID = '88888888-8888-4888-8888-888888888888';
    await t.db
      .insert(vendors)
      .values({ id: VENDOR_ID, slug: 'autodesk', companyName: 'Autodesk, Inc.' });
    await seed(reqRow({ targetType: 'vendor', targetId: VENDOR_ID }));
    const parsed = ListVendorRequestsResponseSchema.parse(await (await getList()).json());
    expect(parsed.data[0]?.target).toEqual({
      id: VENDOR_ID,
      name: 'Autodesk, Inc.',
      slug: 'autodesk',
    });
  });

  it('returns target: null when the referenced target row is missing (AECI-217)', async () => {
    await seed(reqRow()); // no product seeded for TARGET_ID
    const parsed = ListVendorRequestsResponseSchema.parse(await (await getList()).json());
    expect(parsed.data[0]?.target).toBeNull();
  });

  it('returns an empty page when no requests match', async () => {
    const res = await getList();
    expect(res.status).toBe(200);
    const parsed = ListVendorRequestsResponseSchema.parse(await res.json());
    expect(parsed.data).toEqual([]);
    expect(parsed.total).toBe(0);
  });
});

// ─── PATCH /api/admin/requests/:id ───────────────────────────────────────────

const noopSync: SyncRequestToLinear = async () => {};

function moderateApp(
  sync: SyncRequestToLinear = noopSync,
  auth: AuthzVariables['auth'] = ADMIN_AUTH,
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/requests/:id', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.patch('/api/admin/requests/:id', createModerateRequestHandler(t.factory, sync));
  return app;
}

const patchReq = (
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  body: unknown,
  id = REQUEST_ID,
) =>
  app.request(
    `/api/admin/requests/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

/** Open a workflow instance for the seeded request (the submit path normally does). */
const seedWorkflow = (workflowType: string, entityId = REQUEST_ID, currentState = 'open') =>
  t.db
    .insert(workflowInstances)
    .values({ id: crypto.randomUUID(), workflowType, entityId, currentState });

describe('PATCH /api/admin/requests/:id', () => {
  it('resolves an open request: status, resolver fields, audit, transition, sync', async () => {
    await seed(reqRow({ linearIssueUrl: 'https://linear.app/aec-integrations/issue/AECI-901' }));
    await seedWorkflow('vendor_claim');
    const sync = vi.fn<SyncRequestToLinear>(async () => {});

    const res = await patchReq(moderateApp(sync), { action: 'resolve' });
    expect(res.status).toBe(200);
    const body = AdminVendorRequestSchema.parse(await res.json());
    expect(body.status).toBe('resolved');
    expect(body.resolved_by).toBe(ADMIN_ID);
    expect(body.resolved_at).toEqual(expect.any(String));
    expect(body.is_duplicate).toBe(false);
    // AECI-261: the persisted issue url survives the moderation action.
    expect(body.linear_issue_url).toBe('https://linear.app/aec-integrations/issue/AECI-901');

    // Row mutated.
    const [row] = await t.db.select().from(vendorRequests).where(eq(vendorRequests.id, REQUEST_ID));
    expect(row!.status).toBe('resolved');
    expect(row!.resolvedById).toBe(ADMIN_ID);
    expect(row!.resolvedAt).not.toBeNull();

    // Audit row.
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('vendor_request.resolved');
    expect(audits[0]!.actorId).toBe(ADMIN_ID);
    expect(audits[0]!.beforeState).toEqual({ status: 'open' });
    expect(audits[0]!.afterState).toEqual({ status: 'resolved' });

    // Workflow transition + instance completion.
    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromState).toBe('open');
    expect(transitions[0]!.toState).toBe('resolved');
    const [wf] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.entityId, REQUEST_ID));
    expect(wf!.currentState).toBe('resolved');
    expect(wf!.finalOutcome).toBe('completed');
    expect(wf!.completedAt).not.toBeNull();

    // Site→Linear sync fired post-commit with the full resolution input.
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]![2]).toMatchObject({
      requestId: REQUEST_ID,
      linearIssueId: null,
      kind: 'claim',
      toStatus: 'resolved',
      fromStatus: 'open',
      reason: null,
      actorId: ADMIN_ID,
      actorLabel: null,
    });
    expect(sync.mock.calls[0]![2].workflowId).toEqual(expect.any(String));

    expect(requestModerationActions()).toEqual([['action:resolve', 'outcome:ok']]);
  });

  it('rejects an open request: reason recorded in transition/audit, finalOutcome rejected', async () => {
    await seed(reqRow());
    await seedWorkflow('vendor_claim');
    const sync = vi.fn<SyncRequestToLinear>(async () => {});

    const res = await patchReq(moderateApp(sync), { action: 'reject', reason: 'Not a real claim' });
    expect(res.status).toBe(200);
    const body = AdminVendorRequestSchema.parse(await res.json());
    expect(body.status).toBe('rejected');

    const audits = await t.db.select().from(auditLog);
    expect(audits[0]!.action).toBe('vendor_request.rejected');
    expect(audits[0]!.metadata).toMatchObject({
      source: 'admin-moderation',
      reason: 'Not a real claim',
    });
    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions[0]!.toState).toBe('rejected');
    expect(transitions[0]!.reason).toBe('Not a real claim');
    const [wf] = await t.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.entityId, REQUEST_ID));
    expect(wf!.finalOutcome).toBe('rejected');
    expect(sync.mock.calls[0]![2]).toMatchObject({
      toStatus: 'rejected',
      reason: 'Not a real claim',
    });
    expect(requestModerationActions()).toEqual([['action:reject', 'outcome:ok']]);
  });

  it('allows reject with no reason (reason optional for requests) → reason null', async () => {
    await seed(reqRow());
    await seedWorkflow('vendor_claim');
    const res = await patchReq(moderateApp(), { action: 'reject' });
    expect(res.status).toBe(200);
    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions[0]!.toState).toBe('rejected');
    expect(transitions[0]!.reason).toBeNull();
  });

  it('hydrates target in the moderation response (AECI-217)', async () => {
    await t.db.insert(products).values({ id: TARGET_ID, slug: 'procore', name: 'Procore' });
    await seed(reqRow());
    await seedWorkflow('vendor_claim');
    const res = await patchReq(moderateApp(), { action: 'resolve' });
    const body = AdminVendorRequestSchema.parse(await res.json());
    expect(body.target).toEqual({ id: TARGET_ID, name: 'Procore', slug: 'procore' });
  });

  it('resolves from in_review, recording the real prior state', async () => {
    await seed(reqRow({ status: 'in_review' }));
    await seedWorkflow('vendor_claim', REQUEST_ID, 'in_review');
    const res = await patchReq(moderateApp(), { action: 'resolve' });
    expect(res.status).toBe(200);
    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions[0]!.fromState).toBe('in_review');
    expect(transitions[0]!.toState).toBe('resolved');
  });

  it('creates the workflow instance on the fly when one is missing', async () => {
    await seed(reqRow()); // no workflow instance seeded
    const res = await patchReq(moderateApp(), { action: 'resolve' });
    expect(res.status).toBe(200);
    const wfs = await t.db.select().from(workflowInstances);
    expect(wfs).toHaveLength(1);
    expect(wfs[0]!.workflowType).toBe('vendor_claim');
    expect(wfs[0]!.entityId).toBe(REQUEST_ID);
    expect(wfs[0]!.currentState).toBe('resolved');
    expect(wfs[0]!.finalOutcome).toBe('completed');
  });

  it('returns the canonical 404 envelope for an unknown request id', async () => {
    const sync = vi.fn<SyncRequestToLinear>(async () => {});
    const res = await patchReq(moderateApp(sync), { action: 'resolve' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string; id?: string } };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'vendor_request', id: REQUEST_ID });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(sync).not.toHaveBeenCalled();
  });

  it('returns 422 INVALID_STATE_TRANSITION for an already-terminal request', async () => {
    await seed(reqRow({ status: 'resolved' }));
    const sync = vi.fn<SyncRequestToLinear>(async () => {});
    const res = await patchReq(moderateApp(sync), { action: 'reject' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(sync).not.toHaveBeenCalled();
    expect(requestModerationActions()).toEqual([['action:reject', 'outcome:invalid_state']]);
  });

  it('rejects with 400 VALIDATION_FAILED for a missing/unknown action (DB untouched)', async () => {
    await seed(reqRow());
    const res = await patchReq(moderateApp(), { action: 'frobnicate' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.VALIDATION_FAILED,
    );
    // Validation fails before any DB write.
    const [row] = await t.db.select().from(vendorRequests).where(eq(vendorRequests.id, REQUEST_ID));
    expect(row!.status).toBe('open');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('rejects with 400 VALIDATION_FAILED when reason exceeds 500 chars', async () => {
    await seed(reqRow());
    const res = await patchReq(moderateApp(), { action: 'reject', reason: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect(body.error.field).toBe('reason');
  });
});
