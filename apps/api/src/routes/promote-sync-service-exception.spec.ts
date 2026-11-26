/**
 * The Sync Service exception to the owned-endpoint fence (AECI-2041, ruling 7 on
 * AECI-2035, `REVIEW_APP_PROMOTE_API.md` §4a, ADR 0042's 2026-11-24 amendment), driven
 * through `runPromoteIngest` against the real-SQLite harness.
 *
 * Promote may write a pair whose connector is a Sync Service (role `connector` or
 * `hybrid`, kind `sync_service`) and is neither endpoint, even when an endpoint product
 * is owned. It lands in `connector_evidenced_pairs`. Every other owned-endpoint write
 * stays skipped, and the §4b claim fence still runs on top. One test per cell of the
 * decision table in §4a.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectorEvidencedPairs,
  integrations,
  productVendors,
  products,
  promoteJobs,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { racingFactory, wrappedFactory } from '../test/racing-factory';
import {
  BLOCKED_INTEGRATION_REASON,
  BLOCKED_OWNED_ENDPOINT_REASON,
  BLOCKED_PRODUCT_REASON,
  REFUSED_CLAIMED_INTEGRATION,
  runPromoteIngest,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const OWNED = uuid(10); // owns its record (Procore)
const FREE = uuid(11); // AECi owns it (Acumatica)
const RIVETS = uuid(12); // the Sync Service vendor, unowned
const ZAP = uuid(13); // an Integration platform vendor

const P_OWNED = uuid(20); // joined to OWNED
const P_OWNED_2 = uuid(21); // joined to OWNED
const P_OTHER = uuid(22); // joined to FREE
const P_OTHER_2 = uuid(23); // joined to FREE
const S_SYNC = uuid(30); // connector, sync_service
const S_HYBRID = uuid(31); // hybrid, sync_service
const S_PLATFORM = uuid(32); // connector, integration_platform
const S_BLANK = uuid(33); // connector, no kind
const S_STALE = uuid(34); // application with a stale sync_service kind
const MISSING = uuid(39); // names no product

const EDGE_DIRECT = uuid(40); // integrations: P_OWNED → P_OTHER, unclaimed
const PAIR_SYNC = uuid(41); // S_SYNC delivers P_OWNED ↔ P_OTHER, unclaimed
const PAIR_PLATFORM = uuid(42); // S_PLATFORM delivers P_OWNED ↔ P_OTHER, unclaimed
const PAIR_CLAIMED = uuid(43); // S_SYNC delivers P_OWNED_2 ↔ P_OTHER, claimed by RIVETS
const PAIR_VENDOR = uuid(44); // S_HYBRID delivers P_OWNED ↔ P_OTHER, origin vendor

const OWNED_AT = '2026-10-01T00:00:00.000Z';

let t: TestDb;

const rc = (): PromoteRunCtx => ({
  env: { ENV: 'staging' } as Env,
  request: new Request('http://localhost:8787/api/promote'),
  waitUntil: () => {},
  bookmark: () => null,
});

const deps = (dbFor: DbFactory = t.factory): PromoteIngestDeps => ({
  dbFor,
  syncAlgolia: async () => {},
  notifyIndexNow: async () => {},
  refreshHomeStats: async () => {},
});

const ingest = (body: unknown, opts: { jobId?: string; dbFor?: DbFactory } = {}) =>
  runPromoteIngest(
    rc(),
    PromotePayloadSchema.parse(body),
    deps(opts.dbFor),
    opts.jobId ? { jobId: opts.jobId } : {},
  );

/** An integration-only push (§3.5): every endpoint by `supabaseId`. */
const edge = (fields: Record<string, unknown>) => ({ integrations: [{ ref: 'i1', ...fields }] });

const pair = async (id: string) =>
  t.db.query.connectorEvidencedPairs.findFirst({ where: eq(connectorEvidencedPairs.id, id) });
const pairsBetween = async (a: string, b: string) =>
  (await t.db.select().from(connectorEvidencedPairs)).filter(
    (r) => r.productAId === (a < b ? a : b) && r.productBId === (a < b ? b : a),
  );

const blocked = { ref: 'i1', kind: 'integration', reason: BLOCKED_OWNED_ENDPOINT_REASON };

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    {
      id: OWNED,
      slug: 'procore',
      companyName: 'Procore',
      promotionStatus: 'promoted',
      ownedAt: OWNED_AT,
    },
    { id: FREE, slug: 'acumatica', companyName: 'Acumatica', promotionStatus: 'promoted' },
    { id: RIVETS, slug: 'rivets', companyName: 'Rivets', promotionStatus: 'promoted' },
    { id: ZAP, slug: 'zapier', companyName: 'Zapier', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(products).values([
    { id: P_OWNED, slug: 'procore-pm', name: 'Procore PM', promotionStatus: 'promoted' },
    { id: P_OWNED_2, slug: 'procore-fin', name: 'Procore Fin', promotionStatus: 'promoted' },
    { id: P_OTHER, slug: 'acumatica-erp', name: 'Acumatica ERP', promotionStatus: 'promoted' },
    { id: P_OTHER_2, slug: 'acumatica-crm', name: 'Acumatica CRM', promotionStatus: 'promoted' },
    {
      id: S_SYNC,
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      promotionStatus: 'promoted',
      productRole: 'connector',
      connectorKind: 'sync_service',
    },
    {
      id: S_HYBRID,
      slug: 'rivets-hub',
      name: 'Rivets Hub',
      promotionStatus: 'promoted',
      productRole: 'hybrid',
      connectorKind: 'sync_service',
    },
    {
      id: S_PLATFORM,
      slug: 'zapier',
      name: 'Zapier',
      promotionStatus: 'promoted',
      productRole: 'connector',
      connectorKind: 'integration_platform',
    },
    {
      id: S_BLANK,
      slug: 'appxchange',
      name: 'AppXchange',
      promotionStatus: 'promoted',
      productRole: 'connector',
    },
    {
      id: S_STALE,
      slug: 'stale-sync',
      name: 'Stale Sync',
      promotionStatus: 'promoted',
      productRole: 'application',
      connectorKind: 'sync_service',
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_OWNED, vendorId: OWNED, isPrimary: true },
    { productId: P_OWNED_2, vendorId: OWNED, isPrimary: true },
    { productId: P_OTHER, vendorId: FREE, isPrimary: true },
    { productId: P_OTHER_2, vendorId: FREE, isPrimary: true },
    { productId: S_SYNC, vendorId: RIVETS, isPrimary: true },
    { productId: S_HYBRID, vendorId: RIVETS, isPrimary: true },
    { productId: S_PLATFORM, vendorId: ZAP, isPrimary: true },
    { productId: S_BLANK, vendorId: ZAP, isPrimary: true },
    { productId: S_STALE, vendorId: RIVETS, isPrimary: true },
  ]);
  await t.db.insert(integrations).values({
    id: EDGE_DIRECT,
    name: 'Direct seeded',
    sourceProductId: P_OWNED,
    targetProductId: P_OTHER,
  });
  const [a, b] = P_OWNED < P_OTHER ? [P_OWNED, P_OTHER] : [P_OTHER, P_OWNED];
  const [a2, b2] = P_OWNED_2 < P_OTHER ? [P_OWNED_2, P_OTHER] : [P_OTHER, P_OWNED_2];
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: PAIR_SYNC,
      connectorProductId: S_SYNC,
      productAId: a,
      productBId: b,
      name: 'Sync seeded',
    },
    {
      id: PAIR_PLATFORM,
      connectorProductId: S_PLATFORM,
      productAId: a,
      productBId: b,
      name: 'Platform seeded',
    },
    {
      id: PAIR_CLAIMED,
      connectorProductId: S_SYNC,
      productAId: a2,
      productBId: b2,
      name: 'Claimed seeded',
      builtByVendorId: RIVETS,
      claimedAt: OWNED_AT,
    },
    {
      id: PAIR_VENDOR,
      connectorProductId: S_HYBRID,
      productAId: a,
      productBId: b,
      name: 'Vendor seeded',
      origin: 'vendor',
    },
  ]);
});
afterEach(() => t.dispose());

describe('the exception: a Sync Service pair on an owned endpoint writes', () => {
  it('cell 1: a new pair whose connector is a connector-role Sync Service', async () => {
    const before = await t.db.query.products.findFirst({ where: eq(products.id, P_OWNED) });
    const { response } = await ingest(
      edge({
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER_2 },
        poweredByProduct: { supabaseId: S_SYNC },
        builtByVendor: { supabaseId: RIVETS },
        name: 'Procore PM and Acumatica CRM (Rivets Sync)',
      }),
    );
    expect(response.skipped).toEqual([]);
    expect(response.integrations).toEqual([
      expect.objectContaining({ ref: 'i1', id: expect.any(String), operation: 'created' }),
    ]);
    const [row] = await pairsBetween(P_OWNED, P_OTHER_2);
    expect(row).toMatchObject({
      id: response.integrations[0]!.id,
      connectorProductId: S_SYNC,
      builtByVendorId: RIVETS,
      claimedAt: null,
      origin: 'aeci',
    });
    // Nothing on the owned product's own record changed, only its derived counts.
    const after = await t.db.query.products.findFirst({ where: eq(products.id, P_OWNED) });
    expect({ ...after, integrationCount: 0, updatedAt: '' }).toEqual({
      ...before,
      integrationCount: 0,
      updatedAt: '',
    });
    // The audit row says which rule let it through.
    const audit = t.raw
      .prepare(`SELECT metadata FROM audit_log WHERE entity_id = ? AND action = ?`)
      .get(row!.id, 'connector_evidenced_pair.created') as { metadata: string };
    expect(JSON.parse(audit.metadata)).toMatchObject({ ownedEndpointException: 'sync_service' });
  });

  it('cell 2: a new pair whose connector is a hybrid Sync Service', async () => {
    const { response } = await ingest(
      edge({
        sourceProduct: { supabaseId: P_OTHER_2 },
        targetProduct: { supabaseId: P_OWNED },
        poweredByProduct: { supabaseId: S_HYBRID },
      }),
    );
    expect(response.skipped).toEqual([]);
    expect(await pairsBetween(P_OWNED, P_OTHER_2)).toHaveLength(1);
  });

  it('cell 3: both endpoints owned, through an integration-only push', async () => {
    const { response } = await ingest(
      edge({
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OWNED_2 },
        poweredByProduct: { supabaseId: S_SYNC },
      }),
    );
    expect(response.skipped).toEqual([]);
    expect(await pairsBetween(P_OWNED, P_OWNED_2)).toHaveLength(1);
  });

  it("cell 4: through the unowned endpoint's own bundle", async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: P_OTHER_2, name: 'Acumatica CRM' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: P_OWNED },
          poweredByProduct: { supabaseId: S_SYNC },
        },
      ],
    });
    expect(response.skipped).toEqual([]);
    expect(response.integrations.map((i) => i.ref)).toEqual(['i1']);
  });

  it('cell 5: an update of an unclaimed Sync Service pair', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_SYNC,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER },
        poweredByProduct: { supabaseId: S_SYNC },
        name: 'Sync renamed',
      }),
    );
    expect(response.skipped).toEqual([]);
    expect(response.integrations).toEqual([
      expect.objectContaining({ ref: 'i1', id: PAIR_SYNC, operation: 'updated' }),
    ]);
    expect((await pair(PAIR_SYNC))!.name).toBe('Sync renamed');
  });

  it('cell 6: an update with no poweredByProduct inherits the stored Sync Service', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_SYNC,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER },
        name: 'Sync renamed again',
      }),
    );
    expect(response.skipped).toEqual([]);
    expect((await pair(PAIR_SYNC))!.name).toBe('Sync renamed again');
  });

  it('cell 7: a re-point from one Sync Service to another', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_SYNC,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER_2 },
        poweredByProduct: { supabaseId: S_HYBRID },
      }),
    );
    expect(response.skipped).toEqual([]);
    expect(await pair(PAIR_SYNC)).toMatchObject({ connectorProductId: S_HYBRID });
  });

  it('cell 8: the payload product is the Sync Service and keeps its connector role', async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: S_SYNC, name: 'Rivets Sync', productRole: 'connector' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { supabaseId: P_OWNED },
          targetProduct: { supabaseId: P_OTHER_2 },
          poweredByProduct: { ref: 'p1' },
        },
      ],
    });
    expect(response.skipped).toEqual([]);
    expect(await pairsBetween(P_OWNED, P_OTHER_2)).toHaveLength(1);
  });
});

describe('every other owned-endpoint write stays skipped', () => {
  const newEdge = (poweredByProduct?: unknown) =>
    edge({
      sourceProduct: { supabaseId: P_OWNED },
      targetProduct: { supabaseId: P_OTHER_2 },
      ...(poweredByProduct === undefined ? {} : { poweredByProduct }),
    });

  it('cell 9: an Integration platform connector', async () => {
    const { response } = await ingest(newEdge({ supabaseId: S_PLATFORM }));
    expect(response.skipped).toEqual([blocked]);
    expect(await pairsBetween(P_OWNED, P_OTHER_2)).toEqual([]);
  });

  it('cell 10: a connector with no kind', async () => {
    const { response } = await ingest(newEdge({ supabaseId: S_BLANK }));
    expect(response.skipped).toEqual([blocked]);
  });

  it('cell 11: a sync_service kind on an application-role product', async () => {
    const { response } = await ingest(newEdge({ supabaseId: S_STALE }));
    expect(response.skipped).toEqual([blocked]);
  });

  it('cell 12: a direct edge with no connector', async () => {
    const { response } = await ingest(newEdge());
    expect(response.skipped).toEqual([blocked]);
    expect(await t.db.select().from(integrations)).toHaveLength(1);
  });

  it('cell 13: an explicit null connector', async () => {
    const { response } = await ingest(newEdge(null));
    expect(response.skipped).toEqual([blocked]);
  });

  it('cell 14: the Sync Service is itself an endpoint (Convention A)', async () => {
    const { response } = await ingest(
      edge({
        sourceProduct: { supabaseId: S_SYNC },
        targetProduct: { supabaseId: P_OWNED },
        poweredByProduct: { supabaseId: S_SYNC },
      }),
    );
    expect(response.skipped).toEqual([blocked]);
  });

  it('cell 15: a connector that does not resolve', async () => {
    const { response } = await ingest(newEdge({ supabaseId: MISSING }));
    expect(response.skipped).toEqual([blocked]);
    expect(response.unresolvedLinks).toEqual([]);
  });

  it('cell 16: moving a direct edge of the owned product into the pair tier', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: EDGE_DIRECT,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER },
        poweredByProduct: { supabaseId: S_SYNC },
      }),
    );
    expect(response.skipped).toEqual([blocked]);
    const row = await t.db.query.integrations.findFirst({
      where: eq(integrations.id, EDGE_DIRECT),
    });
    expect(row).toMatchObject({ name: 'Direct seeded', poweredByProductId: null });
    expect(await pair(EDGE_DIRECT)).toBeUndefined();
  });

  it('cell 17: a Sync Service pair re-pointed to an Integration platform', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_SYNC,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER_2 },
        poweredByProduct: { supabaseId: S_PLATFORM },
      }),
    );
    expect(response.skipped).toEqual([blocked]);
    expect(await pair(PAIR_SYNC)).toMatchObject({
      connectorProductId: S_SYNC,
      name: 'Sync seeded',
    });
  });

  it('cell 18: an Integration platform pair re-pointed to a Sync Service', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_PLATFORM,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER_2 },
        poweredByProduct: { supabaseId: S_SYNC },
      }),
    );
    expect(response.skipped).toEqual([blocked]);
    expect(await pair(PAIR_PLATFORM)).toMatchObject({ connectorProductId: S_PLATFORM });
  });

  it('cell 19: an Integration platform pair updated in place', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_PLATFORM,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER },
        name: 'Platform renamed',
      }),
    );
    expect(response.skipped).toEqual([blocked]);
    expect((await pair(PAIR_PLATFORM))!.name).toBe('Platform seeded');
  });

  it('cell 20: a Sync Service pair moved back to integrations by an explicit null', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_SYNC,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER },
        poweredByProduct: null,
      }),
    );
    expect(response.skipped).toEqual([blocked]);
    expect(await pair(PAIR_SYNC)).toBeDefined();
    expect(
      await t.db.query.integrations.findFirst({ where: eq(integrations.id, PAIR_SYNC) }),
    ).toBeUndefined();
  });

  it("cell 21: the owned product's own bundle: product and edge both refused", async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: P_OWNED, name: 'Procore Renamed' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: P_OTHER_2 },
          poweredByProduct: { supabaseId: S_SYNC },
        },
      ],
    });
    expect(response.skipped).toEqual([
      { ref: 'p1', kind: 'product', reason: BLOCKED_PRODUCT_REASON },
      { ref: 'i1', kind: 'integration', reason: BLOCKED_INTEGRATION_REASON },
    ]);
    expect((await t.db.query.products.findFirst({ where: eq(products.id, P_OWNED) }))!.name).toBe(
      'Procore PM',
    );
    expect(await pairsBetween(P_OWNED, P_OTHER_2)).toEqual([]);
  });

  it('cell 22: the payload product is the connector and this push makes it an application', async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: S_SYNC, name: 'Rivets Sync', productRole: 'application' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { supabaseId: P_OWNED },
          targetProduct: { supabaseId: P_OTHER_2 },
          poweredByProduct: { ref: 'p1' },
        },
      ],
    });
    expect(response.skipped).toEqual([blocked]);
    expect(await pairsBetween(P_OWNED, P_OTHER_2)).toEqual([]);
  });
});

describe('the claim fence is unchanged on top of the exception', () => {
  it('cell 23: a Sync Service pair its owner claimed is never written', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_CLAIMED,
        sourceProduct: { supabaseId: P_OWNED_2 },
        targetProduct: { supabaseId: P_OTHER },
        poweredByProduct: { supabaseId: S_SYNC },
        name: 'Overwrite attempt',
      }),
    );
    expect(response.skipped).toEqual([
      { ref: 'i1', kind: 'integration', reason: REFUSED_CLAIMED_INTEGRATION },
    ]);
    expect((await pair(PAIR_CLAIMED))!.name).toBe('Claimed seeded');
  });

  it('cell 24: a vendor-origin Sync Service pair is never written', async () => {
    const { response } = await ingest(
      edge({
        supabaseId: PAIR_VENDOR,
        sourceProduct: { supabaseId: P_OWNED },
        targetProduct: { supabaseId: P_OTHER },
        poweredByProduct: { supabaseId: S_HYBRID },
        name: 'Overwrite attempt',
      }),
    );
    expect(response.skipped).toEqual([
      { ref: 'i1', kind: 'integration', reason: REFUSED_CLAIMED_INTEGRATION },
    ]);
    expect((await pair(PAIR_VENDOR))!.name).toBe('Vendor seeded');
  });

  it('cell 25: with no owned endpoint the kind plays no part (an Integration platform pair writes)', async () => {
    const { response } = await ingest(
      edge({
        sourceProduct: { supabaseId: P_OTHER },
        targetProduct: { supabaseId: P_OTHER_2 },
        poweredByProduct: { supabaseId: S_PLATFORM },
      }),
    );
    expect(response.skipped).toEqual([]);
    expect(await pairsBetween(P_OTHER, P_OTHER_2)).toHaveLength(1);
  });
});

describe('the ledger and the commit-time sentinel', () => {
  const syncEdge = edge({
    sourceProduct: { supabaseId: P_OWNED },
    targetProduct: { supabaseId: P_OTHER_2 },
    poweredByProduct: { supabaseId: S_SYNC },
  });

  it('keeps the promote_jobs ledger insert first and the Sync Service sentinel last', async () => {
    let sqls: string[] = [];
    const spying = wrappedFactory(t.factory, (_attempt, run, stmts) => {
      sqls = (stmts as unknown as Array<{ toSQL(): { sql: string } }>).map((s) => s.toSQL().sql);
      return run();
    });
    await ingest(syncEdge, { jobId: 'job-order', dbFor: spying });
    expect(sqls[0]).toMatch(/insert into "promote_jobs"/i);
    expect(sqls[sqls.length - 1]).toMatch(/connector_kind/);
    expect(sqls.some((s) => /on conflict do nothing/i.test(s))).toBe(false);
  });

  it('a replayed job returns the recorded result and writes nothing twice', async () => {
    const first = await ingest(syncEdge, { jobId: 'job-replay' });
    const replay = await ingest(syncEdge, { jobId: 'job-replay' });
    expect(replay.response).toEqual(first.response);
    expect(await pairsBetween(P_OWNED, P_OTHER_2)).toHaveLength(1);
    expect(await t.db.select().from(promoteJobs)).toHaveLength(1);
  });

  it('aborts the whole batch when an admin clears the kind mid-promote', async () => {
    const racing = racingFactory(t.factory, () => {
      t.raw.prepare(`UPDATE products SET connector_kind = NULL WHERE id = ?`).run(S_SYNC);
    });
    await expect(ingest(syncEdge, { jobId: 'job-race', dbFor: racing })).rejects.toMatchObject({
      status: 409,
      code: 'VENDOR_OWNED_DURING_PROMOTE',
    });
    expect(await pairsBetween(P_OWNED, P_OTHER_2)).toEqual([]);
    expect(await t.db.select().from(promoteJobs)).toEqual([]);

    // The re-push plans against the cleared kind, and the owned endpoint fences it.
    const { response } = await ingest(syncEdge, { jobId: 'job-race-2' });
    expect(response.skipped).toEqual([blocked]);
  });

  it('does not guard the exempt edge on ownership: a second owned endpoint mid-promote is fine', async () => {
    const racing = racingFactory(t.factory, () => {
      t.raw.prepare(`UPDATE vendors SET owned_at = ? WHERE id = ?`).run(OWNED_AT, FREE);
    });
    const { response } = await ingest(syncEdge, { jobId: 'job-owned-race', dbFor: racing });
    expect(response.skipped).toEqual([]);
    expect(await pairsBetween(P_OWNED, P_OTHER_2)).toHaveLength(1);
  });
});
