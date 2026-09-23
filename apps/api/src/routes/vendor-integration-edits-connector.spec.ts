/**
 * `PATCH /api/vendor/integrations/:id` on connector-powered rows (AECI-1090, the
 * AECI-1040 owner carve-out, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6).
 *
 * Two arms:
 *   - a connector-powered `integrations` row: the AECI-1006 edit, behind the
 *     entitlement gate, with `mechanism_kind` frozen (ruling 5);
 *   - a `connector_evidenced_pairs` row: the same edit on the second anchor table,
 *     ten fields, the same audit row, notifications, purge and search sync.
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the guarded UPDATE, the race sentinel and the audit-in-batch rule run for real.
 */

import {
  ListVendorNotificationsResponseSchema,
  UpdateVendorIntegrationResponseSchema,
} from '@aeci/shared';
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
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createUpdateVendorIntegrationHandler,
  INTEGRATION_UPDATED_ACTION,
} from './vendor-integration-edits';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A holds P_A, B holds P_B, C holds only an unrelated product (a third-party
// owner), D holds the connector product, E holds nothing on any row.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);
const VENDOR_D = uuid(4);
const VENDOR_E = uuid(5);

// Canonical order for the evidenced table: P_A < P_B.
const P_A = uuid(10);
const P_B = uuid(11);
const P_FOREIGN = uuid(12);
const P_CONNECTOR = uuid(13);

// `integrations` rows, all owned by B.
const I_CONVENTION_A = uuid(20); // A → B, powered_by = B (a self-reference), claimed
const I_IPAAS = uuid(21); // A → B, mechanism_kind iPaaS, no powered_by, claimed
const I_IPAAS_UNCLAIMED = uuid(22); // as above, not claimed

// `connector_evidenced_pairs` rows: A ↔ B through the connector.
const E_OWNED = uuid(30); // owned by C (third party), claimed
const E_UNCLAIMED = uuid(31); // owned by C, not claimed
const E_NO_OWNER = uuid(32); // nobody on file
const E_ENDPOINT_OWNED = uuid(33); // owned by B (an endpoint vendor), claimed

const CLAIMED_AT = '2026-09-01T00:00:00.000Z';

type Auth = AuthzVariables['auth'];

const ACTIVE = { entitlementTier: 'verified', entitlement: { status: 'active', periodEnd: null } };
const NONE = { entitlementTier: 'unclaimed', entitlement: null };

const seat = (n: number, vendorId: string, ent: typeof ACTIVE | typeof NONE = ACTIVE): Auth =>
  ({
    userId: uuid(100 + n),
    email: `seat${n}@example.test`,
    role: 'vendor_admin',
    vendorId,
    ...ent,
  }) as Auth;

const AUTH_A = seat(1, VENDOR_A);
const AUTH_B = seat(2, VENDOR_B);
const AUTH_C = seat(3, VENDOR_C);
const AUTH_D = seat(4, VENDOR_D);
const AUTH_E = seat(5, VENDOR_E);
const AUTH_B_UNENTITLED = seat(6, VENDOR_B, NONE);
const AUTH_C_UNENTITLED = seat(7, VENDOR_C, NONE);
const AUTH_C_LAPSED = {
  ...seat(8, VENDOR_C, NONE),
  entitlement: { status: 'expired', periodEnd: '2026-01-01T00:00:00.000Z' },
} as Auth;

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'cherry', companyName: 'Cherry Bekaert' },
    { id: VENDOR_D, slug: 'agave', companyName: 'Agave' },
    { id: VENDOR_E, slug: 'elsewhere', companyName: 'Elsewhere' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'revit', name: 'Revit' },
    { id: P_B, slug: 'microstation', name: 'MicroStation' },
    { id: P_FOREIGN, slug: 'ramp', name: 'Ramp' },
    { id: P_CONNECTOR, slug: 'agave-sync', name: 'Agave Sync', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_B, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_FOREIGN, vendorId: VENDOR_C, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: VENDOR_D, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_CONVENTION_A,
      name: 'Revit via MicroStation Connect',
      sourceProductId: P_A,
      targetProductId: P_B,
      mechanismKind: 'marketplace-app',
      poweredByProductId: P_B,
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
      maintainedBy: 'vendor',
      updatedAt: CLAIMED_AT,
    },
    {
      id: I_IPAAS,
      name: 'Revit on Zapier',
      sourceProductId: P_A,
      targetProductId: P_B,
      mechanismKind: 'iPaaS',
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
    },
    {
      id: I_IPAAS_UNCLAIMED,
      name: 'Unclaimed iPaaS',
      sourceProductId: P_A,
      targetProductId: P_B,
      mechanismKind: 'iPaaS',
      builtByVendorId: VENDOR_B,
    },
  ]);
  const pair = {
    connectorProductId: P_CONNECTOR,
    productAId: P_A,
    productBId: P_B,
  };
  // The unique (connector, A, B) index allows one pair per triple, so the other
  // rows go through different connectors in the real data. Here each row gets its
  // own connector product, so the index holds.
  await t.db.insert(products).values([
    { id: uuid(14), slug: 'kroo', name: 'Kroo', productRole: 'connector' },
    { id: uuid(15), slug: 'workato', name: 'Workato', productRole: 'connector' },
    { id: uuid(16), slug: 'boomi', name: 'Boomi', productRole: 'connector' },
  ]);
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: E_OWNED,
      ...pair,
      name: 'Revit and MicroStation via Agave',
      direction: 'a_to_b',
      website: 'https://cherry.example/agave',
      notes: 'AECi curation note',
      builtByVendorId: VENDOR_C,
      claimedAt: CLAIMED_AT,
      updatedAt: CLAIMED_AT,
    },
    {
      id: E_UNCLAIMED,
      ...pair,
      connectorProductId: uuid(14),
      name: 'Unclaimed pair',
      builtByVendorId: VENDOR_C,
    },
    { id: E_NO_OWNER, ...pair, connectorProductId: uuid(15), name: 'Nobody' },
    {
      id: E_ENDPOINT_OWNED,
      ...pair,
      connectorProductId: uuid(16),
      name: 'Owned by an endpoint',
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
    },
  ]);
  await t.db
    .insert(profiles)
    .values(
      [
        AUTH_A,
        AUTH_B,
        AUTH_C,
        AUTH_D,
        AUTH_E,
        AUTH_B_UNENTITLED,
        AUTH_C_UNENTITLED,
        AUTH_C_LAPSED,
      ].map((auth) => ({ id: auth.userId, role: 'vendor_admin', vendorId: auth.vendorId })),
    );
});
afterEach(() => t.dispose());

function app(auth: Auth, handler = createUpdateVendorIntegrationHandler(t.factory)) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.patch('/api/vendor/integrations/:id', handler);
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
  path: string,
  init: { method: 'GET' | 'PATCH'; body?: unknown },
  handler?: ReturnType<typeof createUpdateVendorIntegrationHandler>,
  envOverrides: Partial<Env> = {},
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    ...envOverrides,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app(auth, handler).request(
    path,
    {
      method: init.method,
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), headers: { 'Content-Type': 'application/json' } }),
    },
    env,
    execCtx,
  );
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const edit = (auth: Auth, id: string, body: unknown) =>
  call(auth, `/api/vendor/integrations/${id}`, { method: 'PATCH', body });

const intg = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const evPair = async (id: string) =>
  (await t.db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  }))!;
const auditRows = () => t.db.select().from(auditLog);
const updateAudits = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, INTEGRATION_UPDATED_ACTION));
const notificationRows = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));

describe('fixtures', () => {
  it('the integrations rows really are connector-powered, one per disjunct', async () => {
    expect(isConnectorPoweredEdge(await intg(I_CONVENTION_A))).toBe(true);
    expect(isConnectorPoweredEdge(await intg(I_IPAAS))).toBe(true);
  });
});

describe('a connector-powered integrations row (AECI-1090)', () => {
  it('lets the entitled, claimed owner edit it, with the AECI-1006 batch', async () => {
    const res = await edit(AUTH_B, I_CONVENTION_A, {
      name: 'Revit Connect',
      description: 'Sends models.',
    });
    expect(res.status).toBe(200);
    expect(() => UpdateVendorIntegrationResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.integration.changed).toEqual(['name', 'description']);
    const after = await intg(I_CONVENTION_A);
    expect(after.name).toBe('Revit Connect');
    expect(after.description).toBe('Sends models.');
    // Still connector-powered: nothing routing-relevant moved.
    expect(after.mechanismKind).toBe('marketplace-app');
    expect(after.poweredByProductId).toBe(P_B);
    const [audit] = await updateAudits();
    expect(audit).toMatchObject({ entityType: 'integration', entityId: I_CONVENTION_A });
    expect(audit!.metadata).toMatchObject({
      reason: 'owner-edit',
      fields: ['name', 'description'],
    });
    const notes = await notificationRows();
    expect(notes.map((n) => (n.metadata as { vendorId: string }).vendorId)).toEqual([VENDOR_A]);
    expect(res.send).toHaveBeenCalledWith({
      tags: ['pair:microstation__revit', 'product:revit', 'product:microstation'],
      source: 'vendor',
    });
  });

  it('refuses a change to the frozen mechanism_kind with 422, and writes nothing', async () => {
    const res = await edit(AUTH_B, I_IPAAS, { name: 'Renamed', mechanism_kind: 'api' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INTEGRATION_INVALID_VALUE');
    expect(res.body.error.field ?? res.body.error.details?.field).toBe('mechanism_kind');
    expect((await intg(I_IPAAS)).name).toBe('Revit on Zapier');
    expect((await intg(I_IPAAS)).mechanismKind).toBe('iPaaS');
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses clearing the frozen mechanism_kind too', async () => {
    const res = await edit(AUTH_B, I_IPAAS, { mechanism_kind: null });
    expect(res.status).toBe(422);
    expect((await intg(I_IPAAS)).mechanismKind).toBe('iPaaS');
  });

  it('refuses a new kind on a Convention-A row, whose kind is not a connector kind', async () => {
    const res = await edit(AUTH_B, I_CONVENTION_A, { mechanism_kind: 'api' });
    expect(res.status).toBe(422);
    expect((await intg(I_CONVENTION_A)).mechanismKind).toBe('marketplace-app');
  });

  it('drops a mechanism_kind equal to the stored one, and saves the rest', async () => {
    const res = await edit(AUTH_B, I_IPAAS, { name: 'Renamed', mechanism_kind: 'iPaaS' });
    expect(res.status).toBe(200);
    expect(res.body.integration.changed).toEqual(['name']);
    expect((await intg(I_IPAAS)).name).toBe('Renamed');
  });

  it('answers 403 INTEGRATION_ENTITLEMENT_REQUIRED to an unentitled owner, before the claim check', async () => {
    const res = await edit(AUTH_B_UNENTITLED, I_IPAAS_UNCLAIMED, { name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_ENTITLEMENT_REQUIRED');
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers 409 INTEGRATION_NOT_CLAIMED to an entitled owner that has not claimed', async () => {
    const res = await edit(AUTH_B, I_IPAAS_UNCLAIMED, { name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CLAIMED');
  });

  it('asks ownership before the entitlement, so a non-owner learns nothing from it', async () => {
    const res = await edit(seat(9, VENDOR_A, NONE), I_IPAAS, { name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_OWNER');
  });
});

describe('a connector_evidenced_pairs row (AECI-1090)', () => {
  it('lets the entitled, claimed third-party owner edit its ten fields', async () => {
    const res = await edit(AUTH_C, E_OWNED, {
      name: 'Revit ↔ MicroStation (Agave)',
      mechanism_name: 'Agave Sync',
      description: 'Syncs models.',
      listing_url: 'https://cherry.example/listing',
      docs_url: 'https://cherry.example/docs',
      website: null,
      mechanism_url: 'https://cherry.example/mechanism',
      pricing_model: 'Subscription',
      maturity: 'GA',
      direction: 'both',
    });
    expect(res.status).toBe(200);
    expect(() => UpdateVendorIntegrationResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.integration).toMatchObject({ id: E_OWNED, maintained_by: 'vendor' });
    expect(res.body.integration.changed).toEqual([
      'name',
      'mechanism_name',
      'direction',
      'description',
      'listing_url',
      'docs_url',
      'website',
      'mechanism_url',
      'pricing_model',
      'maturity',
    ]);
    const after = await evPair(E_OWNED);
    expect(after).toMatchObject({
      name: 'Revit ↔ MicroStation (Agave)',
      mechanismName: 'Agave Sync',
      direction: 'both',
      description: 'Syncs models.',
      website: null,
      pricingModel: 'Subscription',
      maturity: 'GA',
      maintainedBy: 'vendor',
      // Untouched: AECi's note, the routing columns, the ownership columns.
      notes: 'AECi curation note',
      connectorProductId: P_CONNECTOR,
      productAId: P_A,
      productBId: P_B,
      builtByVendorId: VENDOR_C,
      claimedAt: CLAIMED_AT,
    });
    expect(after.updatedAt).not.toBe(CLAIMED_AT);
  });

  it('writes the same integration.updated audit row, naming the table, in the batch', async () => {
    await edit(AUTH_C, E_OWNED, { name: 'Renamed pair' });
    const rows = await updateAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: AUTH_C.userId,
      entityType: 'integration',
      entityId: E_OWNED,
    });
    expect(rows[0]!.beforeState).toMatchObject({ name: 'Revit and MicroStation via Agave' });
    expect(rows[0]!.afterState).toMatchObject({ name: 'Renamed pair', maintained_by: 'vendor' });
    expect(rows[0]!.metadata).toMatchObject({
      source: 'vendor-portal',
      vendorId: VENDOR_C,
      reason: 'owner-edit',
      fields: ['name'],
      table: 'connector_evidenced_pairs',
      maintenanceTransfer: true,
    });
  });

  it('notifies both endpoint vendors, never the owner or the connector vendor, and feeds it', async () => {
    await edit(AUTH_C, E_OWNED, { pricing_model: 'Free' });
    const rows = await notificationRows();
    expect(rows.map((r) => (r.metadata as { vendorId: string }).vendorId)).toEqual([
      VENDOR_A,
      VENDOR_B,
    ]);
    expect(rows[0]!.metadata).toMatchObject({
      kind: 'integration_update',
      integrationId: E_OWNED,
      ownerVendorId: VENDOR_C,
      ownerName: 'Cherry Bekaert',
      pairSlugs: ['microstation', 'revit'],
    });
    const feedA = await call(AUTH_A, '/api/vendor/notifications', { method: 'GET' });
    expect(() => ListVendorNotificationsResponseSchema.parse(feedA.body)).not.toThrow();
    expect(feedA.body.notifications).toEqual([
      expect.objectContaining({
        kind: 'integration_update',
        integration_id: E_OWNED,
        owner_name: 'Cherry Bekaert',
        pair_path: '/products/microstation/integrations/revit',
      }),
    ]);
  });

  it('purges the pair page, both endpoint pages and the connector page', async () => {
    const res = await edit(AUTH_C, E_OWNED, { maturity: 'Beta' });
    expect(res.send).toHaveBeenCalledWith({
      tags: [
        'pair:microstation__revit',
        'product:revit',
        'product:microstation',
        'product:agave-sync',
      ],
      source: 'vendor',
    });
  });

  it('syncs the pair to search by id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const res = await call(
        AUTH_C,
        `/api/vendor/integrations/${E_OWNED}`,
        { method: 'PATCH', body: { description: 'Syncs.' } },
        undefined,
        { ENV: 'staging', ALGOLIA_APP_ID: 'APP', ALGOLIA_ADMIN_KEY: 'KEY' } as Partial<Env>,
      );
      expect(res.status).toBe(200);
      const algolia = fetchSpy.mock.calls
        .map(([url, init]) => ({ url: String(url), init: init as RequestInit | undefined }))
        .filter(({ url }) => url.includes('algolia'));
      expect(algolia.map(({ url }) => url)).toEqual([
        'https://APP.algolia.net/1/indexes/staging_integrations/batch',
      ]);
      const sent = JSON.parse(String(algolia[0]!.init?.body)) as {
        requests: Array<{ body: { objectID: string } }>;
      };
      expect(sent.requests.map((r) => r.body.objectID)).toEqual([E_OWNED]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('frames direction with A in the source seat for an owner that holds neither endpoint', async () => {
    await edit(AUTH_C, E_OWNED, { direction: 'inbound' });
    expect((await evPair(E_OWNED)).direction).toBe('b_to_a');
  });

  it('frames direction against context_product_id when sent', async () => {
    await edit(AUTH_C, E_OWNED, { direction: 'outbound', context_product_id: P_B });
    expect((await evPair(E_OWNED)).direction).toBe('b_to_a');
  });

  it('frames direction against the owner’s own endpoint when it holds B', async () => {
    await edit(AUTH_B, E_ENDPOINT_OWNED, { direction: 'outbound' });
    expect((await evPair(E_ENDPOINT_OWNED)).direction).toBe('b_to_a');
  });

  it('refuses mechanism_kind, which the table does not have, with 422', async () => {
    const res = await edit(AUTH_C, E_OWNED, { name: 'x', mechanism_kind: 'api' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INTEGRATION_INVALID_VALUE');
    expect((await evPair(E_OWNED)).name).toBe('Revit and MicroStation via Agave');
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([
    ['owner', VENDOR_C],
    ['notes', 'x'],
    ['connector_product_id', P_FOREIGN],
  ])('refuses %s with 400 through the strict schema', async (key, value) => {
    const res = await edit(AUTH_C, E_OWNED, { name: 'x', [key]: value });
    expect(res.status).toBe(400);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a value wrong for its field with 422, naming it', async () => {
    const res = await edit(AUTH_C, E_OWNED, { website: 'ftp://nope' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INTEGRATION_INVALID_VALUE');
  });

  it('refuses a context_product_id that is not an endpoint (the connector included)', async () => {
    const res = await edit(AUTH_C, E_OWNED, { direction: 'both', context_product_id: P_CONNECTOR });
    expect(res.status).toBe(400);
  });

  it('writes nothing, not even an audit row, when every value is unchanged', async () => {
    const res = await edit(AUTH_C, E_OWNED, { name: 'Revit and MicroStation via Agave' });
    expect(res.status).toBe(200);
    expect(res.body.integration.changed).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect(res.send).not.toHaveBeenCalled();
  });
});

describe('a connector_evidenced_pairs row — the gate, in order (AECI-1090)', () => {
  it('answers the same 404 to a vendor on neither endpoint, the connector vendor, and an unknown id', async () => {
    for (const [auth, id] of [
      [AUTH_E, E_OWNED],
      [AUTH_D, E_OWNED],
      [AUTH_E, uuid(999)],
    ] as const) {
      const res = await edit(auth, id, { name: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('answers 403 INTEGRATION_NOT_OWNER to an endpoint vendor that is not the owner', async () => {
    const res = await edit(AUTH_A, E_OWNED, { name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_OWNER');
  });

  it('answers 409 INTEGRATION_OWNER_UNKNOWN to an endpoint vendor when nobody is on file', async () => {
    const res = await edit(AUTH_A, E_NO_OWNER, { name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_OWNER_UNKNOWN');
  });

  it('answers 403 INTEGRATION_ENTITLEMENT_REQUIRED to an owner with no entitlement', async () => {
    const res = await edit(AUTH_C_UNENTITLED, E_OWNED, { name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_ENTITLEMENT_REQUIRED');
    expect(res.body.error.details).toEqual({ tier: 'unclaimed', status: null });
    expect(await auditRows()).toHaveLength(0);
  });

  it('says which status a lapsed entitlement has', async () => {
    const res = await edit(AUTH_C_LAPSED, E_OWNED, { name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual({ tier: 'unclaimed', status: 'expired' });
  });

  it('answers 409 INTEGRATION_NOT_CLAIMED to an entitled owner that has not claimed', async () => {
    const res = await edit(AUTH_C, E_UNCLAIMED, { name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CLAIMED');
    expect((await evPair(E_UNCLAIMED)).name).toBe('Unclaimed pair');
  });

  it('answers 409 INTEGRATION_RETIRED on a retired pair', async () => {
    await t.db
      .update(connectorEvidencedPairs)
      .set({ retiredAt: '2026-09-20T00:00:00.000Z', retiredBy: 'owner' })
      .where(eq(connectorEvidencedPairs.id, E_OWNED));
    const res = await edit(AUTH_C, E_OWNED, { name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
  });

  it('checks ownership before the body, so a non-owner cannot probe with a bad one', async () => {
    const res = await edit(AUTH_A, E_OWNED, { notes: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_OWNER');
  });
});

describe('a connector_evidenced_pairs row — the race guard (AECI-1090)', () => {
  function racing(statement: string, ...params: unknown[]) {
    const factory = t.factory;
    let fired = false;
    return createUpdateVendorIntegrationHandler((env, opts) => {
      const ctx = factory(env, opts);
      if (!fired) {
        const batch = ctx.db.batch.bind(ctx.db);
        (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
          fired = true;
          t.raw.prepare(statement).run(...params);
          return batch(stmts);
        }) as typeof batch;
      }
      return ctx;
    });
  }

  it.each([
    [
      'AECi reassigned the owner',
      `UPDATE connector_evidenced_pairs SET built_by_vendor_id = ?, claimed_at = NULL WHERE id = ?`,
      [VENDOR_A, E_OWNED],
      404,
    ],
    [
      'the claim was cleared',
      `UPDATE connector_evidenced_pairs SET claimed_at = NULL WHERE id = ?`,
      [E_OWNED],
      409,
    ],
    [
      'the pair was retired',
      `UPDATE connector_evidenced_pairs SET retired_at = '2026-09-22T00:00:00.000Z', retired_by = 'owner' WHERE id = ?`,
      [E_OWNED],
      409,
    ],
  ])('writes nothing when %s before the batch ran', async (_label, sql, params, status) => {
    const res = await call(
      AUTH_C,
      `/api/vendor/integrations/${E_OWNED}`,
      { method: 'PATCH', body: { name: 'Lost' } },
      racing(sql, ...params),
    );
    expect(res.status).toBe(status);
    expect((await evPair(E_OWNED)).name).toBe('Revit and MicroStation via Agave');
    expect(await auditRows()).toHaveLength(0);
  });
});
