/**
 * `POST /api/vendor/integrations` (AECI-1011 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7).
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the insert, the audit-in-batch rule and the in-batch count recompute all run
 * for real. The promote half of the duplicate policy is `promote-vendor-twin.spec.ts`.
 */

import {
  CreateVendorIntegrationResponseSchema,
  ListVendorNotificationsResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, integrations, productVendors, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { isClaimed, isVendorHeld } from '../lib/integration-claims';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createProductPairHandler } from './integrations';
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import { createUpdateVendorIntegrationHandler } from './vendor-integration-edits';
import { createCreateVendorIntegrationHandler } from './vendor-integration-create';
import { createRetireIntegrationHandler } from './vendor-integration-retire';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns SOURCE (Revit). B owns TARGET (MicroStation). C owns nothing on the pair.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);

const P_OWN = uuid(10);
const P_OTHER = uuid(11);
const P_PENDING = uuid(12); // exists, not promoted
const P_FOREIGN = uuid(13); // C's product

const I_CURATED_REVERSED = uuid(20); // B → A orientation, no owner on file
const I_OTHER_OWNER = uuid(21); // same pair, owned by C: NOT a strong match
const I_POWERED = uuid(22); // same pair, connector-powered: NOT a strong match

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_A = seat(1, VENDOR_A);
const AUTH_B = seat(2, VENDOR_B);
const AUTH_C = seat(3, VENDOR_C);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_OWN, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: P_OTHER, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
    { id: P_PENDING, slug: 'draft-tool', name: 'Draft Tool' },
    { id: P_FOREIGN, slug: 'archicad', name: 'ArchiCAD', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_OWN, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_OTHER, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_PENDING, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_FOREIGN, vendorId: VENDOR_C, isPrimary: true },
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
  a.post('/api/vendor/integrations', createCreateVendorIntegrationHandler(t.factory));
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(t.factory));
  a.patch('/api/vendor/integrations/:id', createUpdateVendorIntegrationHandler(t.factory));
  a.post('/api/vendor/integrations/:id/retire', createRetireIntegrationHandler(t.factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  a.get('/api/products/:slug/integrations/:otherSlug', createProductPairHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'POST',
  body?: unknown,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body !== undefined
      ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : { method };
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const valid = (overrides: Record<string, unknown> = {}) => ({
  product_id: P_OWN,
  counterpart_product_id: P_OTHER,
  name: 'Revit to MicroStation',
  mechanism_kind: 'native',
  direction: 'outbound',
  listing_url: 'https://autodesk.example/revit-microstation',
  ...overrides,
});
const create = (auth: AuthzVariables['auth'], body: unknown) =>
  call(auth, '/api/vendor/integrations', 'POST', body);

const row = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const countOf = async (id: string) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.integrationCount;

describe('POST /api/vendor/integrations — the happy path', () => {
  it('inserts a claimed, vendor-origin row the caller owns, and answers 201', async () => {
    const res = await create(AUTH_A, valid());
    expect(res.status).toBe(201);
    const body = CreateVendorIntegrationResponseSchema.parse(res.body);
    expect(body.possible_duplicates).toEqual([]);

    const created = await row(body.integration.id);
    expect(created).toMatchObject({
      name: 'Revit to MicroStation',
      sourceProductId: P_OWN,
      targetProductId: P_OTHER,
      mechanismKind: 'native',
      direction: 'a_to_b',
      listingUrl: 'https://autodesk.example/revit-microstation',
      builtByVendorId: VENDOR_A,
      poweredByProductId: null,
      origin: 'vendor',
      maintainedBy: 'vendor',
      retiredAt: null,
    });
    expect(created.claimedAt).toBe(body.integration.claimed_at);
    expect(created.lastReviewedAt).toBe(body.integration.claimed_at);
    // The three predicates every other lane keys on.
    expect(isClaimed(created)).toBe(true);
    expect(isVendorHeld(created)).toBe(true);
    expect(isConnectorPoweredEdge(created)).toBe(false);
  });

  it('frames `direction` against the caller’s own product, which becomes the source', async () => {
    const res = await create(AUTH_A, valid({ direction: 'inbound' }));
    expect((await row(res.body.integration.id)).direction).toBe('b_to_a');
    const both = await create(AUTH_A, valid({ direction: 'both' }));
    expect((await row(both.body.integration.id)).direction).toBe('both');
  });

  it('writes the audit row and one notification per other endpoint vendor in the same batch', async () => {
    const res = await create(AUTH_A, valid());
    const id = res.body.integration.id as string;
    const created = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.created'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      entityType: 'integration',
      entityId: id,
      actorId: AUTH_A.userId,
    });
    expect(created[0]!.metadata).toMatchObject({
      source: 'vendor-portal',
      vendorId: VENDOR_A,
      possibleDuplicateIds: [],
    });

    const notices = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata).toMatchObject({
      kind: 'integration_create',
      vendorId: VENDOR_B,
      integrationId: id,
      ownerVendorId: VENDOR_A,
    });

    const feed = await call(AUTH_B, '/api/vendor/notifications', 'GET');
    const parsed = ListVendorNotificationsResponseSchema.parse(feed.body);
    const item = parsed.notifications.find((n) => n.kind === 'integration_create');
    expect(item).toMatchObject({
      kind: 'integration_create',
      integration_id: id,
      owner_name: 'Autodesk',
      pair_path: '/products/microstation/integrations/revit',
    });
  });

  it('recomputes both endpoints’ counts inside the batch', async () => {
    await t.db.update(products).set({ integrationCount: 7 });
    await create(AUTH_A, valid());
    expect(await countOf(P_OWN)).toBe(1);
    expect(await countOf(P_OTHER)).toBe(1);
  });

  it('purges the pair, both products, the vendor, the index, taxonomy and the sitemap', async () => {
    const res = await create(AUTH_A, valid());
    const tags = res.send.mock.calls.flatMap((c) => (c[0] as { tags: string[] }).tags);
    expect(tags.sort()).toEqual(
      [
        'index:products',
        'pair:microstation__revit',
        'product:microstation',
        'product:revit',
        'sitemap',
        'taxonomy',
        'vendor:autodesk',
      ].sort(),
    );
  });

  it('shows on the public pair page, marked as vendor-created', async () => {
    const res = await create(AUTH_A, valid());
    const pair = await call(AUTH_B, '/api/products/microstation/integrations/revit', 'GET');
    expect(pair.status).toBe(200);
    const mechanism = (pair.body.mechanisms as JsonBody[]).find(
      (m) => m.id === res.body.integration.id,
    );
    expect(mechanism).toMatchObject({
      origin: 'vendor',
      built_by_vendor: { slug: 'autodesk' },
      direction: 'inbound',
    });
  });

  it('lists the new row for both endpoint vendors, and the owner can edit and retire it', async () => {
    const res = await create(AUTH_A, valid());
    const id = res.body.integration.id as string;
    for (const auth of [AUTH_A, AUTH_B]) {
      const list = await call(auth, '/api/vendor/integrations', 'GET');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(id);
    }
    const edit = await call(AUTH_A, `/api/vendor/integrations/${id}`, 'PATCH', {
      name: 'Renamed by the owner',
    });
    expect(edit.status).toBe(200);
    const retired = await call(AUTH_A, `/api/vendor/integrations/${id}/retire`, 'POST');
    expect(retired.status).toBe(200);
  });
});

describe('POST /api/vendor/integrations — refusals', () => {
  it('404s a product the caller does not hold, an unpromoted product, and an unknown one', async () => {
    const notMine = await create(AUTH_C, valid());
    expect(notMine.status).toBe(404);
    const unpromotedOwn = await create(AUTH_A, valid({ product_id: P_PENDING }));
    expect(unpromotedOwn.status).toBe(404);
    const unpromotedOther = await create(
      AUTH_B,
      valid({ product_id: P_OTHER, counterpart_product_id: P_PENDING }),
    );
    expect(unpromotedOther.status).toBe(404);
    const unknown = await create(AUTH_A, valid({ counterpart_product_id: uuid(999) }));
    expect(unknown.status).toBe(404);
    expect(await t.db.select().from(integrations)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('400s equal endpoints, a missing required field and any key it does not know', async () => {
    expect((await create(AUTH_A, valid({ counterpart_product_id: P_OWN }))).status).toBe(400);
    expect((await create(AUTH_A, valid({ name: '  ' }))).status).toBe(400);
    expect((await create(AUTH_A, valid({ direction: undefined }))).status).toBe(400);
    expect((await create(AUTH_A, valid({ powered_by_product_id: P_FOREIGN }))).status).toBe(400);
    expect((await create(AUTH_A, valid({ origin: 'aeci' }))).status).toBe(400);
    expect((await create(AUTH_A, valid({ built_by_vendor_id: VENDOR_C }))).status).toBe(400);
    expect(await t.db.select().from(integrations)).toHaveLength(0);
  });

  it('422s a connector-delivered kind (decision 9) and a bad value', async () => {
    for (const kind of ['iPaaS', 'integrator']) {
      const res = await create(AUTH_A, valid({ mechanism_kind: kind }));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INTEGRATION_INVALID_VALUE');
    }
    expect((await create(AUTH_A, valid({ docs_url: 'ftp://nope' }))).status).toBe(422);
    expect((await create(AUTH_A, valid({ mechanism_kind: 'carrier-pigeon' }))).status).toBe(422);
    expect(await t.db.select().from(integrations)).toHaveLength(0);
  });
});

describe('POST /api/vendor/integrations — possible duplicates warn, never refuse', () => {
  beforeEach(async () => {
    await t.db.insert(integrations).values([
      {
        id: I_CURATED_REVERSED,
        name: 'MicroStation for Revit',
        sourceProductId: P_OTHER,
        targetProductId: P_OWN,
        mechanismKind: 'api',
      },
      {
        id: I_OTHER_OWNER,
        sourceProductId: P_OWN,
        targetProductId: P_OTHER,
        mechanismKind: 'native',
        builtByVendorId: VENDOR_C,
      },
      {
        id: I_POWERED,
        sourceProductId: P_OWN,
        targetProductId: P_OTHER,
        mechanismKind: 'iPaaS',
        poweredByProductId: P_FOREIGN,
      },
    ]);
  });

  it('returns the strong matches in either orientation, and still inserts', async () => {
    const res = await create(AUTH_A, valid());
    expect(res.status).toBe(201);
    const body = CreateVendorIntegrationResponseSchema.parse(res.body);
    expect(body.possible_duplicates).toEqual([
      {
        id: I_CURATED_REVERSED,
        name: 'MicroStation for Revit',
        mechanism_kind: 'api',
        mechanism_name: null,
        orientation: 'reversed',
        owner: null,
        claimed: false,
        retired: false,
      },
    ]);
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.created'));
    expect(audit[0]!.metadata).toMatchObject({ possibleDuplicateIds: [I_CURATED_REVERSED] });
    expect(await t.db.select().from(integrations)).toHaveLength(4);
  });

  it('includes the caller’s own earlier row, retired or not, marked', async () => {
    const first = await create(AUTH_A, valid());
    const firstId = first.body.integration.id as string;
    await call(AUTH_A, `/api/vendor/integrations/${firstId}/retire`, 'POST');
    const second = await create(AUTH_A, valid({ name: 'Again' }));
    expect(second.status).toBe(201);
    const dup = (second.body.possible_duplicates as JsonBody[]).find((d) => d.id === firstId);
    expect(dup).toMatchObject({
      orientation: 'same',
      owner: { id: VENDOR_A, name: 'Autodesk' },
      claimed: true,
      retired: true,
    });
  });
});
