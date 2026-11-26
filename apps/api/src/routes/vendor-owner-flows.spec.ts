/**
 * The owner of a Sync Service pair maintains its data flows (AECI-2039,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §14.10).
 *
 * The authority rule cell by cell: owner / endpoint vendor / stranger × Sync Service /
 * Integration platform / blank kind × claimed / unclaimed × both anchor tables. Then
 * the write mechanics (one batch, audit rows, purge tags, notifications), and the path
 * "claim, confirm a flow, read it on the pair page".
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction.
 */

import { ApiErrorCode } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
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
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { buildOwnershipRecordV2 } from '../lib/ownership-sync';
import {
  createPairAlternativesHandler,
  createPairTimelineHandler,
  createProductPairHandler,
} from './integrations';
import { createProductDetailHandler } from './products';
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import {
  createAddOwnerFlowHandler,
  createChangeOwnerFlowHandler,
  buildOwnerFlowHistory,
  createClearOwnerFlowAnswerHandler,
  createOwnerFlowHistoryHandler,
  createSetOwnerFlowAnswerHandler,
} from './vendor-owner-flows';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A holds P_A, B holds P_B (the endpoint vendors). C is the Sync Service vendor and
// owns every row. E holds nothing anywhere.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);
const VENDOR_E = uuid(5);

const P_A = uuid(10);
const P_B = uuid(11);
// One connector product per pair row, so `(connector, a, b)` stays unique.
const P_SS_1 = uuid(13);
const P_SS_2 = uuid(14);
const P_SS_3 = uuid(15);
const P_PLATFORM = uuid(16);
const P_BLANK = uuid(17);
const P_SS_I = uuid(18);
const P_PLATFORM_I = uuid(19);

// `connector_evidenced_pairs`
const E_SS = uuid(30); // Sync Service, claimed by C
const E_SS_UNCLAIMED = uuid(31);
const E_SS_RETIRED = uuid(32);
const E_PLATFORM = uuid(33); // Integration platform, claimed
const E_BLANK = uuid(34); // connector kind NULL, claimed
// `integrations`
const I_SS = uuid(40); // powered by a Sync Service, claimed by C
const I_SS_UNCLAIMED = uuid(41);
const I_PLATFORM = uuid(42);
const I_DIRECT = uuid(43); // no connector, claimed by C

const DO_RFIS = uuid(50);
const DO_INVOICES = uuid(51);
const CLAIM_SEED = uuid(60); // AECi's RFIs a_to_b on E_SS
const CLAIM_SEED_I = uuid(61); // AECi's RFIs a_to_b on I_SS
const CLAIM_PLATFORM = uuid(62); // on E_PLATFORM

const CLAIMED_AT = '2026-09-01T00:00:00.000Z';

type Auth = AuthzVariables['auth'];
const NONE = { entitlementTier: 'unclaimed', entitlement: null };
const seat = (n: number, vendorId: string): Auth =>
  ({
    userId: uuid(100 + n),
    email: `seat${n}@example.test`,
    role: 'vendor_admin',
    vendorId,
    ...NONE,
  }) as Auth;
const AUTH_A = seat(1, VENDOR_A);
const AUTH_C = seat(3, VENDOR_C);
const AUTH_E = seat(5, VENDOR_E);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'procore-co', companyName: 'Procore' },
    { id: VENDOR_B, slug: 'acumatica-co', companyName: 'Acumatica' },
    { id: VENDOR_C, slug: 'rivets', companyName: 'Rivets' },
    { id: VENDOR_E, slug: 'elsewhere', companyName: 'Elsewhere' },
  ]);
  const ss = { productRole: 'connector', connectorKind: 'sync_service' } as const;
  await t.db.insert(products).values([
    { id: P_A, slug: 'procore', name: 'Procore' },
    { id: P_B, slug: 'acumatica', name: 'Acumatica' },
    { id: P_SS_1, slug: 'rivets-sync', name: 'Rivets Sync', ...ss },
    { id: P_SS_2, slug: 'rivets-sync-2', name: 'Rivets Sync 2', ...ss },
    { id: P_SS_3, slug: 'rivets-sync-3', name: 'Rivets Sync 3', ...ss },
    {
      id: P_PLATFORM,
      slug: 'zapier',
      name: 'Zapier',
      productRole: 'connector',
      connectorKind: 'integration_platform',
    },
    { id: P_BLANK, slug: 'appxchange', name: 'AppXchange', productRole: 'connector' },
    { id: P_SS_I, slug: 'rivets-sync-i', name: 'Rivets Sync I', ...ss },
    {
      id: P_PLATFORM_I,
      slug: 'workato',
      name: 'Workato',
      productRole: 'connector',
      connectorKind: 'integration_platform',
    },
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
    { id: E_PLATFORM, ...pair, connectorProductId: P_PLATFORM, claimedAt: CLAIMED_AT },
    { id: E_BLANK, ...pair, connectorProductId: P_BLANK, claimedAt: CLAIMED_AT },
  ]);
  const row = { sourceProductId: P_A, targetProductId: P_B, builtByVendorId: VENDOR_C };
  await t.db.insert(integrations).values([
    {
      id: I_SS,
      ...row,
      name: 'Procore to Acumatica',
      mechanismKind: 'iPaaS',
      poweredByProductId: P_SS_I,
      claimedAt: CLAIMED_AT,
    },
    {
      id: I_SS_UNCLAIMED,
      ...row,
      name: 'Unclaimed',
      mechanismKind: 'iPaaS',
      poweredByProductId: P_SS_I,
    },
    {
      id: I_PLATFORM,
      ...row,
      name: 'Platform',
      mechanismKind: 'iPaaS',
      poweredByProductId: P_PLATFORM_I,
      claimedAt: CLAIMED_AT,
    },
    { id: I_DIRECT, ...row, name: 'Direct', mechanismKind: 'api', claimedAt: CLAIMED_AT },
  ]);
  await t.db.insert(taxonomyDataObjects).values([
    { id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1 },
    { id: DO_INVOICES, slug: 'invoices', name: 'Invoices', displayOrder: 2 },
  ]);
  await t.db.insert(claims).values([
    { id: CLAIM_SEED, connectorEvidencedPairId: E_SS, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    { id: CLAIM_SEED_I, integrationId: I_SS, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    {
      id: CLAIM_PLATFORM,
      connectorEvidencedPairId: E_PLATFORM,
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    },
  ]);
  await t.db.insert(attestations).values([
    { id: uuid(70), claimId: CLAIM_SEED, source: 'aeci' },
    { id: uuid(71), claimId: CLAIM_SEED_I, source: 'aeci' },
    { id: uuid(72), claimId: CLAIM_PLATFORM, source: 'aeci' },
  ]);
  await t.db.insert(profiles).values(
    [AUTH_A, AUTH_C, AUTH_E].map((a) => ({
      id: a.userId,
      role: 'vendor_admin',
      vendorId: a.vendorId,
    })),
  );
});
afterEach(() => t.dispose());

function app(auth: Auth) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('/api/vendor/*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/owned-integrations/:id/flows', createAddOwnerFlowHandler(t.factory));
  a.put('/api/vendor/owned-flows/:claimId/answer', createSetOwnerFlowAnswerHandler(t.factory));
  a.delete('/api/vendor/owned-flows/:claimId/answer', createClearOwnerFlowAnswerHandler(t.factory));
  a.patch('/api/vendor/owned-flows/:claimId', createChangeOwnerFlowHandler(t.factory));
  a.get(
    '/api/vendor/owned-integrations/:id/flows/history',
    createOwnerFlowHistoryHandler(t.factory),
  );
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(t.factory));
  a.get('/api/products/:slug/integrations/:otherSlug', createProductPairHandler(t.factory));
  a.get(
    '/api/products/:slug/integrations/:otherSlug/timeline',
    createPairTimelineHandler(t.factory),
  );
  a.get(
    '/api/products/:slug/integrations/:otherSlug/alternatives',
    createPairAlternativesHandler(t.factory),
  );
  a.get('/api/products/:slug', createProductDetailHandler(t.factory));
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

const add = (auth: Auth, id: string, dataObject = 'invoices', direction = 'outbound') =>
  call(auth, `/api/vendor/owned-integrations/${id}/flows`, 'POST', {
    data_object: dataObject,
    direction,
  });

describe('the authority rule, cell by cell', () => {
  const OWNER: ReadonlyArray<[string, string, number, string | null]> = [
    ['evidenced pair, Sync Service, claimed', E_SS, 201, null],
    [
      'evidenced pair, Sync Service, unclaimed',
      E_SS_UNCLAIMED,
      409,
      ApiErrorCode.INTEGRATION_NOT_CLAIMED,
    ],
    ['evidenced pair, Sync Service, retired', E_SS_RETIRED, 409, ApiErrorCode.INTEGRATION_RETIRED],
    ['evidenced pair, Integration platform, claimed', E_PLATFORM, 403, ApiErrorCode.FORBIDDEN],
    ['evidenced pair, blank kind, claimed', E_BLANK, 403, ApiErrorCode.FORBIDDEN],
    ['integration, Sync Service, claimed', I_SS, 201, null],
    [
      'integration, Sync Service, unclaimed',
      I_SS_UNCLAIMED,
      409,
      ApiErrorCode.INTEGRATION_NOT_CLAIMED,
    ],
    ['integration, Integration platform, claimed', I_PLATFORM, 403, ApiErrorCode.FORBIDDEN],
    ['integration, no connector, claimed', I_DIRECT, 403, ApiErrorCode.FORBIDDEN],
  ];
  it.each(OWNER)('the owner on an %s (%s) answers %i', async (_label, id, status, code) => {
    const res = await add(AUTH_C, id);
    expect(res.status).toBe(status);
    if (code) expect(res.body.error.code).toBe(code);
    // A refused write leaves nothing behind.
    if (status !== 201) expect(await t.db.select().from(claimOwnerAnswers)).toHaveLength(0);
  });

  const ROWS = [E_SS, E_SS_UNCLAIMED, E_PLATFORM, E_BLANK, I_SS, I_SS_UNCLAIMED, I_PLATFORM];
  it.each(ROWS)('an endpoint vendor that is not the owner gets 403 NOT_OWNER on %s', async (id) => {
    const res = await add(AUTH_A, id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ApiErrorCode.INTEGRATION_NOT_OWNER);
  });

  it.each(ROWS)('a stranger gets a flat 404 on %s', async (id) => {
    const res = await add(AUTH_E, id);
    expect(res.status).toBe(404);
  });

  it('a claim on a row the caller does not touch reads as the claim 404', async () => {
    const res = await call(AUTH_E, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'PUT', {
      asserted: true,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/claim/i);
  });

  it('the owner cannot answer a flow on an Integration platform pair', async () => {
    const res = await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_PLATFORM}/answer`, 'PUT', {
      asserted: true,
    });
    expect(res.status).toBe(403);
  });
});

describe('the writes', () => {
  it('confirms an AECi flow, with its audit rows in the batch and the four purge tags', async () => {
    const res = await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'PUT', {
      asserted: true,
    });
    expect(res.status).toBe(200);
    const flow = res.body.flows.find((f: JsonBody) => f.id === CLAIM_SEED);
    expect(flow).toMatchObject({
      answer: 'yes',
      agreement: 'owner_confirmed',
      direction: 'outbound',
    });
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action).sort()).toEqual(
      ['claim_owner_answer.created', 'integration.updated'].sort(),
    );
    expect(audits.every((a) => a.vendorId === VENDOR_C)).toBe(true);
    expect(res.send).toHaveBeenCalledWith({
      tags: [
        'pair:acumatica__procore',
        'product:procore',
        'product:acumatica',
        'product:rivets-sync',
      ],
      source: 'vendor',
    });
    const [pairRow] = await t.db
      .select()
      .from(connectorEvidencedPairs)
      .where(eq(connectorEvidencedPairs.id, E_SS));
    expect(pairRow?.vendorEditedAt).not.toBeNull();
  });

  it('supersedes by retract-then-insert, and DELETE clears the answer', async () => {
    await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'PUT', { asserted: true });
    const no = await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'PUT', {
      asserted: false,
    });
    expect(no.body.flows[0]).toMatchObject({
      answer: 'no',
      agreement: 'unverified',
      public: false,
    });
    const rows = await t.db.select().from(claimOwnerAnswers);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.retractedAt === null)).toHaveLength(1);

    const cleared = await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'DELETE');
    expect(cleared.status).toBe(204);
    const live = (await t.db.select().from(claimOwnerAnswers)).filter(
      (r) => r.retractedAt === null,
    );
    expect(live).toHaveLength(0);
    // Clearing again changes nothing and writes no audit row.
    const before = (await t.db.select().from(auditLog)).length;
    expect(
      (await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'DELETE')).status,
    ).toBe(204);
    expect(await t.db.select().from(auditLog)).toHaveLength(before);
  });

  it('adds a flow as a vendor claim, confirmed, and tells both endpoint vendors', async () => {
    const res = await add(AUTH_C, E_SS, 'invoices', 'outbound');
    expect(res.status).toBe(201);
    const added = res.body.flows.find((f: JsonBody) => f.data_object_slug === 'invoices');
    expect(added).toMatchObject({
      origin: 'vendor',
      answer: 'yes',
      agreement: 'owner_confirmed',
      public: true,
    });
    const [claim] = await t.db.select().from(claims).where(eq(claims.id, added.id));
    expect(claim).toMatchObject({
      origin: 'vendor',
      createdByVendorId: VENDOR_C,
      direction: 'a_to_b',
    });
    const notes = (await t.db.select().from(auditLog)).filter(
      (a) => a.action === NOTIFICATION_SENT_ACTION,
    );
    expect(notes.map((n) => (n.metadata as { vendorId: string }).vendorId).sort()).toEqual(
      [VENDOR_A, VENDOR_B].sort(),
    );
    // Each recipient reads the direction from its own product.
    const forB = notes.find((n) => (n.metadata as { vendorId: string }).vendorId === VENDOR_B);
    expect((forB?.metadata as { direction: string }).direction).toBe('inbound');
  });

  it('adding a flow that is already listed confirms it rather than duplicating it', async () => {
    const res = await add(AUTH_C, E_SS, 'rfis', 'outbound');
    expect(res.status).toBe(200);
    expect(
      await t.db.select().from(claims).where(eq(claims.connectorEvidencedPairId, E_SS)),
    ).toHaveLength(1);
    expect(res.body.flows[0]).toMatchObject({ id: CLAIM_SEED, answer: 'yes' });
  });

  it('changes a direction: the old flow is removed and the new one confirmed, in one batch', async () => {
    const res = await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}`, 'PATCH', {
      direction: 'both',
    });
    expect(res.status).toBe(200);
    const byDirection = Object.fromEntries(
      res.body.flows.map((f: JsonBody) => [f.direction, f.answer]),
    );
    expect(byDirection).toEqual({ outbound: 'no', both: 'yes' });
    // `claims.direction` is never rewritten.
    const [seed] = await t.db.select().from(claims).where(eq(claims.id, CLAIM_SEED));
    expect(seed?.direction).toBe('a_to_b');
  });

  it('lists the flows on the owned row, editable, and tells the endpoint vendor who keeps them', async () => {
    await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED_I}/answer`, 'PUT', { asserted: true });
    const owner = await call(AUTH_C, '/api/vendor/integrations', 'GET');
    const row = owner.body.owned.find((r: JsonBody) => r.id === E_SS);
    expect(row).toMatchObject({ sync_service: true, flows_editable: true });
    expect(row.flows.map((f: JsonBody) => f.id)).toEqual([CLAIM_SEED]);
    const platform = owner.body.owned.find((r: JsonBody) => r.id === E_PLATFORM);
    expect(platform).toMatchObject({ sync_service: false, flows_editable: false, flows: [] });

    const endpoint = await call(AUTH_A, '/api/vendor/integrations', 'GET');
    const entry = endpoint.body.integrations.find((r: JsonBody) => r.id === I_SS);
    expect(entry).toMatchObject({ attestable: false, flows_maintained_by_owner: true });
    expect(entry.claims[0]).toMatchObject({ agreement: 'owner_confirmed', owner_answer: 'yes' });
    expect(entry.claims[0].counterparty).toBeNull();
    const platformEntry = endpoint.body.integrations.find((r: JsonBody) => r.id === I_PLATFORM);
    expect(platformEntry.flows_maintained_by_owner).toBe(false);
  });
});

describe('claim, confirm a flow, read it on the pair page', () => {
  const pairPage = () => call(AUTH_E, '/api/products/procore/integrations/acumatica', 'GET');
  const mechanism = (body: JsonBody, id: string) =>
    body.mechanisms.find((m: JsonBody) => m.id === id) as JsonBody;

  it('reads "Listed by AEC Integrations" before, owner_confirmed after, and withholds a removed flow', async () => {
    const before = await pairPage();
    expect(before.status).toBe(200);
    expect(mechanism(before.body, E_SS).claims[0].agreement).toBe('unverified');

    await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'PUT', { asserted: true });
    const after = await pairPage();
    const m = mechanism(after.body, E_SS);
    expect(m.claims[0].agreement).toBe('owner_confirmed');
    expect(m.connector_kind).toBe('sync_service');
    expect(m.built_by_vendor.name).toBe('Rivets');
    // The owner's answer is not an attestation row on the wire.
    expect(m.claims[0].attestations.map((a: JsonBody) => a.source)).toEqual(['aeci']);

    await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'PUT', { asserted: false });
    expect(mechanism((await pairPage()).body, E_SS).claims).toEqual([]);
  });

  it('shows a flow the owner added, and stops counting the answer when the row is unclaimed', async () => {
    const res = await add(AUTH_C, I_SS, 'invoices', 'both');
    expect(res.status).toBe(201);
    const shown = mechanism((await pairPage()).body, I_SS).claims.map(
      (c: JsonBody) => `${c.data_object_slug}:${c.agreement}`,
    );
    expect(shown).toContain('invoices:owner_confirmed');

    // Back to AECi: the owner's answers stop counting. Its own flow is withheld.
    await t.db.update(integrations).set({ claimedAt: null }).where(eq(integrations.id, I_SS));
    const unclaimed = mechanism((await pairPage()).body, I_SS).claims.map(
      (c: JsonBody) => `${c.data_object_slug}:${c.agreement}`,
    );
    expect(unclaimed).toEqual(['rfis:unverified']);
  });

  // AECI-2213 review: the server says whether the pair page shows a flow, by the pair
  // read's own rule, so a vendor-made flow backed by AECi reads as public.
  it('reports public from isClaimPubliclyBacked, not from origin', async () => {
    const added = await add(AUTH_C, E_SS, 'invoices', 'outbound');
    const flowId = added.body.flows.find((f: JsonBody) => f.data_object_slug === 'invoices').id;
    // A new owner: C's Yes stops counting, so nobody stands behind C's add.
    await t.db
      .update(connectorEvidencedPairs)
      .set({ builtByVendorId: VENDOR_E })
      .where(eq(connectorEvidencedPairs.id, E_SS));
    const ownedFlow = async () =>
      ((await call(AUTH_E, '/api/vendor/integrations', 'GET')).body.owned as JsonBody[])
        .find((r) => r.id === E_SS)
        ?.flows.find((f: JsonBody) => f.id === flowId);
    expect(await ownedFlow()).toMatchObject({ origin: 'vendor', answer: null, public: false });
    await t.db.insert(attestations).values({ id: uuid(90), claimId: flowId, source: 'aeci' });
    expect(await ownedFlow()).toMatchObject({ origin: 'vendor', answer: null, public: true });
    // The pair page agrees: the flow is listed.
    const listed = mechanism((await pairPage()).body, E_SS).claims.map(
      (c: JsonBody) => c.data_object_slug,
    );
    expect(listed).toContain('invoices');
  });

  it('ignores an answer from a previous owner', async () => {
    await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'PUT', { asserted: true });
    await t.db
      .update(connectorEvidencedPairs)
      .set({ builtByVendorId: VENDOR_E })
      .where(eq(connectorEvidencedPairs.id, E_SS));
    expect(mechanism((await pairPage()).body, E_SS).claims[0].agreement).toBe('unverified');
  });
});

// Follow-up item 1: every other public reader of claims applies the owner's answers, so
// a flow the owner removed shows nowhere public (§14.10 "Readers checked").
describe('every other public reader applies the owner answers', () => {
  const answer = (claimId: string, asserted: boolean) =>
    call(AUTH_C, `/api/vendor/owned-flows/${claimId}/answer`, 'PUT', { asserted });

  it('the connector page counts no removed flow, and counts an added one', async () => {
    const slugsOnHub = async () => {
      const body = (await call(AUTH_E, '/api/products/rivets-sync', 'GET')).body;
      const row = (body.integrations_as_connector as JsonBody[]).find((r) => r.id === E_SS);
      return [...(row?.data_object_slugs as string[])].sort();
    };
    expect(await slugsOnHub()).toEqual(['rfis']);

    const added = await add(AUTH_C, E_SS, 'invoices', 'outbound');
    expect(await slugsOnHub()).toEqual(['invoices', 'rfis']);

    await answer(CLAIM_SEED, false);
    const invoices = added.body.flows.find((f: JsonBody) => f.data_object_slug === 'invoices');
    await answer(invoices.id, false);
    expect(await slugsOnHub()).toEqual([]);
  });

  // AECI-2046: the "What it syncs" roll-up reads the same public flows as the hub.
  it('the connector page "What it syncs" roll-up names no removed flow', async () => {
    const objectsOnBlock = async () => {
      const body = (await call(AUTH_E, '/api/products/rivets-sync', 'GET')).body;
      const block = body.what_it_syncs as JsonBody;
      return (block.objects as JsonBody[]).map((o) => `${o.slug}:${o.pair_count}`);
    };
    expect(await objectsOnBlock()).toEqual(['rfis:1']);

    const added = await add(AUTH_C, E_SS, 'invoices', 'outbound');
    expect(await objectsOnBlock()).toEqual(['invoices:1', 'rfis:1']);

    await answer(CLAIM_SEED, false);
    expect(await objectsOnBlock()).toEqual(['invoices:1']);
    const invoices = added.body.flows.find((f: JsonBody) => f.data_object_slug === 'invoices');
    await answer(invoices.id, false);
    expect(await objectsOnBlock()).toEqual([]);
    const body = (await call(AUTH_E, '/api/products/rivets-sync', 'GET')).body;
    expect(body.what_it_syncs).toMatchObject({ pair_count: 1, pairs_with_flows: 0 });
  });

  it('the endpoint product page and the alternatives lanes drop a removed flow', async () => {
    await t.db
      .insert(products)
      .values({ id: uuid(20), slug: 'buildertrend', name: 'Buildertrend' });
    const moving = async () => {
      const res = await call(
        AUTH_E,
        '/api/products/procore/integrations/buildertrend/alternatives',
        'GET',
      );
      expect(res.status).toBe(200);
      return (res.body.moving.context_only as JsonBody[]).map((o) => o.slug);
    };
    const added = await add(AUTH_C, E_SS, 'invoices', 'outbound');
    expect(await moving()).toContain('invoices');
    const invoices = added.body.flows.find((f: JsonBody) => f.data_object_slug === 'invoices');
    await answer(invoices.id, false);
    expect(await moving()).not.toContain('invoices');

    const page = (await call(AUTH_E, '/api/products/procore', 'GET')).body;
    const rows = [...page.integrations_as_source, ...page.integrations_as_target] as JsonBody[];
    const onPage = rows.find((r) => r.id === E_SS);
    expect(onPage?.data_object_slugs).not.toContain('invoices');
  });

  it('the timeline lists the owner answers, and withholds a removed flow whole', async () => {
    // The timeline is history, so it opens only when a pair vendor is verified (§9.3).
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR_A));
    const timeline = async () =>
      (await call(AUTH_E, '/api/products/procore/integrations/acumatica/timeline', 'GET')).body;
    const of = (body: JsonBody, claimId: string) =>
      (body.claims as JsonBody[]).find((c) => c.claim_id === claimId);

    const added = await add(AUTH_C, E_SS, 'invoices', 'outbound');
    const invoices = added.body.flows.find((f: JsonBody) => f.data_object_slug === 'invoices');
    await answer(CLAIM_SEED, true);
    const body = await timeline();
    expect(body.diff_access).not.toBe('latest_only');
    // An added flow has no attestation row, so its history is the owner's answer.
    expect(of(body, invoices.id)?.entries).toEqual([
      expect.objectContaining({ attestor: 'owner', asserted: true, retracted_at: null }),
    ]);
    expect(of(body, CLAIM_SEED)?.entries.map((e: JsonBody) => e.attestor)).toEqual([
      'aeci',
      'owner',
    ]);

    await answer(CLAIM_SEED, false);
    expect(of(await timeline(), CLAIM_SEED)).toBeUndefined();

    // A previous owner's answers are not listed under the new owner.
    await t.db
      .update(connectorEvidencedPairs)
      .set({ builtByVendorId: VENDOR_E })
      .where(eq(connectorEvidencedPairs.id, E_SS));
    const moved = await timeline();
    expect(of(moved, CLAIM_SEED)?.entries.map((e: JsonBody) => e.attestor)).toEqual(['aeci']);
    expect(of(moved, invoices.id)).toBeUndefined();
  });
});

// Follow-up item 2: the ownership record carries the owner's flows on its delivered pairs.
describe('the ownership record', () => {
  it('lists every flow of a held Sync Service pair with its counted answer', async () => {
    await add(AUTH_C, E_SS, 'invoices', 'both');
    await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'PUT', { asserted: false });
    const record = await buildOwnershipRecordV2(t.db, VENDOR_C, 'vendor_edit');
    const pair = record?.deliveredPairs?.find((p) => p.id === E_SS);
    expect(pair?.owner).toBe('vendor');
    expect(pair?.ownerFlows).toEqual([
      { dataObject: 'invoices', direction: 'both', origin: 'vendor', answer: 'yes' },
      { dataObject: 'rfis', direction: 'a_to_b', origin: 'aeci', answer: 'no' },
    ]);
    // A held pair whose connector is an Integration platform carries no owner flows.
    expect(record?.deliveredPairs?.find((p) => p.id === E_PLATFORM)?.ownerFlows).toBeUndefined();
    // The existing claim slots keep their meaning: an owner answer is never a slot.
    expect(pair?.claims?.map((c) => c.source)).toEqual(['aeci']);
  });

  it('an unclaimed pair carries no owner flows', async () => {
    const record = await buildOwnershipRecordV2(t.db, VENDOR_C, 'vendor_edit');
    const pair = record?.deliveredPairs?.find((p) => p.id === E_SS_UNCLAIMED);
    expect(pair?.ownerFlows).toBeUndefined();
  });
});

// Follow-up item 3: an owner that also makes an endpoint answers as the owner.
describe('the owner that also makes an endpoint', () => {
  beforeEach(async () => {
    // C makes Procore too, so I_SS is on C's ordinary integrations list.
    await t.db
      .insert(productVendors)
      .values({ productId: P_A, vendorId: VENDOR_C, isPrimary: false });
  });

  it('carries the owner flows on its integrations list entry, in the row frame', async () => {
    await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED_I}/answer`, 'PUT', { asserted: true });
    const res = await call(AUTH_C, '/api/vendor/integrations', 'GET');
    const entry = (res.body.integrations as JsonBody[]).find((r) => r.id === I_SS);
    expect(entry).toMatchObject({
      is_owner: true,
      attestable: false,
      flows_maintained_by_owner: true,
    });
    expect(entry?.owner_flows).toMatchObject({
      editable: true,
      product_a: { id: P_A },
      product_b: { id: P_B },
    });
    expect(entry?.owner_flows.flows).toEqual([
      expect.objectContaining({ id: CLAIM_SEED_I, direction: 'outbound', answer: 'yes' }),
    ]);
    // Not listed twice: the owned array skips a row the endpoint list carries.
    expect((res.body.owned as JsonBody[]).some((r) => r.id === I_SS)).toBe(false);
    // An endpoint vendor that is not the owner gets no owner controls.
    const a = await call(AUTH_A, '/api/vendor/integrations', 'GET');
    const theirs = (a.body.integrations as JsonBody[]).find((r) => r.id === I_SS);
    expect(theirs?.owner_flows).toBeNull();
  });
});

// AECI-2213: one data type's history, from claims and every owner answer.
describe('the history read', () => {
  const history = (auth: Auth, id: string, dataObject = 'rfis') =>
    call(
      auth,
      `/api/vendor/owned-integrations/${id}/flows/history?data_object=${dataObject}`,
      'GET',
    );
  const answer = (claimId: string, asserted: boolean) =>
    call(AUTH_C, `/api/vendor/owned-flows/${claimId}/answer`, 'PUT', { asserted });
  const kinds = (body: JsonBody) =>
    (body.events as JsonBody[]).map((e) =>
      e.previous_direction
        ? `${e.kind}:${e.previous_direction}>${e.direction}:${e.actor}`
        : `${e.kind}:${e.direction}:${e.actor}`,
    );

  it('reads the seed, a confirm, a direction change and a clear, newest first', async () => {
    await t.db.update(claims).set({ createdAt: '2026-08-01T00:00:00.000Z' });
    await answer(CLAIM_SEED, true);
    await call(AUTH_C, `/api/vendor/owned-flows/${CLAIM_SEED}`, 'PATCH', { direction: 'both' });
    const both = (await t.db.select().from(claims)).find(
      (c) => c.connectorEvidencedPairId === E_SS && c.direction === 'both',
    );
    await call(AUTH_C, `/api/vendor/owned-flows/${both!.id}/answer`, 'DELETE');

    const res = await history(AUTH_C, E_SS);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data_object_slug: 'rfis', data_object_name: 'RFIs' });
    expect(kinds(res.body)).toEqual([
      'cleared:both:you',
      'direction_changed:outbound>both:you',
      'confirmed:outbound:you',
      'listed:outbound:aeci',
    ]);
    // The new direction's claim is part of the change, not an add of its own.
    expect(kinds(res.body).some((k) => k.startsWith('added'))).toBe(false);
  });

  it('reads an owner add as one "added" event, not an add and a confirm', async () => {
    await add(AUTH_C, E_SS, 'invoices', 'outbound');
    const res = await history(AUTH_C, E_SS, 'invoices');
    expect(kinds(res.body)).toEqual(['added:outbound:you']);
  });

  it('names another company for a previous owner and for a deleted vendor', async () => {
    await answer(CLAIM_SEED, false);
    await t.db.insert(claimOwnerAnswers).values({
      id: uuid(80),
      claimId: CLAIM_SEED,
      vendorId: null,
      asserted: true,
      createdAt: '2026-08-15T00:00:00.000Z',
      retractedAt: '2026-08-16T00:00:00.000Z',
    });
    await t.db
      .update(connectorEvidencedPairs)
      .set({ builtByVendorId: VENDOR_E })
      .where(eq(connectorEvidencedPairs.id, E_SS));
    // E is the owner now, so C's answers and the NULL vendor's are another company's.
    const res = await history(AUTH_E, E_SS);
    expect(res.status).toBe(200);
    const actors = (res.body.events as JsonBody[]).map((e) => `${e.kind}:${e.actor}`);
    expect(actors).toContain('removed:other_company');
    expect(actors).toContain('confirmed:other_company');
    expect(actors).toContain('cleared:other_company');
    expect(actors).not.toContain('removed:you');
  });

  // AECI-2213 review: the clearing actor is whoever retracted, not who answered.
  it("reads the new owner's clear of the old owner's Yes as the new owner's", async () => {
    await answer(CLAIM_SEED, true);
    await t.db
      .update(connectorEvidencedPairs)
      .set({ builtByVendorId: VENDOR_E })
      .where(eq(connectorEvidencedPairs.id, E_SS));
    const cleared = await call(AUTH_E, `/api/vendor/owned-flows/${CLAIM_SEED}/answer`, 'DELETE');
    expect(cleared.status).toBe(204);
    const res = await history(AUTH_E, E_SS);
    expect(kinds(res.body)).toEqual([
      'cleared:outbound:you',
      'confirmed:outbound:other_company',
      'listed:outbound:aeci',
    ]);
  });

  // AECI-2213 review: promote's rule 4 makes a seed vendor-origin; AECi still listed it.
  it('reads a claim promote converted to vendor origin as listed by AECi', async () => {
    await t.db
      .update(claims)
      .set({ origin: 'vendor', createdByVendorId: VENDOR_C })
      .where(eq(claims.id, CLAIM_SEED));
    await t.db.insert(auditLog).values({
      actorType: 'system',
      action: 'claim.converted',
      entityType: 'claim',
      entityId: CLAIM_SEED,
      beforeState: { origin: 'aeci', createdByVendorId: null },
      afterState: { origin: 'vendor', createdByVendorId: VENDOR_C },
    });
    const res = await history(AUTH_C, E_SS);
    expect(kinds(res.body)).toEqual(['listed:outbound:aeci']);
  });

  it('opens on an unclaimed and a retired row', async () => {
    for (const id of [E_SS_UNCLAIMED, E_SS_RETIRED, I_SS_UNCLAIMED]) {
      const res = await history(AUTH_C, id);
      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
    }
  });

  it('keeps the gate before the claim step: endpoint 403, stranger 404, platform 403', async () => {
    expect((await history(AUTH_A, E_SS)).body.error.code).toBe(ApiErrorCode.INTEGRATION_NOT_OWNER);
    expect((await history(AUTH_E, E_SS)).status).toBe(404);
    expect((await history(AUTH_C, E_PLATFORM)).body.error.code).toBe(ApiErrorCode.FORBIDDEN);
  });

  it('refuses a missing or unknown data object with 400', async () => {
    expect(
      (await call(AUTH_C, `/api/vendor/owned-integrations/${E_SS}/flows/history`, 'GET')).status,
    ).toBe(400);
    expect((await history(AUTH_C, E_SS, 'nope')).status).toBe(400);
  });

  // The mount carries no limiter: `vendor-owner-flows.registration.spec.ts`.
  it('writes nothing', async () => {
    const before = (await t.db.select().from(auditLog)).length;
    await history(AUTH_C, E_SS);
    expect(await t.db.select().from(auditLog)).toHaveLength(before);
  });
});

describe('buildOwnerFlowHistory', () => {
  const ME = 'me';
  const T1 = '2026-10-01T00:00:00.000Z';
  const T2 = '2026-10-02T00:00:00.000Z';
  const seed = {
    id: 'c1',
    direction: 'a_to_b',
    origin: 'aeci',
    createdByVendorId: null,
    createdAt: T1,
    converted: false,
  } as const;
  const seed2 = { ...seed, id: 'c2', direction: 'b_to_a' } as const;

  it('pairs a No and a Yes at the same instant into one change, even on two seeds', () => {
    const events = buildOwnerFlowHistory(
      [seed, seed2],
      [
        {
          id: 'a1',
          claimId: 'c1',
          vendorId: ME,
          asserted: false,
          createdAt: T2,
          retractedAt: null,
        },
        { id: 'a2', claimId: 'c2', vendorId: ME, asserted: true, createdAt: T2, retractedAt: null },
      ],
      ME,
    );
    expect(events[0]).toEqual({
      at: T2,
      kind: 'direction_changed',
      direction: 'inbound',
      previous_direction: 'outbound',
      actor: 'you',
    });
    expect(events.map((e) => e.kind)).toEqual(['direction_changed', 'listed', 'listed']);
  });

  it('keeps a No and a Yes at different instants apart', () => {
    const events = buildOwnerFlowHistory(
      [seed, seed2],
      [
        {
          id: 'a1',
          claimId: 'c1',
          vendorId: ME,
          asserted: false,
          createdAt: T1,
          retractedAt: null,
        },
        { id: 'a2', claimId: 'c2', vendorId: ME, asserted: true, createdAt: T2, retractedAt: null },
      ],
      ME,
    );
    expect(events.map((e) => e.kind)).toEqual(['confirmed', 'removed', 'listed', 'listed']);
  });

  it('reads a vendor add by someone else, or by a deleted vendor, as another company', () => {
    const events = buildOwnerFlowHistory(
      [
        { ...seed, origin: 'vendor', createdByVendorId: 'them' },
        { ...seed2, origin: 'vendor', createdByVendorId: null },
      ],
      [],
      ME,
    );
    expect(events.map((e) => e.actor)).toEqual(['other_company', 'other_company']);
  });

  it('reads a converted seed as listed by AECi, never as an add', () => {
    const events = buildOwnerFlowHistory(
      [{ ...seed, origin: 'vendor', createdByVendorId: ME, converted: true }],
      [],
      ME,
    );
    expect(events).toEqual([{ at: T1, kind: 'listed', direction: 'outbound', actor: 'aeci' }]);
  });

  it('names the clearing actor from the retraction, not the answer', () => {
    const retracted = (
      id: string,
      retractedBy: { vendorId: string | null; actorType: string } | null,
    ) => ({
      id,
      claimId: 'c1',
      vendorId: 'old-owner',
      asserted: true,
      createdAt: T1,
      retractedAt: T2,
      retractedBy,
    });
    const actors = [
      retracted('a1', { vendorId: ME, actorType: 'user' }),
      retracted('a2', { vendorId: 'them', actorType: 'user' }),
      retracted('a3', { vendorId: null, actorType: 'system' }),
      retracted('a4', null),
    ].map(
      (answer) =>
        buildOwnerFlowHistory([seed], [answer], ME).find((e) => e.kind === 'cleared')?.actor,
    );
    expect(actors).toEqual(['you', 'other_company', 'aeci', 'other_company']);
  });
});
