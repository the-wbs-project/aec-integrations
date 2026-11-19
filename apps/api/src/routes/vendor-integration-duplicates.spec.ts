/**
 * `GET /api/vendor/integrations/possible-duplicates` (AECI-1953 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.2).
 *
 * Real migrations on in-memory SQLite. The handler cells build their own Hono app.
 * The registration cells drive the REAL Worker with `requireVendor` swapped for a
 * stub and both limiter bindings refusing every call: a 200 with an untouched
 * limiter proves no limiter sits on the route (reads are never rate-limited).
 */

import { PossibleDuplicatesResponseSchema } from '@aeci/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbContext } from '../db/client';
import { auditLog, integrations, productVendors, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import worker from '../index';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createCreateVendorIntegrationHandler } from './vendor-integration-create';
import { createPossibleDuplicatesHandler } from './vendor-integration-duplicates';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns OWN (Revit). B owns OTHER (MicroStation). C owns FOREIGN.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);

const P_OWN = uuid(10);
const P_OTHER = uuid(11);
const P_PENDING = uuid(12); // A's, not promoted
const P_FOREIGN = uuid(13); // C's product

const I_NO_OWNER_REVERSED = uuid(20); // OTHER → OWN, no owner on file
const I_MINE_UNCLAIMED = uuid(21); // OWN → OTHER, owner A, not claimed
const I_MINE_RETIRED = uuid(22); // OWN → OTHER, owner A, claimed and retired by A
const I_MINE_RETIRED_AECI = uuid(26); // OWN → OTHER, owner A, claimed, retired by AECi
const I_OTHER_OWNER = uuid(23); // same pair, owned by C: NOT a strong match
const I_POWERED = uuid(24); // same pair, connector-powered: NOT a strong match
const I_ELSEWHERE = uuid(25); // OWN → FOREIGN: another pair

const SEAT_USER = uuid(101);
const AUTH_A: AuthzVariables['auth'] = {
  userId: SEAT_USER,
  email: 'seat@example.test',
  role: 'vendor_admin',
  vendorId: VENDOR_A,
  entitlementTier: 'unclaimed',
  entitlement: null,
};
const AUTH_C: AuthzVariables['auth'] = { ...AUTH_A, userId: uuid(103), vendorId: VENDOR_C };

const holder: { ctx: DbContext | null } = { ctx: null };

vi.mock('../db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/client')>()),
  getDb: () => holder.ctx,
}));

vi.mock('../lib/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/authz')>();
  const stub =
    (): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> => async (c, next) => {
      if (!c.req.header('authorization')) {
        return c.json({ error: { code: 'UNAUTHENTICATED', message: 'No session' } }, 401);
      }
      c.set('auth', AUTH_A);
      await next();
    };
  return { ...actual, requireVendor: stub };
});

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  holder.ctx = t.dbCtx;
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
  await t.db.insert(profiles).values({ id: SEAT_USER, role: 'vendor_admin', vendorId: VENDOR_A });
  await t.db.insert(integrations).values([
    {
      id: I_NO_OWNER_REVERSED,
      name: 'MicroStation for Revit',
      sourceProductId: P_OTHER,
      targetProductId: P_OWN,
      mechanismKind: 'api',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: I_MINE_UNCLAIMED,
      name: 'Revit to MicroStation',
      sourceProductId: P_OWN,
      targetProductId: P_OTHER,
      mechanismKind: 'native',
      builtByVendorId: VENDOR_A,
      createdAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: I_MINE_RETIRED,
      name: 'Old Revit bridge',
      sourceProductId: P_OWN,
      targetProductId: P_OTHER,
      mechanismKind: 'marketplace-app',
      builtByVendorId: VENDOR_A,
      claimedAt: '2026-03-01T00:00:00.000Z',
      retiredAt: '2026-04-01T00:00:00.000Z',
      retiredBy: 'owner',
      createdAt: '2026-03-01T00:00:00.000Z',
    },
    {
      id: I_MINE_RETIRED_AECI,
      name: 'Revit export',
      sourceProductId: P_OWN,
      targetProductId: P_OTHER,
      mechanismKind: 'api',
      builtByVendorId: VENDOR_A,
      claimedAt: '2026-05-01T00:00:00.000Z',
      retiredAt: '2026-06-01T00:00:00.000Z',
      retiredBy: 'aeci',
      createdAt: '2026-05-01T00:00:00.000Z',
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
    {
      id: I_ELSEWHERE,
      sourceProductId: P_OWN,
      targetProductId: P_FOREIGN,
      mechanismKind: 'api',
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
  a.get('/api/vendor/integrations/possible-duplicates', createPossibleDuplicatesHandler(t.factory));
  a.post('/api/vendor/integrations', createCreateVendorIntegrationHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function read(
  auth: AuthzVariables['auth'],
  query: string,
): Promise<{ status: number; body: JsonBody; cacheControl: string | null }> {
  const res = await app(auth).request(
    `/api/vendor/integrations/possible-duplicates?${query}`,
    { method: 'GET' },
    TEST_ENV,
    fakeExecutionContext(),
  );
  return {
    status: res.status,
    body: (await res.json()) as JsonBody,
    cacheControl: res.headers.get('cache-control'),
  };
}

const pair = (own: string, other: string) => `product_id=${own}&counterpart_product_id=${other}`;

describe('GET /api/vendor/integrations/possible-duplicates — the matches', () => {
  it('lists every strong match in either orientation, oldest first, retired rows marked with who retired them', async () => {
    const res = await read(AUTH_A, pair(P_OWN, P_OTHER));
    expect(res.status).toBe(200);
    const body = PossibleDuplicatesResponseSchema.parse(res.body);
    expect(body.possible_duplicates).toEqual([
      {
        id: I_NO_OWNER_REVERSED,
        name: 'MicroStation for Revit',
        mechanism_kind: 'api',
        mechanism_name: null,
        orientation: 'reversed',
        owner: null,
        claimed: false,
        retired: false,
        retired_by: null,
      },
      {
        id: I_MINE_UNCLAIMED,
        name: 'Revit to MicroStation',
        mechanism_kind: 'native',
        mechanism_name: null,
        orientation: 'same',
        owner: { id: VENDOR_A, name: 'Autodesk' },
        claimed: false,
        retired: false,
        retired_by: null,
      },
      {
        id: I_MINE_RETIRED,
        name: 'Old Revit bridge',
        mechanism_kind: 'marketplace-app',
        mechanism_name: null,
        orientation: 'same',
        owner: { id: VENDOR_A, name: 'Autodesk' },
        claimed: true,
        retired: true,
        retired_by: 'owner',
      },
      {
        id: I_MINE_RETIRED_AECI,
        name: 'Revit export',
        mechanism_kind: 'api',
        mechanism_name: null,
        orientation: 'same',
        owner: { id: VENDOR_A, name: 'Autodesk' },
        claimed: true,
        retired: true,
        retired_by: 'aeci',
      },
    ]);
  });

  it('leaves out another vendor’s row, a connector-powered row and another pair', async () => {
    const res = await read(AUTH_A, pair(P_OWN, P_OTHER));
    const ids = (res.body.possible_duplicates as JsonBody[]).map((d) => d.id);
    expect(ids).not.toContain(I_OTHER_OWNER);
    expect(ids).not.toContain(I_POWERED);
    expect(ids).not.toContain(I_ELSEWHERE);
  });

  it('answers an empty list for a pair with nothing on record', async () => {
    await t.db.delete(integrations);
    const res = await read(AUTH_A, pair(P_OWN, P_OTHER));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ possible_duplicates: [] });
  });

  it('matches exactly what the create then reports in its 201', async () => {
    const before = await read(AUTH_A, pair(P_OWN, P_OTHER));
    const res = await app(AUTH_A).request(
      '/api/vendor/integrations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          product_id: P_OWN,
          counterpart_product_id: P_OTHER,
          name: 'Another one',
          mechanism_kind: 'native',
          direction: 'outbound',
        }),
      },
      { ...TEST_ENV, CACHE_PURGE_QUEUE: { send: vi.fn() } } as unknown as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as JsonBody;
    expect(created.possible_duplicates).toEqual(before.body.possible_duplicates);
  });

  it('is a private read: no-store, and no audit row', async () => {
    const res = await read(AUTH_A, pair(P_OWN, P_OTHER));
    expect(res.cacheControl).toBe('private, no-store');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

describe('GET /api/vendor/integrations/possible-duplicates — refusals', () => {
  it('404s a product the caller does not hold, an unpromoted product, and an unknown one', async () => {
    expect((await read(AUTH_C, pair(P_OWN, P_OTHER))).status).toBe(404);
    expect((await read(AUTH_A, pair(P_PENDING, P_OTHER))).status).toBe(404);
    expect((await read(AUTH_A, pair(P_OWN, P_PENDING))).status).toBe(404);
    expect((await read(AUTH_A, pair(P_OWN, uuid(999)))).status).toBe(404);
    // The counterpart side is ANY promoted product, never the caller's to hold.
    expect((await read(AUTH_A, pair(P_OWN, P_FOREIGN))).status).toBe(200);
  });

  it('400s equal ids, a malformed or missing id and an unknown key', async () => {
    expect((await read(AUTH_A, pair(P_OWN, P_OWN))).status).toBe(400);
    expect((await read(AUTH_A, pair(P_OWN, 'not-a-uuid'))).status).toBe(400);
    expect((await read(AUTH_A, `product_id=${P_OWN}`)).status).toBe(400);
    expect((await read(AUTH_A, `${pair(P_OWN, P_OTHER)}&kind=native`)).status).toBe(400);
  });
});

function refusingLimiter(): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: false };
    },
  };
}

describe('GET /api/vendor/integrations/possible-duplicates — registration', () => {
  const path = `/api/vendor/integrations/possible-duplicates?${pair(P_OWN, P_OTHER)}`;

  it('answers 200 on the real Worker with every limiter refusing, and never asks one', async () => {
    const write = refusingLimiter();
    const token = refusingLimiter();
    const res = await worker.fetch(
      new Request(`https://api${path}`, { headers: { authorization: 'Bearer test' } }),
      { ENV: 'staging', WRITE_RATE_LIMIT: write, TOKEN_RATE_LIMIT: token } as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as JsonBody).possible_duplicates).toHaveLength(4);
    expect(write.keys).toEqual([]);
    expect(token.keys).toEqual([]);
  });

  it('is behind the vendor guard', async () => {
    const res = await worker.fetch(
      new Request(`https://api${path}`),
      { ENV: 'staging' } as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });
});
