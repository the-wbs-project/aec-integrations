/**
 * `GET /api/vendor/recrawl-submissions` (AECI-1187).
 *
 * Per the repo split, this spec stubs `c.set('auth', …)` and exercises the
 * handler over the in-memory D1 harness. The real `requireVendor()` guard cells
 * (anon 401, reviewer 403, site admin 403, unlinked seat 403, banned 403, granted
 * seat 200) live in `vendor.authz-matrix.spec.ts`, which lists this route.
 *
 * The load-bearing assertion is isolation on a SHARED URL: a pair page both
 * endpoint vendors edited is one submission with two causes, and each vendor
 * must see only its own cause row.
 */

import { ListVendorRecrawlSubmissionsResponseSchema } from '@aeci/shared';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  products,
  recrawlSubmissionCauses,
  recrawlSubmissions,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';

import {
  createListVendorRecrawlSubmissionsHandler,
  vendorRecrawlSubmissionsWhere,
} from './vendor-recrawl-submissions';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const QUIET_VENDOR = uuid(3);
const PRODUCT = uuid(10);
const OTHER_PRODUCT = uuid(11);
const SEAT = uuid(20);
const AUDIT_MINE = uuid(30);
const AUDIT_THEIRS = uuid(31);
const BASE = 'https://www.aecintegrations.com';
const PAIR_URL = `${BASE}/products/autodesk-build/integrations/microstation`;

const AUTH: AuthzVariables['auth'] = {
  userId: SEAT,
  email: 'ops@autodesk.test',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
};
const asVendor = (vendorId: string | null): AuthzVariables['auth'] => ({ ...AUTH, vendorId });

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'autodesk', companyName: 'Autodesk' },
    { id: OTHER_VENDOR, slug: 'bentley', companyName: 'Bentley' },
    { id: QUIET_VENDOR, slug: 'trimble', companyName: 'Trimble' },
  ]);
  await t.db.insert(products).values([
    { id: PRODUCT, slug: 'autodesk-build', name: 'Autodesk Build' },
    { id: OTHER_PRODUCT, slug: 'microstation', name: 'MicroStation' },
  ]);
  await t.db.insert(auditLog).values([
    { id: AUDIT_MINE, actorType: 'user', action: 'product.updated' },
    { id: AUDIT_THEIRS, actorType: 'user', action: 'integration.updated' },
  ]);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth'] = AUTH) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/recrawl-submissions', createListVendorRecrawlSubmissionsHandler(t.factory));
  return a;
}

async function get(auth?: AuthzVariables['auth'], qs = '') {
  const res = await app(auth).request(
    `/api/vendor/recrawl-submissions${qs}`,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, body: (await res.json()) as Record<string, any> };
}

async function submission(over: {
  url?: string;
  channel?: 'indexnow' | 'gsc_manual';
  outcome?: 'accepted' | 'refused' | 'failed' | 'requested';
  submittedAt?: string;
}): Promise<number> {
  const [row] = await t.db
    .insert(recrawlSubmissions)
    .values({
      url: over.url ?? `${BASE}/products/autodesk-build`,
      channel: over.channel ?? 'indexnow',
      outcome: over.outcome ?? 'accepted',
      httpStatus: over.channel === 'gsc_manual' ? null : 200,
      batchId: crypto.randomUUID(),
      priority: 1,
      submittedAt: over.submittedAt ?? '2026-10-04T00:05:00.000Z',
    })
    .returning({ id: recrawlSubmissions.id });
  return row!.id;
}

async function cause(
  submissionId: number,
  over: {
    vendorId?: string | null;
    productId?: string | null;
    auditLogId?: string | null;
    queuedAt?: string;
  } = {},
) {
  await t.db.insert(recrawlSubmissionCauses).values({
    submissionId,
    source: over.vendorId === null ? 'promote' : 'vendor',
    vendorId: over.vendorId === undefined ? VENDOR : over.vendorId,
    productId: over.productId === undefined ? PRODUCT : over.productId,
    auditLogId: over.auditLogId === undefined ? AUDIT_MINE : over.auditLogId,
    queuedAt: over.queuedAt ?? '2026-10-03T12:00:00.000Z',
  });
}

describe('vendorRecrawlSubmissionsWhere (the scoping predicate)', () => {
  const dialect = new SQLiteSyncDialect();

  it('filters on the cause row’s vendor, bound as a parameter', () => {
    const q = dialect.sqlToQuery(vendorRecrawlSubmissionsWhere(VENDOR));
    expect(q.sql).toBe('"recrawl_submission_causes"."vendor_id" = ?');
    expect(q.params).toEqual([VENDOR]);
  });

  it('ANDs the channel onto the vendor filter, never replacing it', () => {
    const q = dialect.sqlToQuery(vendorRecrawlSubmissionsWhere(VENDOR, 'gsc_manual'));
    expect(q.sql).toBe(
      '("recrawl_submission_causes"."vendor_id" = ? and "recrawl_submissions"."channel" = ?)',
    );
    expect(q.params).toEqual([VENDOR, 'gsc_manual']);
  });
});

describe('GET /api/vendor/recrawl-submissions', () => {
  it('returns the vendor’s submission with its cause, action and product', async () => {
    const id = await submission({});
    await cause(id);

    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(() => ListVendorRecrawlSubmissionsResponseSchema.parse(body)).not.toThrow();
    expect(body).toEqual({
      data: [
        {
          submission_id: id,
          url: `${BASE}/products/autodesk-build`,
          channel: 'indexnow',
          outcome: 'accepted',
          submitted_at: '2026-10-04T00:05:00.000Z',
          cause: {
            audit_log_id: AUDIT_MINE,
            action: 'product.updated',
            product_id: PRODUCT,
            product_slug: 'autodesk-build',
            product_name: 'Autodesk Build',
            queued_at: '2026-10-03T12:00:00.000Z',
          },
        },
      ],
      page: 1,
      perPage: 24,
      total: 1,
    });
  });

  it('on a shared URL, each vendor sees only its own cause', async () => {
    const id = await submission({ url: PAIR_URL });
    await cause(id, { vendorId: VENDOR, productId: PRODUCT, auditLogId: AUDIT_MINE });
    await cause(id, {
      vendorId: OTHER_VENDOR,
      productId: OTHER_PRODUCT,
      auditLogId: AUDIT_THEIRS,
    });
    // A promote cause names no vendor and must reach nobody.
    await cause(id, { vendorId: null, productId: null, auditLogId: null });

    const mine = await get(asVendor(VENDOR));
    expect(mine.body.total).toBe(1);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].cause).toMatchObject({
      audit_log_id: AUDIT_MINE,
      action: 'product.updated',
      product_id: PRODUCT,
    });

    const theirs = await get(asVendor(OTHER_VENDOR));
    expect(theirs.body.total).toBe(1);
    expect(theirs.body.data[0].cause).toMatchObject({
      audit_log_id: AUDIT_THEIRS,
      action: 'integration.updated',
      product_id: OTHER_PRODUCT,
    });

    // Neither response names the other vendor's audit row or product.
    expect(JSON.stringify(mine.body)).not.toContain(AUDIT_THEIRS);
    expect(JSON.stringify(mine.body)).not.toContain(OTHER_PRODUCT);
    expect(JSON.stringify(theirs.body)).not.toContain(AUDIT_MINE);
    expect(JSON.stringify(theirs.body)).not.toContain(PRODUCT);
  });

  it('is an empty list for a vendor with no causes', async () => {
    await cause(await submission({}));
    const { res, body } = await get(asVendor(QUIET_VENDOR));
    expect(res.status).toBe(200);
    expect(body).toEqual({ data: [], page: 1, perPage: 24, total: 0 });
  });

  it('serves a Free vendor (no entitlement) with 200: the read is never gated', async () => {
    await cause(await submission({}));
    const { res, body } = await get({
      ...AUTH,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
  });

  it('filters by channel', async () => {
    await cause(await submission({ channel: 'indexnow', outcome: 'refused' }));
    const gsc = await submission({
      channel: 'gsc_manual',
      outcome: 'requested',
      submittedAt: '2026-10-02T09:00:00.000Z',
    });
    await cause(gsc);

    const { body } = await get(AUTH, '?channel=gsc_manual');
    expect(body.total).toBe(1);
    expect(body.data.map((r: { submission_id: number }) => r.submission_id)).toEqual([gsc]);
    expect(body.data[0]).toMatchObject({ channel: 'gsc_manual', outcome: 'requested' });
  });

  it('rejects an unknown channel with 400', async () => {
    const { res } = await get(AUTH, '?channel=google');
    expect(res.status).toBe(400);
  });

  it('orders submitted_at DESC, then submission id DESC, then cause id DESC', async () => {
    const older = await submission({ submittedAt: '2026-10-01T00:05:00.000Z' });
    // Two submissions in one drain run share a submitted_at.
    const sameRunA = await submission({
      url: `${BASE}/a`,
      submittedAt: '2026-10-04T00:05:00.000Z',
    });
    const sameRunB = await submission({
      url: `${BASE}/b`,
      submittedAt: '2026-10-04T00:05:00.000Z',
    });
    await cause(older);
    await cause(sameRunA);
    // Two of this vendor's edits queued the same URL: one submission, two rows.
    await cause(sameRunB, { queuedAt: '2026-10-03T01:00:00.000Z' });
    await cause(sameRunB, { queuedAt: '2026-10-03T02:00:00.000Z', productId: null });

    const { body } = await get();
    expect(
      body.data.map((r: { submission_id: number; cause: { queued_at: string } }) => [
        r.submission_id,
        r.cause.queued_at,
      ]),
    ).toEqual([
      [sameRunB, '2026-10-03T02:00:00.000Z'],
      [sameRunB, '2026-10-03T01:00:00.000Z'],
      [sameRunA, '2026-10-03T12:00:00.000Z'],
      [older, '2026-10-03T12:00:00.000Z'],
    ]);
    // A cause naming no product keeps its row, with null product fields.
    expect(body.data[0].cause).toMatchObject({
      product_id: null,
      product_slug: null,
      product_name: null,
    });
  });

  it('a URL refused N times yields N rows with the same cause', async () => {
    for (const day of ['01', '02', '03']) {
      await cause(
        await submission({ outcome: 'refused', submittedAt: `2026-10-${day}T00:05:00.000Z` }),
      );
    }
    const { body } = await get();
    expect(body.total).toBe(3);
    expect(new Set(body.data.map((r: { url: string }) => r.url)).size).toBe(1);
    expect(body.data.every((r: { outcome: string }) => r.outcome === 'refused')).toBe(true);
  });

  it('paginates with a total counted over every page', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await submission({ submittedAt: `2026-10-0${i + 1}T00:05:00.000Z` });
      await cause(id);
      ids.push(id);
    }
    const newestFirst = [...ids].reverse();

    const p1 = await get(AUTH, '?page=1&perPage=2');
    const p3 = await get(AUTH, '?page=3&perPage=2');
    expect(p1.body).toMatchObject({ page: 1, perPage: 2, total: 5 });
    expect(p1.body.data.map((r: { submission_id: number }) => r.submission_id)).toEqual(
      newestFirst.slice(0, 2),
    );
    expect(p3.body).toMatchObject({ page: 3, perPage: 2, total: 5 });
    expect(p3.body.data.map((r: { submission_id: number }) => r.submission_id)).toEqual(
      newestFirst.slice(4),
    );
  });

  it('keeps a cause whose audit row is absent, with a null action', async () => {
    await cause(await submission({}), { auditLogId: uuid(99) });
    const { body } = await get();
    expect(body.data[0].cause).toMatchObject({ audit_log_id: uuid(99), action: null });
  });

  it('answers 403 when the session names no vendor (guard not mounted)', async () => {
    const { res, body } = await get(asVendor(null));
    expect(res.status).toBe(403);
    expect(body.error?.code ?? body.code).toBe('FORBIDDEN');
  });

  it('writes no audit_log row', async () => {
    await cause(await submission({}));
    const before = await t.db.select().from(auditLog);
    await get();
    const after = await t.db.select().from(auditLog);
    expect(after).toHaveLength(before.length);
  });
});
