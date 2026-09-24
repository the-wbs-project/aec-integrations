/**
 * AECI-1092 re-review: the by-id Algolia sync on a contest accept sends its run
 * metrics in ONE request.
 *
 * `syncOwnerWriteSearch` (`routes/integration-retire-write.ts`) runs on the request
 * path, beside the purge, the audit forward and, on a contest accept, the Linear
 * filing. One metrics request per point could pass the Worker connection limit
 * (AECI-666), so it hands `emitAlgoliaSyncMetrics` a `batch` hook that calls
 * `submitMetricsBatch` once. This drives the real route (an owner accept on a
 * claimed evidenced pair) with fake Algolia credentials, stubs only the index push
 * and the metric transport, and asserts the hook carried every point.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/algolia-sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/algolia-sync')>();
  return {
    ...real,
    syncIndexTargets: vi.fn(async () => [
      {
        entity: 'integrations',
        indexName: 'test_integrations',
        saved: 1,
        deleted: 0,
        transformErrors: 0,
        ok: true,
      },
    ]),
  };
});
vi.mock('../posthog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../posthog')>();
  return {
    ...real,
    submitCount: vi.fn(),
    submitDistribution: vi.fn(),
    submitMetricsBatch: vi.fn(),
  };
});

import {
  connectorEvidencedPairs,
  productVendors,
  products,
  profiles,
  vendorEntitlements,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { syncIndexTargets } from '../lib/algolia-sync';
import type { AuthzVariables } from '../lib/authz';
import { submitCount, submitDistribution, submitMetricsBatch } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createDecideContestHandler, createSubmitContestHandler } from './vendor-contests';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_T = uuid(3);
const P_A = uuid(10);
const P_B = uuid(11);
const P_CONNECTOR = uuid(12);
const PAIR = uuid(30);
const SEAT_A = uuid(100);
const SEAT_T = uuid(102);
const NOW = '2026-09-01T00:00:00.000Z';

type Auth = AuthzVariables['auth'];
const seat = (userId: string, vendorId: string, entitled: boolean): Auth => ({
  userId,
  email: `${userId}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: entitled ? 'verified' : 'unclaimed',
  entitlement: entitled ? { status: 'active', periodEnd: null } : null,
});

let t: TestDb;

beforeEach(async () => {
  vi.clearAllMocks();
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_T, slug: 'syncezy', companyName: 'SyncEzy' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'revit', name: 'Revit' },
    { id: P_B, slug: 'procore', name: 'Procore' },
    { id: P_CONNECTOR, slug: 'syncezy-connect', name: 'SyncEzy Connect' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_B, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: VENDOR_T, isPrimary: true },
  ]);
  await t.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    connectorProductId: P_CONNECTOR,
    productAId: P_A,
    productBId: P_B,
    docsUrl: 'https://example.test/docs',
    builtByVendorId: VENDOR_T,
    claimedAt: NOW,
  });
  await t.db.insert(vendorEntitlements).values({
    vendorId: VENDOR_T,
    tier: 'verified',
    status: 'active',
    grantedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_T, role: 'vendor_admin', vendorId: VENDOR_T },
  ]);
});
afterEach(() => t.dispose());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
  path: string,
  body: unknown,
): Promise<{ status: number; body: JsonBody }> {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/integrations/:id/contests', createSubmitContestHandler(t.factory));
  a.post('/api/vendor/contests/:id/decision', createDecideContestHandler(t.factory));
  const env: Env = {
    ...TEST_ENV,
    // Fake credentials: the index push itself is stubbed above.
    ALGOLIA_APP_ID: 'TESTAPP',
    ALGOLIA_ADMIN_KEY: 'test-admin-key',
  } as Env;
  const execCtx = fakeExecutionContext();
  const res = await a.request(
    path,
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    env,
    execCtx,
  );
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody };
}

describe('the owner accept’s Algolia sync metrics (AECI-1092 re-review)', () => {
  it('sends every run metric through ONE submitMetricsBatch call', async () => {
    const filed = await call(
      seat(SEAT_A, VENDOR_A, false),
      `/api/vendor/integrations/${PAIR}/contests`,
      {
        field: 'docs_url',
        proposed_value: 'https://example.test/better-docs',
        reason: 'The docs moved.',
      },
    );
    expect(filed.status).toBe(201);
    expect(filed.body.contest.routed_to).toBe('owner');
    vi.mocked(submitMetricsBatch).mockClear();

    const decided = await call(
      seat(SEAT_T, VENDOR_T, true),
      `/api/vendor/contests/${filed.body.contest.id}/decision`,
      { decision: 'accept' },
    );
    expect(decided.status).toBe(200);
    expect(
      (
        await t.db
          .select()
          .from(connectorEvidencedPairs)
          .where(eq(connectorEvidencedPairs.id, PAIR))
      )[0]!.docsUrl,
    ).toBe('https://example.test/better-docs');

    // The sync ran for the pair, by id.
    expect(vi.mocked(syncIndexTargets)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncIndexTargets).mock.calls[0]![4]).toEqual({
      integrations: [PAIR],
      products: [],
      vendors: [],
    });
    // ONE metrics request: three counts for the entity plus the run duration.
    expect(vi.mocked(submitMetricsBatch)).toHaveBeenCalledTimes(1);
    const points = vi.mocked(submitMetricsBatch).mock.calls[0]![3];
    expect(points.map((p) => p.metric)).toEqual([
      'aeci.algolia.sync',
      'aeci.algolia.sync.records',
      'aeci.algolia.sync.records',
      'aeci.algolia.sync.duration_ms',
    ]);
    // And none of them went through the one-request-per-point submitters.
    const singles = [
      ...vi.mocked(submitCount).mock.calls,
      ...vi.mocked(submitDistribution).mock.calls,
    ].filter((c) => String(c[3]).startsWith('aeci.algolia.sync'));
    expect(singles).toHaveLength(0);
  });
});
