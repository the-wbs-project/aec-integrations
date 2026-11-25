/**
 * AECI-2045 — a Sync Service sees and asks for the pairs it delivers, and AECi sets
 * the owner of a connector-delivered pair directly.
 *
 * Real migrations on in-memory SQLite, `db.batch` shimmed onto one transaction, so
 * the audit-in-batch rule and the race sentinels are exercised, not mocked. Blocks:
 *
 *   - `GET /api/vendor/products/:id/delivered-pairs`: ownership 404, empty on a
 *     product that is not a Sync Service, both tables, the caller's own and retired
 *     rows left out, the caller's open request.
 *   - The connector-holder authority on `POST /api/vendor/integrations/:id/contests`
 *     (§11b.2): only an `owner` contest naming itself, routed to AECi and alerted;
 *     an Integration platform's vendor and a third vendor keep the flat 404. An AECi
 *     accept then records it as the owner and claims the row.
 *   - `GET /api/admin/products/:id/delivered-pairs` and
 *     `PUT /api/admin/integrations/:id/owner`.
 */

import {
  AdminDeliveredPairsResponseSchema,
  AdminSetIntegrationOwnerResponseSchema,
  ListVendorDeliveredPairsResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../posthog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../posthog')>();
  return { ...real, logBatchToPosthog: vi.fn() };
});

import {
  auditLog,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { isIntegrationClaimed } from '../lib/integration-contests';
import { logBatchToPosthog } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createModerateContestHandler } from './admin-contests';
import {
  createAdminDeliveredPairsHandler,
  createAdminSetIntegrationOwnerHandler,
} from './admin-integration-owner';
import { createSubmitContestHandler } from './vendor-contests';
import { createListVendorDeliveredPairsHandler } from './vendor-delivered-pairs';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A and B make the two endpoints. R (Rivets) sells the Sync Service product. Z sells
// an Integration platform. C owns nothing here.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_R = uuid(3);
const VENDOR_Z = uuid(4);
const VENDOR_C = uuid(5);

const P_A = uuid(10);
const P_B = uuid(11);
const P_SYNC = uuid(12);
const P_ZAP = uuid(13);
const P_C = uuid(14);
const P_B2 = uuid(15);
const P_B3 = uuid(16);
const P_B4 = uuid(17);

const PAIR_UNOWNED = uuid(30);
const PAIR_OTHER = uuid(31); // owned and claimed by B
const PAIR_MINE = uuid(32); // owned by R
const PAIR_RETIRED = uuid(33);
const ROW_POWERED = uuid(34); // integrations row, powered by Sync, unowned
const PAIR_ZAP = uuid(35); // through the Integration platform
const ROW_DIRECT = uuid(36); // a direct integration, no connector

const SEAT_R = uuid(100);
const SEAT_Z = uuid(101);
const SEAT_C = uuid(102);
const ADMIN = uuid(900);
const CLAIMED_AT = '2026-09-01T00:00:00.000Z';

type Auth = AuthzVariables['auth'];
const seat = (userId: string, vendorId: string): Auth => ({
  userId,
  email: `${userId}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_R = seat(SEAT_R, VENDOR_R);
const AUTH_Z = seat(SEAT_Z, VENDOR_Z);
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
let factory: DbFactory | null = null;
const sendAlert = vi.fn().mockResolvedValue('sent');
const fileIssue = vi.fn().mockResolvedValue({ status: 'created' });

beforeEach(async () => {
  factory = null;
  sendAlert.mockClear();
  fileIssue.mockClear();
  vi.mocked(logBatchToPosthog).mockClear();
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'procore-co', companyName: 'Procore' },
    { id: VENDOR_B, slug: 'acumatica-co', companyName: 'Acumatica' },
    { id: VENDOR_R, slug: 'rivets', companyName: 'Rivets' },
    { id: VENDOR_Z, slug: 'zapier', companyName: 'Zapier' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'procore', name: 'Procore' },
    { id: P_B, slug: 'acumatica', name: 'Acumatica' },
    {
      id: P_SYNC,
      slug: 'sync',
      name: 'Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
    },
    {
      id: P_ZAP,
      slug: 'zapier',
      name: 'Zapier',
      productRole: 'connector',
      connectorKind: 'integration_platform',
    },
    { id: P_C, slug: 'archicad', name: 'ArchiCAD' },
    { id: P_B2, slug: 'qbo', name: 'QuickBooks Online' },
    { id: P_B3, slug: 'bc', name: 'Business Central' },
    { id: P_B4, slug: 'ies', name: 'Intuit Enterprise Suite' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_B, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_SYNC, vendorId: VENDOR_R, isPrimary: true },
    { productId: P_ZAP, vendorId: VENDOR_Z, isPrimary: true },
    { productId: P_C, vendorId: VENDOR_C, isPrimary: true },
    { productId: P_B2, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_B3, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_B4, vendorId: VENDOR_B, isPrimary: true },
  ]);
  const pair = (id: string, extra: Partial<typeof connectorEvidencedPairs.$inferInsert>) => ({
    id,
    connectorProductId: P_SYNC,
    productAId: P_A,
    productBId: P_B,
    direction: 'a_to_b',
    ...extra,
  });
  await t.db.insert(connectorEvidencedPairs).values([
    pair(PAIR_UNOWNED, { name: 'B Procore and QuickBooks', productBId: P_B2 }),
    pair(PAIR_OTHER, {
      name: 'A Procore to Acumatica',
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
    }),
    pair(PAIR_MINE, { name: 'C ours', productBId: P_B3, builtByVendorId: VENDOR_R }),
    pair(PAIR_RETIRED, {
      name: 'D retired',
      productBId: P_B4,
      retiredAt: CLAIMED_AT,
      retiredBy: 'aeci',
    }),
    pair(PAIR_ZAP, { name: 'E zap', connectorProductId: P_ZAP }),
  ]);
  await t.db.insert(integrations).values([
    {
      id: ROW_POWERED,
      name: 'F powered row',
      sourceProductId: P_A,
      targetProductId: P_B,
      mechanismKind: 'iPaaS',
      poweredByProductId: P_SYNC,
    },
    {
      id: ROW_DIRECT,
      name: 'G direct',
      sourceProductId: P_A,
      targetProductId: P_B,
      mechanismKind: 'native',
      builtByVendorId: VENDOR_A,
    },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_R, role: 'vendor_admin', vendorId: VENDOR_R },
    { id: SEAT_Z, role: 'vendor_admin', vendorId: VENDOR_Z },
    { id: SEAT_C, role: 'vendor_admin', vendorId: VENDOR_C },
    { id: ADMIN, role: 'admin' },
  ]);
});
afterEach(() => t.dispose());

function app(auth: Auth) {
  const f: DbFactory = factory ?? t.factory;
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/products/:id/delivered-pairs', createListVendorDeliveredPairsHandler(f));
  a.post(
    '/api/vendor/integrations/:id/contests',
    createSubmitContestHandler(f, isIntegrationClaimed, undefined, sendAlert),
  );
  a.patch('/api/admin/contests/:id', createModerateContestHandler(f, fileIssue));
  a.get('/api/admin/products/:id/delivered-pairs', createAdminDeliveredPairsHandler(f));
  a.put('/api/admin/integrations/:id/owner', createAdminSetIntegrationOwnerHandler(f));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(auth: Auth, path: string, body?: unknown, method = 'POST') {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body === undefined
      ? { method: 'GET' }
      : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const askOwner = (auth: Auth, id: string, proposed: string | null, field = 'owner') =>
  call(auth, `/api/vendor/integrations/${id}/contests`, {
    field,
    proposed_value: field === 'owner' ? proposed : 'https://example.test/x',
    reason: 'We sell and run this sync.',
  });
const pairRow = async (id: string) =>
  (await t.db.select().from(connectorEvidencedPairs).where(eq(connectorEvidencedPairs.id, id)))[0]!;

// ─── The vendor read ─────────────────────────────────────────────────────────

describe('GET /api/vendor/products/:id/delivered-pairs', () => {
  it('lists the live pairs it delivers that it does not own, from both tables, by name', async () => {
    const { status, body } = await call(AUTH_R, `/api/vendor/products/${P_SYNC}/delivered-pairs`);
    expect(status).toBe(200);
    const parsed = ListVendorDeliveredPairsResponseSchema.parse(body);
    expect(parsed.pairs.map((p) => p.id)).toEqual([PAIR_OTHER, PAIR_UNOWNED, ROW_POWERED]);
    expect(parsed.pairs[0]).toMatchObject({
      anchor: 'evidenced_pair',
      owner: { id: VENDOR_B, name: 'Acumatica' },
      claimed: true,
      product_a: { id: P_A, name: 'Procore' },
      product_b: { id: P_B, name: 'Acumatica' },
      open_request_id: null,
    });
    expect(parsed.pairs[2]).toMatchObject({ anchor: 'integration', owner: null, claimed: false });
  });

  it('carries the caller’s own open owner request', async () => {
    const filed = await askOwner(AUTH_R, PAIR_UNOWNED, VENDOR_R);
    expect(filed.status).toBe(201);
    const { body } = await call(AUTH_R, `/api/vendor/products/${P_SYNC}/delivered-pairs`);
    const row = (body.pairs as JsonBody[]).find((p) => p.id === PAIR_UNOWNED)!;
    expect(row.open_request_id).toBe(filed.body.contest.id);
  });

  it('answers an empty list on an Integration platform', async () => {
    const { status, body } = await call(AUTH_Z, `/api/vendor/products/${P_ZAP}/delivered-pairs`);
    expect(status).toBe(200);
    expect(body).toEqual({ pairs: [] });
  });

  it('is the flat 404 on another company’s product', async () => {
    const { status } = await call(AUTH_C, `/api/vendor/products/${P_SYNC}/delivered-pairs`);
    expect(status).toBe(404);
  });
});

// ─── The connector-holder authority (§11b.2) ─────────────────────────────────

describe('POST /api/vendor/integrations/:id/contests by the Sync Service’s vendor', () => {
  it('files an owner request naming itself, routed to AECi, with the AECi alert', async () => {
    const res = await askOwner(AUTH_R, PAIR_OTHER, VENDOR_R);
    expect(res.status).toBe(201);
    expect(res.body.contest).toMatchObject({
      field: 'owner',
      routed_to: 'aeci',
      anchor: 'evidenced_pair',
    });
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0]![1]).toMatchObject({ routeReason: 'owner-field' });
    const audit = await t.db.select().from(auditLog);
    expect(audit.map((r) => r.action)).toContain('integration.contest.submitted');
  });

  it('works on an integrations row the Sync Service powers', async () => {
    const res = await askOwner(AUTH_R, ROW_POWERED, VENDOR_R);
    expect(res.status).toBe(201);
    expect(res.body.contest.anchor).toBe('integration');
  });

  it('refuses any other field with 403 CONTEST_CONNECTOR_OWNER_ONLY', async () => {
    const res = await askOwner(AUTH_R, PAIR_UNOWNED, null, 'docs_url');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CONTEST_CONNECTOR_OWNER_ONLY');
  });

  it('refuses naming another company, or nobody, with 422', async () => {
    for (const proposed of [VENDOR_A, null]) {
      const res = await askOwner(AUTH_R, PAIR_UNOWNED, proposed);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CONTEST_INVALID_VALUE');
    }
  });

  it('keeps one open request per row: a second is 409 CONTEST_DUPLICATE', async () => {
    expect((await askOwner(AUTH_R, PAIR_UNOWNED, VENDOR_R)).status).toBe(201);
    const again = await askOwner(AUTH_R, PAIR_UNOWNED, VENDOR_R);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONTEST_DUPLICATE');
  });

  it('keeps the flat 404 for an Integration platform’s vendor', async () => {
    const res = await askOwner(AUTH_Z, PAIR_ZAP, VENDOR_Z);
    expect(res.status).toBe(404);
  });

  it('keeps the flat 404 for a company that holds neither endpoint nor the connector', async () => {
    const res = await askOwner(AUTH_C, PAIR_UNOWNED, VENDOR_C);
    expect(res.status).toBe(404);
  });

  it('an AECi accept records the Sync Service as the owner and claims the row', async () => {
    const filed = await askOwner(AUTH_R, PAIR_UNOWNED, VENDOR_R);
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/contests/${filed.body.contest.id}`,
      { decision: 'accept', note: 'Rivets sells this pair.' },
      'PATCH',
    );
    expect(res.status).toBe(200);
    const row = await pairRow(PAIR_UNOWNED);
    expect(row.builtByVendorId).toBe(VENDOR_R);
    expect(row.claimedAt).not.toBeNull();
  });
});

// ─── Admin ───────────────────────────────────────────────────────────────────

describe('GET /api/admin/products/:id/delivered-pairs', () => {
  it('lists every pair in both tables, live and retired, with owner and claim', async () => {
    const { status, body } = await call(
      AUTH_ADMIN,
      `/api/admin/products/${P_SYNC}/delivered-pairs`,
    );
    expect(status).toBe(200);
    const parsed = AdminDeliveredPairsResponseSchema.parse(body);
    expect(parsed.connector).toMatchObject({ id: P_SYNC, connector_kind: 'sync_service' });
    expect(parsed.connector_vendors).toEqual([{ id: VENDOR_R, name: 'Rivets' }]);
    expect(parsed.pairs.map((p) => p.id)).toEqual([
      PAIR_OTHER,
      PAIR_UNOWNED,
      PAIR_MINE,
      PAIR_RETIRED,
      ROW_POWERED,
    ]);
    const retired = parsed.pairs.find((p) => p.id === PAIR_RETIRED)!;
    expect(retired).toMatchObject({ retired_by: 'aeci' });
    expect(parsed.pairs[0]!.endpoint_vendors.map((v) => v.name)).toEqual(['Acumatica', 'Procore']);
  });

  it('404s an unknown product and 409s an application', async () => {
    expect(
      (await call(AUTH_ADMIN, `/api/admin/products/${uuid(999)}/delivered-pairs`)).status,
    ).toBe(404);
    const app = await call(AUTH_ADMIN, `/api/admin/products/${P_A}/delivered-pairs`);
    expect(app.status).toBe(409);
    expect(app.body.error.code).toBe('CONNECTOR_KIND_NOT_CONNECTOR');
  });
});

describe('PUT /api/admin/integrations/:id/owner', () => {
  const setOwner = (id: string, owner: string | null, reason: unknown = 'Rivets sells it.') =>
    call(
      AUTH_ADMIN,
      `/api/admin/integrations/${id}/owner`,
      { owner_vendor_id: owner, reason },
      'PUT',
    );

  it('reassigns a claimed pair: the claim clears, with its audit row, purge and forward', async () => {
    const res = await setOwner(PAIR_OTHER, VENDOR_R);
    expect(res.status).toBe(200);
    const parsed = AdminSetIntegrationOwnerResponseSchema.parse(res.body);
    expect(parsed).toMatchObject({
      changed: true,
      pair: { owner: { id: VENDOR_R }, claimed_at: null },
    });
    const row = await pairRow(PAIR_OTHER);
    expect(row.builtByVendorId).toBe(VENDOR_R);
    expect(row.claimedAt).toBeNull();
    const audit = await t.db.select().from(auditLog);
    expect(audit).toHaveLength(2);
    const updated = audit.find((r) => r.action === 'integration.updated')!;
    expect(updated).toMatchObject({
      entityType: 'connector_evidenced_pair',
      entityId: PAIR_OTHER,
    });
    // The displaced owner is told, with the reason, in the same batch (AECI-1159).
    const notice = audit.find((r) => r.action === 'notification.sent')!;
    expect(notice.metadata).toMatchObject({
      vendorId: VENDOR_B,
      event: 'field_overridden',
      field: 'owner',
      reason: 'Rivets sells it.',
    });
    expect(updated.metadata).toMatchObject({
      reason: 'owner-reassigned',
      source: 'admin-owner-write',
      adminReason: 'Rivets sells it.',
    });
    const tags = res.send.mock.calls.flatMap((c) => (c[0] as { tags: string[] }).tags);
    expect(tags).toEqual(
      expect.arrayContaining(['pair:acumatica__procore', 'product:procore', 'product:sync']),
    );
    expect(logBatchToPosthog).toHaveBeenCalled();
  });

  it('records an owner on an unclaimed powered integrations row', async () => {
    const res = await setOwner(ROW_POWERED, VENDOR_R);
    expect(res.status).toBe(200);
    const row = (
      await t.db.select().from(integrations).where(eq(integrations.id, ROW_POWERED))
    )[0]!;
    expect(row.builtByVendorId).toBe(VENDOR_R);
    expect(row.claimedAt).toBeNull();
  });

  it('records that nobody offers it', async () => {
    const res = await setOwner(PAIR_MINE, null);
    expect(res.status).toBe(200);
    expect((await pairRow(PAIR_MINE)).builtByVendorId).toBeNull();
  });

  it('re-routes an open owner-routed contest to AECi in the same batch', async () => {
    await t.db.insert(integrationFieldChallenges).values({
      id: uuid(70),
      evidencedPairId: PAIR_OTHER,
      field: 'docs_url',
      currentValue: null,
      proposedValue: 'https://example.test/docs',
      reason: 'Docs moved.',
      submitterVendorId: VENDOR_A,
      routedTo: 'owner',
      ownerVendorId: VENDOR_B,
      status: 'open',
    });
    expect((await setOwner(PAIR_OTHER, VENDOR_R)).status).toBe(200);
    const contest = (
      await t.db
        .select()
        .from(integrationFieldChallenges)
        .where(eq(integrationFieldChallenges.id, uuid(70)))
    )[0]!;
    expect(contest.routedTo).toBe('aeci');
    const actions = (await t.db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['integration.updated', 'integration.contest.rerouted']),
    );
  });

  it('writes nothing for the owner already on file', async () => {
    const res = await setOwner(PAIR_OTHER, VENDOR_B);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect((await pairRow(PAIR_OTHER)).claimedAt).toBe(CLAIMED_AT);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses a Convention-A self-reference, which the delivered list leaves out', async () => {
    await t.db.insert(integrations).values({
      id: uuid(37),
      name: 'H self-reference',
      sourceProductId: P_SYNC,
      targetProductId: P_B,
      mechanismKind: 'iPaaS',
      poweredByProductId: P_SYNC,
    });
    const res = await setOwner(uuid(37), VENDOR_R);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CONNECTOR_DELIVERED');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses a direct integration with 409 INTEGRATION_NOT_CONNECTOR_DELIVERED', async () => {
    const res = await setOwner(ROW_DIRECT, VENDOR_R);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CONNECTOR_DELIVERED');
  });

  it('404s an unknown id, 422s an unknown vendor, 400s a missing reason', async () => {
    expect((await setOwner(uuid(998), VENDOR_R)).status).toBe(404);
    const unknown = await setOwner(PAIR_UNOWNED, uuid(997));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.field).toBe('owner_vendor_id');
    expect((await setOwner(PAIR_UNOWNED, VENDOR_R, '')).status).toBe(400);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('writes nothing and answers 409 when the row is claimed between the read and the batch', async () => {
    factory = (env) => {
      const handle = t.factory(env);
      const batch = handle.db.batch.bind(handle.db);
      handle.db.batch = (async (stmts: Parameters<typeof batch>[0]) => {
        await t.db
          .update(connectorEvidencedPairs)
          .set({ builtByVendorId: VENDOR_A, claimedAt: CLAIMED_AT })
          .where(eq(connectorEvidencedPairs.id, PAIR_UNOWNED));
        return batch(stmts);
      }) as unknown as typeof handle.db.batch;
      return handle;
    };
    const res = await setOwner(PAIR_UNOWNED, VENDOR_R);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_CHANGED_WHILE_SAVING');
    expect((await pairRow(PAIR_UNOWNED)).builtByVendorId).toBe(VENDOR_A);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

// ─── The connector holder's authority holds at commit (AECI-2042 review) ──────

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

describe('the connector holder’s owner request re-checks its authority at commit', () => {
  it.each([
    [
      'the caller no longer holds the connector product',
      'DELETE FROM product_vendors WHERE vendor_id = ? AND product_id = ?',
      [VENDOR_R, P_SYNC],
    ],
    [
      'the connector product is no longer a Sync Service',
      "UPDATE products SET connector_kind = 'integration_platform' WHERE id = ?",
      [P_SYNC],
    ],
    [
      'the row moved to another connector',
      'UPDATE integrations SET powered_by_product_id = ? WHERE id = ?',
      [P_ZAP, ROW_POWERED],
    ],
  ])('%s: 409 CONTEST_INTEGRATION_CHANGED, nothing filed', async (_label, statement, params) => {
    raceBeforeBatch(statement, ...params);
    const res = await askOwner(AUTH_R, ROW_POWERED, VENDOR_R);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTEST_INTEGRATION_CHANGED');
    expect(await t.db.select().from(integrationFieldChallenges)).toEqual([]);
  });
});
