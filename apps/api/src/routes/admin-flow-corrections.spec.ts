/**
 * AECi corrects one data flow on a claimed Sync Service pair (AECI-2139,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §14.10).
 *
 * The gate refusal by refusal, the batch contents (the correction row, the audit rows,
 * the owner's notice, the purge), the two redirect shapes, the lift, the races, the
 * owner's refusals, and every public reader of the §14.10 table: a corrected flow shows
 * nowhere public, and the rest of the integration stays listed.
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction.
 */

import { ApiErrorCode } from '@aeci/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
  claimAeciCorrections,
  claimOwnerAnswers,
  claims,
  connectorEvidencedPairs,
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
import type { DbFactory } from '../lib/handler-utils';
import { buildOwnershipRecordV2 } from '../lib/ownership-sync';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminFlowsHandler,
  createAdminVendorFlowCorrectionsHandler,
  createCorrectFlowHandler,
  createLiftFlowCorrectionHandler,
} from './admin-flow-corrections';
import {
  createPairAlternativesHandler,
  createPairTimelineHandler,
  createProductPairHandler,
} from './integrations';
import { createProductDetailHandler } from './products';
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import { createListVendorNotificationsHandler } from './vendor-notifications';
import {
  createAddOwnerFlowHandler,
  createChangeOwnerFlowHandler,
  createClearOwnerFlowAnswerHandler,
  createSetOwnerFlowAnswerHandler,
  planOwnerFlowChange,
} from './vendor-owner-flows';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A holds P_A, B holds P_B. C is the Sync Service vendor and owns every row.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);

const P_A = uuid(10);
const P_B = uuid(11);
const P_SS_1 = uuid(13);
const P_SS_2 = uuid(14);
const P_SS_3 = uuid(15);
const P_SS_4 = uuid(16);
const P_PLATFORM = uuid(17);
const P_SS_I = uuid(18);

const E_SS = uuid(30); // Sync Service, claimed by C
const E_SS_UNCLAIMED = uuid(31);
const E_SS_RETIRED = uuid(32);
const E_SS_VETOED = uuid(33);
const E_PLATFORM = uuid(34);
const I_SS = uuid(40); // `integrations`, powered by a Sync Service, claimed by C

const DO_RFIS = uuid(50);
const DO_INVOICES = uuid(51);
const CLAIM_RFIS = uuid(60); // AECi's RFIs a_to_b on E_SS
const CLAIM_INVOICES = uuid(61); // AECi's Invoices both on E_SS: the rest of the row
const CLAIM_UNCLAIMED = uuid(62);
const CLAIM_RETIRED = uuid(63);
const CLAIM_VETOED = uuid(64);
const CLAIM_PLATFORM = uuid(65);
const CLAIM_I = uuid(66); // RFIs a_to_b on I_SS

const CLAIMED_AT = '2026-09-01T00:00:00.000Z';
const SOURCE = 'https://rivets.example/docs/procore-acumatica';
const REASON = 'The Sync Service page lists no RFI sync between these two.';
const NOTE = 'Checked on 2026-11-26.';

type Auth = AuthzVariables['auth'];
const ADMIN: Auth = {
  userId: uuid(90),
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};
const AUTH_C = {
  userId: uuid(103),
  email: 'seat3@example.test',
  role: 'vendor_admin',
  vendorId: VENDOR_C,
  entitlementTier: 'unclaimed',
  entitlement: null,
} as Auth;
const AUTH_A = { ...AUTH_C, userId: uuid(101), vendorId: VENDOR_A } as Auth;

let t: TestDb;
let factory: DbFactory;

beforeEach(async () => {
  t = await makeTestDb();
  factory = t.factory;
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'procore-co', companyName: 'Procore', verified: true },
    { id: VENDOR_B, slug: 'acumatica-co', companyName: 'Acumatica' },
    { id: VENDOR_C, slug: 'rivets', companyName: 'Rivets' },
  ]);
  const ss = { productRole: 'connector', connectorKind: 'sync_service' } as const;
  await t.db.insert(products).values([
    { id: P_A, slug: 'procore', name: 'Procore' },
    { id: P_B, slug: 'acumatica', name: 'Acumatica' },
    { id: P_SS_1, slug: 'rivets-sync', name: 'Rivets Sync', ...ss },
    { id: P_SS_2, slug: 'rivets-sync-2', name: 'Rivets Sync 2', ...ss },
    { id: P_SS_3, slug: 'rivets-sync-3', name: 'Rivets Sync 3', ...ss },
    { id: P_SS_4, slug: 'rivets-sync-4', name: 'Rivets Sync 4', ...ss },
    {
      id: P_PLATFORM,
      slug: 'zapier',
      name: 'Zapier',
      productRole: 'connector',
      connectorKind: 'integration_platform',
    },
    { id: P_SS_I, slug: 'rivets-sync-i', name: 'Rivets Sync I', ...ss },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_B, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_SS_1, vendorId: VENDOR_C, isPrimary: true },
  ]);
  const pair = { productAId: P_A, productBId: P_B, builtByVendorId: VENDOR_C };
  await t.db.insert(connectorEvidencedPairs).values([
    { id: E_SS, ...pair, connectorProductId: P_SS_1, claimedAt: CLAIMED_AT, direction: 'both' },
    { id: E_SS_UNCLAIMED, ...pair, connectorProductId: P_SS_2 },
    {
      id: E_SS_RETIRED,
      ...pair,
      connectorProductId: P_SS_3,
      claimedAt: CLAIMED_AT,
      retiredAt: CLAIMED_AT,
      retiredBy: 'owner',
    },
    {
      id: E_SS_VETOED,
      ...pair,
      connectorProductId: P_SS_4,
      claimedAt: CLAIMED_AT,
      vetoedAt: CLAIMED_AT,
    },
    { id: E_PLATFORM, ...pair, connectorProductId: P_PLATFORM, claimedAt: CLAIMED_AT },
  ]);
  await t.db.insert(integrations).values({
    id: I_SS,
    sourceProductId: P_A,
    targetProductId: P_B,
    builtByVendorId: VENDOR_C,
    name: 'Procore to Acumatica',
    mechanismKind: 'iPaaS',
    poweredByProductId: P_SS_I,
    claimedAt: CLAIMED_AT,
  });
  await t.db.insert(taxonomyDataObjects).values([
    { id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1 },
    { id: DO_INVOICES, slug: 'invoices', name: 'Invoices', displayOrder: 2 },
  ]);
  const seed = (id: string, anchor: Record<string, string>, dataObjectId = DO_RFIS) => ({
    id,
    ...anchor,
    dataObjectId,
    direction: 'a_to_b',
  });
  await t.db.insert(claims).values([
    seed(CLAIM_RFIS, { connectorEvidencedPairId: E_SS }),
    {
      ...seed(CLAIM_INVOICES, { connectorEvidencedPairId: E_SS }, DO_INVOICES),
      direction: 'both',
    },
    seed(CLAIM_UNCLAIMED, { connectorEvidencedPairId: E_SS_UNCLAIMED }),
    seed(CLAIM_RETIRED, { connectorEvidencedPairId: E_SS_RETIRED }),
    seed(CLAIM_VETOED, { connectorEvidencedPairId: E_SS_VETOED }),
    seed(CLAIM_PLATFORM, { connectorEvidencedPairId: E_PLATFORM }),
    seed(CLAIM_I, { integrationId: I_SS }),
  ]);
  await t.db
    .insert(attestations)
    .values(
      [
        CLAIM_RFIS,
        CLAIM_INVOICES,
        CLAIM_UNCLAIMED,
        CLAIM_RETIRED,
        CLAIM_VETOED,
        CLAIM_PLATFORM,
        CLAIM_I,
      ].map((claimId, i) => ({ id: uuid(70 + i), claimId, source: 'aeci' })),
    );
  await t.db.insert(profiles).values([
    { id: ADMIN.userId, role: 'admin' },
    { id: AUTH_C.userId, role: 'vendor_admin', vendorId: VENDOR_C },
    { id: AUTH_A.userId, role: 'vendor_admin', vendorId: VENDOR_A },
  ]);
});
afterEach(() => t.dispose());

function app(auth: Auth) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/admin/flows/:claimId/correction', createCorrectFlowHandler(factory));
  a.post('/api/admin/flow-corrections/:id/lift', createLiftFlowCorrectionHandler(factory));
  a.get('/api/admin/flows', createAdminFlowsHandler(factory));
  a.get(
    '/api/admin/vendors/:id/flow-corrections',
    createAdminVendorFlowCorrectionsHandler(factory),
  );
  a.post('/api/vendor/owned-integrations/:id/flows', createAddOwnerFlowHandler(factory));
  a.put('/api/vendor/owned-flows/:claimId/answer', createSetOwnerFlowAnswerHandler(factory));
  a.delete('/api/vendor/owned-flows/:claimId/answer', createClearOwnerFlowAnswerHandler(factory));
  a.patch('/api/vendor/owned-flows/:claimId', createChangeOwnerFlowHandler(factory));
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(factory));
  a.get('/api/products/:slug/integrations/:otherSlug', createProductPairHandler(factory));
  a.get('/api/products/:slug/integrations/:otherSlug/timeline', createPairTimelineHandler(factory));
  a.get(
    '/api/products/:slug/integrations/:otherSlug/alternatives',
    createPairAlternativesHandler(factory),
  );
  a.get('/api/products/:slug', createProductDetailHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app(auth).request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    },
    env,
    execCtx,
  );
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as JsonBody, send };
}

const remove = (claimId: string, extra: Record<string, unknown> = {}) =>
  call(ADMIN, `/api/admin/flows/${claimId}/correction`, 'POST', {
    action: 'remove',
    sourceUrl: SOURCE,
    reason: REASON,
    internalNote: NOTE,
    ...extra,
  });
const redirect = (claimId: string, direction: string) =>
  call(ADMIN, `/api/admin/flows/${claimId}/correction`, 'POST', {
    action: 'redirect',
    direction,
    sourceUrl: SOURCE,
    reason: REASON,
  });
const answer = (claimId: string, asserted: boolean) =>
  call(AUTH_C, `/api/vendor/owned-flows/${claimId}/answer`, 'PUT', { asserted });
const pairPage = async () =>
  (await call(AUTH_A, '/api/products/procore/integrations/acumatica', 'GET')).body;
const evidencedCard = (body: JsonBody) =>
  (body.mechanisms as JsonBody[]).find((m) => m.id === E_SS) as JsonBody;
const flowsOn = (card: JsonBody) =>
  (card.claims as JsonBody[]).map((c) => `${c.data_object_slug}:${c.direction}`).sort();

describe('the gate', () => {
  const REFUSALS: ReadonlyArray<[string, string, number, string]> = [
    ['an unknown claim', uuid(999), 404, ApiErrorCode.NOT_FOUND],
    [
      'an Integration platform pair',
      CLAIM_PLATFORM,
      403,
      ApiErrorCode.FLOW_CORRECTION_NOT_AVAILABLE,
    ],
    ['an unclaimed pair', CLAIM_UNCLAIMED, 409, ApiErrorCode.INTEGRATION_NOT_CLAIMED],
    ['a retired pair', CLAIM_RETIRED, 409, ApiErrorCode.INTEGRATION_RETIRED],
    ['a vetoed pair', CLAIM_VETOED, 409, ApiErrorCode.INTEGRATION_VETOED],
  ];
  it.each(REFUSALS)('refuses %s', async (_label, claimId, status, code) => {
    const res = await remove(claimId);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(await t.db.select().from(claimAeciCorrections)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses a second correction of a corrected flow', async () => {
    expect((await remove(CLAIM_RFIS)).status).toBe(201);
    const res = await remove(CLAIM_RFIS);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.FLOW_ALREADY_CORRECTED);
  });

  it('refuses a redirect to the current direction, and a body that breaks the schema', async () => {
    const same = await redirect(CLAIM_RFIS, 'a_to_b');
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe(ApiErrorCode.FLOW_NO_CHANGE);
    const noDirection = await call(ADMIN, `/api/admin/flows/${CLAIM_RFIS}/correction`, 'POST', {
      action: 'redirect',
      sourceUrl: SOURCE,
      reason: REASON,
    });
    expect(noDirection.status).toBe(400);
    const http = await remove(CLAIM_RFIS, { sourceUrl: 'http://rivets.example/docs' });
    expect(http.status).toBe(400);
    const noReason = await remove(CLAIM_RFIS, { reason: '   ' });
    expect(noReason.status).toBe(400);
    expect(await t.db.select().from(claimAeciCorrections)).toHaveLength(0);
  });

  it('refuses a redirect onto a direction the owner removed', async () => {
    const other = uuid(67);
    await t.db.insert(claims).values({
      id: other,
      connectorEvidencedPairId: E_SS,
      dataObjectId: DO_RFIS,
      direction: 'b_to_a',
    });
    await t.db.insert(attestations).values({ id: uuid(80), claimId: other, source: 'aeci' });
    expect((await answer(other, false)).status).toBe(200);
    const res = await redirect(CLAIM_RFIS, 'b_to_a');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.FLOW_DIRECTION_REMOVED_BY_OWNER);
  });
});

describe('a removal', () => {
  it('writes the correction, its audit rows and the owner notice in one batch, and purges four tags', async () => {
    const before = await t.db.query.connectorEvidencedPairs.findFirst({
      where: eq(connectorEvidencedPairs.id, E_SS),
    });
    const res = await remove(CLAIM_RFIS);
    expect(res.status).toBe(201);
    expect(res.body.correction).toMatchObject({
      claim_id: CLAIM_RFIS,
      replacement_claim_id: null,
      anchor_id: E_SS,
      anchor: 'evidenced_pair',
      data_object_slug: 'rfis',
      direction: 'a_to_b',
      replacement_direction: null,
      source_url: SOURCE,
      reason: REASON,
      internal_note: NOTE,
      created_by: ADMIN.userId,
      retracted_at: null,
    });
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action).sort()).toEqual(
      ['claim_aeci_correction.created', NOTIFICATION_SENT_ACTION].sort(),
    );
    expect(audits.every((a) => a.vendorId === VENDOR_C)).toBe(true);
    const created = audits.find((a) => a.action === 'claim_aeci_correction.created');
    expect(created).toMatchObject({ entityType: 'claim_aeci_correction', actorType: 'admin' });
    expect(created?.metadata).toMatchObject({
      source: 'admin-moderation',
      sourceUrl: SOURCE,
      reason: REASON,
      reasonVisibility: 'vendor',
      internalNote: NOTE,
    });
    const notice = audits.find((a) => a.action === NOTIFICATION_SENT_ACTION);
    expect(notice?.metadata).toMatchObject({
      notificationId: 'portal-flow-corrected-by-aeci',
      event: 'flow_corrected',
      vendorId: VENDOR_C,
      dataObjectName: 'RFIs',
      sourceUrl: SOURCE,
      flowRedirected: false,
    });
    // The note is never on the owner's notice.
    expect(JSON.stringify(notice?.metadata)).not.toContain(NOTE);
    expect(res.send).toHaveBeenCalledWith({
      tags: [
        'pair:acumatica__procore',
        'product:procore',
        'product:acumatica',
        'product:rivets-sync',
      ],
      source: 'moderation',
    });
    // `updated_at` moves the owner's cursor. The "Maintained by" stamp is the owner's.
    const after = await t.db.query.connectorEvidencedPairs.findFirst({
      where: eq(connectorEvidencedPairs.id, E_SS),
    });
    expect(after?.updatedAt).not.toBe(before?.updatedAt);
    expect(after?.vendorEditedAt).toBe(before?.vendorEditedAt);
    // `claims.direction` is never rewritten, and no claim is deleted.
    expect(await t.db.select().from(claims).where(eq(claims.id, CLAIM_RFIS))).toEqual([
      expect.objectContaining({ direction: 'a_to_b' }),
    ]);
  });

  it('takes the flow off the pair page, and the rest of the integration stays listed', async () => {
    expect(flowsOn(evidencedCard(await pairPage()))).toEqual(['invoices:both', 'rfis:outbound']);
    await remove(CLAIM_RFIS);
    const card = evidencedCard(await pairPage());
    expect(flowsOn(card)).toEqual(['invoices:both']);
    // The caption names no data type (P10a).
    expect(card.corrections).toEqual([
      expect.objectContaining({ field: 'data_flow', source_url: SOURCE, cleared: true }),
    ]);
  });

  it("beats the owner's Yes, on either anchor table", async () => {
    expect((await answer(CLAIM_I, true)).status).toBe(200);
    expect((await remove(CLAIM_I)).status).toBe(201);
    const body = await pairPage();
    const card = (body.mechanisms as JsonBody[]).find((m) => m.id === I_SS) as JsonBody;
    expect(card.claims).toEqual([]);
  });

  it('every other public reader drops the corrected flow', async () => {
    // Invoices moves on E_SS alone, so once it is corrected no row names it.
    await t.db
      .insert(products)
      .values({ id: uuid(20), slug: 'buildertrend', name: 'Buildertrend' });
    await remove(CLAIM_INVOICES);

    const hub = (await call(AUTH_A, '/api/products/rivets-sync', 'GET')).body;
    const hubRow = (hub.integrations_as_connector as JsonBody[]).find((r) => r.id === E_SS);
    expect(hubRow?.data_object_slugs).toEqual(['rfis']);
    const syncs = (hub.what_it_syncs.objects as JsonBody[]).map((o) => o.slug);
    expect(syncs).toEqual(['rfis']);

    const page = (await call(AUTH_A, '/api/products/procore', 'GET')).body;
    const rows = [...page.integrations_as_source, ...page.integrations_as_target] as JsonBody[];
    expect(rows.find((r) => r.id === E_SS)?.data_object_slugs).toEqual(['rfis']);

    const lanes = (
      await call(AUTH_A, '/api/products/procore/integrations/buildertrend/alternatives', 'GET')
    ).body;
    const moving = (lanes.moving.context_only as JsonBody[]).map((o) => o.slug);
    expect(moving).toContain('rfis');
    expect(moving).not.toContain('invoices');

    // The timeline opens: VENDOR_A is verified in the fixture (§9.3).
    const timeline = (
      await call(AUTH_A, '/api/products/procore/integrations/acumatica/timeline', 'GET')
    ).body;
    const ids = (timeline.claims as JsonBody[]).map((c) => c.claim_id);
    expect(ids).not.toContain(CLAIM_INVOICES);
    expect(ids).toContain(CLAIM_RFIS);
  });

  it('the owner reads it on its flows panel, its integrations list and its record', async () => {
    await remove(CLAIM_RFIS);
    const owned = (await call(AUTH_C, '/api/vendor/integrations', 'GET')).body;
    const row = (owned.owned as JsonBody[]).find((r) => r.id === E_SS);
    const flow = (row?.flows as JsonBody[]).find((f) => f.id === CLAIM_RFIS);
    expect(flow).toMatchObject({
      public: false,
      aeci_correction: { reason: REASON, source_url: SOURCE, created_at: expect.any(String) },
    });
    expect(JSON.stringify(flow)).not.toContain(NOTE);

    const record = await buildOwnershipRecordV2(t.db, VENDOR_C, 'vendor_edit');
    const pair = record?.deliveredPairs?.find((p) => p.id === E_SS);
    expect(pair?.ownerFlows).toEqual([
      { dataObject: 'invoices', direction: 'both', origin: 'aeci', answer: null },
      {
        dataObject: 'rfis',
        direction: 'a_to_b',
        origin: 'aeci',
        answer: null,
        aeciCorrected: true,
      },
    ]);

    const notices = (await call(AUTH_C, '/api/vendor/notifications', 'GET')).body;
    expect(notices.notifications).toEqual([
      expect.objectContaining({
        kind: 'aeci_override',
        event: 'flow_corrected',
        reason: REASON,
        data_object_name: 'RFIs',
        source_url: SOURCE,
      }),
    ]);
  });

  it('the endpoint vendor reads the flow as removed by AECi', async () => {
    await remove(CLAIM_I);
    const body = (await call(AUTH_A, '/api/vendor/integrations', 'GET')).body;
    const entry = (body.integrations as JsonBody[]).find((r) => r.id === I_SS);
    const claim = (entry?.claims as JsonBody[]).find((c) => c.id === CLAIM_I);
    expect(claim?.aeci_corrected).toBe(true);
  });

  it('lists in the admin reads', async () => {
    await remove(CLAIM_RFIS);
    const flows = (await call(ADMIN, `/api/admin/flows?pairId=${E_SS}`, 'GET')).body;
    expect(flows).toMatchObject({ anchor: 'evidenced_pair', blocked: null });
    expect(
      (flows.flows as JsonBody[]).map((f) => [f.data_object_slug, f.public, !!f.correction]),
    ).toEqual([
      ['rfis', false, true],
      ['invoices', true, false],
    ]);
    const list = (await call(ADMIN, `/api/admin/vendors/${VENDOR_C}/flow-corrections`, 'GET')).body;
    expect((list.corrections as JsonBody[]).map((c) => c.claim_id)).toEqual([CLAIM_RFIS]);
    const blocked = (await call(ADMIN, `/api/admin/flows?pairId=${E_SS_UNCLAIMED}`, 'GET')).body;
    expect(blocked.blocked).toBe('not_claimed');
    expect((await call(ADMIN, '/api/admin/flows', 'GET')).status).toBe(400);
  });
});

describe('a direction correction', () => {
  it('lists a new AECi flow the right way, removes the old one, and tells the owner', async () => {
    const res = await redirect(CLAIM_RFIS, 'b_to_a');
    expect(res.status).toBe(201);
    const replacement = res.body.correction.replacement_claim_id as string;
    expect(res.body.correction.replacement_direction).toBe('b_to_a');
    const row = await t.db.query.claims.findFirst({ where: eq(claims.id, replacement) });
    expect(row).toMatchObject({ origin: 'aeci', createdByVendorId: null, direction: 'b_to_a' });
    expect(flowsOn(evidencedCard(await pairPage()))).toEqual(['invoices:both', 'rfis:inbound']);
    expect(evidencedCard(await pairPage()).corrections).toEqual([
      expect.objectContaining({ field: 'data_flow', cleared: false }),
    ]);
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(
      ['claim.created', 'claim_aeci_correction.created', NOTIFICATION_SENT_ACTION].sort(),
    );
  });

  it('reuses a public claim in that direction, and backs an unbacked one', async () => {
    const vendorMade = uuid(68);
    await t.db.insert(claims).values({
      id: vendorMade,
      connectorEvidencedPairId: E_SS,
      dataObjectId: DO_RFIS,
      direction: 'b_to_a',
      origin: 'vendor',
      createdByVendorId: VENDOR_C,
    });
    // Nobody stands behind it, so the pair page withholds it.
    expect(flowsOn(evidencedCard(await pairPage()))).not.toContain('rfis:inbound');
    const res = await redirect(CLAIM_RFIS, 'b_to_a');
    expect(res.status).toBe(201);
    expect(res.body.correction.replacement_claim_id).toBe(vendorMade);
    // No new claim: the six seeded RFIs claims and the vendor's one.
    expect(await t.db.select().from(claims).where(eq(claims.dataObjectId, DO_RFIS))).toHaveLength(
      7,
    );
    const live = await t.db
      .select()
      .from(attestations)
      .where(and(eq(attestations.claimId, vendorMade), isNull(attestations.retractedAt)));
    expect(live).toEqual([expect.objectContaining({ source: 'aeci', asserted: true })]);
    expect(flowsOn(evidencedCard(await pairPage()))).toEqual(['invoices:both', 'rfis:inbound']);
  });

  it('the owner may still answer the replacement', async () => {
    const res = await redirect(CLAIM_RFIS, 'both');
    const replacement = res.body.correction.replacement_claim_id as string;
    expect((await answer(replacement, true)).status).toBe(200);
    expect((await answer(replacement, false)).status).toBe(200);
    expect(flowsOn(evidencedCard(await pairPage()))).toEqual(['invoices:both']);
  });
});

describe('the owner cannot undo it', () => {
  beforeEach(async () => {
    expect((await remove(CLAIM_RFIS)).status).toBe(201);
  });
  const refused = (res: { status: number; body: JsonBody }) => {
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.FLOW_CORRECTED_BY_AECI);
  };

  it('refuses set, clear, direction change and an add on the identity, and writes nothing', async () => {
    const audits = (await t.db.select().from(auditLog)).length;
    refused(await answer(CLAIM_RFIS, true));
    refused(await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_RFIS}/answer`, 'DELETE'));
    refused(
      await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_RFIS}`, 'PATCH', { direction: 'both' }),
    );
    refused(
      await call(AUTH_C, `/api/vendor/owned-integrations/${E_SS}/flows`, 'POST', {
        data_object: 'rfis',
        direction: 'outbound',
      }),
    );
    // A direction change elsewhere that would land on the corrected identity.
    refused(
      await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_INVOICES}`, 'PATCH', {
        direction: 'outbound',
      }).then(async () => answer(CLAIM_RFIS, true)),
    );
    expect(
      await t.db.select().from(claimOwnerAnswers).where(eq(claimOwnerAnswers.claimId, CLAIM_RFIS)),
    ).toEqual([]);
    expect((await t.db.select().from(auditLog)).length).toBeGreaterThanOrEqual(audits);
  });

  it('refuses a data flow report accept through planOwnerFlowChange', async () => {
    const target = {
      anchor: 'evidenced_pair' as const,
      id: E_SS,
      name: null,
      productAId: P_A,
      productBId: P_B,
      connectorProductId: P_SS_1,
      builtByVendorId: VENDOR_C,
      claimedAt: CLAIMED_AT,
    };
    await expect(
      planOwnerFlowChange(t.db, { id: CLAIM_RFIS, dataObjectId: DO_RFIS, target }, null),
    ).rejects.toMatchObject({ code: ApiErrorCode.FLOW_CORRECTED_BY_AECI });
    // Moving another flow onto the corrected identity is refused too.
    const other = uuid(69);
    await t.db.insert(claims).values({
      id: other,
      connectorEvidencedPairId: E_SS,
      dataObjectId: DO_RFIS,
      direction: 'b_to_a',
    });
    await expect(
      planOwnerFlowChange(t.db, { id: other, dataObjectId: DO_RFIS, target }, 'a_to_b'),
    ).rejects.toMatchObject({ code: ApiErrorCode.FLOW_CORRECTED_BY_AECI });
  });
});

describe('the races', () => {
  /** A factory whose next `db.batch` runs `before` first, as a write racing the request. */
  const racing = (before: () => Promise<unknown>): DbFactory => {
    let armed = true;
    return (env) => {
      const handle = t.factory(env);
      const batch = handle.db.batch.bind(handle.db);
      handle.db.batch = (async (stmts: Parameters<typeof batch>[0]) => {
        if (armed) {
          armed = false;
          await before();
        }
        return batch(stmts);
      }) as unknown as typeof handle.db.batch;
      return handle;
    };
  };

  it('a correction landing after the owner read aborts the owner write', async () => {
    factory = racing(() =>
      t.db.insert(claimAeciCorrections).values({
        id: uuid(500),
        claimId: CLAIM_RFIS,
        reason: REASON,
        sourceUrl: SOURCE,
      }),
    );
    const res = await answer(CLAIM_RFIS, true);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.FLOW_CORRECTED_BY_AECI);
    expect(await t.db.select().from(claimOwnerAnswers)).toEqual([]);
  });

  it('a second correction landing first trips the live index', async () => {
    factory = racing(() =>
      t.db.insert(claimAeciCorrections).values({
        id: uuid(501),
        claimId: CLAIM_RFIS,
        reason: REASON,
        sourceUrl: SOURCE,
      }),
    );
    const res = await remove(CLAIM_RFIS);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.FLOW_ALREADY_CORRECTED);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('a handback landing first stops the correction at the row sentinel', async () => {
    factory = racing(() =>
      t.db
        .update(connectorEvidencedPairs)
        .set({ claimedAt: null })
        .where(eq(connectorEvidencedPairs.id, E_SS)),
    );
    const res = await remove(CLAIM_RFIS);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.INTEGRATION_NOT_CLAIMED);
    expect(await t.db.select().from(claimAeciCorrections)).toEqual([]);
  });
});

describe('the lift', () => {
  it('ends the correction, tells the owner, and the flow follows its owner answer again', async () => {
    const created = await remove(CLAIM_RFIS);
    const id = created.body.correction.id as string;
    const res = await call(ADMIN, `/api/admin/flow-corrections/${id}/lift`, 'POST', {
      reason: 'We read the wrong page.',
    });
    expect(res.status).toBe(200);
    expect(res.body.correction).toMatchObject({
      retracted_by: ADMIN.userId,
      retracted_reason: 'We read the wrong page.',
    });
    expect(res.body.correction.retracted_at).not.toBeNull();
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ source: 'moderation' }));
    expect(flowsOn(evidencedCard(await pairPage()))).toEqual(['invoices:both', 'rfis:outbound']);
    expect(evidencedCard(await pairPage()).corrections ?? []).toEqual([]);
    const lifted = (await t.db.select().from(auditLog)).filter((a) =>
      ['claim_aeci_correction.retracted', NOTIFICATION_SENT_ACTION].includes(a.action),
    );
    expect(lifted.map((a) => a.action).sort()).toEqual(
      [
        'claim_aeci_correction.retracted',
        NOTIFICATION_SENT_ACTION,
        NOTIFICATION_SENT_ACTION,
      ].sort(),
    );
    // The owner can answer it again.
    expect((await answer(CLAIM_RFIS, false)).status).toBe(200);
    expect(flowsOn(evidencedCard(await pairPage()))).toEqual(['invoices:both']);

    const again = await call(ADMIN, `/api/admin/flow-corrections/${id}/lift`, 'POST', {
      reason: 'Twice.',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe(ApiErrorCode.FLOW_CORRECTION_LIFTED);
    const missing = await call(ADMIN, `/api/admin/flow-corrections/${uuid(998)}/lift`, 'POST', {
      reason: 'None.',
    });
    expect(missing.status).toBe(404);
  });

  it('keeps a replacement as a public AECi flow', async () => {
    const created = await redirect(CLAIM_RFIS, 'b_to_a');
    await call(ADMIN, `/api/admin/flow-corrections/${created.body.correction.id}/lift`, 'POST', {
      reason: 'Both directions turn out to be listed.',
    });
    expect(flowsOn(evidencedCard(await pairPage()))).toEqual([
      'invoices:both',
      'rfis:inbound',
      'rfis:outbound',
    ]);
  });
});
