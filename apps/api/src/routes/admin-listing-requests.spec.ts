/**
 * The admin listing request queue (AECI-1293, `VENDOR_PROGRAM_PAGE_SPEC.md` §15.5)
 * against the in-memory D1 harness. A stub middleware sets the `auth` Variable
 * `requireAdmin()` would (the guard itself is covered in `authz.spec.ts`).
 */

import {
  ApiErrorCode,
  AdminListingRequestSchema,
  ListListingRequestsResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, listingRequests, profiles, vendorRequests } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createAdminListingRequestsListHandler,
  createModerateListingRequestHandler,
} from './admin-listing-requests';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const REQ_A = '33333333-3333-4333-8333-333333333333';
const REQ_B = '55555555-5555-4555-8555-555555555555';

const ADMIN_AUTH: AuthzVariables['auth'] = {
  userId: ADMIN_ID,
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
});
afterEach(() => t.dispose());

function row(o: Partial<typeof listingRequests.$inferInsert> = {}) {
  return {
    id: REQ_A,
    listingName: 'Site Diary Pro',
    website: 'https://sitediary.example.com',
    submitterEmail: 'pat@sitediary.example.com',
    submitterName: 'Pat Lee',
    submitterRole: 'Founder',
    submitterLinkedinUrl: null,
    body: 'Two products.',
    status: 'open',
    createdAt: '2026-10-12T08:00:00.000Z',
    ...o,
  } satisfies typeof listingRequests.$inferInsert;
}

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('/api/admin/listing-requests/*', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  a.use('/api/admin/listing-requests', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  a.get('/api/admin/listing-requests', createAdminListingRequestsListHandler(t.factory));
  a.patch('/api/admin/listing-requests/:id', createModerateListingRequestHandler(t.factory));
  return a;
}

const list = (qs = '') =>
  app().request(`/api/admin/listing-requests${qs}`, {}, TEST_ENV, fakeExecutionContext());

const patch = (id: string, body: unknown) =>
  app().request(
    `/api/admin/listing-requests/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

describe('GET /api/admin/listing-requests', () => {
  it('lists open requests newest first with every field the queue shows', async () => {
    await t.db
      .insert(listingRequests)
      .values([
        row(),
        row({ id: REQ_B, listingName: 'Newer', createdAt: '2026-10-12T09:00:00.000Z' }),
        row({ id: crypto.randomUUID(), status: 'resolved' }),
      ]);
    const res = await list();
    expect(res.status).toBe(200);
    const parsed = ListListingRequestsResponseSchema.parse(await res.json());
    expect(parsed.total).toBe(2);
    expect(parsed.data.map((r) => r.id)).toEqual([REQ_B, REQ_A]);
    expect(parsed.data[1]).toMatchObject({
      listing_name: 'Site Diary Pro',
      website: 'https://sitediary.example.com',
      submitter_email: 'pat@sitediary.example.com',
      body: 'Two products.',
    });
  });

  it('filters by status', async () => {
    await t.db.insert(listingRequests).values([row(), row({ id: REQ_B, status: 'rejected' })]);
    const parsed = ListListingRequestsResponseSchema.parse(
      await (await list('?status=rejected')).json(),
    );
    expect(parsed.data.map((r) => r.id)).toEqual([REQ_B]);
  });

  // AECI-1365: a row saved before the plan question was retired keeps its answer in
  // the deprecated column, but the queue no longer returns it.
  it('leaves a legacy stored plan answer out of the response', async () => {
    await t.db.insert(listingRequests).values(row({ planInterest: 'managed' }));
    const body = (await (await list()).json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('plan_interest');
  });
});

describe('PATCH /api/admin/listing-requests/:id', () => {
  it('resolves an open request and writes its audit row in the same batch', async () => {
    await t.db.insert(listingRequests).values(row());
    const batch = vi.spyOn(t.db, 'batch');
    const res = await patch(REQ_A, { action: 'resolve' });
    expect(res.status).toBe(200);
    const body = AdminListingRequestSchema.parse(await res.json());
    expect(body.status).toBe('resolved');
    expect(body.resolved_by).toBe(ADMIN_ID);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);

    const [stored] = await t.db.select().from(listingRequests).where(eq(listingRequests.id, REQ_A));
    expect(stored).toMatchObject({ status: 'resolved', resolvedById: ADMIN_ID });
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({
      action: 'listing_request.resolved',
      entityType: 'listing_request',
      entityId: REQ_A,
      actorId: ADMIN_ID,
    });
    batch.mockRestore();
  });

  it('records a reject reason in the audit row only', async () => {
    await t.db.insert(listingRequests).values(row());
    const res = await patch(REQ_A, { action: 'reject', reason: 'Not AEC software.' });
    expect(res.status).toBe(200);
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({ action: 'listing_request.rejected' });
    expect(audit!.metadata).toMatchObject({ reason: 'Not AEC software.' });
  });

  it('answers 422 on a request that is already decided, and writes nothing', async () => {
    await t.db.insert(listingRequests).values(row({ status: 'resolved' }));
    const res = await patch(REQ_A, { action: 'reject' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ApiErrorCode.INVALID_STATE_TRANSITION,
    );
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('answers 404 for an unknown id and 400 for a bad action', async () => {
    expect((await patch(REQ_A, { action: 'resolve' })).status).toBe(404);
    await t.db.insert(listingRequests).values(row());
    expect((await patch(REQ_A, { action: 'approve' })).status).toBe(400);
  });
});

describe('pending_requests (AECI-1293)', () => {
  it('counts open corrections plus open listing requests, and never claims', async () => {
    await t.db.insert(listingRequests).values([row(), row({ id: REQ_B, status: 'resolved' })]);
    await t.db.insert(vendorRequests).values([
      {
        kind: 'correction',
        status: 'open',
        targetType: 'product',
        targetId: crypto.randomUUID(),
        submitterEmail: 'a@example.com',
        body: 'A correction body that is long enough.',
      },
      {
        kind: 'claim',
        status: 'open',
        targetType: 'vendor',
        targetId: crypto.randomUUID(),
        submitterEmail: 'b@example.com',
        body: '',
      },
    ]);
    const counts = await readAdminQueueCounts(t.db);
    expect(counts.pending_requests).toBe(2);
    expect(counts.pending_claims).toBe(1);
  });
});
