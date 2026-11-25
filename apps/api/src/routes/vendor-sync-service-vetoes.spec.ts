/**
 * The endpoint veto on a Sync Service pair (AECI-2042, ruling 8 on AECI-2035,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2).
 *
 * Real migrations on in-memory SQLite with `db.batch` on one transaction, so the veto
 * INSERT, the `vetoed_at` recompute, the audit rows, the notices and the counts all
 * commit or roll back together. The public reads are `vetoed-public-reads.spec.ts`.
 *
 * Covered here: who may veto (endpoint seat yes, owner no, the Sync Service vendor no,
 * stranger 404, platform / blank / native refused), the effect, the notices, withdraw,
 * two vetoes, the admin lift, the restore refusals, the re-create refusal (also after
 * the row is gone), and promote never reviving or duplicating a vetoed pair.
 */

import { PromotePayloadSchema, VetoWriteResponseSchema } from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
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
  syncServicePairVetoes,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import { syncIndexTargets, type IndexTargetIds } from '../lib/algolia-sync';
import type { AuthzVariables } from '../lib/authz';
import { checkVetoedAtMismatch } from '../lib/data-quality';
import { findSyncServicePairBlock } from '../lib/integration-twins';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminRestoreIntegrationHandler,
  createAdminRetireIntegrationHandler,
} from './admin-integration-retire';
import {
  createAdminLiftVetoHandler,
  createAdminListVetoesHandler,
} from './admin-sync-service-vetoes';
import { REFUSED_VETOED_INTEGRATION, runPromoteIngest, type PromoteRunCtx } from './promote';
import {
  createRestoreIntegrationHandler,
  createRetireIntegrationHandler,
} from './vendor-integration-retire';
import { createCreateSyncServicePairHandler } from './vendor-sync-service-pair-create';
import {
  createFileVetoHandler,
  createListVendorVetoesHandler,
  createWithdrawVetoHandler,
} from './vendor-sync-service-vetoes';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const RIVETS = uuid(1); // sells the Sync Service, owns PAIR
const PROCORE = uuid(2); // endpoint A of PAIR
const ACUMATICA = uuid(3); // endpoint B of PAIR, and of the other rows
const ZAPIER = uuid(4); // an Integration platform
const NOBODY = uuid(5); // holds no product on any pair

// Canonical order: product A sorts first.
const P_PROCORE = uuid(10);
const P_ACUMATICA = uuid(11);
const P_INEIGHT = uuid(12);
const S_SYNC = uuid(20); // connector, sync_service, Rivets
const S_PLATFORM = uuid(21); // connector, integration_platform, Zapier
const S_BLANK = uuid(22); // connector, no kind, Zapier

const PAIR = uuid(30); // S_SYNC: Procore ↔ Acumatica, claimed by Rivets
const PAIR_SEEDED = uuid(31); // S_SYNC: Procore ↔ InEight, AECi-held, unclaimed
const PAIR_PLATFORM = uuid(32);
const PAIR_BLANK = uuid(33);
const INT_NATIVE = uuid(34); // integrations, no connector
const INT_SYNC = uuid(35); // integrations, powered by S_SYNC: Acumatica → InEight

const CLAIMED_AT = '2026-10-01T00:00:00.000Z';

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
const AUTH_ACUMATICA = seat(3, ACUMATICA);
const AUTH_NOBODY = seat(5, NOBODY);
const AUTH_ADMIN: AuthzVariables['auth'] = {
  userId: uuid(199),
  email: 'admin@example.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: RIVETS, slug: 'rivets', companyName: 'Rivets' },
    { id: PROCORE, slug: 'procore-inc', companyName: 'Procore Inc' },
    { id: ACUMATICA, slug: 'acumatica-inc', companyName: 'Acumatica Inc' },
    { id: ZAPIER, slug: 'zapier', companyName: 'Zapier' },
    { id: NOBODY, slug: 'nobody', companyName: 'Nobody' },
  ]);
  const promoted = { promotionStatus: 'promoted' } as const;
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', ...promoted },
    { id: P_ACUMATICA, slug: 'acumatica', name: 'Acumatica', ...promoted },
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
      id: S_PLATFORM,
      slug: 'zap-flow',
      name: 'Zap Flow',
      productRole: 'connector',
      connectorKind: 'integration_platform',
      ...promoted,
    },
    { id: S_BLANK, slug: 'zap-blank', name: 'Zap Blank', productRole: 'connector', ...promoted },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_PROCORE, vendorId: PROCORE, isPrimary: true },
    { productId: P_ACUMATICA, vendorId: ACUMATICA, isPrimary: true },
    { productId: P_INEIGHT, vendorId: ACUMATICA, isPrimary: true },
    { productId: S_SYNC, vendorId: RIVETS, isPrimary: true },
    { productId: S_PLATFORM, vendorId: ZAPIER, isPrimary: true },
    { productId: S_BLANK, vendorId: ZAPIER, isPrimary: true },
  ]);
  await t.db.insert(profiles).values(
    [AUTH_RIVETS, AUTH_PROCORE, AUTH_ACUMATICA, AUTH_NOBODY, AUTH_ADMIN].map((auth) => ({
      id: auth.userId,
      role: auth.role,
      vendorId: auth.vendorId,
    })),
  );
  const held = {
    builtByVendorId: RIVETS,
    claimedAt: CLAIMED_AT,
    origin: 'vendor',
    maintainedBy: 'vendor' as const,
  };
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: PAIR,
      name: 'Procore and Acumatica (Rivets Sync)',
      connectorProductId: S_SYNC,
      productAId: P_PROCORE,
      productBId: P_ACUMATICA,
      direction: 'a_to_b',
      ...held,
    },
    {
      id: PAIR_SEEDED,
      name: 'Procore and InEight (Rivets Sync)',
      connectorProductId: S_SYNC,
      productAId: P_PROCORE,
      productBId: P_INEIGHT,
      direction: 'both',
    },
    {
      id: PAIR_PLATFORM,
      name: 'Platform pair',
      connectorProductId: S_PLATFORM,
      productAId: P_PROCORE,
      productBId: P_ACUMATICA,
      direction: 'both',
    },
    {
      id: PAIR_BLANK,
      name: 'Blank pair',
      connectorProductId: S_BLANK,
      productAId: P_PROCORE,
      productBId: P_ACUMATICA,
      direction: 'both',
    },
  ]);
  await t.db.insert(integrations).values([
    {
      id: INT_NATIVE,
      name: 'Native',
      sourceProductId: P_PROCORE,
      targetProductId: P_ACUMATICA,
      mechanismKind: 'native',
    },
    {
      id: INT_SYNC,
      name: 'Acumatica to InEight (Rivets Sync)',
      sourceProductId: P_ACUMATICA,
      targetProductId: P_INEIGHT,
      poweredByProductId: S_SYNC,
      mechanismKind: 'iPaaS',
      builtByVendorId: RIVETS,
    },
  ]);
});
afterEach(() => {
  extraEnv = {};
  t.dispose();
});

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/integrations/:id/veto', createFileVetoHandler(t.factory));
  a.post('/api/vendor/vetoes/:id/withdraw', createWithdrawVetoHandler(t.factory));
  a.get('/api/vendor/vetoes', createListVendorVetoesHandler(t.factory));
  a.post('/api/vendor/integrations/:id/retire', createRetireIntegrationHandler(t.factory));
  a.post('/api/vendor/integrations/:id/restore', createRestoreIntegrationHandler(t.factory));
  a.post('/api/vendor/sync-service-pairs', createCreateSyncServicePairHandler(t.factory));
  a.get('/api/admin/vetoes', createAdminListVetoesHandler(t.factory));
  a.post('/api/admin/vetoes/:id/lift', createAdminLiftVetoHandler(t.factory));
  a.post('/api/admin/integrations/:id/retire', createAdminRetireIntegrationHandler(t.factory));
  a.post('/api/admin/integrations/:id/restore', createAdminRestoreIntegrationHandler(t.factory));
  return a;
}

/** Env a test adds to every call (the Algolia credentials, for the by-id sync). */
let extraEnv: Partial<Env> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  path: string,
  method: 'GET' | 'POST' = 'POST',
  body?: unknown,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    ...extraEnv,
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

const veto = (id: string, auth = AUTH_PROCORE, reason = 'We never authorised this.') =>
  call(auth, `/api/vendor/integrations/${id}/veto`, 'POST', { reason });
const withdraw = (vetoId: string, auth = AUTH_PROCORE) =>
  call(auth, `/api/vendor/vetoes/${vetoId}/withdraw`, 'POST');
const pairRow = async (id: string) =>
  (await t.db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  }))!;
const countOf = async (id: string) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.integrationCount;
const notices = async () =>
  (await t.db.select().from(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION))).filter(
    (r) => (r.metadata as { kind?: string } | null)?.kind === 'pair_right',
  );
const purgedTags = (send: ReturnType<typeof vi.fn>): string[] =>
  send.mock.calls.flatMap((c) => (c[0] as { tags?: string[] }).tags ?? []);

describe('POST /api/vendor/integrations/:id/veto — who may veto', () => {
  it('an endpoint vendor with a seat vetoes a Sync Service pair: 201, and it is off the site', async () => {
    const res = await veto(PAIR);
    expect(res.status).toBe(201);
    const body = VetoWriteResponseSchema.parse(res.body);
    expect(body.pair_public).toBe(false);
    expect(body.veto.in_force).toBe(true);
    expect(body.veto.vendor_name).toBe('Procore Inc');
    expect((await pairRow(PAIR)).vetoedAt).not.toBeNull();
  });

  it('the other endpoint vendor may veto too', async () => {
    expect((await veto(PAIR, AUTH_ACUMATICA)).status).toBe(201);
  });

  it('may veto an AECi-seeded pair nobody has claimed', async () => {
    expect((await veto(PAIR_SEEDED)).status).toBe(201);
    expect((await pairRow(PAIR_SEEDED)).vetoedAt).not.toBeNull();
  });

  it('covers an `integrations` row whose connector is a Sync Service', async () => {
    const res = await veto(INT_SYNC, AUTH_ACUMATICA);
    expect(res.status).toBe(201);
    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, INT_SYNC) });
    expect(row!.vetoedAt).not.toBeNull();
  });

  it('the owner gets 403 SYNC_SERVICE_RIGHT_OWN_INTEGRATION, as does the Sync Service vendor', async () => {
    const owner = await veto(PAIR, AUTH_RIVETS);
    expect(owner.status).toBe(404); // Rivets holds neither endpoint: a stranger to the pair.
    // Make Rivets an endpoint vendor too, as a Sync Service that also sells Procore.
    await t.db.insert(productVendors).values({ productId: P_PROCORE, vendorId: RIVETS });
    const again = await veto(PAIR, AUTH_RIVETS);
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('SYNC_SERVICE_RIGHT_OWN_INTEGRATION');
  });

  it('a vendor holding neither endpoint gets the same 404 as an unknown id', async () => {
    const stranger = await veto(PAIR, AUTH_NOBODY);
    const unknown = await veto(uuid(999));
    expect(stranger.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(stranger.body.error.code).toBe(unknown.body.error.code);
  });

  it.each([
    ['an Integration platform pair', PAIR_PLATFORM],
    ['a pair whose connector kind is blank', PAIR_BLANK],
    ['a native integration', INT_NATIVE],
  ])('refuses %s with 403 SYNC_SERVICE_RIGHT_NOT_AVAILABLE', async (_label, id) => {
    const res = await veto(id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SYNC_SERVICE_RIGHT_NOT_AVAILABLE');
    expect(await t.db.select().from(syncServicePairVetoes)).toEqual([]);
  });

  it('a second veto by the same vendor is 409 VETO_DUPLICATE and writes nothing', async () => {
    await veto(PAIR);
    const again = await veto(PAIR);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('VETO_DUPLICATE');
    expect(await t.db.select().from(syncServicePairVetoes)).toHaveLength(1);
  });

  it('a reason is required', async () => {
    const res = await call(AUTH_PROCORE, `/api/vendor/integrations/${PAIR}/veto`, 'POST', {
      reason: '  ',
    });
    expect(res.status).toBe(400);
  });
});

describe('the veto batch', () => {
  it('recomputes all three counts in the batch, and a withdraw puts them back', async () => {
    // Procore touches PAIR, PAIR_SEEDED, PAIR_PLATFORM, PAIR_BLANK and INT_NATIVE; Acumatica
    // touches PAIR, the two other pairs, INT_NATIVE and INT_SYNC. Rivets
    // Sync counts the two pairs it delivers (§12.5 option B).
    const filed = await veto(PAIR);
    expect(await countOf(P_PROCORE)).toBe(4);
    expect(await countOf(P_ACUMATICA)).toBe(4);
    expect(await countOf(S_SYNC)).toBe(1);
    await withdraw(filed.body.veto.id);
    expect(await countOf(P_PROCORE)).toBe(5);
    expect(await countOf(S_SYNC)).toBe(2);
  });

  it('writes the audit row, and tells the owner who vetoed and why, and the other endpoint vendor only that it happened', async () => {
    const res = await veto(PAIR, AUTH_PROCORE, 'We do not support this sync.');
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.vetoed'));
    expect(audit).toMatchObject({
      entityType: 'sync_service_pair_veto',
      entityId: res.body.veto.id,
      vendorId: PROCORE,
    });
    const sent = await notices();
    const owner = sent.find((n) => n.vendorId === RIVETS)!;
    const other = sent.find((n) => n.vendorId === ACUMATICA)!;
    expect(owner.metadata).toMatchObject({
      event: 'vetoed',
      byVendorName: 'Procore Inc',
      reason: 'We do not support this sync.',
      pairPublic: false,
      notificationId: 'portal-sync-service-veto',
    });
    expect(other.metadata).toMatchObject({ event: 'vetoed', reason: null });
    expect(sent.find((n) => n.vendorId === PROCORE)).toBeUndefined();
  });

  it('purges the pair, both endpoints and the connector', async () => {
    const res = await veto(PAIR);
    const tags = purgedTags(res.send);
    expect(tags).toEqual(
      expect.arrayContaining([
        'pair:acumatica__procore',
        'product:procore',
        'product:acumatica',
        'product:rivets-sync',
        'vendor:rivets',
        'index:products',
      ]),
    );
  });

  it('keeps the data-quality invariant clean', async () => {
    await veto(PAIR);
    expect((await checkVetoedAtMismatch(t.db)).lines).toEqual([]);
    // A write that bypassed the batch is caught.
    await t.db
      .update(connectorEvidencedPairs)
      .set({ vetoedAt: null })
      .where(eq(connectorEvidencedPairs.id, PAIR));
    expect((await checkVetoedAtMismatch(t.db)).lines).toHaveLength(1);
  });
});

describe('withdraw and lift', () => {
  it('the vetoing vendor withdraws its veto, and the pair returns as it was', async () => {
    const before = await pairRow(PAIR);
    const filed = await veto(PAIR);
    const res = await withdraw(filed.body.veto.id);
    expect(res.status).toBe(200);
    expect(res.body.pair_public).toBe(true);
    const after = await pairRow(PAIR);
    expect(after.vetoedAt).toBeNull();
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    // History is kept.
    const [row] = await t.db.select().from(syncServicePairVetoes);
    expect(row).toMatchObject({ endedHow: 'withdrawn' });
  });

  it('another vendor cannot withdraw it: 404', async () => {
    const filed = await veto(PAIR);
    expect((await withdraw(filed.body.veto.id, AUTH_ACUMATICA)).status).toBe(404);
  });

  it('when both endpoint vendors veto, the pair returns only when both have ended', async () => {
    const a = await veto(PAIR, AUTH_PROCORE);
    const b = await veto(PAIR, AUTH_ACUMATICA);
    const first = await withdraw(a.body.veto.id, AUTH_PROCORE);
    expect(first.body.pair_public).toBe(false);
    expect((await pairRow(PAIR)).vetoedAt).not.toBeNull();
    const second = await withdraw(b.body.veto.id, AUTH_ACUMATICA);
    expect(second.body.pair_public).toBe(true);
    expect((await pairRow(PAIR)).vetoedAt).toBeNull();
  });

  it('an AECi admin lifts a veto with a required note; the vendor is told', async () => {
    const filed = await veto(PAIR);
    const noNote = await call(
      AUTH_ADMIN,
      `/api/admin/vetoes/${filed.body.veto.id}/lift`,
      'POST',
      {},
    );
    expect(noNote.status).toBe(400);
    const res = await call(AUTH_ADMIN, `/api/admin/vetoes/${filed.body.veto.id}/lift`, 'POST', {
      note: 'The seat that filed it was granted in error.',
    });
    expect(res.status).toBe(200);
    expect(res.body.veto.ended_how).toBe('lifted');
    expect((await pairRow(PAIR)).vetoedAt).toBeNull();
    const told = (await notices()).filter(
      (n) => (n.metadata as { event?: string }).event === 'veto_lifted',
    );
    expect(told.map((n) => n.vendorId).sort()).toEqual([ACUMATICA, PROCORE, RIVETS].sort());
    const again = await call(AUTH_ADMIN, `/api/admin/vetoes/${filed.body.veto.id}/lift`, 'POST', {
      note: 'again',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('VETO_NOT_IN_FORCE');
  });

  it('lists the vetoes a vendor filed and the vetoes on pairs it owns', async () => {
    await veto(PAIR);
    const filed = await call(AUTH_PROCORE, '/api/vendor/vetoes', 'GET');
    expect(filed.body.filed).toHaveLength(1);
    expect(filed.body.received).toEqual([]);
    const owner = await call(AUTH_RIVETS, '/api/vendor/vetoes', 'GET');
    expect(owner.body.received).toHaveLength(1);
    expect(owner.body.received[0]).toMatchObject({ vendor_name: 'Procore Inc', in_force: true });
    const admin = await call(AUTH_ADMIN, '/api/admin/vetoes', 'GET');
    expect(admin.body.data[0]).toMatchObject({ owner_name: 'Rivets' });
  });
});

describe('a veto is not a retire: neither restore brings the pair back', () => {
  it('the owner retire leaves the veto in force, and the owner restore answers 409 INTEGRATION_VETOED', async () => {
    expect((await call(AUTH_RIVETS, `/api/vendor/integrations/${PAIR}/retire`)).status).toBe(200);
    await veto(PAIR);
    const res = await call(AUTH_RIVETS, `/api/vendor/integrations/${PAIR}/restore`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_VETOED');
    expect((await pairRow(PAIR)).retiredAt).not.toBeNull();
  });

  it('the owner restore of a vetoed live row also answers INTEGRATION_VETOED', async () => {
    await veto(PAIR);
    const res = await call(AUTH_RIVETS, `/api/vendor/integrations/${PAIR}/restore`);
    expect(res.body.error.code).toBe('INTEGRATION_VETOED');
  });

  it('the admin restore refuses a vetoed row until the veto is lifted', async () => {
    const retired = await call(AUTH_ADMIN, `/api/admin/integrations/${PAIR}/retire`, 'POST', {
      reason: 'Checked with the vendor.',
    });
    expect(retired.status).toBe(200);
    const filed = await veto(PAIR);
    const refused = await call(AUTH_ADMIN, `/api/admin/integrations/${PAIR}/restore`, 'POST', {
      reason: 'Back.',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INTEGRATION_VETOED');
    await call(AUTH_ADMIN, `/api/admin/vetoes/${filed.body.veto.id}/lift`, 'POST', {
      note: 'Filed in error.',
    });
    const restored = await call(AUTH_ADMIN, `/api/admin/integrations/${PAIR}/restore`, 'POST', {
      reason: 'Back.',
    });
    expect(restored.status).toBe(200);
  });
});

describe('the Sync Service cannot re-create a vetoed pair', () => {
  const recreate = () =>
    call(AUTH_RIVETS, '/api/vendor/sync-service-pairs', 'POST', {
      connector_product_id: S_SYNC,
      product_id: P_PROCORE,
      counterpart_product_id: P_ACUMATICA,
      name: 'Procore and Acumatica again',
      direction: 'outbound',
    });

  it('answers 409 INTEGRATION_VETOED while the veto is in force', async () => {
    await veto(PAIR);
    const res = await recreate();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_VETOED');
    expect(
      (
        await findSyncServicePairBlock(t.db, {
          connectorProductId: S_SYNC,
          productAId: P_PROCORE,
          productBId: P_ACUMATICA,
        })
      )?.reason,
    ).toBe('endpoint_veto');
  });

  it('still answers 409 after the vetoed row is deleted: the veto keeps the pair key', async () => {
    await veto(PAIR);
    await t.db.delete(connectorEvidencedPairs).where(eq(connectorEvidencedPairs.id, PAIR));
    const [kept] = await t.db.select().from(syncServicePairVetoes);
    expect(kept!.evidencedPairId).toBeNull();
    const res = await recreate();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_VETOED');
  });
});

describe('promote never revives, overwrites or duplicates a vetoed pair', () => {
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
  const seededEdge = (extra: Record<string, unknown> = {}) => ({
    ref: 'i1',
    sourceProduct: { supabaseId: P_PROCORE },
    targetProduct: { supabaseId: P_INEIGHT },
    poweredByProduct: { supabaseId: S_SYNC },
    name: 'Renamed upstream',
    ...extra,
  });

  it('a promote addressing a vetoed AECi-held pair by id is refused, and the row is unchanged', async () => {
    await veto(PAIR_SEEDED);
    const before = await pairRow(PAIR_SEEDED);
    const { response } = await ingest({ integrations: [seededEdge({ supabaseId: PAIR_SEEDED })] });
    expect(response.skipped).toEqual([
      expect.objectContaining({ ref: 'i1', reason: REFUSED_VETOED_INTEGRATION }),
    ]);
    expect(await pairRow(PAIR_SEEDED)).toEqual(before);
  });

  it('a promote of the same pair under a new upstream id writes no second row', async () => {
    await veto(PAIR_SEEDED);
    const { response } = await ingest({ integrations: [seededEdge()] });
    expect(response.skipped).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(connectorEvidencedPairs)
      .where(
        and(
          eq(connectorEvidencedPairs.productAId, P_PROCORE),
          eq(connectorEvidencedPairs.productBId, P_INEIGHT),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('after the vetoed row is deleted, a promote of its key is refused, not re-added', async () => {
    await veto(PAIR_SEEDED);
    await t.db.delete(connectorEvidencedPairs).where(eq(connectorEvidencedPairs.id, PAIR_SEEDED));
    const { response } = await ingest({ integrations: [seededEdge()] });
    expect(response.skipped).toEqual([
      expect.objectContaining({ ref: 'i1', reason: REFUSED_VETOED_INTEGRATION }),
    ]);
    const rows = await t.db
      .select()
      .from(connectorEvidencedPairs)
      .where(eq(connectorEvidencedPairs.productBId, P_INEIGHT));
    expect(rows).toEqual([]);
  });

  it('once the veto is withdrawn, promote writes the pair again', async () => {
    const filed = await veto(PAIR_SEEDED);
    await withdraw(filed.body.veto.id);
    const { response } = await ingest({ integrations: [seededEdge({ supabaseId: PAIR_SEEDED })] });
    expect(response.skipped).toEqual([]);
    expect((await pairRow(PAIR_SEEDED)).name).toBe('Renamed upstream');
  });
});

// ─── Review blocker 1: a veto hides every row on its pair key ────────────────
//
// The veto row keeps the pair key (connector, A, B). The same key can sit in both
// tables, and in more than one `integrations` row, so every row on it must leave the
// site, and come back, together. `integrations` rows are source → target, so a row
// stored B → A is on the key too.

const DUP_REV = uuid(36); // integrations: Acumatica → Procore via S_SYNC, AECi-held
const DUP_FWD = uuid(37); // integrations: Procore → Acumatica via S_SYNC, Nobody owns it
const INT_TWIN = uuid(38); // integrations: InEight → Acumatica via S_SYNC, beside INT_SYNC

const intRow = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;

async function seedDuplicates(): Promise<void> {
  await t.db.insert(integrations).values([
    {
      id: DUP_REV,
      name: 'Acumatica to Procore (Rivets Sync)',
      sourceProductId: P_ACUMATICA,
      targetProductId: P_PROCORE,
      poweredByProductId: S_SYNC,
      mechanismKind: 'iPaaS',
    },
    {
      id: DUP_FWD,
      name: 'Procore to Acumatica (Rivets Sync, resold)',
      sourceProductId: P_PROCORE,
      targetProductId: P_ACUMATICA,
      poweredByProductId: S_SYNC,
      mechanismKind: 'iPaaS',
      builtByVendorId: NOBODY,
      claimedAt: CLAIMED_AT,
      origin: 'vendor',
    },
    {
      id: INT_TWIN,
      name: 'InEight to Acumatica (Rivets Sync)',
      sourceProductId: P_INEIGHT,
      targetProductId: P_ACUMATICA,
      poweredByProductId: S_SYNC,
      mechanismKind: 'iPaaS',
    },
  ]);
}

describe('a veto hides every row on its pair key (review blocker 1)', () => {
  beforeEach(seedDuplicates);

  it('hides the pair in both tables and both orientations, and a withdraw brings all back', async () => {
    const filed = await veto(PAIR);
    expect(filed.status).toBe(201);
    expect((await pairRow(PAIR)).vetoedAt).not.toBeNull();
    expect((await intRow(DUP_REV)).vetoedAt).not.toBeNull();
    expect((await intRow(DUP_FWD)).vetoedAt).not.toBeNull();
    // A row on another key is untouched.
    expect((await intRow(INT_TWIN)).vetoedAt).toBeNull();
    expect((await checkVetoedAtMismatch(t.db)).lines).toEqual([]);
    // Procore counts none of the three: PAIR_SEEDED, PAIR_PLATFORM, PAIR_BLANK and
    // INT_NATIVE are left.
    expect(await countOf(P_PROCORE)).toBe(4);

    const back = await withdraw(filed.body.veto.id);
    expect(back.status).toBe(200);
    expect(back.body.pair_public).toBe(true);
    expect((await pairRow(PAIR)).vetoedAt).toBeNull();
    expect((await intRow(DUP_REV)).vetoedAt).toBeNull();
    expect((await intRow(DUP_FWD)).vetoedAt).toBeNull();
    expect(await countOf(P_PROCORE)).toBe(7);
  });

  it('two integrations rows on one key: a veto on one hides both, and a lift brings both back', async () => {
    const filed = await veto(INT_SYNC, AUTH_ACUMATICA);
    expect(filed.status).toBe(201);
    expect((await intRow(INT_SYNC)).vetoedAt).not.toBeNull();
    expect((await intRow(INT_TWIN)).vetoedAt).not.toBeNull();
    const lifted = await call(AUTH_ADMIN, `/api/admin/vetoes/${filed.body.veto.id}/lift`, 'POST', {
      note: 'Filed through a seat granted in error.',
    });
    expect(lifted.status).toBe(200);
    expect((await intRow(INT_SYNC)).vetoedAt).toBeNull();
    expect((await intRow(INT_TWIN)).vetoedAt).toBeNull();
  });

  it('both endpoint vendors veto: every row stays hidden until both have ended', async () => {
    const a = await veto(PAIR, AUTH_PROCORE);
    const b = await veto(DUP_REV, AUTH_ACUMATICA);
    expect(b.status).toBe(201);
    const first = await withdraw(a.body.veto.id, AUTH_PROCORE);
    expect(first.body.pair_public).toBe(false);
    for (const id of [DUP_REV, DUP_FWD]) expect((await intRow(id)).vetoedAt).not.toBeNull();
    // The column is the earliest veto still in force: the second one now.
    expect((await pairRow(PAIR)).vetoedAt).toBe(b.body.veto.filed_at);
    const second = await withdraw(b.body.veto.id, AUTH_ACUMATICA);
    expect(second.body.pair_public).toBe(true);
    for (const id of [DUP_REV, DUP_FWD]) expect((await intRow(id)).vetoedAt).toBeNull();
    expect((await pairRow(PAIR)).vetoedAt).toBeNull();
    expect((await checkVetoedAtMismatch(t.db)).lines).toEqual([]);
  });

  it('after the vetoed row is deleted, the other rows stay hidden, and a withdraw brings them back', async () => {
    const filed = await veto(PAIR);
    await t.db.delete(connectorEvidencedPairs).where(eq(connectorEvidencedPairs.id, PAIR));
    expect((await intRow(DUP_REV)).vetoedAt).not.toBeNull();
    expect((await checkVetoedAtMismatch(t.db)).lines).toEqual([]);
    const back = await withdraw(filed.body.veto.id);
    expect(back.status).toBe(200);
    expect(back.body.pair_public).toBe(true);
    expect((await intRow(DUP_REV)).vetoedAt).toBeNull();
    expect((await intRow(DUP_FWD)).vetoedAt).toBeNull();
  });

  it('the owner of another row on the key is told, and sees the veto in its list', async () => {
    await veto(PAIR);
    const told = (await notices()).find((n) => n.vendorId === NOBODY);
    expect(told?.metadata).toMatchObject({ event: 'vetoed', reason: 'We never authorised this.' });
    const list = await call(AUTH_NOBODY, '/api/vendor/vetoes', 'GET');
    expect(list.body.received).toHaveLength(1);
  });

  it('syncs and purges every row on the key, not only the anchor', async () => {
    extraEnv = { ENV: 'staging', ALGOLIA_APP_ID: 'TESTAPP', ALGOLIA_ADMIN_KEY: 'test-admin-key' };
    vi.mocked(syncIndexTargets).mockClear();
    const res = await veto(PAIR);
    const targets = vi.mocked(syncIndexTargets).mock.calls[0]![4] as IndexTargetIds;
    expect([...targets.integrations].sort()).toEqual([PAIR, DUP_REV, DUP_FWD].sort());
    expect(targets.vendors).toEqual(expect.arrayContaining([RIVETS, NOBODY]));
    expect(purgedTags(res.send)).toEqual(
      expect.arrayContaining(['vendor:rivets', 'vendor:nobody']),
    );
  });

  it('the data-quality check reports a second row on a vetoed key left on the site', async () => {
    await veto(PAIR);
    await t.db.update(integrations).set({ vetoedAt: null }).where(eq(integrations.id, DUP_REV));
    const { lines } = await checkVetoedAtMismatch(t.db);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(DUP_REV);
  });

  it('no restore brings back a duplicate row while the veto is in force', async () => {
    await veto(PAIR);
    const res = await call(AUTH_ADMIN, `/api/admin/integrations/${DUP_FWD}/restore`, 'POST', {
      reason: 'Back.',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_VETOED');
  });
});

// ─── Review blocker 2: the gate is asserted again inside the batch ────────────
//
// `resolvePairRightTarget` reads before the batch. Each case changes one fact between
// that read and the commit, the way a promote, an AECi owner change or a seat removal
// can, and the veto must write nothing.

/** Run `statement` once, just before the next `db.batch` commits. */
function raceBeforeBatch(statement: string, ...params: unknown[]): void {
  type BatchFn = (s: unknown[]) => Promise<unknown[]>;
  const holder = t.db as unknown as { batch: BatchFn };
  const realBatch = holder.batch.bind(t.db) as BatchFn;
  holder.batch = async (stmts) => {
    holder.batch = realBatch;
    t.raw.prepare(statement).run(...params);
    return realBatch(stmts);
  };
}

describe('the veto gate holds at commit (review blocker 2)', () => {
  const nothingWritten = async () => {
    expect(await t.db.select().from(syncServicePairVetoes)).toEqual([]);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'integration.vetoed')),
    ).toEqual([]);
  };

  it.each([
    [
      'the endpoints changed',
      PAIR,
      'UPDATE connector_evidenced_pairs SET product_a_id = ?, product_b_id = ? WHERE id = ?',
      [P_ACUMATICA, P_INEIGHT, PAIR],
    ],
    [
      'the connector changed',
      PAIR_SEEDED,
      'UPDATE connector_evidenced_pairs SET connector_product_id = ? WHERE id = ?',
      [S_PLATFORM, PAIR_SEEDED],
    ],
    [
      'the connector is no longer a Sync Service',
      PAIR,
      "UPDATE products SET connector_kind = 'integration_platform' WHERE id = ?",
      [S_SYNC],
    ],
    [
      'the caller lost its endpoint',
      PAIR,
      'DELETE FROM product_vendors WHERE vendor_id = ?',
      [PROCORE],
    ],
    [
      'the caller became the owner',
      PAIR,
      'UPDATE connector_evidenced_pairs SET built_by_vendor_id = ? WHERE id = ?',
      [PROCORE, PAIR],
    ],
  ])('%s: 409 VETO_PAIR_CHANGED, nothing written', async (_label, id, statement, params) => {
    raceBeforeBatch(statement, ...params);
    const res = await veto(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VETO_PAIR_CHANGED');
    await nothingWritten();
    expect((await pairRow(id)).vetoedAt).toBeNull();
  });

  it('an `integrations` row whose endpoint changed is refused too', async () => {
    raceBeforeBatch(
      'UPDATE integrations SET source_product_id = ? WHERE id = ?',
      P_PROCORE,
      INT_SYNC,
    );
    const res = await veto(INT_SYNC, AUTH_ACUMATICA);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VETO_PAIR_CHANGED');
    await nothingWritten();
  });

  it('with nothing changed the same veto goes through', async () => {
    raceBeforeBatch('UPDATE products SET name = name WHERE id = ?', S_SYNC);
    expect((await veto(PAIR)).status).toBe(201);
  });
});
