/**
 * AECI-1539 — the admin read of private row threads (`STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.12, `ADMIN_PANEL_SPEC.md` §5.19).
 *
 * The handlers over the in-memory D1. What this file pins:
 *
 *   - the list: every thread, newest activity first, with its two companies, its
 *     data object, its message count and its help and close state;
 *   - `?help=requested` keeps only threads a seat asked AECi to look at;
 *   - a thread whose claim is gone is still named, from `anchor_snapshot`;
 *   - the detail returns every message oldest first, the TEXT of a soft-deleted
 *     one included (§15.3), and `404` on an unknown id;
 *   - neither read writes anything: no audit row, no read marker;
 *   - the deny matrix through the real `requireAdmin()` guard.
 */

import { AdminThreadDetailResponseSchema, AdminThreadsResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  claimThreadMessages,
  claimThreadReads,
  claimThreads,
  claims,
  integrations,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createAdminThreadDetailHandler, createAdminThreadsListHandler } from './admin-threads';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const I_MAIN = uuid(20);
const DO_RFIS = uuid(30);
const DO_DRAWINGS = uuid(31);
const C_RFIS = uuid(40);
const C_DRAWINGS = uuid(41);
const T_OPEN = uuid(50);
const T_HELP = uuid(51);
const T_REMOVED = uuid(52);
const M1 = uuid(60);
const M2 = uuid(61);
const M3 = uuid(62);
const M4 = uuid(63);
const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const ADMIN = uuid(105);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db.insert(integrations).values({
    id: I_MAIN,
    sourceProductId: P_SOURCE,
    targetProductId: P_TARGET,
    mechanismKind: 'native',
  });
  await t.db.insert(taxonomyDataObjects).values([
    { id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1 },
    { id: DO_DRAWINGS, slug: 'drawings', name: 'Drawings', displayOrder: 2 },
  ]);
  await t.db.insert(claims).values([
    { id: C_RFIS, integrationId: I_MAIN, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    { id: C_DRAWINGS, integrationId: I_MAIN, dataObjectId: DO_DRAWINGS, direction: 'both' },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: ADMIN, role: 'admin' },
  ]);
  await t.db.insert(claimThreads).values([
    {
      id: T_OPEN,
      claimId: C_RFIS,
      vendorAId: VENDOR_A,
      vendorBId: VENDOR_B,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: T_HELP,
      claimId: C_DRAWINGS,
      vendorAId: VENDOR_A,
      vendorBId: VENDOR_B,
      helpRequestedAt: '2026-10-03T00:00:00.000Z',
      createdAt: '2026-10-02T00:00:00.000Z',
    },
    // The claim was deleted: `claim_id` is null and the close stamped the anchor.
    {
      id: T_REMOVED,
      claimId: null,
      vendorAId: VENDOR_A,
      vendorBId: VENDOR_B,
      anchorSnapshot: { anchorId: I_MAIN, dataObjectId: DO_DRAWINGS },
      closedAt: '2026-10-05T00:00:00.000Z',
      closedReason: 'claim_removed',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  ]);
  await t.db.insert(claimThreadMessages).values([
    {
      id: M1,
      threadId: T_OPEN,
      authorProfileId: SEAT_A,
      authorVendorId: VENDOR_A,
      body: 'Do your RFIs carry a due date?',
      createdAt: '2026-10-01T10:00:00.000Z',
    },
    {
      id: M2,
      threadId: T_OPEN,
      authorProfileId: SEAT_B,
      authorVendorId: VENDOR_B,
      body: 'Withdrawn text the vendors no longer see',
      createdAt: '2026-10-06T10:00:00.000Z',
      deletedAt: '2026-10-06T11:00:00.000Z',
    },
    {
      id: M3,
      threadId: T_HELP,
      authorProfileId: null,
      authorVendorId: VENDOR_B,
      body: 'We think this row is wrong.',
      createdAt: '2026-10-02T10:00:00.000Z',
    },
    {
      id: M4,
      threadId: T_REMOVED,
      authorProfileId: SEAT_A,
      authorVendorId: VENDOR_A,
      body: 'Old conversation.',
      createdAt: '2026-09-01T10:00:00.000Z',
    },
  ]);
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.get('/api/admin/threads', createAdminThreadsListHandler(t.factory));
  a.get('/api/admin/threads/:id', createAdminThreadDetailHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function get(path: string): Promise<{ status: number; body: JsonBody }> {
  const res = await app().request(path, {}, TEST_ENV, fakeExecutionContext());
  return { status: res.status, body: (await res.json()) as JsonBody };
}

describe('GET /api/admin/threads', () => {
  it('lists every thread, newest activity first, with its companies and data object', async () => {
    const { status, body } = await get('/api/admin/threads');
    expect(status).toBe(200);
    expect(() => AdminThreadsResponseSchema.parse(body)).not.toThrow();
    expect(body.total).toBe(3);
    // T_OPEN's newest message (deleted, still counted) is 10-06, T_HELP's 10-02,
    // T_REMOVED's 09-01.
    expect(body.data.map((r: JsonBody) => r.id)).toEqual([T_OPEN, T_HELP, T_REMOVED]);
    expect(body.data[0]).toEqual({
      id: T_OPEN,
      claim_id: C_RFIS,
      data_object: { slug: 'rfis', name: 'RFIs' },
      vendor_a: { id: VENDOR_A, slug: 'autodesk', name: 'Autodesk' },
      vendor_b: { id: VENDOR_B, slug: 'bentley', name: 'Bentley' },
      message_count: 2,
      last_message_at: '2026-10-06T10:00:00.000Z',
      help_requested_at: null,
      closed_at: null,
      closed_reason: null,
      created_at: '2026-10-01T00:00:00.000Z',
    });
  });

  it('names a thread whose claim is gone from its anchor snapshot (§15.10)', async () => {
    const { body } = await get('/api/admin/threads');
    const removed = body.data.find((r: JsonBody) => r.id === T_REMOVED);
    expect(removed.claim_id).toBeNull();
    expect(removed.data_object).toEqual({ slug: 'drawings', name: 'Drawings' });
    expect(removed.closed_reason).toBe('claim_removed');
  });

  it('keeps only threads a seat asked AECi to look at with ?help=requested', async () => {
    const { body } = await get('/api/admin/threads?help=requested');
    expect(body.total).toBe(1);
    expect(body.data.map((r: JsonBody) => r.id)).toEqual([T_HELP]);
  });

  it('pages with the shared page query', async () => {
    const { body } = await get('/api/admin/threads?page=2&perPage=2');
    expect(body.page).toBe(2);
    expect(body.total).toBe(3);
    expect(body.data.map((r: JsonBody) => r.id)).toEqual([T_REMOVED]);
  });

  it('refuses an unknown help filter', async () => {
    const { status } = await get('/api/admin/threads?help=maybe');
    expect(status).toBe(400);
  });
});

describe('GET /api/admin/threads/:id', () => {
  it('returns every message oldest first, with the text of a deleted one (§15.3)', async () => {
    const { status, body } = await get(`/api/admin/threads/${T_OPEN}`);
    expect(status).toBe(200);
    expect(() => AdminThreadDetailResponseSchema.parse(body)).not.toThrow();
    expect(body.thread.messages).toEqual([
      {
        id: M1,
        author_vendor: { id: VENDOR_A, slug: 'autodesk', name: 'Autodesk' },
        author_profile_id: SEAT_A,
        body: 'Do your RFIs carry a due date?',
        created_at: '2026-10-01T10:00:00.000Z',
        deleted_at: null,
      },
      {
        id: M2,
        author_vendor: { id: VENDOR_B, slug: 'bentley', name: 'Bentley' },
        author_profile_id: SEAT_B,
        body: 'Withdrawn text the vendors no longer see',
        created_at: '2026-10-06T10:00:00.000Z',
        deleted_at: '2026-10-06T11:00:00.000Z',
      },
    ]);
  });

  it('keeps the company of an erased author, with a null profile', async () => {
    const { body } = await get(`/api/admin/threads/${T_HELP}`);
    expect(body.thread.help_requested_at).toBe('2026-10-03T00:00:00.000Z');
    expect(body.thread.messages[0].author_profile_id).toBeNull();
    expect(body.thread.messages[0].author_vendor.name).toBe('Bentley');
  });

  it('404s an unknown thread', async () => {
    const { status, body } = await get(`/api/admin/threads/${uuid(99)}`);
    expect(status).toBe(404);
    expect(body.error.details.resource).toBe('claim_thread');
  });

  it('writes nothing: no audit row and no read marker', async () => {
    await get('/api/admin/threads');
    await get(`/api/admin/threads/${T_OPEN}`);
    expect(await t.db.select().from(auditLog)).toEqual([]);
    expect(await t.db.select().from(claimThreadReads)).toEqual([]);
  });
});

// ─── Authorization ───────────────────────────────────────────────────────────

describe('/api/admin/threads — authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'staging', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guarded() {
    const guard = { getKey: jwks.getKey, dbFor: t.factory };
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.get('/api/admin/threads', requireAdmin(guard), createAdminThreadsListHandler(t.factory));
    a.get('/api/admin/threads/:id', requireAdmin(guard), createAdminThreadDetailHandler(t.factory));
    return a;
  }

  const request = (path: string, token?: string) =>
    guarded().request(
      path,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );
  const token = (sub: string) => jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL });

  it('401s an anonymous caller on both reads', async () => {
    expect((await request('/api/admin/threads')).status).toBe(401);
    expect((await request(`/api/admin/threads/${T_OPEN}`)).status).toBe(401);
  });

  it('403s a vendor seat of one of the two companies on both reads', async () => {
    const tk = await token(SEAT_A);
    expect((await request('/api/admin/threads', tk)).status).toBe(403);
    expect((await request(`/api/admin/threads/${T_OPEN}`, tk)).status).toBe(403);
  });

  it('lets an admin through on both reads', async () => {
    const tk = await token(ADMIN);
    expect((await request('/api/admin/threads', tk)).status).toBe(200);
    expect((await request(`/api/admin/threads/${T_OPEN}`, tk)).status).toBe(200);
  });
});
