/**
 * AECI-2036 — `PATCH /api/admin/products/:id/connector-kind`
 * (`STAGE_1_5_SPEC.md` §13.13, `ADMIN_PANEL_SPEC.md` §5.7).
 *
 * The handler is mounted bare behind a stub session, as `logos.spec.ts` does. The
 * guard and the limiter are `index.ts`'s, and `admin-panel.writes.spec.ts` pins the
 * registration to §6's table.
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, products, productVendors, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminSetConnectorKindHandler } from './admin-connector-kind';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = uuid(1);
const VENDOR = uuid(2);
const CONNECTOR = uuid(3);
const APPLICATION = uuid(4);
const HYBRID = uuid(5);

const AUTH: AuthzVariables['auth'] = {
  userId: ADMIN,
  email: 'admin@example.com',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;
let env: Env;
let send: ReturnType<typeof vi.fn>;

function app() {
  const hono = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  hono.onError(errorHandler());
  hono.use('*', async (c, next) => {
    c.set('auth', AUTH);
    await next();
  });
  hono.patch(
    '/api/admin/products/:id/connector-kind',
    createAdminSetConnectorKindHandler(t.factory),
  );
  return hono;
}

async function patch(id: string, body: unknown) {
  const ctx = fakeExecutionContext();
  const res = await app().request(
    `https://example.com/api/admin/products/${id}/connector-kind`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
    ctx,
  );
  await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map(([p]) => p));
  return res;
}

const kindOf = async (id: string) =>
  (await t.db.select().from(products).where(eq(products.id, id)))[0]?.connectorKind;

beforeEach(async () => {
  t = await makeTestDb();
  send = vi.fn().mockResolvedValue(undefined);
  env = { ...TEST_ENV, CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'] };
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'rivets', companyName: 'Rivets' });
  await t.db.insert(products).values([
    { id: CONNECTOR, slug: 'rivets-sync', name: 'Rivets Sync', productRole: 'connector' },
    { id: APPLICATION, slug: 'procore', name: 'Procore', productRole: 'application' },
    { id: HYBRID, slug: 'anyware', name: 'AnyWare Apps', productRole: 'hybrid' },
  ]);
  await t.db
    .insert(productVendors)
    .values({ productId: CONNECTOR, vendorId: VENDOR, isPrimary: true });
});
afterEach(() => t.dispose());

describe('PATCH /api/admin/products/:id/connector-kind', () => {
  it('sets the kind with its audit row in the same batch and queues the purge', async () => {
    const res = await patch(CONNECTOR, { connector_kind: 'sync_service' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: CONNECTOR,
      connector_kind: 'sync_service',
      changed: true,
    });
    expect(await kindOf(CONNECTOR)).toBe('sync_service');

    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'product.updated',
      entityType: 'product',
      entityId: CONNECTOR,
      productId: CONNECTOR,
      actorId: ADMIN,
      beforeState: { connectorKind: null },
      afterState: { connectorKind: 'sync_service' },
      metadata: { source: 'admin-panel', fields: ['connector_kind'] },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      tags: ['product:rivets-sync', 'index:products'],
      source: 'moderation',
    });
  });

  it('clears the kind with null, and audits the before value', async () => {
    await t.db
      .update(products)
      .set({ connectorKind: 'integration_platform' })
      .where(eq(products.id, CONNECTOR));
    const res = await patch(CONNECTOR, { connector_kind: null });
    expect(res.status).toBe(200);
    expect(await kindOf(CONNECTOR)).toBeNull();
    const [row] = await t.db.select().from(auditLog);
    expect(row).toMatchObject({
      beforeState: { connectorKind: 'integration_platform' },
      afterState: { connectorKind: null },
    });
  });

  it('sets the kind on a hybrid product', async () => {
    const res = await patch(HYBRID, { connector_kind: 'integration_platform' });
    expect(res.status).toBe(200);
    expect(await kindOf(HYBRID)).toBe('integration_platform');
  });

  it('refuses an application product with 409 and writes nothing', async () => {
    const res = await patch(APPLICATION, { connector_kind: 'sync_service' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'CONNECTOR_KIND_NOT_CONNECTOR',
        details: { product_role: 'application' },
      },
    });
    expect(await kindOf(APPLICATION)).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses when a promote moves the product off a connector role mid-request', async () => {
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce(async (queries) => {
      t.raw.prepare("UPDATE products SET product_role = 'application' WHERE id = ?").run(CONNECTOR);
      return original(queries);
    });
    const res = await patch(CONNECTOR, { connector_kind: 'sync_service' });
    expect(res.status).toBe(409);
    expect(await kindOf(CONNECTOR)).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('answers an unchanged value with changed: false and writes, audits and purges nothing', async () => {
    await t.db
      .update(products)
      .set({ connectorKind: 'sync_service' })
      .where(eq(products.id, CONNECTOR));
    const res = await patch(CONNECTOR, { connector_kind: 'sync_service' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false, connector_kind: 'sync_service' });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('404s an unknown product', async () => {
    const res = await patch(uuid(99), { connector_kind: 'sync_service' });
    expect(res.status).toBe(404);
  });

  it.each([
    ['an unknown kind', { connector_kind: 'ipaas' }],
    ['a missing kind', {}],
    ['an extra key', { connector_kind: 'sync_service', product_role: 'connector' }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = await patch(CONNECTOR, body);
    expect(res.status).toBe(400);
    expect(await kindOf(CONNECTOR)).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
