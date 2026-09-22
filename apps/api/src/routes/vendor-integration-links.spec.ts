/**
 * `PUT` / `DELETE /api/vendor/integrations/:id/links/:productId/:kind`
 * (AECI-1007 / ADR 0035 decision 6 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.7).
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the upsert, the maintenance transfer and the audit-in-batch rule run for real.
 */

import { IntegrationLinkResponseSchema, ListVendorIntegrationsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  integrations,
  integrationVendorLinks,
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
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import {
  createDeleteIntegrationLinkHandler,
  createPutIntegrationLinkHandler,
  INTEGRATION_LINK_REMOVED_ACTION,
  INTEGRATION_LINK_SET_ACTION,
} from './vendor-integration-links';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns SOURCE, B owns TARGET and owns (built) I_MAIN. C owns an unrelated product.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);

const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const P_FOREIGN = uuid(12);
const P_CONNECTOR = uuid(13);

const I_MAIN = uuid(20); // SOURCE (A) → TARGET (B), owned by B, unclaimed
const I_POWERED = uuid(21); // SOURCE (A) → TARGET (B), powered by CONNECTOR
const I_IPAAS = uuid(22); // SOURCE (A) → TARGET (B), mechanism iPaaS, no powered_by

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  // No entitlement at all: a seat is the whole gate (decision 15).
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_A = seat(1, VENDOR_A);
const AUTH_B = seat(2, VENDOR_B);
const AUTH_C = seat(3, VENDOR_C);

const OLD = '2026-01-01T00:00:00.000Z';
let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation' },
    { id: P_FOREIGN, slug: 'archicad', name: 'ArchiCAD' },
    { id: P_CONNECTOR, slug: 'agave', name: 'Agave', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_FOREIGN, vendorId: VENDOR_C, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_MAIN,
      name: 'Revit for MicroStation',
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      mechanismKind: 'native',
      builtByVendorId: VENDOR_B,
      listingUrl: 'https://aeci.example/curated',
      updatedAt: OLD,
    },
    {
      id: I_POWERED,
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      mechanismKind: 'integrator',
      poweredByProductId: P_CONNECTOR,
    },
    { id: I_IPAAS, sourceProductId: P_SOURCE, targetProductId: P_TARGET, mechanismKind: 'iPaaS' },
  ]);
  await t.db.insert(profiles).values(
    [AUTH_A, AUTH_B, AUTH_C].map((auth) => ({
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
  const path = '/api/vendor/integrations/:id/links/:productId/:kind';
  a.put(path, createPutIntegrationLinkHandler(t.factory));
  a.delete(path, createDeleteIntegrationLinkHandler(t.factory));
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  method: 'PUT' | 'DELETE' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const linkPath = (id: string, productId: string, kind: string) =>
  `/api/vendor/integrations/${id}/links/${productId}/${kind}`;
const put = (
  auth: AuthzVariables['auth'],
  id: string,
  productId: string,
  kind: string,
  url: unknown,
) => call(auth, 'PUT', linkPath(id, productId, kind), { url });
const del = (auth: AuthzVariables['auth'], id: string, productId: string, kind: string) =>
  call(auth, 'DELETE', linkPath(id, productId, kind));

const storedLinks = () => t.db.select().from(integrationVendorLinks);
const auditRows = () => t.db.select().from(auditLog);
const row = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;

describe('PUT …/links — an endpoint vendor sets its own link', () => {
  it('stores the link on the caller’s own side, with no integration ownership needed', async () => {
    // A owns SOURCE but not the integration (B does), and has no entitlement.
    const res = await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/listing');
    expect(res.status).toBe(200);
    expect(() => IntegrationLinkResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body).toEqual({
      integration_id: I_MAIN,
      product_id: P_SOURCE,
      links: { listing_url: 'https://autodesk.example/listing', docs_url: null },
    });
    expect(await storedLinks()).toEqual([
      expect.objectContaining({
        integrationId: I_MAIN,
        productId: P_SOURCE,
        kind: 'listing',
        url: 'https://autodesk.example/listing',
        vendorId: VENDOR_A,
      }),
    ]);
  });

  it('transfers maintenance and moves updated_at, which is what the freshness cursor reads', async () => {
    await put(AUTH_A, I_MAIN, P_SOURCE, 'docs', 'https://autodesk.example/docs');
    const after = await row(I_MAIN);
    expect(after.maintainedBy).toBe('vendor');
    expect(after.lastReviewedAt).not.toBeNull();
    expect(after.updatedAt > OLD).toBe(true);
    // Content and the AECi-curated link are untouched.
    expect(after.listingUrl).toBe('https://aeci.example/curated');
    expect(after.claimedAt).toBeNull();
  });

  it('writes one audit row in the same batch, marking the first transfer only', async () => {
    await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/one');
    await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/two');
    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.action === INTEGRATION_LINK_SET_ACTION)).toBe(true);
    const [first, second] = audits;
    expect(first).toMatchObject({
      actorId: AUTH_A.userId,
      entityType: 'integration',
      entityId: I_MAIN,
    });
    expect(first!.beforeState).toEqual({ product_id: P_SOURCE, kind: 'listing', url: null });
    expect(first!.metadata).toMatchObject({ maintenanceTransfer: true, vendorId: VENDOR_A });
    expect(second!.beforeState).toMatchObject({ url: 'https://autodesk.example/one' });
    expect(second!.afterState).toMatchObject({ url: 'https://autodesk.example/two' });
    expect(second!.metadata).not.toHaveProperty('maintenanceTransfer');
    // Upsert, not a second row.
    expect(await storedLinks()).toHaveLength(1);
  });

  it('keeps the two sides apart on one row', async () => {
    await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/listing');
    await put(AUTH_B, I_MAIN, P_TARGET, 'listing', 'https://bentley.example/listing');
    const byProduct = Object.fromEntries((await storedLinks()).map((l) => [l.productId, l.url]));
    expect(byProduct).toEqual({
      [P_SOURCE]: 'https://autodesk.example/listing',
      [P_TARGET]: 'https://bentley.example/listing',
    });
  });

  it('purges the pair page and both product pages', async () => {
    const res = await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/l');
    expect(res.send).toHaveBeenCalledWith({
      tags: ['pair:microstation__revit', 'product:revit', 'product:microstation'],
      source: 'vendor',
    });
  });
});

describe('PUT …/links — refusals', () => {
  it.each([
    ['the other endpoint’s side', AUTH_A, I_MAIN, P_TARGET],
    ['a product that is not an endpoint', AUTH_C, I_MAIN, P_FOREIGN],
    ['a caller with no endpoint at all', AUTH_C, I_MAIN, P_SOURCE],
    ['an unknown integration', AUTH_A, uuid(99), P_SOURCE],
  ])('answers 404 for %s, and writes nothing', async (_label, auth, id, productId) => {
    const res = await put(auth, id, productId, 'listing', 'https://x.example/l');
    expect(res.status).toBe(404);
    expect(await storedLinks()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it.each([I_POWERED, I_IPAAS])(
    'refuses a connector-powered row with 403 (decision 9)',
    async (id) => {
      const res = await put(AUTH_A, id, P_SOURCE, 'listing', 'https://x.example/l');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INTEGRATION_CONNECTOR_POWERED');
      expect(await storedLinks()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    },
  );

  it('answers 404 before 403: a stranger learns nothing about a powered row', async () => {
    const res = await put(AUTH_C, I_POWERED, P_SOURCE, 'listing', 'https://x.example/l');
    expect(res.status).toBe(404);
  });

  it.each([
    ['http', 'http://autodesk.example/l'],
    ['javascript', 'javascript:alert(1)'],
    ['credentials', 'https://user:pass@autodesk.example/l'],
    ['relative', '/listing'],
    ['too long', `https://autodesk.example/${'a'.repeat(2100)}`],
    ['not a string', 42],
  ])('rejects a %s URL with 400', async (_label, url) => {
    const res = await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', url);
    expect(res.status).toBe(400);
    expect(await storedLinks()).toEqual([]);
  });

  it('rejects an unknown kind with 400', async () => {
    const res = await put(AUTH_A, I_MAIN, P_SOURCE, 'pricing', 'https://autodesk.example/p');
    expect(res.status).toBe(400);
  });
});

describe('DELETE …/links', () => {
  it('removes the caller’s link and leaves the other kind and side alone', async () => {
    await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/l');
    await put(AUTH_A, I_MAIN, P_SOURCE, 'docs', 'https://autodesk.example/d');
    await put(AUTH_B, I_MAIN, P_TARGET, 'listing', 'https://bentley.example/l');

    const res = await del(AUTH_A, I_MAIN, P_SOURCE, 'listing');
    expect(res.status).toBe(200);
    expect(res.body.links).toEqual({ listing_url: null, docs_url: 'https://autodesk.example/d' });
    expect((await storedLinks()).map((l) => `${l.productId}:${l.kind}`).sort()).toEqual(
      [`${P_SOURCE}:docs`, `${P_TARGET}:listing`].sort(),
    );
    const removed = (await auditRows()).filter((a) => a.action === INTEGRATION_LINK_REMOVED_ACTION);
    expect(removed).toHaveLength(1);
    expect(removed[0]!.beforeState).toMatchObject({ url: 'https://autodesk.example/l' });
    expect(removed[0]!.afterState).toMatchObject({ url: null });
  });

  it('writes nothing, not even an audit row, when there is nothing to remove', async () => {
    const res = await del(AUTH_A, I_MAIN, P_SOURCE, 'docs');
    expect(res.status).toBe(200);
    expect(res.send).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([]);
    expect((await row(I_MAIN)).maintainedBy).toBe('aeci');
  });

  it('writes nothing when a concurrent request removed the link first (one-row sentinel)', async () => {
    await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/l');
    const auditsBefore = (await auditRows()).length;
    const maintainedBefore = (await row(I_MAIN)).lastReviewedAt;
    // A factory whose batch first lets a "concurrent" request delete the row.
    const racing: typeof t.factory = (env, opts) => {
      const ctx = t.factory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db);
      (ctx.db as { batch: unknown }).batch = async (stmts: Parameters<typeof batch>[0]) => {
        t.raw.prepare(`DELETE FROM integration_vendor_links`).run();
        return batch(stmts);
      };
      return ctx;
    };
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', AUTH_A);
      await next();
    });
    a.delete('/x/:id/:productId/:kind', createDeleteIntegrationLinkHandler(racing));
    const res = await a.request(
      `/x/${I_MAIN}/${P_SOURCE}/listing`,
      { method: 'DELETE' },
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as JsonBody).links).toEqual({ listing_url: null, docs_url: null });
    expect(await auditRows()).toHaveLength(auditsBefore);
    expect((await row(I_MAIN)).lastReviewedAt).toBe(maintainedBefore);
  });

  it('refuses the other side with 404', async () => {
    await put(AUTH_B, I_MAIN, P_TARGET, 'listing', 'https://bentley.example/l');
    const res = await del(AUTH_A, I_MAIN, P_TARGET, 'listing');
    expect(res.status).toBe(404);
    expect(await storedLinks()).toHaveLength(1);
  });
});

describe('DELETE …/links — a link stranded on a row promote made connector-powered', () => {
  // Promote retypes an unclaimed row in place. The link set before stays stored.
  async function strand(retype: Partial<typeof integrations.$inferInsert>) {
    await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/l');
    await t.db
      .update(integrations)
      .set({ ...retype, maintainedBy: 'aeci', lastReviewedAt: null, updatedAt: OLD })
      .where(eq(integrations.id, I_MAIN));
  }

  it.each([
    ['a connector mechanism kind', { mechanismKind: 'iPaaS' }],
    ['a Convention-A self-reference', { poweredByProductId: P_TARGET }],
  ])('lets the vendor remove its own link on %s', async (_label, retype) => {
    await strand(retype);
    const res = await del(AUTH_A, I_MAIN, P_SOURCE, 'listing');
    expect(res.status).toBe(200);
    expect(res.body.links).toEqual({ listing_url: null, docs_url: null });
    expect(await storedLinks()).toEqual([]);
    const removed = (await auditRows()).filter((a) => a.action === INTEGRATION_LINK_REMOVED_ACTION);
    expect(removed).toHaveLength(1);
    expect(removed[0]!.metadata).toMatchObject({ connectorPowered: true });
    expect(removed[0]!.metadata).not.toHaveProperty('maintenanceTransfer');
  });

  it('writes no maintenance transfer, but moves updated_at for the cursor', async () => {
    await strand({ mechanismKind: 'iPaaS' });
    await del(AUTH_A, I_MAIN, P_SOURCE, 'listing');
    const after = await row(I_MAIN);
    expect(after.maintainedBy).toBe('aeci');
    expect(after.lastReviewedAt).toBeNull();
    expect(after.updatedAt > OLD).toBe(true);
  });

  it('still refuses a PUT there with 403', async () => {
    await strand({ mechanismKind: 'iPaaS' });
    const res = await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/new');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_CONNECTOR_POWERED');
    expect((await storedLinks()).map((l) => l.url)).toEqual(['https://autodesk.example/l']);
  });

  it('still answers the other side 404', async () => {
    await strand({ mechanismKind: 'iPaaS' });
    const res = await del(AUTH_B, I_MAIN, P_SOURCE, 'listing');
    expect(res.status).toBe(404);
  });

  it('lists the stranded link in own_links so the portal can offer Remove', async () => {
    await strand({ mechanismKind: 'iPaaS' });
    const res = await call(AUTH_A, 'GET', '/api/vendor/integrations');
    const entry = (res.body.integrations as JsonBody[]).find((e) => e.id === I_MAIN);
    expect(entry?.attestable).toBe(false);
    expect(entry?.own_links).toEqual({ listing_url: 'https://autodesk.example/l', docs_url: null });
  });
});

describe('GET /api/vendor/integrations — own_links', () => {
  it('returns each entry’s own side only', async () => {
    await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/l');
    await put(AUTH_B, I_MAIN, P_TARGET, 'docs', 'https://bentley.example/d');

    const res = await call(AUTH_A, 'GET', '/api/vendor/integrations');
    expect(res.status).toBe(200);
    const parsed = ListVendorIntegrationsResponseSchema.parse(res.body);
    const main = parsed.integrations.find((i) => i.id === I_MAIN)!;
    expect(main.context_product.id).toBe(P_SOURCE);
    expect(main.own_links).toEqual({ listing_url: 'https://autodesk.example/l', docs_url: null });
    // Unset on a row the caller never linked.
    const powered = parsed.integrations.find((i) => i.id === I_POWERED)!;
    expect(powered.own_links).toEqual({ listing_url: null, docs_url: null });
    expect(powered.attestable).toBe(false);
  });
});

describe('a retired row takes no link write (AECI-1010)', () => {
  const RETIRED_AT = '2026-09-20T00:00:00.000Z';
  const retireMain = () =>
    t.db
      .update(integrations)
      .set({ builtByVendorId: VENDOR_B, claimedAt: OLD, retiredAt: RETIRED_AT })
      .where(eq(integrations.id, I_MAIN));

  it('refuses PUT with 409 INTEGRATION_RETIRED and writes nothing', async () => {
    await retireMain();
    const res = await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/l');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
    expect(await storedLinks()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it('refuses DELETE with 409 and keeps the link', async () => {
    await put(AUTH_A, I_MAIN, P_SOURCE, 'listing', 'https://autodesk.example/l');
    await retireMain();
    const res = await del(AUTH_A, I_MAIN, P_SOURCE, 'listing');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
    expect(await storedLinks()).toHaveLength(1);
  });

  it('still answers a stranger 404, not 409', async () => {
    await retireMain();
    const res = await put(AUTH_C, I_MAIN, P_SOURCE, 'listing', 'https://x.example/l');
    expect(res.status).toBe(404);
  });

  it('refuses a PUT whose batch meets a retire that landed after the read', async () => {
    const racing: typeof t.factory = (env, opts) => {
      const ctx = t.factory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db);
      (ctx.db as { batch: unknown }).batch = async (stmts: Parameters<typeof batch>[0]) => {
        t.raw
          .prepare(
            `UPDATE integrations SET built_by_vendor_id = ?, claimed_at = ?, retired_at = ? WHERE id = ?`,
          )
          .run(VENDOR_B, OLD, RETIRED_AT, I_MAIN);
        return batch(stmts);
      };
      return ctx;
    };
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', AUTH_A);
      await next();
    });
    a.put('/x/:id/:productId/:kind', createPutIntegrationLinkHandler(racing));
    const res = await a.request(
      `/x/${I_MAIN}/${P_SOURCE}/listing`,
      {
        method: 'PUT',
        body: JSON.stringify({ url: 'https://autodesk.example/l' }),
        headers: { 'content-type': 'application/json' },
      },
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as JsonBody).error.code).toBe('INTEGRATION_RETIRED');
    expect(await storedLinks()).toEqual([]);
    expect(await auditRows()).toEqual([]);
    expect((await row(I_MAIN)).maintainedBy).toBe('aeci');
  });
});
