/**
 * "Looks right" (AECI-1216 / `STAGE_2_PAID_TIERS_SPEC.md` §13.8 and §13.9).
 *
 *   POST /api/vendor/profile/review
 *   POST /api/vendor/products/:id/review
 *   POST /api/vendor/products/:id/integrations/review
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the stamp, the audit-in-batch rule and the rollback run for real. Every route is
 * exercised as a seat with NO plan and as a Managed (`verified`) seat, because the
 * routes are seat-only and must behave identically on both.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorEvidencedPairs,
  integrations,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createReviewVendorProductHandler,
  createReviewVendorProductIntegrationsHandler,
  createReviewVendorProfileHandler,
} from './vendor-review';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OLD = '2026-01-01T00:00:00.000Z';

const VENDOR = uuid(1);
const OTHER = uuid(2);

const P_OWN = uuid(10); // VENDOR's product, the one under review
const P_PARTNER = uuid(11); // OTHER's product, the counterpart endpoint
const P_FOREIGN = uuid(12); // OTHER's product, never reachable by VENDOR
const P_OWN_TWO = uuid(13); // VENDOR's second product, not under review
const P_BRIDGE = uuid(14); // a connector product, OTHER's

// Integrations touching P_OWN, one per arm of the §13.9 rule.
const I_STAMP = uuid(20); // built by VENDOR, vendor-maintained → STAMPED
const I_AECI = uuid(21); // built by VENDOR, AECi-maintained → untouched
const I_OTHER = uuid(22); // built by OTHER, vendor-maintained → untouched
const I_RETIRED = uuid(23); // built by VENDOR, vendor-maintained, retired → untouched
const I_ELSEWHERE = uuid(24); // built by VENDOR, vendor-maintained, other product → untouched
const I_POWERED = uuid(25); // P_OWN is the connector; built by VENDOR, vendor-maintained → STAMPED

const E_STAMP = uuid(30); // evidenced pair on P_OWN, VENDOR's, vendor-maintained → STAMPED
const E_AECI = uuid(31); // evidenced pair on P_OWN, VENDOR's, AECi-maintained → untouched
const E_OTHER = uuid(32); // evidenced pair on P_OWN, OTHER's, vendor-maintained → untouched

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const FREE = seat(1, VENDOR);
const MANAGED: AuthzVariables['auth'] = {
  ...seat(2, VENDOR),
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
};
const OTHER_SEAT = seat(3, OTHER);

const PLANS = [
  ['a seat with no plan', FREE],
  ['a Managed seat', MANAGED],
] as const;

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'autodesk', companyName: 'Autodesk' },
    { id: OTHER, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: P_OWN, slug: 'revit', name: 'Revit' },
    { id: P_PARTNER, slug: 'microstation', name: 'MicroStation' },
    { id: P_FOREIGN, slug: 'openroads', name: 'OpenRoads' },
    { id: P_OWN_TWO, slug: 'acc', name: 'ACC' },
    { id: P_BRIDGE, slug: 'bridge', name: 'Bridge', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_OWN, vendorId: VENDOR, isPrimary: true },
    { productId: P_OWN_TWO, vendorId: VENDOR, isPrimary: true },
    { productId: P_PARTNER, vendorId: OTHER, isPrimary: true },
    { productId: P_FOREIGN, vendorId: OTHER, isPrimary: true },
    { productId: P_BRIDGE, vendorId: OTHER, isPrimary: true },
  ]);
  const vendorRow = (id: string, extra: Partial<typeof integrations.$inferInsert> = {}) => ({
    id,
    sourceProductId: P_OWN,
    targetProductId: P_PARTNER,
    builtByVendorId: VENDOR,
    maintainedBy: 'vendor',
    lastReviewedAt: OLD,
    ...extra,
  });
  await t.db.insert(integrations).values([
    vendorRow(I_STAMP),
    vendorRow(I_AECI, { maintainedBy: 'aeci' }),
    vendorRow(I_OTHER, {
      builtByVendorId: OTHER,
      sourceProductId: P_PARTNER,
      targetProductId: P_OWN,
    }),
    vendorRow(I_RETIRED, { retiredAt: OLD, retiredBy: 'owner' }),
    vendorRow(I_ELSEWHERE, { sourceProductId: P_OWN_TWO }),
    vendorRow(I_POWERED, {
      sourceProductId: P_PARTNER,
      targetProductId: P_FOREIGN,
      mechanismKind: 'iPaaS',
      poweredByProductId: P_OWN,
    }),
  ]);
  const pairRow = (
    id: string,
    extra: Partial<typeof connectorEvidencedPairs.$inferInsert> = {},
  ) => ({
    id,
    connectorProductId: P_BRIDGE,
    productAId: P_OWN,
    productBId: P_PARTNER,
    builtByVendorId: VENDOR,
    maintainedBy: 'vendor',
    lastReviewedAt: OLD,
    ...extra,
  });
  // The pair table's canonical order needs product_a_id < product_b_id. P_OWN (…10)
  // sorts before P_PARTNER (…11) and P_FOREIGN (…12), so each row below is canonical.
  await t.db
    .insert(connectorEvidencedPairs)
    .values([
      pairRow(E_STAMP),
      pairRow(E_AECI, { productBId: P_FOREIGN, maintainedBy: 'aeci' }),
      pairRow(E_OTHER, { productBId: P_OWN_TWO, builtByVendorId: OTHER }),
    ]);
  // `audit_log.actor_id` is an FK to `profiles`, so every seat needs its row.
  await t.db.insert(profiles).values(
    [FREE, MANAGED, OTHER_SEAT].map((auth) => ({
      id: auth.userId,
      role: 'vendor_admin',
      vendorId: auth.vendorId,
    })),
  );
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/profile/review', createReviewVendorProfileHandler(t.factory));
  a.post('/api/vendor/products/:id/review', createReviewVendorProductHandler(t.factory));
  a.post(
    '/api/vendor/products/:id/integrations/review',
    createReviewVendorProductIntegrationsHandler(t.factory),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function post(
  auth: AuthzVariables['auth'],
  path: string,
  body: string | undefined = '{}',
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) {
    init.body = body;
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const profileReview = (auth: AuthzVariables['auth'], body?: string) =>
  post(auth, '/api/vendor/profile/review', body);
const productReview = (auth: AuthzVariables['auth'], id = P_OWN, body?: string) =>
  post(auth, `/api/vendor/products/${id}/review`, body);
const listReview = (auth: AuthzVariables['auth'], id = P_OWN, body?: string) =>
  post(auth, `/api/vendor/products/${id}/integrations/review`, body);

const auditRows = () => t.db.select().from(auditLog);
const vendorRow = async (id = VENDOR) =>
  (await t.db.query.vendors.findFirst({ where: eq(vendors.id, id) }))!;
const productRow = async (id = P_OWN) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!;
const integrationRow = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const pairRow = async (id: string) =>
  (await t.db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  }))!;

/** The single message the purge queue received. */
function purged(send: ReturnType<typeof vi.fn>): { tags: string[]; source: string } {
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0]![0] as { tags: string[]; source: string };
}

// ─── POST /api/vendor/profile/review ─────────────────────────────────────────

describe('POST /api/vendor/profile/review', () => {
  it.each(PLANS)('stamps and transfers the vendor row for %s', async (_label, auth) => {
    const before = Date.now();
    const res = await profileReview(auth);
    expect(res.status).toBe(200);

    const row = await vendorRow();
    expect(row.maintainedBy).toBe('vendor');
    expect(row.lastReviewedAt).toBe(res.body.last_reviewed_at);
    expect(Date.parse(row.lastReviewedAt!)).toBeGreaterThanOrEqual(before);
    // The `profile` cursor on `GET /api/vendor/updates` reads this column.
    expect(row.updatedAt).toBe(res.body.last_reviewed_at);
  });

  it('writes one vendor.reviewed audit row, marking the hand-over only once', async () => {
    const first = await profileReview(FREE);
    await profileReview(FREE);
    const audits = await auditRows();
    expect(audits.map((a) => a.action)).toEqual(['vendor.reviewed', 'vendor.reviewed']);
    expect(audits[0]).toMatchObject({
      actorId: FREE.userId,
      actorType: 'user',
      entityType: 'vendor',
      entityId: VENDOR,
      beforeState: { maintained_by: 'aeci', last_reviewed_at: null },
      afterState: { maintained_by: 'vendor', last_reviewed_at: first.body.last_reviewed_at },
      metadata: {
        source: 'vendor-portal',
        vendorId: VENDOR,
        reason: 'looks-right',
        maintenanceTransfer: true,
      },
    });
    // The key is OMITTED on a later save, never `false` (§13.9 consequence 1).
    expect(audits[1]!.metadata).not.toHaveProperty('maintenanceTransfer');
  });

  it('queues the vendor:{slug} purge, as the profile edit does', async () => {
    const { send } = await profileReview(MANAGED);
    expect(purged(send)).toEqual({ tags: ['vendor:autodesk'], source: 'vendor' });
  });

  it('accepts a request with no body at all', async () => {
    const res = await profileReview(FREE, undefined);
    expect(res.status).toBe(200);
    expect((await vendorRow()).maintainedBy).toBe('vendor');
  });

  it('refuses a body carrying an edit, and writes nothing', async () => {
    const res = await profileReview(FREE, JSON.stringify({ description: 'New blurb' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((await vendorRow()).maintainedBy).toBe('aeci');
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await profileReview(FREE, 'not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('does not flip the vendor products: the transfer is per record', async () => {
    await profileReview(FREE);
    expect((await productRow()).maintainedBy).toBe('aeci');
  });

  it('rolls the stamp back when the audit row cannot be written (§26.1)', async () => {
    const ghost: AuthzVariables['auth'] = { ...FREE, userId: uuid(998) };
    expect((await profileReview(ghost)).status).toBe(500);
    const row = await vendorRow();
    expect(row.maintainedBy).toBe('aeci');
    expect(row.lastReviewedAt).toBeNull();
  });
});

// ─── POST /api/vendor/products/:id/review ────────────────────────────────────

describe('POST /api/vendor/products/:id/review', () => {
  it.each(PLANS)('stamps and transfers the product row for %s', async (_label, auth) => {
    const res = await productReview(auth);
    expect(res.status).toBe(200);
    expect(res.body.product_id).toBe(P_OWN);

    const row = await productRow();
    expect(row.maintainedBy).toBe('vendor');
    expect(row.lastReviewedAt).toBe(res.body.last_reviewed_at);
    // `$onUpdate` restamps it, which moves the `products` cursor.
    expect(row.updatedAt >= res.body.last_reviewed_at).toBe(true);
    // Not this route's column.
    expect(row.integrationsReviewedAt).toBeNull();
  });

  it('writes one product.reviewed audit row in the batch', async () => {
    const res = await productReview(FREE);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'product.reviewed',
      entityType: 'product',
      entityId: P_OWN,
      beforeState: { maintained_by: 'aeci', last_reviewed_at: null },
      afterState: { maintained_by: 'vendor', last_reviewed_at: res.body.last_reviewed_at },
      metadata: {
        source: 'vendor-portal',
        vendorId: VENDOR,
        reason: 'looks-right',
        maintenanceTransfer: true,
      },
    });
  });

  it("queues productEditTags' set with no facet change", async () => {
    const { send } = await productReview(MANAGED);
    expect(purged(send)).toEqual({
      tags: ['product:revit', 'index:products'],
      source: 'vendor',
    });
  });

  it('404s a product the vendor does not own, and writes nothing', async () => {
    const res = await productReview(FREE, P_FOREIGN);
    expect(res.status).toBe(404);
    expect((await productRow(P_FOREIGN)).maintainedBy).toBe('aeci');
    expect(await auditRows()).toHaveLength(0);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('404s a foreign product before reading the body', async () => {
    // A 400 here would confirm the product exists.
    const res = await productReview(FREE, P_FOREIGN, JSON.stringify({ description: 'x' }));
    expect(res.status).toBe(404);
  });

  it('does not flip the vendor row: the transfer is per record', async () => {
    await productReview(FREE);
    expect((await vendorRow()).maintainedBy).toBe('aeci');
  });

  it('rolls the stamp back when the audit row cannot be written (§26.1)', async () => {
    const ghost: AuthzVariables['auth'] = { ...FREE, userId: uuid(998) };
    expect((await productReview(ghost)).status).toBe(500);
    expect((await productRow()).lastReviewedAt).toBeNull();
  });
});

// ─── POST /api/vendor/products/:id/integrations/review ───────────────────────

describe('POST /api/vendor/products/:id/integrations/review', () => {
  it.each(PLANS)('stamps only the rows the vendor already maintains, for %s', async (_l, auth) => {
    const res = await listReview(auth);
    expect(res.status).toBe(200);
    const now = res.body.integrations_reviewed_at as string;
    expect(res.body).toEqual({
      product_id: P_OWN,
      integrations_reviewed_at: now,
      stamped_count: 3,
    });

    expect((await productRow()).integrationsReviewedAt).toBe(now);

    // Stamped: vendor-maintained, built by the caller, live, touching the product
    // (as an endpoint, or as the connector powering the row).
    for (const id of [I_STAMP, I_POWERED]) {
      expect((await integrationRow(id)).lastReviewedAt, id).toBe(now);
    }
    expect((await pairRow(E_STAMP)).lastReviewedAt).toBe(now);

    // Untouched: AECi-maintained, another vendor's, retired, or on another product.
    for (const id of [I_AECI, I_OTHER, I_RETIRED, I_ELSEWHERE]) {
      expect((await integrationRow(id)).lastReviewedAt, id).toBe(OLD);
    }
    for (const id of [E_AECI, E_OTHER]) {
      expect((await pairRow(id)).lastReviewedAt, id).toBe(OLD);
    }
  });

  it('never writes maintained_by on either table', async () => {
    await listReview(FREE);
    expect((await integrationRow(I_AECI)).maintainedBy).toBe('aeci');
    expect((await pairRow(E_AECI)).maintainedBy).toBe('aeci');
    expect((await integrationRow(I_STAMP)).maintainedBy).toBe('vendor');
  });

  it('leaves the product maintenance pair alone', async () => {
    await listReview(FREE);
    const row = await productRow();
    expect(row.maintainedBy).toBe('aeci');
    expect(row.lastReviewedAt).toBeNull();
  });

  it('writes one audit row keyed to the product, naming the stamped ids', async () => {
    const res = await listReview(MANAGED);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: MANAGED.userId,
      action: 'product.integrations_reviewed',
      entityType: 'product',
      entityId: P_OWN,
      beforeState: { integrations_reviewed_at: null },
      afterState: { integrations_reviewed_at: res.body.integrations_reviewed_at },
      metadata: {
        source: 'vendor-portal',
        vendorId: VENDOR,
        reason: 'looks-right',
        integrationIds: [I_STAMP, I_POWERED].sort(),
        evidencedPairIds: [E_STAMP],
      },
    });
  });

  it('queues product:{slug} plus each stamped integration: tag', async () => {
    const { send } = await listReview(FREE);
    const message = purged(send);
    expect(message.source).toBe('vendor');
    expect(message.tags).toEqual([
      'product:revit',
      ...[I_STAMP, I_POWERED].sort().map((id) => `integration:${id}`),
      `integration:${E_STAMP}`,
    ]);
  });

  it('still stamps the product when the vendor maintains no row on it', async () => {
    // P_OWN_TWO carries one stampable row, I_ELSEWHERE. Hand it to AECi so the
    // vendor maintains nothing on this product.
    await t.db
      .update(integrations)
      .set({ maintainedBy: 'aeci' })
      .where(eq(integrations.id, I_ELSEWHERE));
    const again = await listReview(FREE, P_OWN_TWO);
    expect(again.body.stamped_count).toBe(0);
    expect((await productRow(P_OWN_TWO)).integrationsReviewedAt).toBe(
      again.body.integrations_reviewed_at,
    );
    const last = (await auditRows()).at(-1)!;
    expect(last.metadata).toMatchObject({ integrationIds: [], evidencedPairIds: [] });
    expect(purged(again.send).tags).toEqual(['product:acc']);
  });

  it('404s a product the vendor does not own, and writes nothing', async () => {
    const res = await listReview(OTHER_SEAT, P_OWN);
    expect(res.status).toBe(404);
    expect((await productRow()).integrationsReviewedAt).toBeNull();
    expect((await integrationRow(I_OTHER)).lastReviewedAt).toBe(OLD);
    expect(await auditRows()).toHaveLength(0);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('refuses a body carrying anything', async () => {
    const res = await listReview(FREE, P_OWN, JSON.stringify({ ids: [I_AECI] }));
    expect(res.status).toBe(400);
    expect((await integrationRow(I_AECI)).lastReviewedAt).toBe(OLD);
  });

  it('rolls every stamp back when the audit row cannot be written (§26.1)', async () => {
    const ghost: AuthzVariables['auth'] = { ...FREE, userId: uuid(998) };
    expect((await listReview(ghost)).status).toBe(500);
    expect((await productRow()).integrationsReviewedAt).toBeNull();
    expect((await integrationRow(I_STAMP)).lastReviewedAt).toBe(OLD);
    expect((await pairRow(E_STAMP)).lastReviewedAt).toBe(OLD);
  });
});
