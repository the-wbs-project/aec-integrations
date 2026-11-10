/**
 * AECI-1092 — contests on connector-powered integrations and connector-evidenced
 * pairs, with the AECI-1040 routing rulings (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.13).
 *
 * Real migrations (0050 included) on in-memory SQLite, with `db.batch` shimmed onto
 * one transaction, so the two-arm anchor CHECK, the evidenced open-contest key and
 * the audit-in-batch rule are exercised, not mocked. What each block pins:
 *
 *   - Submit on a pair: the endpoint-vendor check (`resolveEvidencedPairSlots`),
 *     the owner refusal, the eleven fields (no `mechanism_kind`), the canonical
 *     A/B direction frame, the evidenced duplicate key.
 *   - Routing: ruling A (`mechanism_kind` on a connector-powered row goes to AECi),
 *     and the unchanged §11b.4 rule elsewhere. Ruling E is retired (AECI-1663,
 *     ruling 14): the owner's plan never routes a contest.
 *   - The owner decision on any plan, and an accept that writes the PAIR with its
 *     audit row in the same batch.
 *   - The AECi accept on a pair: the content write on a claimed pair and ruling C's
 *     owner approval.
 *   - Ruling B is retired too: a last-license revoke moves no contest.
 *   - The connectors read carries one contest target per delivered pair.
 *   - A protest on a pair contest files as on any contest.
 */

import { AdminContestSchema, VendorProductConnectorsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the batched telemetry forward (the AECI-666 connection-limit rule); every
// other export keeps its real, self-gating behaviour.
vi.mock('../posthog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../posthog')>();
  return { ...real, logBatchToPosthog: vi.fn() };
});

import {
  auditLog,
  connectorEvidencedPairs,
  fieldOverrides,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  licenses,
  vendors,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { BatchTuple } from '../lib/audit';
import type { DbFactory } from '../lib/handler-utils';
import { logBatchToPosthog } from '../posthog';
import {
  contestIntegrationStateSentinel,
  contestValueUnchangedSentinel,
  isContestRaceError,
  routeContest,
} from '../lib/integration-contests';
import { makeTestDb, type TestDb } from '../test/d1';
import { seedLicense } from '../test/licenses';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createModerateContestHandler } from './admin-contests';
import { createGrantLicensesHandler, createUpdateLicenseHandler } from './admin-licenses';
import { createFileContestProtestHandler } from './vendor-contest-protests';
import {
  createDecideContestHandler,
  createListVendorContestsHandler,
  createSubmitContestHandler,
} from './vendor-contests';
import { createListVendorProductConnectorsHandler } from './vendor-connectors';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns endpoint A of the pair, B owns endpoint B, T is a third-party owner that
// sells the connector product. C owns nothing on the pair.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_T = uuid(3);
const VENDOR_C = uuid(4);

// Ids sort so P_A < P_B, which is the pair's canonical order.
const P_A = uuid(10);
const P_B = uuid(11);
const P_CONNECTOR = uuid(12);
const P_OTHER = uuid(13);

const PAIR = uuid(30);
const I_POWERED = uuid(31); // integrations row, iPaaS, A → B, owned by B
const I_PLAIN = uuid(32); // integrations row, native, A → B, owned by B

const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const SEAT_T = uuid(102);
const SEAT_C = uuid(103);
const ADMIN = uuid(900);

const CLAIMED_AT = '2026-09-01T00:00:00.000Z';

type Auth = AuthzVariables['auth'];
const seat = (userId: string, vendorId: string, entitled = false): Auth => ({
  userId,
  email: `${userId}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: entitled ? 'verified' : 'unclaimed',
  entitlement: entitled ? { status: 'active', periodEnd: null } : null,
});
const AUTH_A = seat(SEAT_A, VENDOR_A);
const AUTH_B = seat(SEAT_B, VENDOR_B);
const AUTH_C = seat(SEAT_C, VENDOR_C);
const AUTH_ADMIN: Auth = {
  userId: ADMIN,
  email: undefined,
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;
const fileIssue = vi.fn().mockResolvedValue({ status: 'created' });

beforeEach(async () => {
  fileIssue.mockClear();
  factory = null;
  vi.mocked(logBatchToPosthog).mockClear();
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_T, slug: 'syncezy', companyName: 'SyncEzy' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'revit', name: 'Revit' },
    { id: P_B, slug: 'procore', name: 'Procore' },
    { id: P_CONNECTOR, slug: 'syncezy-connect', name: 'SyncEzy Connect' },
    { id: P_OTHER, slug: 'archicad', name: 'ArchiCAD' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_B, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: VENDOR_T, isPrimary: true },
    { productId: P_OTHER, vendorId: VENDOR_C, isPrimary: true },
  ]);
  await t.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    connectorProductId: P_CONNECTOR,
    productAId: P_A,
    productBId: P_B,
    name: 'Revit to Procore via SyncEzy',
    direction: 'a_to_b',
    docsUrl: 'https://example.test/docs',
    builtByVendorId: VENDOR_T,
  });
  await t.db.insert(integrations).values([
    {
      id: I_POWERED,
      name: 'Revit for Procore (iPaaS)',
      sourceProductId: P_A,
      targetProductId: P_B,
      mechanismKind: 'iPaaS',
      direction: 'a_to_b',
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
    },
    {
      id: I_PLAIN,
      name: 'Revit for Procore',
      sourceProductId: P_A,
      targetProductId: P_B,
      mechanismKind: 'native',
      direction: 'a_to_b',
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
    },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_T, role: 'vendor_admin', vendorId: VENDOR_T },
    { id: SEAT_C, role: 'vendor_admin', vendorId: VENDOR_C },
    { id: ADMIN, role: 'admin' },
  ]);
});
afterEach(() => t.dispose());

/** Managed: one live license, which the owner checks read since AECI-1355. Its id
 *  is kept so {@link revokeLast} can end it. */
const licenseOf = new Map<string, string>();
const entitle = async (vendorId: string) => {
  await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, vendorId));
  licenseOf.set(vendorId, await seedLicense(t.db, vendorId));
};
/** Revoke the vendor's only live license: the last-license revoke that carries the
 *  ruling B re-route (AECI-1375). */
const revokeLast = (vendorId: string) =>
  call(
    AUTH_ADMIN,
    `/api/admin/licenses/${licenseOf.get(vendorId)}`,
    { action: 'revoke', reason: 'The pilot ended.' },
    'PATCH',
  );
const claimPair = () =>
  t.db
    .update(connectorEvidencedPairs)
    .set({ claimedAt: CLAIMED_AT })
    .where(eq(connectorEvidencedPairs.id, PAIR));

let factory: DbFactory | null = null;

function app(auth: Auth) {
  const f: DbFactory = factory ?? t.factory;
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  // AECI-1092: one route for both tables; the handler finds which one the id names.
  a.post('/api/vendor/integrations/:id/contests', createSubmitContestHandler(f));
  a.get('/api/vendor/contests', createListVendorContestsHandler(f));
  a.post('/api/vendor/contests/:id/decision', createDecideContestHandler(f));
  a.post('/api/vendor/contests/:id/protest', createFileContestProtestHandler(f));
  a.get('/api/vendor/products/:id/connectors', createListVendorProductConnectorsHandler(f));
  a.patch('/api/admin/contests/:id', createModerateContestHandler(f, fileIssue));
  const noEmails = async () => new Map<string, string>();
  a.patch(
    '/api/admin/licenses/:id',
    createUpdateLicenseHandler(f, noEmails, async () => 'sent' as const),
  );
  a.post(
    '/api/admin/vendors/:id/licenses',
    createGrantLicensesHandler(f, noEmails, async () => 'sent' as const),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body === undefined
      ? {}
      : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const submitPair = (auth: Auth, body: unknown) =>
  call(auth, `/api/vendor/integrations/${PAIR}/contests`, body);
const submitIntegration = (auth: Auth, id: string, body: unknown) =>
  call(auth, `/api/vendor/integrations/${id}/contests`, body);
const contest = async (id: string) =>
  (
    await t.db
      .select()
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.id, id))
  )[0]!;
const pairRow = async () =>
  (
    await t.db.select().from(connectorEvidencedPairs).where(eq(connectorEvidencedPairs.id, PAIR))
  )[0]!;
const actions = async () => (await t.db.select().from(auditLog)).map((r) => r.action);

const DOCS = {
  field: 'docs_url',
  proposed_value: 'https://example.test/better-docs',
  reason: 'The docs moved.',
};

// ─── Submit on a pair ────────────────────────────────────────────────────────

describe('POST /api/vendor/integrations/:id/contests on an evidenced pair — submit', () => {
  it('lets an endpoint vendor contest a pair, anchored on the pair, routed to AECi when unclaimed', async () => {
    const res = await submitPair(AUTH_A, DOCS);
    expect(res.status).toBe(201);
    expect(res.body.contest).toMatchObject({
      integration_id: PAIR,
      anchor: 'evidenced_pair',
      field: 'docs_url',
      current_value: 'https://example.test/docs',
      routed_to: 'aeci',
      owner_vendor: { id: VENDOR_T, name: 'SyncEzy' },
    });
    const row = await contest(res.body.contest.id);
    expect(row.integrationId).toBeNull();
    expect(row.evidencedPairId).toBe(PAIR);
    // The audit row and the transition landed with it.
    expect(await actions()).toContain('integration.contest.submitted');
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);
  });

  it('answers a vendor that owns neither endpoint with the unknown-id 404', async () => {
    expect((await submitPair(AUTH_C, DOCS)).status).toBe(404);
    expect((await call(AUTH_A, `/api/vendor/integrations/${uuid(99)}/contests`, DOCS)).status).toBe(
      404,
    );
  });

  it('refuses the pair owner with 403 CONTEST_OWN_INTEGRATION, once it proves an endpoint', async () => {
    await t.db
      .update(connectorEvidencedPairs)
      .set({ builtByVendorId: VENDOR_A })
      .where(eq(connectorEvidencedPairs.id, PAIR));
    const res = await submitPair(AUTH_A, DOCS);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CONTEST_OWN_INTEGRATION');
  });

  it('lets the pair’s named owner, a connector vendor on no endpoint, say "not ours" (AECI-1225)', async () => {
    const res = await submitPair(seat(SEAT_T, VENDOR_T), {
      field: 'owner',
      proposed_value: null,
      reason: 'We list the connector, but we do not offer this pair.',
    });
    expect(res.status).toBe(201);
    expect(res.body.contest).toMatchObject({ field: 'owner', routed_to: 'aeci' });
    const row = await contest(res.body.contest.id);
    expect(row.evidencedPairId).toBe(PAIR);
    expect(row.submitterVendorId).toBe(VENDOR_T);
    expect(row.ownerVendorId).toBe(VENDOR_T);
  });

  it('refuses a content field from the pair’s named owner with 403 (AECI-1225)', async () => {
    const res = await submitPair(seat(SEAT_T, VENDOR_T), DOCS);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CONTEST_OWN_INTEGRATION');
  });

  it('refuses mechanism_kind on a pair as a shape error (the column does not exist)', async () => {
    const res = await submitPair(AUTH_A, {
      field: 'mechanism_kind',
      proposed_value: 'native',
      reason: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('stores direction in the pair’s canonical A/B frame, from either endpoint', async () => {
    // B says "we send to Revit": in the A/B frame that is b_to_a.
    const res = await submitPair(AUTH_B, {
      field: 'direction',
      proposed_value: 'outbound',
      reason: 'Procore pushes to Revit.',
    });
    expect(res.status).toBe(201);
    expect((await contest(res.body.contest.id)).proposedValue).toBe('b_to_a');
    // And the wire re-frames it back for B.
    expect(res.body.contest.proposed_value).toBe('outbound');
  });

  it('keeps one open contest per field per vendor on the pair arm', async () => {
    expect((await submitPair(AUTH_A, DOCS)).status).toBe(201);
    const again = await submitPair(AUTH_A, { ...DOCS, proposed_value: 'https://example.test/x' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONTEST_DUPLICATE');
  });

  it('checks an owner proposal against the pair’s endpoint vendors', async () => {
    const bad = await submitPair(AUTH_A, { field: 'owner', proposed_value: VENDOR_C, reason: 'x' });
    expect(bad.status).toBe(422);
    const good = await submitPair(AUTH_A, {
      field: 'owner',
      proposed_value: VENDOR_A,
      reason: 'x',
    });
    expect(good.status).toBe(201);
    expect(good.body.contest.routed_to).toBe('aeci');
  });

  it('refuses a new contest on a retired pair', async () => {
    await t.db
      .update(connectorEvidencedPairs)
      .set({ retiredAt: CLAIMED_AT, retiredBy: 'owner' })
      .where(eq(connectorEvidencedPairs.id, PAIR));
    const res = await submitPair(AUTH_A, DOCS);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
  });
});

// ─── Routing rulings ─────────────────────────────────────────────────────────

describe('routing on connector-powered rows (ruling A; E retired by AECI-1663)', () => {
  it('routes a claimed pair’s content contest to its owner', async () => {
    await claimPair();
    const res = await submitPair(AUTH_A, DOCS);
    expect(res.body.contest.routed_to).toBe('owner');
    // The owner is told, in the same batch.
    const sent = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === 'notification.sent',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.metadata).toMatchObject({ vendorId: VENDOR_T, anchor: 'evidenced_pair' });
  });

  it('routes it to a Free-plan owner too, and to one whose plan ended (AECI-1663)', async () => {
    // Ruling 14 retired ruling E: the owner's plan never routes a contest.
    await claimPair();
    const res = await submitPair(AUTH_A, DOCS);
    expect(res.body.contest.routed_to).toBe('owner');
    await entitle(VENDOR_T);
    await t.db.update(licenses).set({ endedAt: CLAIMED_AT, endReason: 'revoked' });
    const again = await submitPair(AUTH_A, { ...DOCS, field: 'listing_url' });
    expect(again.body.contest.routed_to).toBe('owner');
  });

  it('routes mechanism_kind on a claimed connector-powered integration to AECi (ruling A)', async () => {
    // VENDOR_B is on Free: ruling A holds on every plan.
    const res = await submitIntegration(AUTH_A, I_POWERED, {
      field: 'mechanism_kind',
      proposed_value: 'native',
      reason: 'It is native.',
    });
    expect(res.status).toBe(201);
    expect(res.body.contest.routed_to).toBe('aeci');
    // A content field on the same row still goes to the owner.
    const name = await submitIntegration(AUTH_A, I_POWERED, {
      field: 'name',
      proposed_value: 'Better name',
      reason: 'x',
    });
    expect(name.body.contest.routed_to).toBe('owner');
  });

  it('leaves a row that is not connector-powered on §11b.4, with no entitlement needed', async () => {
    const res = await submitIntegration(AUTH_A, I_PLAIN, {
      field: 'mechanism_kind',
      proposed_value: 'marketplace-app',
      reason: 'x',
    });
    expect(res.body.contest.routed_to).toBe('owner');
  });

  it('routes a mechanism_kind proposal that would make the row connector-powered to AECi', async () => {
    // Otherwise the owner could turn its own row connector-powered by accepting it,
    // which its own edit route refuses (review finding, ruling A forward-looking).
    const res = await submitIntegration(AUTH_A, I_PLAIN, {
      field: 'mechanism_kind',
      proposed_value: 'iPaaS',
      reason: 'x',
    });
    expect(res.status).toBe(201);
    expect(res.body.contest.routed_to).toBe('aeci');
  });

  it('pins the pure rule', () => {
    const row = { id: PAIR, builtByVendorId: VENDOR_T, claimedAt: CLAIMED_AT };
    const on = (field: 'name' | 'mechanism_kind') =>
      routeContest(row, field, undefined, { connectorPowered: true }).routedTo;
    expect(on('name')).toBe('owner');
    expect(on('mechanism_kind')).toBe('aeci');
    expect(routeContest(row, 'mechanism_kind').routedTo).toBe('owner');
  });
});

// ─── The owner's decision ────────────────────────────────────────────────────

describe('POST /api/vendor/contests/:id/decision on a pair', () => {
  async function ownerRoutedPairContest(): Promise<string> {
    await claimPair();
    const res = await submitPair(AUTH_A, DOCS);
    expect(res.body.contest.routed_to).toBe('owner');
    return res.body.contest.id as string;
  }

  it('lets a Free-plan owner decide, with its audit row (AECI-1663)', async () => {
    const id = await ownerRoutedPairContest();
    const res = await call(seat(SEAT_T, VENDOR_T, false), `/api/vendor/contests/${id}/decision`, {
      decision: 'decline',
    });
    expect(res.status).toBe(200);
    expect((await contest(id)).status).toBe('declined');
    expect(await actions()).toContain('integration.contest.declined');
  });

  it('writes the pair, transfers maintenance, audits in the batch and purges four tags', async () => {
    const id = await ownerRoutedPairContest();
    const res = await call(seat(SEAT_T, VENDOR_T, true), `/api/vendor/contests/${id}/decision`, {
      decision: 'accept',
    });
    expect(res.status).toBe(200);
    const pair = await pairRow();
    expect(pair.docsUrl).toBe(DOCS.proposed_value);
    expect(pair.maintainedBy).toBe('vendor');
    // The same audit shape the AECI-1090 owner edit writes on a pair.
    const updated = (await t.db.select().from(auditLog)).find(
      (r) => r.action === 'integration.updated',
    );
    expect(updated).toMatchObject({ entityType: 'connector_evidenced_pair', entityId: PAIR });
    expect(updated!.metadata).toMatchObject({
      reason: 'contest-accepted',
      maintenanceTransfer: true,
      connectorPowered: true,
      anchor: 'evidenced_pair',
    });
    const tags = res.send.mock.calls.flatMap((c) => (c[0] as { tags: string[] }).tags);
    expect(tags).toEqual(
      expect.arrayContaining([
        'pair:procore__revit',
        'product:revit',
        'product:procore',
        'product:syncezy-connect',
      ]),
    );
  });
});

// ─── The AECi accept on a pair ───────────────────────────────────────────────

describe('PATCH /api/admin/contests/:id on a pair', () => {
  it('applies a content accept to a claimed pair, with its audit row', async () => {
    // Filed while the pair was unclaimed, so it routed to AECi, and then claimed.
    const { body } = await submitPair(AUTH_A, DOCS);
    expect(body.contest.routed_to).toBe('aeci');
    await claimPair();
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/contests/${body.contest.id}`,
      {
        decision: 'accept',
        note: 'Applied for the owner (AECI-1191).',
        // AECI-1628: an applied-here accept names its source.
        sourceUrl: 'https://vendor.example/evidence',
      },
      'PATCH',
    );
    expect(res.status).toBe(200);
    expect(AdminContestSchema.parse(res.body).integration).toMatchObject({
      id: PAIR,
      anchor: 'evidenced_pair',
      connector: { id: P_CONNECTOR, name: 'SyncEzy Connect' },
    });
    expect((await pairRow()).docsUrl).toBe(DOCS.proposed_value);
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({
      integrationId: PAIR,
      anchor: 'evidenced_pair',
      appliedMode: 'applied-here',
    });
    // AECI-1628: recorded as AECi's correction, under the pair's own entity type.
    expect(await t.db.select().from(fieldOverrides)).toEqual([
      expect.objectContaining({
        entityType: 'connector_evidenced_pair',
        entityId: PAIR,
        field: 'docs_url',
        value: DOCS.proposed_value,
        sourceUrl: 'https://vendor.example/evidence',
        liftReason: 'record-only',
      }),
    ]);
  });

  it('writes nothing to an unclaimed pair (promote carries it)', async () => {
    const { body } = await submitPair(AUTH_A, DOCS);
    await call(
      AUTH_ADMIN,
      `/api/admin/contests/${body.contest.id}`,
      {
        decision: 'accept',
        note: 'Applied for the owner (AECI-1191).',
        // AECI-1628: an applied-here accept names its source.
        sourceUrl: 'https://vendor.example/evidence',
      },
      'PATCH',
    );
    expect((await pairRow()).docsUrl).toBe('https://example.test/docs');
    expect(fileIssue.mock.calls[0]![2]).toMatchObject({ appliedMode: 'upstream-only' });
  });

  it('records the owner and the claim on an owner approval (ruling C)', async () => {
    const { body } = await submitPair(AUTH_A, {
      field: 'owner',
      proposed_value: VENDOR_A,
      reason: 'x',
    });
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/contests/${body.contest.id}`,
      {
        decision: 'accept',
        note: 'Applied for the owner (AECI-1191).',
        // AECI-1628: an applied-here accept names its source.
        sourceUrl: 'https://vendor.example/evidence',
      },
      'PATCH',
    );
    expect(res.status).toBe(200);
    const pair = await pairRow();
    expect(pair.builtByVendorId).toBe(VENDOR_A);
    expect(pair.claimedAt).not.toBeNull();
    expect(await actions()).toContain('integration.claimed');
  });
});

// ─── Ruling B ────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/licenses/:id revoke of the last live license (ruling B retired)', () => {
  it('moves no contest: the owner keeps deciding on Free (AECI-1663)', async () => {
    await entitle(VENDOR_B);
    const powered = await submitIntegration(AUTH_A, I_POWERED, {
      field: 'name',
      proposed_value: 'Powered name',
      reason: 'x',
    });
    expect(powered.body.contest.routed_to).toBe('owner');
    await claimPair();
    await entitle(VENDOR_T);
    const onPair = await submitPair(AUTH_A, DOCS);
    expect(onPair.body.contest.routed_to).toBe('owner');

    expect((await revokeLast(VENDOR_B)).status).toBe(200);
    expect((await revokeLast(VENDOR_T)).status).toBe(200);
    expect((await contest(powered.body.contest.id)).routedTo).toBe('owner');
    expect((await contest(onPair.body.contest.id)).routedTo).toBe('owner');
    expect(await actions()).not.toContain('integration.contest.rerouted');

    // The owner, now on Free, still decides it.
    const owner = await call(
      seat(SEAT_B, VENDOR_B, false),
      `/api/vendor/contests/${powered.body.contest.id}/decision`,
      { decision: 'decline' },
    );
    expect(owner.status).toBe(200);
  });
});

// ─── The connectors read and the list ───────────────────────────────────────

describe('contest targets on the connectors read', () => {
  it('carries one target per delivered pair, framed on the owned product', async () => {
    const res = await call(AUTH_B, `/api/vendor/products/${P_B}/connectors`);
    expect(res.status).toBe(200);
    const body = VendorProductConnectorsResponseSchema.parse(res.body);
    const target = body.connectors[0]!.delivered_contest_targets[0]!;
    expect(target).toMatchObject({
      id: PAIR,
      context_product: { id: P_B },
      other_product: { id: P_A },
      connector: { id: P_CONNECTOR },
      owner: { id: VENDOR_T, name: 'SyncEzy' },
      is_owner: false,
      retired: false,
    });
    // B is endpoint B, so the stored a_to_b reads as inbound from B's seat.
    expect(target.contestable_fields.direction).toBe('inbound');
    expect(target.contestable_fields.mechanism_kind).toBeNull();
    expect(target.endpoint_vendors.map((v) => v.id).sort()).toEqual([VENDOR_A, VENDOR_B].sort());
  });

  it('lists a pair contest with its anchor on both sides', async () => {
    await submitPair(AUTH_A, DOCS);
    const res = await call(AUTH_A, '/api/vendor/contests');
    expect(res.body.submitted[0]).toMatchObject({ anchor: 'evidenced_pair', integration_id: PAIR });
  });
});

// ─── Protest ─────────────────────────────────────────────────────────────────

describe('a protest on a pair contest', () => {
  it('files against the owner’s decline as on any contest', async () => {
    await claimPair();
    await entitle(VENDOR_T);
    const { body } = await submitPair(AUTH_A, DOCS);
    const decline = await call(
      seat(SEAT_T, VENDOR_T, true),
      `/api/vendor/contests/${body.contest.id}/decision`,
      { decision: 'decline', note: 'No.' },
    );
    expect(decline.status).toBe(200);
    const res = await call(AUTH_A, `/api/vendor/contests/${body.contest.id}/protest`, {
      reason: 'The docs really moved.',
    });
    expect(res.status).toBe(200);
    expect((await contest(body.contest.id)).protestStatus).toBe('open');
  });
});

// ─── The in-batch guards ────────────────────────────────────────────────────

describe('the AECI-1092 batch sentinels', () => {
  const run = (stmts: unknown[]) => t.db.batch(stmts as unknown as BatchTuple);

  it('the state and value sentinels read the pair table for a pair anchor', async () => {
    const anchor = { kind: 'evidenced_pair' as const, id: PAIR };
    await expect(
      run([
        contestIntegrationStateSentinel(t.db, anchor, { claimed: false, ownerVendorId: VENDOR_T }),
      ]),
    ).resolves.toBeDefined();
    const moved = await run([
      contestIntegrationStateSentinel(t.db, anchor, { claimed: true, ownerVendorId: VENDOR_T }),
    ]).catch((e: unknown) => e);
    expect(isContestRaceError(moved)).toBe(true);
    await expect(
      run([contestValueUnchangedSentinel(t.db, anchor, 'docs_url', 'https://example.test/docs')]),
    ).resolves.toBeDefined();
    const stale = await run([
      contestValueUnchangedSentinel(t.db, anchor, 'docs_url', 'https://other.test'),
    ]).catch((e: unknown) => e);
    expect(isContestRaceError(stale)).toBe(true);
  });
});

// ─── Review findings (2026-09-23) ────────────────────────────────────────────

const transitionsFor = async (workflowId: string | null) =>
  (await t.db.select().from(workflowTransitions)).filter((r) => r.workflowId === workflowId);

describe('a row that BECOMES connector-powered (review MAJOR 1)', () => {
  // C also owns endpoint A here, so two vendors can hold open contests on the row.
  beforeEach(async () => {
    await t.db
      .insert(productVendors)
      .values({ productId: P_A, vendorId: VENDOR_C, isPrimary: false });
  });

  async function openContests() {
    const name = await submitIntegration(AUTH_A, I_PLAIN, {
      field: 'name',
      proposed_value: 'Better name',
      reason: 'x',
    });
    const kind = await submitIntegration(AUTH_C, I_PLAIN, {
      field: 'mechanism_kind',
      proposed_value: 'marketplace-app',
      reason: 'x',
    });
    const toIpaas = await submitIntegration(AUTH_A, I_PLAIN, {
      field: 'mechanism_kind',
      proposed_value: 'iPaaS',
      reason: 'It runs through an iPaaS.',
    });
    expect(name.body.contest.routed_to).toBe('owner');
    expect(kind.body.contest.routed_to).toBe('owner');
    expect(toIpaas.body.contest.routed_to).toBe('aeci');
    return {
      name: name.body.contest.id as string,
      kind: kind.body.contest.id as string,
      toIpaas: toIpaas.body.contest.id as string,
    };
  }

  it('moves only the type contests of a Free-plan owner, with audit and transitions (AECI-1663)', async () => {
    const ids = await openContests();
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/contests/${ids.toIpaas}`,
      {
        decision: 'accept',
        note: 'Applied for the owner (AECI-1191).',
        // AECI-1628: an applied-here accept names its source.
        sourceUrl: 'https://vendor.example/evidence',
      },
      'PATCH',
    );
    expect(res.status).toBe(200);
    expect(
      (await t.db.select().from(integrations).where(eq(integrations.id, I_PLAIN)))[0]!
        .mechanismKind,
    ).toBe('iPaaS');
    // Ruling A moves the type contest. Ruling 14 keeps the content one with the owner,
    // whatever its plan (VENDOR_B holds no license here).
    const kind = await contest(ids.kind);
    expect(kind.routedTo).toBe('aeci');
    const moved = await transitionsFor(kind.workflowId);
    expect(moved.some((r) => r.fromState === 'open' && r.toState === 'open')).toBe(true);
    expect((await contest(ids.name)).routedTo).toBe('owner');
    const rerouted = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === 'integration.contest.rerouted',
    );
    expect(rerouted.map((r) => r.entityId)).toEqual([ids.kind]);
    expect(rerouted[0]!.metadata).toMatchObject({ reason: 'became-connector-powered' });
    // The Free-plan owner decides the content contest it kept.
    const decided = await call(AUTH_B, `/api/vendor/contests/${ids.name}/decision`, {
      decision: 'decline',
    });
    expect(decided.status).toBe(200);
  });

  it('does the same for an owner with a plan', async () => {
    await entitle(VENDOR_B);
    const ids = await openContests();
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/contests/${ids.toIpaas}`,
      {
        decision: 'accept',
        note: 'Applied for the owner (AECI-1191).',
        // AECI-1628: an applied-here accept names its source.
        sourceUrl: 'https://vendor.example/evidence',
      },
      'PATCH',
    );
    expect(res.status).toBe(200);
    expect((await contest(ids.name)).routedTo).toBe('owner');
    expect((await contest(ids.kind)).routedTo).toBe('aeci');
    // The entitled owner can still decide the content contest it kept.
    const decided = await call(
      seat(SEAT_B, VENDOR_B, true),
      `/api/vendor/contests/${ids.name}/decision`,
      { decision: 'decline' },
    );
    expect(decided.status).toBe(200);
  });

  it('refuses an owner accept that would make its own row connector-powered (422)', async () => {
    // A contest routed to the owner before AECI-1092 could propose iPaaS.
    const res = await submitIntegration(AUTH_A, I_PLAIN, {
      field: 'mechanism_kind',
      proposed_value: 'marketplace-app',
      reason: 'x',
    });
    const id = res.body.contest.id as string;
    await t.db
      .update(integrationFieldChallenges)
      .set({ proposedValue: 'iPaaS' })
      .where(eq(integrationFieldChallenges.id, id));
    const accept = await call(AUTH_B, `/api/vendor/contests/${id}/decision`, {
      decision: 'accept',
    });
    expect(accept.status).toBe(422);
    expect(accept.body.error.code).toBe('INTEGRATION_INVALID_VALUE');
    expect(
      (await t.db.select().from(integrations).where(eq(integrations.id, I_PLAIN)))[0]!
        .mechanismKind,
    ).toBe('native');
    expect((await contest(id)).status).toBe('open');
    const decline = await call(AUTH_B, `/api/vendor/contests/${id}/decision`, {
      decision: 'decline',
    });
    expect(decline.status).toBe(200);
  });
});

describe('batched telemetry on the admin tail (review MAJOR 2)', () => {
  it('forwards every audit row and the transition of an accept in ONE request', async () => {
    const { body } = await submitPair(AUTH_A, {
      field: 'owner',
      proposed_value: VENDOR_A,
      reason: 'x',
    });
    vi.mocked(logBatchToPosthog).mockClear();
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/contests/${body.contest.id}`,
      {
        decision: 'accept',
        note: 'Applied for the owner (AECI-1191).',
        // AECI-1628: an applied-here accept names its source.
        sourceUrl: 'https://vendor.example/evidence',
      },
      'PATCH',
    );
    expect(res.status).toBe(200);
    const moderation = vi
      .mocked(logBatchToPosthog)
      .mock.calls.filter((c) => c[3].some((e) => e.source === 'admin-moderation'));
    expect(moderation).toHaveLength(1);
    // decision + claim + one notification per other endpoint vendor + contest
    // notification, and the transition.
    const events = moderation[0]![3];
    expect(events.filter((e) => String(e.message).startsWith('workflow '))).toHaveLength(1);
    expect(
      events.filter((e) => String(e.message).startsWith('audit ')).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
