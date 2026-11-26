/**
 * An accepted existence ("not offered") report acts on the whole pair key (AECI-2170,
 * ruled 2026-11-25, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.3).
 *
 * Covered: every live vendor-held row on the key, both tables and either endpoint
 * order, is retired in one batch whoever owns it; each owner is told with the reason
 * and the report id; each endpoint vendor gets one notice for the pair; an audit row
 * per row; the counts and the purge; an AECi-held row is left alone and listed for
 * retraction (`?retractions=true`); a row that joins the key or changes owner between
 * the read and the batch answers 409 with nothing written; the owner restore and a
 * Sync Service re-create are refused; a key already retired records 'already-retired'.
 */

import {
  AdminPairContestResponseSchema,
  AdminPairContestsResponseSchema,
  ListVendorNotificationsResponseSchema,
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
  syncServicePairContests,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { findSyncServicePairBlock } from '../lib/integration-twins';
import { pairContestWireRows } from '../lib/sync-service-pair-contests';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminDecidePairContestHandler,
  createAdminListPairContestsHandler,
} from './admin-pair-contests';
import { createRestoreIntegrationHandler } from './vendor-integration-retire';
import { createListVendorNotificationsHandler } from './vendor-notifications';
import { createSubmitPairContestHandler } from './vendor-pair-contests';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const RIVETS = uuid(1); // the Sync Service's vendor; owns PAIR
const PROCORE = uuid(2);
const ACUMATICA = uuid(3); // files the report
const BOLT = uuid(4); // a third party; owns INT_BOLT
const NOBODY = uuid(5);
const P_PROCORE = uuid(10);
const P_ACUMATICA = uuid(11);
const S_SYNC = uuid(20);
const PAIR = uuid(30); // evidenced pair, claimed by Rivets
const INT_BOLT = uuid(31); // integrations row on the same key, reversed, claimed by Bolt
const INT_AECI = uuid(32); // integrations row on the same key, AECi-held

const seat = (
  n: number,
  vendorId: string | null,
  role = 'vendor_admin',
): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: role as AuthzVariables['auth']['role'],
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_RIVETS = seat(1, RIVETS);
const AUTH_ACUMATICA = seat(3, ACUMATICA);
const AUTH_ADMIN = seat(9, null, 'admin');

const PROOF = 'https://rivets.example/changelog';
const NOTE = 'Rivets confirmed it is no longer offered.';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: RIVETS, slug: 'rivets', companyName: 'Rivets' },
    { id: PROCORE, slug: 'procore-inc', companyName: 'Procore Inc' },
    { id: ACUMATICA, slug: 'acumatica-inc', companyName: 'Acumatica Inc' },
    { id: BOLT, slug: 'bolt', companyName: 'Bolt' },
    { id: NOBODY, slug: 'nobody', companyName: 'Nobody' },
  ]);
  const promoted = { promotionStatus: 'promoted' } as const;
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', integrationCount: 5, ...promoted },
    { id: P_ACUMATICA, slug: 'acumatica', name: 'Acumatica', integrationCount: 5, ...promoted },
    {
      id: S_SYNC,
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
      integrationCount: 5,
      ...promoted,
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_PROCORE, vendorId: PROCORE, isPrimary: true },
    { productId: P_ACUMATICA, vendorId: ACUMATICA, isPrimary: true },
    { productId: S_SYNC, vendorId: RIVETS, isPrimary: true },
  ]);
  await t.db.insert(profiles).values(
    [AUTH_RIVETS, AUTH_ACUMATICA, AUTH_ADMIN].map((auth) => ({
      id: auth.userId,
      role: auth.role,
      vendorId: auth.vendorId,
    })),
  );
  await t.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    name: 'Procore and Acumatica (Rivets Sync)',
    connectorProductId: S_SYNC,
    productAId: P_PROCORE,
    productBId: P_ACUMATICA,
    direction: 'a_to_b',
    builtByVendorId: RIVETS,
    claimedAt: '2026-10-01T00:00:00.000Z',
    origin: 'vendor',
    maintainedBy: 'vendor',
  });
  await t.db.insert(integrations).values({
    id: INT_BOLT,
    name: 'Acumatica to Procore by Bolt',
    // Reversed: an `integrations` row is on the key in either order.
    sourceProductId: P_ACUMATICA,
    targetProductId: P_PROCORE,
    poweredByProductId: S_SYNC,
    mechanismKind: 'iPaaS',
    builtByVendorId: BOLT,
    claimedAt: '2026-10-02T00:00:00.000Z',
    origin: 'vendor',
    maintainedBy: 'vendor',
  });
});
afterEach(() => t.dispose());

const addAeciRow = () =>
  t.db.insert(integrations).values({
    id: INT_AECI,
    name: 'Procore to Acumatica (seeded)',
    sourceProductId: P_PROCORE,
    targetProductId: P_ACUMATICA,
    poweredByProductId: S_SYNC,
    mechanismKind: 'iPaaS',
  });

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/integrations/:id/pair-contests', createSubmitPairContestHandler(t.factory));
  a.post('/api/vendor/integrations/:id/restore', createRestoreIntegrationHandler(t.factory));
  a.get('/api/admin/pair-contests', createAdminListPairContestsHandler(t.factory));
  a.patch('/api/admin/pair-contests/:id', createAdminDecidePairContestHandler(t.factory));
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
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

const file = async (id = PAIR) =>
  (
    await call(AUTH_ACUMATICA, `/api/vendor/integrations/${id}/pair-contests`, 'POST', {
      kind: 'existence',
      reason: 'Rivets stopped offering this in 2026.',
    })
  ).body.contest.id as string;
const accept = (id: string) =>
  call(AUTH_ADMIN, `/api/admin/pair-contests/${id}`, 'PATCH', {
    decision: 'accept',
    note: NOTE,
    source_url: PROOF,
  });

const pairRow = async () =>
  (await t.db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, PAIR),
  }))!;
const intRow = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const auditsFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));
const meta = (row: { metadata: unknown }) => row.metadata as Record<string, unknown>;
const retireNotices = async () =>
  (await auditsFor('notification.sent')).filter((r) => meta(r).kind === 'integration_retire');

/** Run a statement just before the handler's batch, once: a write that lands between
 *  the accept's reads and its commit. */
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

describe('an existence accept retires every vendor-held row on the key', () => {
  it('retires both rows, whoever owns them, in one batch, and tells everyone once', async () => {
    const id = await file();
    const res = await accept(id);
    expect(res.status).toBe(200);
    const { contest } = AdminPairContestResponseSchema.parse(res.body);
    expect(contest).toMatchObject({ status: 'accepted', accept_mode: 'retired', retract_by: null });
    expect(contest.key_rows?.map((r) => [r.id, r.held, r.retired])).toEqual([
      [PAIR, 'vendor', true],
      [INT_BOLT, 'vendor', true],
    ]);

    // Both rows, both tables, retired by AECi.
    expect(await pairRow()).toMatchObject({ retiredBy: 'aeci' });
    expect((await pairRow()).retiredAt).not.toBeNull();
    expect(await intRow(INT_BOLT)).toMatchObject({ retiredBy: 'aeci' });
    expect((await intRow(INT_BOLT)).retiredAt).not.toBeNull();

    // One `integration.retired` audit row per row, with the proof on the internal note.
    const retired = await auditsFor('integration.retired');
    expect(retired.map((r) => r.entityId).sort()).toEqual([INT_BOLT, PAIR].sort());
    for (const r of retired) expect(String(meta(r).internalNote)).toContain(PROOF);

    // Each owner hears on its own row, with the reason and the report. Each endpoint
    // vendor hears once for the pair, with neither.
    const notices = await retireNotices();
    const byRecipient = new Map<string, Record<string, unknown>[]>();
    for (const n of notices) {
      byRecipient.set(n.vendorId!, [...(byRecipient.get(n.vendorId!) ?? []), meta(n)]);
    }
    expect(byRecipient.get(RIVETS)).toEqual([
      expect.objectContaining({ integrationId: PAIR, reason: NOTE, existenceReportId: id }),
    ]);
    expect(byRecipient.get(BOLT)).toEqual([
      expect.objectContaining({ integrationId: INT_BOLT, reason: NOTE, existenceReportId: id }),
    ]);
    for (const endpoint of [PROCORE, ACUMATICA]) {
      const mine = byRecipient.get(endpoint)!;
      expect(mine).toHaveLength(1);
      expect(mine[0]).not.toHaveProperty('reason');
      expect(mine[0]).not.toHaveProperty('existenceReportId');
    }

    // The decision row records what the accept did on the key.
    const [decision] = await auditsFor('integration.pair_contest.accepted');
    expect(meta(decision!)).toMatchObject({
      retiredRowIds: [PAIR, INT_BOLT],
      upstreamRowIds: [],
      alreadyRetiredRowIds: [],
    });

    // The counts were recomputed in the batch over the key as it left it.
    const counts = await t.db
      .select({ id: products.id, n: products.integrationCount })
      .from(products);
    expect(Object.fromEntries(counts.map((c) => [c.id, c.n]))).toEqual({
      [P_PROCORE]: 0,
      [P_ACUMATICA]: 0,
      [S_SYNC]: 0,
    });

    // One purge covers every row: the pair, both endpoints, the connector, both owners.
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'moderation',
        tags: expect.arrayContaining([
          'pair:acumatica__procore',
          'product:procore',
          'product:acumatica',
          'product:rivets-sync',
          'vendor:rivets',
          'vendor:bolt',
        ]),
      }),
    );
  });

  it("the owner's portal feed carries the reason and the report", async () => {
    const id = await file();
    await accept(id);
    const feed = await call(AUTH_RIVETS, '/api/vendor/notifications', 'GET');
    const parsed = ListVendorNotificationsResponseSchema.parse(feed.body);
    expect(parsed.notifications).toContainEqual(
      expect.objectContaining({
        kind: 'integration_retire',
        integration_id: PAIR,
        retired_by: 'aeci',
        reason: NOTE,
        existence_report_id: id,
      }),
    );
  });

  it('the owner cannot restore it, and the Sync Service cannot add the pair again', async () => {
    await accept(await file());
    const restore = await call(AUTH_RIVETS, `/api/vendor/integrations/${PAIR}/restore`);
    expect(restore.status).toBe(403);
    expect(restore.body.error.code).toBe('INTEGRATION_RETIRED_BY_AECI');
    expect(
      await findSyncServicePairBlock(t.db, {
        connectorProductId: S_SYNC,
        productAId: P_PROCORE,
        productBId: P_ACUMATICA,
      }),
    ).not.toBeNull();
  });

  it('a key already retired records already-retired and writes no catalog data', async () => {
    const id = await file();
    const at = '2026-11-20T00:00:00.000Z';
    await t.db
      .update(connectorEvidencedPairs)
      .set({ retiredAt: at, retiredBy: 'owner' })
      .where(eq(connectorEvidencedPairs.id, PAIR));
    await t.db
      .update(integrations)
      .set({ retiredAt: at, retiredBy: 'owner' })
      .where(eq(integrations.id, INT_BOLT));
    const res = await accept(id);
    expect(res.status).toBe(200);
    expect(res.body.contest.accept_mode).toBe('already-retired');
    expect(await auditsFor('integration.retired')).toEqual([]);
    expect((await pairRow()).retiredBy).toBe('owner');
  });
});

describe('an AECi-held row on the key is left for the review app', () => {
  it('retires the vendor-held rows, leaves the AECi row, and lists it to retract', async () => {
    await addAeciRow();
    const id = await file();
    const res = await accept(id);
    expect(res.status).toBe(200);
    const { contest } = AdminPairContestResponseSchema.parse(res.body);
    expect(contest.accept_mode).toBe('retired');
    expect(contest.retract_by).not.toBeNull();
    expect(contest.key_rows?.find((r) => r.id === INT_AECI)).toMatchObject({
      held: 'aeci',
      retired: false,
      owner_vendor_id: null,
    });
    expect(contest.key_rows?.find((r) => r.id === INT_BOLT)).toMatchObject({
      owner_name: 'Bolt',
    });
    expect((await intRow(INT_AECI)).retiredAt).toBeNull();
    const [decision] = await auditsFor('integration.pair_contest.accepted');
    expect(meta(decision!)).toMatchObject({
      retiredRowIds: [PAIR, INT_BOLT],
      upstreamRowIds: [INT_AECI],
    });

    const list = await call(AUTH_ADMIN, '/api/admin/pair-contests?retractions=true', 'GET');
    const { data } = AdminPairContestsResponseSchema.parse(list.body);
    expect(data.map((r) => r.id)).toEqual([id]);
    expect(data[0]!.retract_by).toBe(contest.retract_by);

    // Once the review app retracts it (promote retires or deletes it), it drops off.
    await t.db.delete(integrations).where(eq(integrations.id, INT_AECI));
    const after = await call(AUTH_ADMIN, '/api/admin/pair-contests?retractions=true', 'GET');
    expect(after.body.data).toEqual([]);
  });

  it('with only an AECi-held row live, records upstream-only and writes no catalog data', async () => {
    await addAeciRow();
    const id = await file(INT_AECI);
    const at = '2026-11-20T00:00:00.000Z';
    await t.db
      .update(connectorEvidencedPairs)
      .set({ retiredAt: at, retiredBy: 'owner' })
      .where(eq(connectorEvidencedPairs.id, PAIR));
    await t.db
      .update(integrations)
      .set({ retiredAt: at, retiredBy: 'owner' })
      .where(eq(integrations.id, INT_BOLT));
    const res = await accept(id);
    expect(res.body.contest).toMatchObject({ accept_mode: 'upstream-only' });
    expect(res.body.contest.retract_by).not.toBeNull();
    expect(await auditsFor('integration.retired')).toEqual([]);
  });

  it('the vendor read of the report carries no key rows', async () => {
    await addAeciRow();
    const id = await file();
    await accept(id);
    const row = await t.db.query.syncServicePairContests.findFirst({
      where: eq(syncServicePairContests.id, id),
    });
    expect(row?.status).toBe('accepted');
    const [wire] = await pairContestWireRows(t.db, [row!]);
    expect(wire).not.toHaveProperty('key_rows');
    expect(wire).not.toHaveProperty('retract_by');
  });
});

describe('the key is held at commit', () => {
  it.each([
    [
      'a row joined the key',
      "INSERT INTO integrations (id, source_product_id, target_product_id, powered_by_product_id, mechanism_kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'iPaaS', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')",
      [uuid(39), P_PROCORE, P_ACUMATICA, S_SYNC],
    ],
    [
      "a row's owner changed",
      'UPDATE integrations SET built_by_vendor_id = ? WHERE id = ?',
      [NOBODY, INT_BOLT],
    ],
    [
      'a row was retired',
      "UPDATE integrations SET retired_at = '2026-11-25T00:00:00.000Z', retired_by = 'owner' WHERE id = ?",
      [INT_BOLT],
    ],
  ])('%s: 409 PAIR_CONTEST_CHANGED, nothing written', async (_label, statement, params) => {
    const id = await file();
    const auditsBefore = (await t.db.select().from(auditLog)).length;
    raceBeforeBatch(statement, ...params);
    const res = await accept(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAIR_CONTEST_CHANGED');
    expect((await pairRow()).retiredAt).toBeNull();
    const report = await t.db.query.syncServicePairContests.findFirst({
      where: eq(syncServicePairContests.id, id),
    });
    expect(report?.status).toBe('open');
    expect((await t.db.select().from(auditLog)).length).toBe(auditsBefore);
  });

  it('an AECi-held row that became vendor-held also aborts the upstream-only accept', async () => {
    await addAeciRow();
    const id = await file(INT_AECI);
    const at = '2026-11-20T00:00:00.000Z';
    await t.db
      .update(connectorEvidencedPairs)
      .set({ retiredAt: at, retiredBy: 'owner' })
      .where(eq(connectorEvidencedPairs.id, PAIR));
    await t.db
      .update(integrations)
      .set({ retiredAt: at, retiredBy: 'owner' })
      .where(eq(integrations.id, INT_BOLT));
    raceBeforeBatch(
      "UPDATE integrations SET claimed_at = '2026-11-25T00:00:00.000Z', built_by_vendor_id = ? WHERE id = ?",
      BOLT,
      INT_AECI,
    );
    const res = await accept(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAIR_CONTEST_CHANGED');
  });

  it('a report decided meanwhile answers PAIR_CONTEST_NOT_OPEN', async () => {
    const id = await file();
    raceBeforeBatch("UPDATE sync_service_pair_contests SET status = 'declined' WHERE id = ?", id);
    const res = await accept(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAIR_CONTEST_NOT_OPEN');
    expect((await pairRow()).retiredAt).toBeNull();
  });
});
