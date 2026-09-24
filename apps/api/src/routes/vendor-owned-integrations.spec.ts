/**
 * The owned-rows read and its cursor statement (AECI-1089 / AECI-1040 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5 / `STAGE_2_REALTIME_SPEC.md` §2.2).
 *
 * `GET /api/vendor/integrations` gains `owned`: rows the caller owns in either table
 * that the endpoint-scoped list does not carry. `GET /api/vendor/updates` gains one
 * statement under the same two predicates. The spec pins both halves against each
 * other, because the cursor invariant fails silently in both directions: too narrow
 * and the owner's tab never refreshes, too wide and a timestamp leaks another
 * vendor's row.
 *
 * Fixture instants are relative to now and pinned per row, as in
 * `vendor-updates.spec.ts`, so "did it move?" never depends on wall-clock ordering.
 */

import { ListVendorIntegrationsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectorEvidencedPairs,
  integrations,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createListVendorIntegrationsHandler } from './vendor-attestations';
import { createVendorUpdatesHandler } from './vendor-updates';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A holds REVIT. B holds MICRO and ROADS. T is a third party that holds only BRIDGE,
// a connector product. X holds only ZED and owns one pair on B's products.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_T = uuid(3);
const VENDOR_X = uuid(4);

const P_REVIT = uuid(10);
const P_MICRO = uuid(11);
const P_ROADS = uuid(12);
const P_BRIDGE = uuid(13);
const P_ZED = uuid(14);

const I_AB = uuid(20); // REVIT → MICRO, owned by A: on A's attestable list
const I_T = uuid(21); // REVIT → MICRO powered by BRIDGE, owned by T (third party)
const I_T_RETIRED = uuid(22); // MICRO → ROADS, owned by T, claimed and retired

const E_T = uuid(30); // BRIDGE: REVIT ↔ MICRO, owned by T
const E_A = uuid(31); // BRIDGE: REVIT ↔ ROADS, owned by A (an endpoint vendor)
const E_X = uuid(32); // BRIDGE: MICRO ↔ ROADS, owned by X

const DAY_MS = 86_400_000;
const SEEDED = new Date(Date.now() - 30 * DAY_MS).toISOString();
const MOVED = new Date(Date.now() - 20 * DAY_MS).toISOString();

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
const AUTH_T = seat(3, VENDOR_T);
const AUTH_X = seat(4, VENDOR_X);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_T, slug: 'bridgeco', companyName: 'BridgeCo' },
    { id: VENDOR_X, slug: 'zedco', companyName: 'ZedCo' },
  ]);
  await t.db.insert(products).values([
    { id: P_REVIT, slug: 'revit', name: 'Revit' },
    { id: P_MICRO, slug: 'microstation', name: 'MicroStation' },
    { id: P_ROADS, slug: 'openroads', name: 'OpenRoads' },
    { id: P_BRIDGE, slug: 'bridge', name: 'Bridge', productRole: 'connector' },
    { id: P_ZED, slug: 'zed', name: 'Zed' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_REVIT, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_MICRO, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_ROADS, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_BRIDGE, vendorId: VENDOR_T, isPrimary: true },
    { productId: P_ZED, vendorId: VENDOR_X, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_AB,
      name: 'Revit to MicroStation',
      sourceProductId: P_REVIT,
      targetProductId: P_MICRO,
      mechanismKind: 'native',
      builtByVendorId: VENDOR_A,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
    {
      id: I_T,
      name: 'Revit to MicroStation via Bridge',
      sourceProductId: P_REVIT,
      targetProductId: P_MICRO,
      mechanismKind: 'iPaaS',
      mechanismName: 'Bridge',
      poweredByProductId: P_BRIDGE,
      builtByVendorId: VENDOR_T,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
    {
      id: I_T_RETIRED,
      sourceProductId: P_MICRO,
      targetProductId: P_ROADS,
      mechanismKind: 'iPaaS',
      poweredByProductId: P_BRIDGE,
      builtByVendorId: VENDOR_T,
      claimedAt: SEEDED,
      retiredAt: SEEDED,
      retiredBy: 'aeci',
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
  ]);
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: E_T,
      connectorProductId: P_BRIDGE,
      productAId: P_REVIT,
      productBId: P_MICRO,
      name: 'Revit and MicroStation via Bridge',
      builtByVendorId: VENDOR_T,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
    {
      id: E_A,
      connectorProductId: P_BRIDGE,
      productAId: P_REVIT,
      productBId: P_ROADS,
      builtByVendorId: VENDOR_A,
      claimedAt: SEEDED,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
    {
      id: E_X,
      connectorProductId: P_BRIDGE,
      productAId: P_MICRO,
      productBId: P_ROADS,
      builtByVendorId: VENDOR_X,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
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
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(t.factory));
  a.get('/api/vendor/updates', createVendorUpdatesHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function get(auth: AuthzVariables['auth'], path: string): Promise<JsonBody> {
  const res = await app(auth).request(path, {}, TEST_ENV, fakeExecutionContext());
  expect(res.status).toBe(200);
  return (await res.json()) as JsonBody;
}

const list = (auth: AuthzVariables['auth']) => get(auth, '/api/vendor/integrations');
const cursor = async (auth: AuthzVariables['auth']): Promise<string | null> =>
  (await get(auth, '/api/vendor/updates')).revisions.integrations;

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('GET /api/vendor/integrations — owned rows (AECI-1089)', () => {
  it('lists a third-party owner’s rows from both tables, though it holds no endpoint', async () => {
    const body = await list(AUTH_T);
    expect(() => ListVendorIntegrationsResponseSchema.parse(body)).not.toThrow();
    expect(body.integrations).toEqual([]);
    expect(ids(body.owned)).toEqual([I_T, I_T_RETIRED, E_T].sort());

    const pair = body.owned.find((r: JsonBody) => r.id === E_T);
    expect(pair).toEqual({
      id: E_T,
      anchor: 'evidenced_pair',
      name: 'Revit and MicroStation via Bridge',
      mechanism_kind: null,
      mechanism_name: null,
      product_a: expect.objectContaining({ id: P_REVIT, slug: 'revit' }),
      product_b: expect.objectContaining({ id: P_MICRO, slug: 'microstation' }),
      connector: expect.objectContaining({ id: P_BRIDGE, slug: 'bridge' }),
      connector_powered: true,
      claimed_at: null,
      retired_at: null,
      retired_by: null,
    });
    const row = body.owned.find((r: JsonBody) => r.id === I_T);
    expect(row).toMatchObject({
      anchor: 'integration',
      mechanism_kind: 'iPaaS',
      product_a: expect.objectContaining({ id: P_REVIT }),
      product_b: expect.objectContaining({ id: P_MICRO }),
      connector: expect.objectContaining({ id: P_BRIDGE }),
      connector_powered: true,
    });
  });

  it('keeps a retired owned row listed, with who retired it', async () => {
    const body = await list(AUTH_T);
    expect(body.owned.find((r: JsonBody) => r.id === I_T_RETIRED)).toMatchObject({
      claimed_at: SEEDED,
      retired_at: SEEDED,
      retired_by: 'aeci',
    });
  });

  it('sorts the owned rows by product name, then by id', async () => {
    const body = await list(AUTH_T);
    expect(body.owned.map((r: JsonBody) => r.id)).toEqual([I_T_RETIRED, I_T, E_T]);
  });

  it('lists an endpoint vendor’s owned evidenced pair, and never an owned row it already lists', async () => {
    const body = await list(AUTH_A);
    // I_AB is on the attestable list, so it is not repeated. I_T is on that list
    // too (A holds REVIT), but T owns it, so it is not A's owned row either.
    expect(ids(body.integrations)).toEqual([I_AB, I_T].sort());
    expect(ids(body.owned)).toEqual([E_A]);
    expect(body.owned[0]).toMatchObject({ anchor: 'evidenced_pair', claimed_at: SEEDED });
  });

  it('never lists another vendor’s rows as owned', async () => {
    // B holds endpoints of every pair, and owns none of them.
    expect((await list(AUTH_B)).owned).toEqual([]);
    // X owns E_X but holds none of its products: the pair is its only row.
    const x = await list(AUTH_X);
    expect(x.integrations).toEqual([]);
    expect(ids(x.owned)).toEqual([E_X]);
  });
});

describe('GET /api/vendor/updates — the owned-rows statement (AECI-1089)', () => {
  it('gives a third-party owner a cursor, where it had none before', async () => {
    expect(await cursor(AUTH_T)).toBe(SEEDED);
  });

  it('moves on a write to an owned evidenced pair, for the owner only', async () => {
    const before = { a: await cursor(AUTH_A), b: await cursor(AUTH_B) };
    await t.db
      .update(connectorEvidencedPairs)
      .set({ claimedAt: MOVED, updatedAt: MOVED })
      .where(eq(connectorEvidencedPairs.id, E_T));
    expect(await cursor(AUTH_T)).toBe(MOVED);
    // A and B hold E_T's endpoints but do not own it, and neither list reads it.
    expect(await cursor(AUTH_A)).toBe(before.a);
    expect(await cursor(AUTH_B)).toBe(before.b);
  });

  it('moves on a write to an owned integrations row the owner holds no endpoint of', async () => {
    await t.db
      .update(integrations)
      .set({ claimedAt: MOVED, updatedAt: MOVED })
      .where(eq(integrations.id, I_T_RETIRED));
    expect(await cursor(AUTH_T)).toBe(MOVED);
  });

  it('does not move for another vendor’s owned pair (no timestamp leak)', async () => {
    const before = await cursor(AUTH_T);
    await t.db
      .update(connectorEvidencedPairs)
      .set({ updatedAt: MOVED })
      .where(eq(connectorEvidencedPairs.id, E_X));
    expect(await cursor(AUTH_T)).toBe(before);
    expect(await cursor(AUTH_X)).toBe(MOVED);
  });

  it('stays null for a vendor that owns nothing and holds no endpoint', async () => {
    await t.db.insert(vendors).values({ id: uuid(9), slug: 'empty', companyName: 'Empty' });
    expect(await cursor(seat(9, uuid(9)))).toBeNull();
  });

  it('equals the newest row the list returns, for every vendor (the §2.2 invariant)', async () => {
    await t.db
      .update(connectorEvidencedPairs)
      .set({ updatedAt: MOVED })
      .where(eq(connectorEvidencedPairs.id, E_A));
    for (const auth of [AUTH_A, AUTH_B, AUTH_T, AUTH_X]) {
      const body = await list(auth);
      const listed = new Set<string>([
        ...body.integrations.map((r: JsonBody) => r.id),
        ...body.owned.map((r: JsonBody) => r.id),
      ]);
      const stamps = await Promise.all(
        [...listed].map(async (id) => {
          const row =
            (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) })) ??
            (await t.db.query.connectorEvidencedPairs.findFirst({
              where: eq(connectorEvidencedPairs.id, id),
            }));
          return row!.updatedAt;
        }),
      );
      const newest = stamps.sort().at(-1) ?? null;
      expect({ vendor: auth.vendorId, cursor: await cursor(auth) }).toEqual({
        vendor: auth.vendorId,
        cursor: newest,
      });
    }
  });
});
