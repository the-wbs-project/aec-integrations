/**
 * The promote record-ownership fence (AECI-1415, ADR 0042, `REVIEW_APP_PROMOTE_API.md`
 * §4a), driven through `runPromoteIngest` against the real-SQLite harness.
 *
 * Ownership is the stored `vendors.owned_at`, not seat presence. Promote refuses an
 * owned vendor, every product joined to an owned vendor (Q3: any one is enough), a
 * NEW product that would join one, and every integration whose source or target is
 * an owned product, wherever the payload's own product is (Q2). An edge where the
 * owned product is only the `poweredByProduct` connector still writes. An unowned
 * company promotes exactly as before. The commit-time sentinel aborts the batch when
 * a vendor the plan treated as unowned becomes owned before it commits.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  integrations,
  productVendors,
  products,
  profiles,
  promoteJobs,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { racingFactory, wrappedFactory } from '../test/racing-factory';
import {
  BLOCKED_OWNED_ENDPOINT_REASON,
  BLOCKED_PRODUCT_REASON,
  BLOCKED_VENDOR_REASON,
  PROPOSED_PRODUCT_INTEGRATION_REASON,
  PROPOSED_PRODUCT_REASON,
  runPromoteIngest,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const OWNED = uuid(10); // owns its record, and holds NO seat: frozen
const FREE = uuid(11); // AECi owns it
const SEATED_UNOWNED = uuid(12); // a seat but no stamp: a seat alone owns nothing
const P_OWNED = uuid(20); // joined to OWNED
const P_SHARED = uuid(21); // joined to FREE and OWNED (Q3)
const P_FREE = uuid(22); // joined to FREE
const P_OTHER = uuid(23); // joined to FREE
const P_CONNECTOR = uuid(24); // a connector product joined to OWNED
const EDGE = uuid(30); // P_OWNED → P_OTHER, unclaimed
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

const product = async (id: string) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!;
const vendor = async (id: string) =>
  (await t.db.query.vendors.findFirst({ where: eq(vendors.id, id) }))!;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    {
      id: OWNED,
      slug: 'bentley',
      companyName: 'Bentley',
      promotionStatus: 'promoted',
      ownedAt: OWNED_AT,
    },
    { id: FREE, slug: 'autodesk', companyName: 'Autodesk', promotionStatus: 'promoted' },
    { id: SEATED_UNOWNED, slug: 'trimble', companyName: 'Trimble', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(products).values([
    { id: P_OWNED, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
    { id: P_SHARED, slug: 'synchro', name: 'Synchro', promotionStatus: 'promoted' },
    { id: P_FREE, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: P_OTHER, slug: 'navisworks', name: 'Navisworks', promotionStatus: 'promoted' },
    {
      id: P_CONNECTOR,
      slug: 'itwin-connect',
      name: 'iTwin Connect',
      promotionStatus: 'promoted',
      productRole: 'connector',
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_OWNED, vendorId: OWNED, isPrimary: true },
    { productId: P_SHARED, vendorId: FREE, isPrimary: true },
    { productId: P_SHARED, vendorId: OWNED, isPrimary: false },
    { productId: P_FREE, vendorId: FREE, isPrimary: true },
    { productId: P_OTHER, vendorId: FREE, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: OWNED, isPrimary: true },
  ]);
  await t.db.insert(integrations).values({
    id: EDGE,
    name: 'Seeded name',
    sourceProductId: P_OWNED,
    targetProductId: P_OTHER,
  });
  await t.db
    .insert(profiles)
    .values({ id: uuid(40), role: 'vendor_admin', vendorId: SEATED_UNOWNED, seatOwner: true });
});
afterEach(() => t.dispose());

describe('promote refuses an owned record (AECI-1415)', () => {
  it('skips an owned vendor with no seat left: seat loss froze it, it did not hand it back', async () => {
    const { response } = await ingest({
      vendors: [
        { ref: 'v1', supabaseId: OWNED, companyName: 'Bentley Renamed', website: 'https://x' },
      ],
    });
    expect(response.vendors).toEqual([]);
    expect(response.skipped).toEqual([
      { ref: 'v1', kind: 'vendor', reason: BLOCKED_VENDOR_REASON },
    ]);
    expect((await vendor(OWNED)).companyName).toBe('Bentley');
  });

  it('skips an existing product joined to an owned vendor', async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: P_OWNED, name: 'MicroStation 2027' },
    });
    expect(response.product).toBeNull();
    expect(response.skipped).toEqual([
      { ref: 'p1', kind: 'product', reason: BLOCKED_PRODUCT_REASON },
    ]);
    expect((await product(P_OWNED)).name).toBe('MicroStation');
  });

  it('skips a co-owned product when any one joined vendor is owned (Q3)', async () => {
    const { response } = await ingest({
      vendors: [{ ref: 'v1', supabaseId: FREE, companyName: 'Autodesk' }],
      product: { ref: 'p1', supabaseId: P_SHARED, name: 'Synchro Renamed' },
    });
    expect(response.product).toBeNull();
    expect(response.skipped).toContainEqual({
      ref: 'p1',
      kind: 'product',
      reason: BLOCKED_PRODUCT_REASON,
    });
    expect((await product(P_SHARED)).name).toBe('Synchro');
    // The unowned co-owner itself still promotes.
    expect(response.vendors.map((v) => v.id)).toEqual([FREE]);
  });

  it('skips an existing product this payload would join to an owned vendor', async () => {
    const { response } = await ingest({
      vendors: [{ ref: 'v1', supabaseId: OWNED, companyName: 'Bentley' }],
      product: { ref: 'p1', supabaseId: P_FREE, name: 'Revit Renamed' },
    });
    expect(response.product).toBeNull();
    expect((await product(P_FREE)).name).toBe('Revit');
    const joins = await t.db
      .select()
      .from(productVendors)
      .where(eq(productVendors.productId, P_FREE));
    expect(joins.map((j) => j.vendorId)).toEqual([FREE]);
  });

  it('does not create a NEW product that would join an owned vendor; it becomes a proposal (AECI-1416)', async () => {
    const before = await t.db.select().from(products);
    const { response } = await ingest({
      vendors: [{ ref: 'v1', supabaseId: OWNED, companyName: 'Bentley' }],
      product: { ref: 'p1', name: 'OpenRoads', categories: ['Civil'] },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: P_OTHER } },
      ],
    });
    expect(response.product).toBeNull();
    expect(response.skipped).toContainEqual({
      ref: 'p1',
      kind: 'product',
      reason: PROPOSED_PRODUCT_REASON,
      proposalId: expect.any(String),
    });
    expect(response.skipped).toContainEqual({
      ref: 'i1',
      kind: 'integration',
      reason: PROPOSED_PRODUCT_INTEGRATION_REASON,
    });
    expect(await t.db.select().from(products)).toEqual(before);
    expect(response.taxonomy.categories).toEqual([]);
  });

  it("skips an integration whose FAR endpoint is owned, on another product's push (Q2)", async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: P_FREE, name: 'Revit' },
      integrations: [
        // New edge to an owned product.
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: P_OWNED } },
        // A co-owned far endpoint counts too (Q3).
        { ref: 'i2', sourceProduct: { supabaseId: P_SHARED }, targetProduct: { ref: 'p1' } },
        // Unrelated: both endpoints unowned, so it writes.
        { ref: 'i3', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: P_OTHER } },
      ],
    });
    expect(response.product?.id).toBe(P_FREE);
    expect(response.integrations.map((i) => i.ref)).toEqual(['i3']);
    const refused = response.skipped.filter((s) => s.kind === 'integration');
    expect(refused).toEqual([
      { ref: 'i1', kind: 'integration', reason: BLOCKED_OWNED_ENDPOINT_REASON },
      { ref: 'i2', kind: 'integration', reason: BLOCKED_OWNED_ENDPOINT_REASON },
    ]);
  });

  it('skips an update that would move an edge AWAY from an owned product', async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: P_FREE, name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: EDGE,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: P_OTHER },
          name: 'Upstream name',
        },
      ],
    });
    expect(response.skipped).toContainEqual({
      ref: 'i1',
      kind: 'integration',
      reason: BLOCKED_OWNED_ENDPOINT_REASON,
    });
    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) });
    expect(row).toMatchObject({ sourceProductId: P_OWNED, name: 'Seeded name' });
  });

  it('still writes an edge where the owned product is only the poweredBy connector', async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: P_FREE, name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: P_OTHER },
          poweredByProduct: { supabaseId: P_CONNECTOR },
          name: 'Through the connector',
        },
      ],
    });
    expect(response.skipped).toEqual([]);
    expect(response.integrations.map((i) => i.ref)).toEqual(['i1']);
  });

  it("still writes a poweredBy-only edge on the owned connector's own refused push", async () => {
    const { response } = await ingest({
      product: { ref: 'p1', supabaseId: P_CONNECTOR, name: 'iTwin Connect Renamed' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { supabaseId: P_FREE },
          targetProduct: { supabaseId: P_OTHER },
          poweredByProduct: { supabaseId: P_CONNECTOR },
          name: 'Through the connector',
        },
      ],
    });
    expect(response.product).toBeNull();
    expect(response.skipped).toEqual([
      { ref: 'p1', kind: 'product', reason: BLOCKED_PRODUCT_REASON },
    ]);
    expect(response.integrations.map((i) => i.ref)).toEqual(['i1']);
    expect((await product(P_CONNECTOR)).name).toBe('iTwin Connect');
  });
});

describe('an unowned company promotes as before', () => {
  it('writes a vendor with a seat but no ownership stamp, its product and its edges', async () => {
    const { response, wrote } = await ingest({
      vendors: [{ ref: 'v1', supabaseId: SEATED_UNOWNED, companyName: 'Trimble Inc' }],
      product: { ref: 'p1', name: 'Tekla' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: P_OTHER } },
      ],
    });
    expect(wrote).toBe(true);
    expect(response.skipped).toEqual([]);
    expect(response.product?.operation).toBe('created');
    expect(response.integrations.map((i) => i.ref)).toEqual(['i1']);
    expect((await vendor(SEATED_UNOWNED)).companyName).toBe('Trimble Inc');
  });
});

describe('the commit-time ownership sentinel', () => {
  it('aborts the whole batch when the payload vendor becomes owned mid-promote', async () => {
    const productsBefore = await t.db.select().from(products);
    const racing = racingFactory(t.factory, () => {
      t.raw.prepare(`UPDATE vendors SET owned_at = ? WHERE id = ?`).run(OWNED_AT, FREE);
    });
    await expect(
      ingest(
        {
          vendors: [{ ref: 'v1', supabaseId: FREE, companyName: 'Autodesk Renamed' }],
          product: { ref: 'p1', supabaseId: P_FREE, name: 'Revit Renamed' },
        },
        { jobId: 'job-race', dbFor: racing },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'VENDOR_OWNED_DURING_PROMOTE' });
    expect((await vendor(FREE)).companyName).toBe('Autodesk');
    expect(await t.db.select().from(products)).toEqual(productsBefore);
    // The ledger row rolled back with it, so a re-push under a new job id is clean.
    expect(await t.db.select().from(promoteJobs)).toEqual([]);

    // The re-push plans against the owned vendor and skips it.
    const { response } = await ingest(
      {
        vendors: [{ ref: 'v1', supabaseId: FREE, companyName: 'Autodesk Renamed' }],
        product: { ref: 'p1', supabaseId: P_FREE, name: 'Revit Renamed' },
      },
      { jobId: 'job-race-2' },
    );
    expect(response.skipped.map((s) => s.kind).sort()).toEqual(['product', 'vendor']);
  });

  it("aborts when a written edge's far endpoint becomes owned mid-promote", async () => {
    const racing = racingFactory(t.factory, () => {
      t.raw.prepare(`UPDATE vendors SET owned_at = ? WHERE id = ?`).run(OWNED_AT, FREE);
    });
    await expect(
      ingest(
        {
          product: { ref: 'p1', name: 'Brand New' },
          integrations: [
            { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: P_OTHER } },
          ],
        },
        { jobId: 'job-edge-race', dbFor: racing },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'VENDOR_OWNED_DURING_PROMOTE' });
    expect(await t.db.select().from(promoteJobs)).toEqual([]);
  });

  it('keeps the promote_jobs ledger insert as the first statement', async () => {
    let first = '';
    const spying = wrappedFactory(t.factory, (_attempt, run, stmts) => {
      first = (stmts as unknown as Array<{ toSQL(): { sql: string } }>)[0]!.toSQL().sql;
      return run();
    });
    await ingest(
      { vendors: [{ ref: 'v1', supabaseId: FREE, companyName: 'Autodesk' }] },
      { jobId: 'job-order', dbFor: spying },
    );
    expect(first).toMatch(/insert into "promote_jobs"/i);
  });
});
