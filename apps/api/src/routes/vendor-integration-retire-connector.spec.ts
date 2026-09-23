/**
 * Retire and restore on connector-powered rows, owner and AECi (AECI-1091 / the
 * AECI-1040 carve-out and ruling D / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6, §4.6.4).
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the guarded UPDATE, the race sentinel and the audit-in-batch rule run for real.
 *
 * The seed has one connector (P_CONNECTOR, vendor V_CONN) delivering two pairs between
 * P_A (vendor V_A) and P_B (vendor V_B):
 *
 * - PAIR_OWNED: owned and claimed by V_CONN, a third party that holds neither
 *   endpoint. That is the production shape: all 35 third-party-owned rows are pairs.
 * - PAIR_UNCLAIMED: V_CONN on file, not claimed. AECi-held.
 *
 * plus I_POWERED, a claimed connector-powered `integrations` row owned by V_B.
 */

import {
  ListVendorNotificationsResponseSchema,
  RetireIntegrationResponseSchema,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import {
  EVIDENCED_PAIR_ENTITY_TYPE,
  INTEGRATION_RESTORED_ACTION,
  INTEGRATION_RETIRED_ACTION,
} from '../lib/integration-retire';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminRestoreIntegrationHandler,
  createAdminRetireIntegrationHandler,
  createAdminVendorIntegrationsHandler,
} from './admin-integration-retire';
import { buildPairRetireBatch } from './integration-retire-write';
import { createSubmitContestHandler } from './vendor-contests';
import {
  createRestoreIntegrationHandler,
  createRetireIntegrationHandler,
} from './vendor-integration-retire';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const V_A = uuid(1);
const V_B = uuid(2);
const V_CONN = uuid(3);
const V_OTHER = uuid(4);

// Canonical order is a CHECK (`product_a_id < product_b_id`), so A sorts first.
const P_A = uuid(10);
const P_B = uuid(11);
const P_CONNECTOR = uuid(12);
const P_OTHER = uuid(13);

const PAIR_OWNED = uuid(20);
const PAIR_UNCLAIMED = uuid(21);
const I_POWERED = uuid(22);
const DATA_OBJECT = uuid(30);
const CLAIM = uuid(31);
const ATTESTATION = uuid(32);

const CLAIMED_AT = '2026-09-01T00:00:00.000Z';
const REASON = 'The listing names a product the vendor does not sell (Terms 7.2).';

const ACTIVE = {
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
} as const;
const seat = (n: number, vendorId: string, entitled: boolean): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  ...(entitled ? ACTIVE : { entitlementTier: 'unclaimed', entitlement: null }),
});
const CONN = seat(1, V_CONN, true);
const CONN_UNENTITLED = seat(2, V_CONN, false);
const AUTH_A = seat(3, V_A, true);
const AUTH_B = seat(4, V_B, true);
const AUTH_B_UNENTITLED = seat(5, V_B, false);
const STRANGER = seat(6, V_OTHER, true);
const ADMIN: AuthzVariables['auth'] = {
  userId: uuid(90),
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V_A, slug: 'procore-inc', companyName: 'Procore Inc' },
    { id: V_B, slug: 'sage', companyName: 'Sage' },
    { id: V_CONN, slug: 'agave', companyName: 'Agave' },
    { id: V_OTHER, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: P_B, slug: 'sage-intacct', name: 'Sage Intacct', promotionStatus: 'promoted' },
    {
      id: P_CONNECTOR,
      slug: 'agave-sync',
      name: 'Agave Sync',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
    { id: P_OTHER, slug: 'archicad', name: 'ArchiCAD', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: V_A, isPrimary: true },
    { productId: P_B, vendorId: V_B, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: V_CONN, isPrimary: true },
    { productId: P_OTHER, vendorId: V_OTHER, isPrimary: true },
  ]);
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: PAIR_OWNED,
      name: 'Agave: Procore to Sage Intacct',
      connectorProductId: P_CONNECTOR,
      productAId: P_A,
      productBId: P_B,
      direction: 'a_to_b',
      builtByVendorId: V_CONN,
      claimedAt: CLAIMED_AT,
      maintainedBy: 'vendor',
      updatedAt: CLAIMED_AT,
    },
    {
      id: PAIR_UNCLAIMED,
      name: 'Agave: second route',
      connectorProductId: P_CONNECTOR,
      productAId: P_A,
      productBId: P_OTHER,
      direction: 'both',
      builtByVendorId: V_CONN,
    },
  ]);
  await t.db.insert(integrations).values({
    id: I_POWERED,
    name: 'Procore via Agave',
    sourceProductId: P_A,
    targetProductId: P_B,
    mechanismKind: 'iPaaS',
    poweredByProductId: P_CONNECTOR,
    builtByVendorId: V_B,
    claimedAt: CLAIMED_AT,
    maintainedBy: 'vendor',
  });
  // A claim and an attestation on the owned pair: retire must keep both.
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DATA_OBJECT, slug: 'invoice', name: 'Invoice' });
  await t.db.insert(claims).values({
    id: CLAIM,
    connectorEvidencedPairId: PAIR_OWNED,
    dataObjectId: DATA_OBJECT,
    direction: 'a_to_b',
  });
  await t.db.insert(attestations).values({ id: ATTESTATION, claimId: CLAIM, source: 'aeci' });
  await t.db.insert(profiles).values([
    ...[CONN, CONN_UNENTITLED, AUTH_A, AUTH_B, AUTH_B_UNENTITLED, STRANGER].map((auth) => ({
      id: auth.userId,
      role: 'vendor_admin' as const,
      vendorId: auth.vendorId,
    })),
    { id: ADMIN.userId, role: 'admin' as const },
  ]);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/integrations/:id/retire', createRetireIntegrationHandler(t.factory));
  a.post('/api/vendor/integrations/:id/restore', createRestoreIntegrationHandler(t.factory));
  a.post('/api/admin/integrations/:id/retire', createAdminRetireIntegrationHandler(t.factory));
  a.post('/api/admin/integrations/:id/restore', createAdminRestoreIntegrationHandler(t.factory));
  a.get('/api/admin/vendors/:id/integrations', createAdminVendorIntegrationsHandler(t.factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  a.post('/api/vendor/integrations/:id/contests', createSubmitContestHandler(t.factory));
  return a;
}

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
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit = body
    ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
    : { method };
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const retire = (auth: AuthzVariables['auth'], id: string) =>
  call(auth, `/api/vendor/integrations/${id}/retire`);
const restore = (auth: AuthzVariables['auth'], id: string) =>
  call(auth, `/api/vendor/integrations/${id}/restore`);
const adminRetire = (id: string) =>
  call(ADMIN, `/api/admin/integrations/${id}/retire`, 'POST', { reason: REASON });
const adminRestore = (id: string) =>
  call(ADMIN, `/api/admin/integrations/${id}/restore`, 'POST', { reason: REASON });

const pair = async (id: string) =>
  (await t.db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  }))!;
const countOf = async (id: string) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.integrationCount;
const auditsFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));
const tagsOf = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.flatMap((c) => (c[0] as { tags: string[] }).tags).sort();

describe('owner retire on an evidenced pair (AECI-1091)', () => {
  it('soft-retires the pair: stamps retired_at, retired_by and updated_at, keeps claims and attestations', async () => {
    const res = await retire(CONN, PAIR_OWNED);
    expect(res.status).toBe(200);
    expect(() => RetireIntegrationResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.integration).toMatchObject({ id: PAIR_OWNED, retired_by: 'owner' });
    expect(res.body.withdrawn_contest_ids).toEqual([]);

    const after = await pair(PAIR_OWNED);
    expect(after.retiredAt).toBe(res.body.integration.retired_at);
    expect(after.retiredBy).toBe('owner');
    expect(after.updatedAt).toBe(res.body.integration.updated_at);
    expect(after.updatedAt > CLAIMED_AT).toBe(true);
    // Not a delete, and nothing cascaded.
    expect(after.claimedAt).toBe(CLAIMED_AT);
    expect(await t.db.query.claims.findFirst({ where: eq(claims.id, CLAIM) })).toBeDefined();
    expect(
      await t.db.query.attestations.findFirst({ where: eq(attestations.id, ATTESTATION) }),
    ).toBeDefined();
  });

  it('audits as a connector_evidenced_pair and tells both endpoint vendors, in the batch', async () => {
    await retire(CONN, PAIR_OWNED);
    const [audit] = await auditsFor(INTEGRATION_RETIRED_ACTION);
    expect(audit).toMatchObject({
      actorId: CONN.userId,
      entityType: EVIDENCED_PAIR_ENTITY_TYPE,
      entityId: PAIR_OWNED,
    });
    expect(audit!.beforeState).toEqual({ retired_at: null, retired_by: null });
    expect(audit!.afterState).toMatchObject({ retired_by: 'owner' });
    expect(audit!.metadata).toMatchObject({
      anchor: 'evidenced_pair',
      vendorId: V_CONN,
      retiredBy: 'owner',
      connectorProductId: P_CONNECTOR,
    });

    // The owner holds neither endpoint, so both endpoint vendors are told.
    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notices.map((n) => (n.metadata as { vendorId: string }).vendorId).sort()).toEqual(
      [V_A, V_B].sort(),
    );
    expect(notices.every((n) => n.entityType === EVIDENCED_PAIR_ENTITY_TYPE)).toBe(true);
    const feed = await call(AUTH_A, '/api/vendor/notifications', 'GET');
    expect(() => ListVendorNotificationsResponseSchema.parse(feed.body)).not.toThrow();
    expect(feed.body.notifications[0]).toMatchObject({
      kind: 'integration_retire',
      event: 'retired',
      integration_id: PAIR_OWNED,
      owner_name: 'Agave',
      retired_by: 'owner',
      pair_path: '/products/procore/integrations/sage-intacct',
    });
  });

  it('recomputes THREE products, the connector included, and purges all three', async () => {
    await t.db.update(products).set({ integrationCount: 9 });
    const res = await retire(CONN, PAIR_OWNED);
    // P_A: I_POWERED + PAIR_UNCLAIMED. P_B: I_POWERED. Connector: PAIR_UNCLAIMED.
    expect(await countOf(P_A)).toBe(2);
    expect(await countOf(P_B)).toBe(1);
    expect(await countOf(P_CONNECTOR)).toBe(1);
    // Not in the batch: the product whose count this pair never touched.
    expect(await countOf(P_OTHER)).toBe(9);
    expect(tagsOf(res.send)).toEqual(
      [
        'pair:procore__sage-intacct',
        'product:procore',
        'product:sage-intacct',
        'product:agave-sync',
        'vendor:agave',
        'index:products',
        'taxonomy',
        'sitemap',
      ].sort(),
    );
  });

  it('restore clears both columns and puts the counts back', async () => {
    await retire(CONN, PAIR_OWNED);
    const res = await restore(CONN, PAIR_OWNED);
    expect(res.status).toBe(200);
    expect(res.body.integration).toMatchObject({ retired_at: null, retired_by: null });
    const after = await pair(PAIR_OWNED);
    expect(after.retiredAt).toBeNull();
    expect(after.retiredBy).toBeNull();
    expect(await countOf(P_CONNECTOR)).toBe(2);
    expect(await countOf(P_A)).toBe(3);
    const [audit] = await auditsFor(INTEGRATION_RESTORED_ACTION);
    expect(audit).toMatchObject({ entityType: EVIDENCED_PAIR_ENTITY_TYPE, entityId: PAIR_OWNED });
  });

  it('refuses, in the ladder order, without writing', async () => {
    // A stranger holds neither endpoint and does not own the row: 404.
    expect((await retire(STRANGER, PAIR_OWNED)).status).toBe(404);
    // An endpoint vendor that is not the owner: 403 NOT_OWNER.
    const notOwner = await retire(AUTH_A, PAIR_OWNED);
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.error.code).toBe('INTEGRATION_NOT_OWNER');
    // The owner with no active entitlement: 403 ENTITLEMENT_REQUIRED.
    const unentitled = await retire(CONN_UNENTITLED, PAIR_OWNED);
    expect(unentitled.status).toBe(403);
    expect(unentitled.body.error.code).toBe('INTEGRATION_ENTITLEMENT_REQUIRED');
    expect(unentitled.body.error.details).toEqual({ tier: 'unclaimed', status: null });
    // The owner of an unclaimed pair: 409 NOT_CLAIMED.
    const unclaimed = await retire(CONN, PAIR_UNCLAIMED);
    expect(unclaimed.status).toBe(409);
    expect(unclaimed.body.error.code).toBe('INTEGRATION_NOT_CLAIMED');
    // Restoring a live pair: 409 NOT_RETIRED.
    expect((await restore(CONN, PAIR_OWNED)).body.error.code).toBe('INTEGRATION_NOT_RETIRED');

    expect((await pair(PAIR_OWNED)).retiredAt).toBeNull();
    expect(await auditsFor(INTEGRATION_RETIRED_ACTION)).toHaveLength(0);
    expect(await auditsFor(NOTIFICATION_SENT_ACTION)).toHaveLength(0);
  });

  it('is idempotent by refusal: retiring a retired pair is 409 INTEGRATION_RETIRED', async () => {
    await retire(CONN, PAIR_OWNED);
    const again = await retire(CONN, PAIR_OWNED);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INTEGRATION_RETIRED');
    expect(await auditsFor(INTEGRATION_RETIRED_ACTION)).toHaveLength(1);
  });

  it('the pair batch aborts at the race sentinel when its guard matches nothing', async () => {
    // Build the batch against the live row, then let another write retire it first.
    const live = await pair(PAIR_OWNED);
    await t.db
      .update(connectorEvidencedPairs)
      .set({ retiredAt: CLAIMED_AT, retiredBy: 'aeci' })
      .where(eq(connectorEvidencedPairs.id, PAIR_OWNED));
    const batch = buildPairRetireBatch(t.db, {
      mode: 'retire',
      pair: live,
      now: '2026-09-23T00:00:00.000Z',
      actor: { actorId: CONN.userId, actorType: 'user' },
      retiredBy: 'owner',
      source: 'vendor-portal',
      metadata: {},
      guard: and(eq(connectorEvidencedPairs.builtByVendorId, V_CONN))!,
      actingVendorId: V_CONN,
      recipients: [V_A],
      owner: { id: V_CONN, name: 'Agave' },
      pairSlugs: ['procore', 'sage-intacct'],
      contests: [],
    });
    // `retireRaceSentinel`, right after the guarded UPDATE, raises on `changes() = 0`,
    // so the audit row and the notifications roll back with it.
    await expect(t.db.batch(batch.stmts as never)).rejects.toThrow(/malformed JSON|retire-race/i);
    expect(await auditsFor(INTEGRATION_RETIRED_ACTION)).toHaveLength(0);
    expect((await pair(PAIR_OWNED)).retiredBy).toBe('aeci');
  });
});

describe('contests on the pair (AECI-1091 over AECI-1092)', () => {
  const PAIR_CONTEST = uuid(40);

  async function seedPairContest(): Promise<void> {
    await t.db.insert(integrationFieldChallenges).values({
      id: PAIR_CONTEST,
      evidencedPairId: PAIR_OWNED,
      field: 'name',
      currentValue: 'Agave: Procore to Sage Intacct',
      proposedValue: 'Agave Procore Sync',
      reason: 'The listing uses the shorter name.',
      submitterVendorId: V_A,
      submittedBy: AUTH_A.userId,
      routedTo: 'owner',
      ownerVendorId: V_CONN,
    });
  }

  it('a retire closes the open contests anchored on the pair, in the same batch', async () => {
    await seedPairContest();
    const res = await retire(CONN, PAIR_OWNED);
    expect(res.status).toBe(200);
    expect(res.body.withdrawn_contest_ids).toEqual([PAIR_CONTEST]);
    const contest = await t.db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, PAIR_CONTEST),
    });
    expect(contest!.status).toBe('withdrawn');
    const [withdrawn] = await auditsFor('integration.contest.withdrawn');
    expect(withdrawn!.metadata).toMatchObject({
      integrationId: PAIR_OWNED,
      anchor: 'evidenced_pair',
      reason: 'integration retired',
    });
    // The submitter is told, on the contest notification's pair form.
    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    const toSubmitter = notices.filter((n) => (n.metadata as { kind: string }).kind === 'contest');
    expect(toSubmitter.map((n) => n.metadata)).toEqual([
      expect.objectContaining({
        vendorId: V_A,
        event: 'closed_by_retire',
        anchor: 'evidenced_pair',
        retiredBy: 'owner',
      }),
    ]);
    const [audit] = await auditsFor(INTEGRATION_RETIRED_ACTION);
    expect(audit!.metadata).toMatchObject({ withdrawnContestIds: [PAIR_CONTEST] });
  });

  it('an AECi retire closes them too', async () => {
    await seedPairContest();
    const res = await adminRetire(PAIR_OWNED);
    expect(res.body.withdrawn_contest_ids).toEqual([PAIR_CONTEST]);
  });

  it('noOpenContestsSentinel aborts a pair retire when a contest was filed after the read', async () => {
    const live = await pair(PAIR_OWNED);
    // The batch was planned with no open contest; one lands before it commits.
    const batch = buildPairRetireBatch(t.db, {
      mode: 'retire',
      pair: live,
      now: '2026-09-23T00:00:00.000Z',
      actor: { actorId: CONN.userId, actorType: 'user' },
      retiredBy: 'owner',
      source: 'vendor-portal',
      metadata: {},
      guard: eq(connectorEvidencedPairs.builtByVendorId, V_CONN),
      actingVendorId: V_CONN,
      recipients: [V_A, V_B],
      owner: { id: V_CONN, name: 'Agave' },
      pairSlugs: ['procore', 'sage-intacct'],
      contests: [],
    });
    await seedPairContest();
    await expect(t.db.batch(batch.stmts as never)).rejects.toThrow(/malformed JSON|retire-race/i);
    expect((await pair(PAIR_OWNED)).retiredAt).toBeNull();
    expect(await auditsFor(INTEGRATION_RETIRED_ACTION)).toHaveLength(0);
  });

  it('a new contest on a retired pair is refused', async () => {
    await retire(CONN, PAIR_OWNED);
    const res = await call(AUTH_A, `/api/vendor/integrations/${PAIR_OWNED}/contests`, 'POST', {
      field: 'name',
      proposed_value: 'Agave Procore Sync',
      reason: 'The listing uses the shorter name.',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
  });
});

describe('owner retire on a connector-powered integrations row (AECI-1091)', () => {
  it('lets the entitled owner retire and restore it', async () => {
    const res = await retire(AUTH_B, I_POWERED);
    expect(res.status).toBe(200);
    const row = await t.db.query.integrations.findFirst({
      where: eq(integrations.id, I_POWERED),
    });
    expect(row!.retiredBy).toBe('owner');
    const [audit] = await auditsFor(INTEGRATION_RETIRED_ACTION);
    // An `integrations` row keeps the `integration` entity type, with the carve-out
    // markers the claim and the edit write.
    expect(audit).toMatchObject({ entityType: 'integration', entityId: I_POWERED });
    expect(audit!.metadata).toMatchObject({ connectorPowered: true, anchor: 'integration' });
    // The `powered_by` product's page lists the row, so it is purged too.
    expect(tagsOf(res.send)).toContain('product:agave-sync');
    expect((await restore(AUTH_B, I_POWERED)).status).toBe(200);
  });

  it('refuses the unentitled owner with 403 INTEGRATION_ENTITLEMENT_REQUIRED', async () => {
    const res = await retire(AUTH_B_UNENTITLED, I_POWERED);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_ENTITLEMENT_REQUIRED');
    // A non-owner still gets the ownership answer, entitled or not.
    expect((await retire(AUTH_A, I_POWERED)).body.error.code).toBe('INTEGRATION_NOT_OWNER');
  });
});

describe('AECi retire on an evidenced pair (AECI-1091, ruling D)', () => {
  it('retires a vendor-held pair as aeci, notifies the owner and both endpoint vendors', async () => {
    const res = await adminRetire(PAIR_OWNED);
    expect(res.status).toBe(200);
    expect(res.body.integration.retired_by).toBe('aeci');
    expect((await pair(PAIR_OWNED)).retiredBy).toBe('aeci');
    const [audit] = await auditsFor(INTEGRATION_RETIRED_ACTION);
    expect(audit).toMatchObject({ entityType: EVIDENCED_PAIR_ENTITY_TYPE, actorId: ADMIN.userId });
    expect(audit!.metadata).toMatchObject({
      source: 'admin-moderation',
      reason: REASON,
      retiredBy: 'aeci',
      anchor: 'evidenced_pair',
    });
    const notices = await auditsFor(NOTIFICATION_SENT_ACTION);
    expect(notices.map((n) => (n.metadata as { vendorId: string }).vendorId).sort()).toEqual(
      [V_A, V_B, V_CONN].sort(),
    );
    expect(await countOf(P_CONNECTOR)).toBe(1);
    expect(tagsOf(res.send)).toContain('product:agave-sync');
  });

  it('refuses an AECi-held pair with 409 INTEGRATION_NOT_VENDOR_HELD', async () => {
    const res = await adminRetire(PAIR_UNCLAIMED);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_VENDOR_HELD');
    expect((await pair(PAIR_UNCLAIMED)).retiredAt).toBeNull();
  });

  it('the owner cannot undo an AECi retire, and AECi can', async () => {
    await adminRetire(PAIR_OWNED);
    const owner = await restore(CONN, PAIR_OWNED);
    expect(owner.status).toBe(403);
    expect(owner.body.error.code).toBe('INTEGRATION_RETIRED_BY_AECI');
    expect((await pair(PAIR_OWNED)).retiredBy).toBe('aeci');
    const admin = await adminRestore(PAIR_OWNED);
    expect(admin.status).toBe(200);
    expect((await pair(PAIR_OWNED)).retiredAt).toBeNull();
  });

  it('AECi cannot undo an owner retire', async () => {
    await retire(CONN, PAIR_OWNED);
    const res = await adminRestore(PAIR_OWNED);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED_BY_OWNER');
    expect((await pair(PAIR_OWNED)).retiredBy).toBe('owner');
  });

  it('lists the vendor-held pairs a vendor owns, live and retired, beside its integrations', async () => {
    await adminRetire(PAIR_OWNED);
    const res = await call(ADMIN, `/api/admin/vendors/${V_CONN}/integrations`, 'GET');
    expect(res.status).toBe(200);
    // PAIR_UNCLAIMED is AECi-held, so it is not listed.
    expect(res.body.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      id: PAIR_OWNED,
      anchor: 'evidenced_pair',
      source: { slug: 'procore' },
      target: { slug: 'sage-intacct' },
      connector: { slug: 'agave-sync' },
      retired_by: 'aeci',
      pair_path: '/products/procore/integrations/sage-intacct',
    });
    const b = await call(ADMIN, `/api/admin/vendors/${V_B}/integrations`, 'GET');
    expect(b.body.data.map((r: JsonBody) => [r.id, r.anchor])).toEqual([
      [I_POWERED, 'integration'],
    ]);
  });
});
