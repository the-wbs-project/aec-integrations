/**
 * `POST /api/vendor/sync-service-pairs` (AECI-2040, rulings 7 and 11 on AECI-2035,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.7).
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the sentinels, the insert, the audit-in-batch rule and the in-batch count
 * recomputes all run for real. Promote meeting a vendor-created pair is the last block.
 */

import {
  CreateSyncServicePairResponseSchema,
  ListVendorNotificationsResponseSchema,
  PromotePayloadSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/algolia-sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/algolia-sync')>();
  return { ...real, syncIndexTargets: vi.fn(async () => []) };
});

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
import { syncIndexTargets, type IndexTargetIds } from '../lib/algolia-sync';
import { resetAlgoliaWriteGuardWarning } from '../lib/algolia-write-guard';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { isClaimed, isVendorHeld } from '../lib/integration-claims';
import { findSyncServicePairBlock, VENDOR_OWNED_TWIN } from '../lib/integration-twins';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { racingFactory } from '../test/racing-factory';
import { createProductPairHandler } from './integrations';
import { runPromoteIngest, type PromoteRunCtx } from './promote';
import { createListVendorNotificationsHandler } from './vendor-notifications';
import { createCreateSyncServicePairHandler } from './vendor-sync-service-pair-create';
import type { DbFactory } from '../lib/handler-utils';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const RIVETS = uuid(1); // sells the Sync Service
const PROCORE = uuid(2); // owns its record
const ACUMATICA = uuid(3); // AECi holds its record
const ZAPIER = uuid(4); // an Integration platform
const NOBODY = uuid(5); // holds no product on the pair

const P_PROCORE = uuid(10);
const P_ACUMATICA = uuid(11);
const P_HIDDEN = uuid(12);
const P_PENDING = uuid(13);
const P_INEIGHT = uuid(14);
const S_SYNC = uuid(20); // connector, sync_service, Rivets
const S_HYBRID = uuid(21); // hybrid, sync_service, Rivets
const S_PLATFORM = uuid(22); // connector, integration_platform, Rivets
const S_BLANK = uuid(23); // connector, no kind, Rivets
const S_APP = uuid(24); // application with a stale sync_service kind, Rivets
const S_ZAP = uuid(25); // connector, sync_service, but Zapier's
const MISSING = uuid(29);

const OWNED_AT = '2026-10-01T00:00:00.000Z';

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_RIVETS = seat(1, RIVETS);
const AUTH_PROCORE = seat(2, PROCORE);
const AUTH_NOBODY = seat(5, NOBODY);

let t: TestDb;
let callEnv: Partial<Env> = {};

beforeEach(async () => {
  callEnv = {};
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: RIVETS, slug: 'rivets', companyName: 'Rivets' },
    { id: PROCORE, slug: 'procore', companyName: 'Procore', ownedAt: OWNED_AT },
    { id: ACUMATICA, slug: 'acumatica', companyName: 'Acumatica' },
    { id: ZAPIER, slug: 'zapier', companyName: 'Zapier' },
    { id: NOBODY, slug: 'nobody', companyName: 'Nobody' },
  ]);
  const promoted = { promotionStatus: 'promoted' } as const;
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', ...promoted },
    { id: P_ACUMATICA, slug: 'acumatica', name: 'Acumatica', ...promoted },
    { id: P_HIDDEN, slug: 'hidden', name: 'Hidden', ...promoted, hiddenAt: OWNED_AT },
    { id: P_PENDING, slug: 'pending', name: 'Pending' },
    { id: P_INEIGHT, slug: 'ineight', name: 'InEight', ...promoted },
    {
      id: S_SYNC,
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
      ...promoted,
    },
    {
      id: S_HYBRID,
      slug: 'rivets-hub',
      name: 'Rivets Hub',
      productRole: 'hybrid',
      connectorKind: 'sync_service',
      ...promoted,
    },
    {
      id: S_PLATFORM,
      slug: 'rivets-flow',
      name: 'Rivets Flow',
      productRole: 'connector',
      connectorKind: 'integration_platform',
      ...promoted,
    },
    {
      id: S_BLANK,
      slug: 'rivets-blank',
      name: 'Rivets Blank',
      productRole: 'connector',
      ...promoted,
    },
    {
      id: S_APP,
      slug: 'rivets-app',
      name: 'Rivets App',
      productRole: 'application',
      connectorKind: 'sync_service',
      ...promoted,
    },
    {
      id: S_ZAP,
      slug: 'zap-sync',
      name: 'Zap Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
      ...promoted,
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_PROCORE, vendorId: PROCORE, isPrimary: true },
    { productId: P_ACUMATICA, vendorId: ACUMATICA, isPrimary: true },
    { productId: P_HIDDEN, vendorId: ACUMATICA, isPrimary: true },
    { productId: P_PENDING, vendorId: ACUMATICA, isPrimary: true },
    { productId: P_INEIGHT, vendorId: ACUMATICA, isPrimary: true },
    { productId: S_SYNC, vendorId: RIVETS, isPrimary: true },
    { productId: S_HYBRID, vendorId: RIVETS, isPrimary: true },
    { productId: S_PLATFORM, vendorId: RIVETS, isPrimary: true },
    { productId: S_BLANK, vendorId: RIVETS, isPrimary: true },
    { productId: S_APP, vendorId: RIVETS, isPrimary: true },
    { productId: S_ZAP, vendorId: ZAPIER, isPrimary: true },
  ]);
  await t.db.insert(profiles).values(
    [AUTH_RIVETS, AUTH_PROCORE, AUTH_NOBODY].map((auth) => ({
      id: auth.userId,
      role: 'vendor_admin',
      vendorId: auth.vendorId,
    })),
  );
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth'], dbFor: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/sync-service-pairs', createCreateSyncServicePairHandler(dbFor));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  a.get('/api/products/:slug/integrations/:otherSlug', createProductPairHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  path: string,
  method: 'GET' | 'POST' = 'POST',
  body?: unknown,
  dbFor?: DbFactory,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    ...callEnv,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body !== undefined
      ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : { method };
  const res = await app(auth, dbFor).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const valid = (overrides: Record<string, unknown> = {}) => ({
  connector_product_id: S_SYNC,
  product_id: P_PROCORE,
  counterpart_product_id: P_ACUMATICA,
  name: 'Procore and Acumatica (Rivets Sync)',
  direction: 'outbound',
  listing_url: 'https://rivets.example/procore-acumatica',
  ...overrides,
});
const create = (body: unknown, auth = AUTH_RIVETS, dbFor?: DbFactory) =>
  call(auth, '/api/vendor/sync-service-pairs', 'POST', body, dbFor);

const pairRow = async (id: string) =>
  (await t.db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  }))!;
const countOf = async (id: string) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.integrationCount;
const pairCount = async () => (await t.db.select().from(connectorEvidencedPairs)).length;
const canonical = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

describe('POST /api/vendor/sync-service-pairs — the happy path', () => {
  it('inserts a claimed, vendor-origin pair the Sync Service owns, between two endpoints that are not its own', async () => {
    const res = await create(valid());
    expect(res.status).toBe(201);
    const body = CreateSyncServicePairResponseSchema.parse(res.body);
    const [a, b] = canonical(P_PROCORE, P_ACUMATICA);
    expect(body.pair).toMatchObject({
      connector_product_id: S_SYNC,
      product_a_id: a,
      product_b_id: b,
    });

    const row = await pairRow(body.pair.id);
    expect(row).toMatchObject({
      connectorProductId: S_SYNC,
      productAId: a,
      productBId: b,
      name: 'Procore and Acumatica (Rivets Sync)',
      listingUrl: 'https://rivets.example/procore-acumatica',
      builtByVendorId: RIVETS,
      origin: 'vendor',
      maintainedBy: 'vendor',
      retiredAt: null,
    });
    expect(row.claimedAt).toBe(body.pair.claimed_at);
    expect(row.vendorEditedAt).toBe(body.pair.claimed_at);
    expect(isClaimed(row)).toBe(true);
    expect(isVendorHeld(row)).toBe(true);
  });

  it('frames `direction` against `product_id` and stores it in the A/B frame', async () => {
    // P_PROCORE (uuid 10) < P_ACUMATICA (uuid 11), so Procore is A.
    const fromA = await create(valid({ direction: 'outbound' }));
    expect((await pairRow(fromA.body.pair.id)).direction).toBe('a_to_b');
    const fromB = await create(
      valid({
        connector_product_id: S_HYBRID,
        product_id: P_ACUMATICA,
        counterpart_product_id: P_PROCORE,
        direction: 'outbound',
      }),
    );
    expect((await pairRow(fromB.body.pair.id)).direction).toBe('b_to_a');
  });

  it('accepts a hybrid Sync Service', async () => {
    const res = await create(valid({ connector_product_id: S_HYBRID }));
    expect(res.status).toBe(201);
  });

  it('writes the audit row and a notification to each endpoint vendor in the same batch', async () => {
    const res = await create(valid());
    const id = res.body.pair.id as string;
    const created = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.created'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      entityType: 'connector_evidenced_pair',
      entityId: id,
      actorId: AUTH_RIVETS.userId,
    });
    expect(created[0]!.metadata).toMatchObject({
      source: 'vendor-portal',
      vendorId: RIVETS,
      reason: 'sync-service-create',
      anchor: 'evidenced_pair',
      connectorProductId: S_SYNC,
    });

    const notices = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));
    expect(notices.map((n) => n.vendorId).sort()).toEqual([PROCORE, ACUMATICA].sort());
    for (const notice of notices) {
      expect(notice.entityType).toBe('connector_evidenced_pair');
      expect(notice.metadata).toMatchObject({
        kind: 'integration_create',
        notificationId: 'portal-sync-service-pair-create',
        integrationId: id,
        ownerVendorId: RIVETS,
        ownerName: 'Rivets',
      });
    }

    const feed = await call(AUTH_PROCORE, '/api/vendor/notifications', 'GET');
    const parsed = ListVendorNotificationsResponseSchema.parse(feed.body);
    expect(parsed.notifications.find((n) => n.kind === 'integration_create')).toMatchObject({
      integration_id: id,
      owner_name: 'Rivets',
      pair_path: '/products/acumatica/integrations/procore',
    });
  });

  it('does not notify the caller when it also makes an endpoint', async () => {
    await t.db.insert(productVendors).values({ productId: P_INEIGHT, vendorId: RIVETS });
    await create(valid({ counterpart_product_id: P_INEIGHT }));
    const notices = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));
    expect(notices.map((n) => n.vendorId).sort()).toEqual([PROCORE, ACUMATICA].sort());
  });

  it('recomputes both endpoints’ and the connector’s counts inside the batch', async () => {
    await t.db.update(products).set({ integrationCount: 7 });
    await create(valid());
    expect(await countOf(P_PROCORE)).toBe(1);
    expect(await countOf(P_ACUMATICA)).toBe(1);
    expect(await countOf(S_SYNC)).toBe(1);
  });

  it('purges the pair, both endpoints, the connector, the vendor, the index and taxonomy', async () => {
    const res = await create(valid());
    const tags = res.send.mock.calls.flatMap((c) => (c[0] as { tags: string[] }).tags);
    expect(tags).toEqual(
      expect.arrayContaining([
        'pair:acumatica__procore',
        'product:acumatica',
        'product:procore',
        'product:rivets-sync',
        'vendor:rivets',
        'index:products',
        'taxonomy',
      ]),
    );
  });

  it('re-indexes the pair, the three products and their vendors in Algolia', async () => {
    vi.mocked(syncIndexTargets).mockClear();
    resetAlgoliaWriteGuardWarning();
    callEnv = { ENV: 'staging', ALGOLIA_APP_ID: 'TESTAPP', ALGOLIA_ADMIN_KEY: 'test-admin-key' };
    const res = await create(valid());
    expect(res.status).toBe(201);
    expect(syncIndexTargets).toHaveBeenCalledTimes(1);
    const targets = vi.mocked(syncIndexTargets).mock.calls[0]![4] as IndexTargetIds;
    expect(targets.integrations).toEqual([res.body.pair.id]);
    expect([...(targets.products ?? [])].sort()).toEqual([P_PROCORE, P_ACUMATICA, S_SYNC].sort());
    expect(targets.vendors).toEqual([RIVETS]);
  });

  it('shows on the public pair page with the vendor origin, so "Added by the vendor" can render', async () => {
    const res = await create(valid());
    const page = await call(AUTH_NOBODY, '/api/products/procore/integrations/acumatica', 'GET');
    expect(page.status).toBe(200);
    const mechanism = (page.body.mechanisms as JsonBody[]).find((m) => m.id === res.body.pair.id);
    expect(mechanism).toMatchObject({
      origin: 'vendor',
      via: { slug: 'rivets-sync' },
      built_by_vendor: { slug: 'rivets' },
      direction: 'outbound',
    });
  });
});

describe('POST /api/vendor/sync-service-pairs — refusals', () => {
  it.each([
    ['an Integration platform', S_PLATFORM],
    ['an unclassified connector', S_BLANK],
    ['an application', S_APP],
  ])('refuses %s with 422 CONNECTOR_NOT_SYNC_SERVICE', async (_label, connector) => {
    const res = await create(valid({ connector_product_id: connector }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONNECTOR_NOT_SYNC_SERVICE');
    expect(await pairCount()).toBe(0);
  });

  it('refuses a vendor with no Sync Service product: another vendor’s Sync Service is a 404', async () => {
    const res = await create(valid({ connector_product_id: S_ZAP }));
    expect(res.status).toBe(404);
    const none = await create(valid(), AUTH_NOBODY);
    expect(none.status).toBe(404);
    expect(await pairCount()).toBe(0);
  });

  it('refuses a hidden or unpromoted connector with the same 404', async () => {
    await t.db.update(products).set({ hiddenAt: OWNED_AT }).where(eq(products.id, S_SYNC));
    expect((await create(valid())).status).toBe(404);
    await t.db
      .update(products)
      .set({ hiddenAt: null, promotionStatus: 'pending' })
      .where(eq(products.id, S_SYNC));
    expect((await create(valid())).status).toBe(404);
  });

  it.each([
    ['hidden', P_HIDDEN],
    ['not promoted', P_PENDING],
    ['missing', MISSING],
  ])('refuses an endpoint that is %s with 404', async (_label, endpoint) => {
    const res = await create(valid({ counterpart_product_id: endpoint }));
    expect(res.status).toBe(404);
    expect(await pairCount()).toBe(0);
  });

  it('refuses the connector as an endpoint, and two equal endpoints, with 400', async () => {
    expect((await create(valid({ counterpart_product_id: S_SYNC }))).status).toBe(400);
    expect((await create(valid({ product_id: S_SYNC }))).status).toBe(400);
    expect((await create(valid({ counterpart_product_id: P_PROCORE }))).status).toBe(400);
  });

  it('refuses a body with mechanism_kind, origin or an unknown key (strict)', async () => {
    expect((await create(valid({ mechanism_kind: 'native' }))).status).toBe(400);
    expect((await create(valid({ origin: 'aeci' }))).status).toBe(400);
    expect((await create(valid({ built_by_vendor_id: PROCORE }))).status).toBe(400);
  });

  it('requires name and direction', async () => {
    expect((await create(valid({ name: undefined }))).status).toBe(400);
    expect((await create(valid({ direction: '' }))).status).toBe(400);
  });

  it('applies the owner edit value rule', async () => {
    const res = await create(valid({ listing_url: 'not a url' }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INTEGRATION_INVALID_VALUE');
    expect(res.body.error.field).toBe('listing_url');
  });
});

describe('the twin guard, across both tables and the same connector', () => {
  const [a, b] = canonical(P_PROCORE, P_ACUMATICA);

  it('refuses a pair AECi already holds through the same connector', async () => {
    await t.db.insert(connectorEvidencedPairs).values({
      id: uuid(40),
      connectorProductId: S_SYNC,
      productAId: a,
      productBId: b,
      name: 'Curated',
    });
    const res = await create(valid({ product_id: P_ACUMATICA, counterpart_product_id: P_PROCORE }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_ALREADY_ON_RECORD');
    expect(res.body.error.details).toEqual({
      existing_id: uuid(40),
      anchor: 'evidenced_pair',
      retired: false,
      retired_by_aeci: false,
      owned_by_caller: false,
      claimed: false,
    });
  });

  it('refuses a retired pair of the same key: restore it instead', async () => {
    await t.db.insert(connectorEvidencedPairs).values({
      id: uuid(41),
      connectorProductId: S_SYNC,
      productAId: a,
      productBId: b,
      builtByVendorId: RIVETS,
      origin: 'vendor',
      claimedAt: OWNED_AT,
      retiredAt: OWNED_AT,
      retiredBy: 'owner',
    });
    const res = await create(valid());
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({
      existing_id: uuid(41),
      retired: true,
      retired_by_aeci: false,
      owned_by_caller: true,
    });
    expect(res.body.error.message).toMatch(/Restore it/);
  });

  it('refuses a pair AECi retired without telling the owner to restore it (AECI-2268)', async () => {
    // The restore answers `403 INTEGRATION_RETIRED_BY_AECI`, so "restore it" is a dead end.
    await t.db.insert(connectorEvidencedPairs).values({
      id: uuid(41),
      connectorProductId: S_SYNC,
      productAId: a,
      productBId: b,
      builtByVendorId: RIVETS,
      origin: 'vendor',
      claimedAt: OWNED_AT,
      retiredAt: OWNED_AT,
      retiredBy: 'aeci',
    });
    const res = await create(valid());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_ALREADY_ON_RECORD');
    expect(res.body.error.details).toMatchObject({
      existing_id: uuid(41),
      retired: true,
      retired_by_aeci: true,
      owned_by_caller: true,
    });
    expect(res.body.error.message).toMatch(/AEC Integrations retired it/);
    expect(res.body.error.message).toMatch(/support@aecintegrations\.com/);
    expect(res.body.error.message).not.toMatch(/Restore it/);
  });

  it('refuses an `integrations` row through the same connector, in either order', async () => {
    await t.db.insert(integrations).values({
      id: uuid(42),
      sourceProductId: P_ACUMATICA,
      targetProductId: P_PROCORE,
      poweredByProductId: S_SYNC,
      mechanismKind: 'iPaaS',
    });
    const res = await create(valid());
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ existing_id: uuid(42), anchor: 'integration' });
  });

  it('allows the same pair through a different connector, or with no connector', async () => {
    await t.db.insert(connectorEvidencedPairs).values({
      id: uuid(43),
      connectorProductId: S_ZAP,
      productAId: a,
      productBId: b,
    });
    await t.db.insert(integrations).values({
      id: uuid(44),
      sourceProductId: P_PROCORE,
      targetProductId: P_ACUMATICA,
      mechanismKind: 'native',
    });
    expect((await create(valid())).status).toBe(201);
  });

  it('the guard function reads both tables', async () => {
    expect(
      await findSyncServicePairBlock(t.db, {
        connectorProductId: S_SYNC,
        productAId: a,
        productBId: b,
      }),
    ).toBeNull();
    await create(valid());
    expect(
      await findSyncServicePairBlock(t.db, {
        connectorProductId: S_SYNC,
        productAId: a,
        productBId: b,
      }),
    ).toMatchObject({ reason: 'evidenced_twin', anchor: 'evidenced_pair' });
  });
});

describe('the race: a change between the read and the batch writes nothing', () => {
  it('a promote of the same pair lands first: 409 on record, one row, no audit', async () => {
    const [a, b] = canonical(P_PROCORE, P_ACUMATICA);
    const racing = racingFactory(t.factory, async () => {
      await t.db.insert(connectorEvidencedPairs).values({
        id: uuid(50),
        connectorProductId: S_SYNC,
        productAId: a,
        productBId: b,
      });
    });
    const res = await create(valid(), AUTH_RIVETS, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_ALREADY_ON_RECORD');
    expect(await pairCount()).toBe(1);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'integration.created')),
    ).toHaveLength(0);
  });

  it('an admin clears the kind first: 422, nothing written', async () => {
    const racing = racingFactory(t.factory, async () => {
      await t.db.update(products).set({ connectorKind: null }).where(eq(products.id, S_SYNC));
    });
    const res = await create(valid(), AUTH_RIVETS, racing);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONNECTOR_NOT_SYNC_SERVICE');
    expect(await pairCount()).toBe(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('an endpoint is hidden first: 404, nothing written', async () => {
    const racing = racingFactory(t.factory, async () => {
      await t.db.update(products).set({ hiddenAt: OWNED_AT }).where(eq(products.id, P_ACUMATICA));
    });
    const res = await create(valid(), AUTH_RIVETS, racing);
    expect(res.status).toBe(404);
    expect(await pairCount()).toBe(0);
  });

  it('the seat’s vendor loses the connector product first: 404, nothing written', async () => {
    const racing = racingFactory(t.factory, async () => {
      await t.db.delete(productVendors).where(eq(productVendors.productId, S_SYNC));
    });
    const res = await create(valid(), AUTH_RIVETS, racing);
    expect(res.status).toBe(404);
    expect(await pairCount()).toBe(0);
  });
});

describe('promote never writes a vendor-created pair', () => {
  const rc = (): PromoteRunCtx => ({
    env: { ENV: 'staging' } as Env,
    request: new Request('http://localhost:8787/api/promote'),
    waitUntil: () => {},
    bookmark: () => null,
  });
  const ingest = (body: unknown) =>
    runPromoteIngest(rc(), PromotePayloadSchema.parse(body), {
      dbFor: t.factory,
      syncAlgolia: async () => {},
      notifyIndexNow: async () => {},
      refreshHomeStats: async () => {},
    });

  it('a later promote of the same pair is a VENDOR_OWNED_TWIN skip, not a second row', async () => {
    const res = await create(valid());
    const id = res.body.pair.id as string;
    const { response } = await ingest({
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { supabaseId: P_ACUMATICA },
          targetProduct: { supabaseId: P_PROCORE },
          poweredByProduct: { supabaseId: S_SYNC },
          name: 'Curated twin',
        },
      ],
    });
    expect(response.skipped).toEqual([
      expect.objectContaining({ ref: 'i1', reason: VENDOR_OWNED_TWIN, existingId: id }),
    ]);
    expect(await pairCount()).toBe(1);
    expect((await pairRow(id)).name).toBe('Procore and Acumatica (Rivets Sync)');
  });

  it('a promote addressing the pair by id is refused by the fence and changes nothing', async () => {
    const res = await create(valid());
    const id = res.body.pair.id as string;
    const before = await pairRow(id);
    const { response } = await ingest({
      integrations: [
        {
          ref: 'i1',
          supabaseId: id,
          sourceProduct: { supabaseId: P_PROCORE },
          targetProduct: { supabaseId: P_ACUMATICA },
          poweredByProduct: { supabaseId: S_SYNC },
          name: 'Renamed upstream',
        },
      ],
    });
    expect(response.integrations).toEqual([]);
    expect(response.skipped).toHaveLength(1);
    expect(await pairRow(id)).toEqual(before);
  });
});
