/**
 * AECI-2046 — `PATCH /api/admin/products/:id/sync-facts` (`STAGE_1_5_SPEC.md` §13.13,
 * `ADMIN_PANEL_SPEC.md` §5.7), and how the product read shows the facts.
 *
 * The handler is mounted bare behind a stub session, as `admin-connector-kind.spec.ts`
 * does. The guard and the limiter are `index.ts`'s, and `admin-panel.writes.spec.ts`
 * pins the registration to §6's table. That promote never writes or clears the facts is
 * pinned in `promote.spec.ts`.
 */
import { SYNC_FACT_MAX_LENGTH } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, products, productVendors, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminSetSyncFactsHandler } from './admin-sync-facts';
import { createProductDetailHandler } from './products';

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
const SYNC = uuid(3);
const PLATFORM = uuid(4);
const BLANK = uuid(5);
const APPLICATION = uuid(6);

const AUTH: AuthzVariables['auth'] = {
  userId: ADMIN,
  email: 'admin@example.com',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

const FACTS = {
  sync_frequency: 'Every 15 minutes',
  sync_support: 'Rivets supports it, by email and phone',
  sync_setup: 'Rivets sets it up in a one-hour call',
  source_url: 'https://example.com/rivets-sync',
};
const UNSET = {
  sync_frequency: null,
  sync_support: null,
  sync_setup: null,
  source_url: null,
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
  hono.patch('/api/admin/products/:id/sync-facts', createAdminSetSyncFactsHandler(t.factory));
  hono.get('/api/products/:slug', createProductDetailHandler(t.factory));
  return hono;
}

async function patch(id: string, body: unknown) {
  const ctx = fakeExecutionContext();
  const res = await app().request(
    `https://example.com/api/admin/products/${id}/sync-facts`,
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

async function read(slug: string) {
  const res = await app().request(
    `https://example.com/api/products/${slug}`,
    {},
    env,
    fakeExecutionContext(),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { sync_facts: unknown; what_it_syncs: unknown };
}

const stored = async (id: string) => {
  const [row] = await t.db.select().from(products).where(eq(products.id, id));
  return {
    sync_frequency: row?.syncFrequency ?? null,
    sync_support: row?.syncSupport ?? null,
    sync_setup: row?.syncSetup ?? null,
    source_url: row?.syncFactsSourceUrl ?? null,
  };
};
const recordedAt = async (id: string) =>
  (await t.db.select().from(products).where(eq(products.id, id)))[0]?.syncFactsRecordedAt ?? null;

beforeEach(async () => {
  t = await makeTestDb();
  send = vi.fn().mockResolvedValue(undefined);
  env = { ...TEST_ENV, CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'] };
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'rivets', companyName: 'Rivets' });
  await t.db.insert(products).values([
    {
      id: SYNC,
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
    },
    {
      id: PLATFORM,
      slug: 'zapier',
      name: 'Zapier',
      productRole: 'connector',
      connectorKind: 'integration_platform',
    },
    { id: BLANK, slug: 'appxchange', name: 'AppXchange', productRole: 'connector' },
    { id: APPLICATION, slug: 'procore', name: 'Procore', productRole: 'application' },
  ]);
  await t.db.insert(productVendors).values({ productId: SYNC, vendorId: VENDOR, isPrimary: true });
});
afterEach(() => t.dispose());

describe('PATCH /api/admin/products/:id/sync-facts', () => {
  it('sets the facts with their audit row in the same batch and purges the product page', async () => {
    const res = await patch(SYNC, FACTS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recorded_at: string };
    expect(body).toMatchObject({ id: SYNC, ...FACTS, changed: true });
    expect(await stored(SYNC)).toEqual(FACTS);
    // The date the page prints with the source ("marked as ours, with its source and date").
    expect(await recordedAt(SYNC)).toBe(body.recorded_at);
    expect(Number.isNaN(Date.parse(body.recorded_at))).toBe(false);

    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'product.updated',
      entityType: 'product',
      entityId: SYNC,
      productId: SYNC,
      actorId: ADMIN,
      beforeState: UNSET,
      afterState: FACTS,
      metadata: {
        source: 'admin-panel',
        fields: ['sync_frequency', 'sync_support', 'sync_setup', 'source_url'],
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ tags: ['product:rivets-sync'], source: 'moderation' });
  });

  it('trims each value, clears a blank one, and audits only the fields that changed', async () => {
    await patch(SYNC, FACTS);
    await t.db.delete(auditLog);
    const res = await patch(SYNC, {
      sync_frequency: `  ${FACTS.sync_frequency}  `,
      sync_support: '   ',
      sync_setup: FACTS.sync_setup,
      source_url: FACTS.source_url,
    });
    expect(res.status).toBe(200);
    expect(await stored(SYNC)).toEqual({ ...FACTS, sync_support: null });
    const [row] = await t.db.select().from(auditLog);
    expect(row).toMatchObject({
      beforeState: { sync_support: FACTS.sync_support },
      afterState: { sync_support: null },
      metadata: { fields: ['sync_support'] },
    });
  });

  it('answers an unchanged set with changed: false and writes, audits and purges nothing', async () => {
    await patch(SYNC, FACTS);
    await t.db.delete(auditLog);
    send.mockClear();
    const res = await patch(SYNC, FACTS);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['an Integration platform', PLATFORM, 'connector', 'integration_platform'],
    ['a connector with no kind', BLANK, 'connector', null],
    ['an application', APPLICATION, 'application', null],
  ])('refuses %s with 409 and writes nothing', async (_label, id, role, kind) => {
    const res = await patch(id, FACTS);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'SYNC_FACTS_NOT_SYNC_SERVICE',
        details: { product_role: role, connector_kind: kind },
      },
    });
    expect(await stored(id)).toEqual(UNSET);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses when the kind changes between the read and the batch', async () => {
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce(async (queries) => {
      t.raw
        .prepare("UPDATE products SET connector_kind = 'integration_platform' WHERE id = ?")
        .run(SYNC);
      return original(queries);
    });
    const res = await patch(SYNC, FACTS);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'SYNC_FACTS_NOT_SYNC_SERVICE',
        details: { connector_kind: 'integration_platform' },
      },
    });
    expect(await stored(SYNC)).toEqual(UNSET);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('404s an unknown product', async () => {
    expect((await patch(uuid(99), FACTS)).status).toBe(404);
  });

  it.each([
    ['a missing key', { sync_frequency: 'Hourly', sync_support: null, sync_setup: null }],
    ['a fact with no source link', { ...FACTS, source_url: null }],
    ['a source that is not an https link', { ...FACTS, source_url: 'http://example.com' }],
    ['an extra key', { ...FACTS, connector_kind: 'sync_service' }],
    [
      'a value over its cap',
      { ...FACTS, sync_setup: 'x'.repeat(SYNC_FACT_MAX_LENGTH.sync_setup + 1) },
    ],
    ['a value that is not text', { ...FACTS, sync_frequency: 15 }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = await patch(SYNC, body);
    expect(res.status).toBe(400);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('clears the source and the date with the last fact', async () => {
    await patch(SYNC, FACTS);
    const res = await patch(SYNC, { ...UNSET, source_url: FACTS.source_url });
    expect(res.status).toBe(200);
    expect(await stored(SYNC)).toEqual(UNSET);
    expect(await recordedAt(SYNC)).toBeNull();
  });

  it('accepts a value at its cap', async () => {
    const res = await patch(SYNC, {
      ...FACTS,
      sync_setup: 'x'.repeat(SYNC_FACT_MAX_LENGTH.sync_setup),
    });
    expect(res.status).toBe(200);
  });
});

describe('the product read shows the facts only on a Sync Service', () => {
  it('carries them on a Sync Service, and null when none is recorded', async () => {
    expect((await read('rivets-sync')).sync_facts).toBeNull();
    await patch(SYNC, FACTS);
    expect((await read('rivets-sync')).sync_facts).toMatchObject(FACTS);
  });

  it('keeps them stored after a kind change, and hides them until it is a Sync Service again', async () => {
    await patch(SYNC, FACTS);
    await t.db
      .update(products)
      .set({ connectorKind: 'integration_platform' })
      .where(eq(products.id, SYNC));
    const hidden = await read('rivets-sync');
    expect(hidden.sync_facts).toBeNull();
    expect(hidden.what_it_syncs).toBeNull();
    expect(await stored(SYNC)).toEqual(FACTS);

    await t.db.update(products).set({ connectorKind: 'sync_service' }).where(eq(products.id, SYNC));
    expect((await read('rivets-sync')).sync_facts).toMatchObject(FACTS);
  });

  it('never carries a block on a product that is not a Sync Service', async () => {
    const body = await read('procore');
    expect(body.sync_facts).toBeNull();
    expect(body.what_it_syncs).toBeNull();
  });
});
