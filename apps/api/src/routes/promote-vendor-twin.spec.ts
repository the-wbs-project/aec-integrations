/**
 * Promote's `VENDOR_OWNED_TWIN` guard (AECI-1011 / AECI-1012 ruling 2026-09-22 /
 * `REVIEW_APP_PROMOTE_API.md` §4c).
 *
 * When promote would INSERT an integration (brand new, or the AECI-568 fallback for a
 * dead id) and a vendor-held row strongly matches it (the same two products in either
 * order, no connector, an owner that agrees or is unknown), promote skips the insert
 * and names the vendor's row. Live OR retired: this is what keeps a curator's re-add
 * from undoing an owner's retire in public (the AECI-1010 gap, ADR 0035).
 *
 * Drives `runPromoteIngest` directly against the real-SQLite harness, like
 * `promote-claim-fence.spec.ts`.
 */

import { PromotePayloadSchema, type PromoteResponse } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  claims,
  integrations,
  products,
  promoteJobs,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import type { DbFactory } from '../lib/handler-utils';
import { VENDOR_OWNED_TWIN } from '../lib/integration-twins';
import { makeTestDb, type TestDb } from '../test/d1';
import { runPromoteIngest, type PromoteIngestDeps, type PromoteRunCtx } from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const REVIT = uuid(1);
const NAVIS = uuid(2);
const AGAVE = uuid(4);
const OWNER = uuid(10);
const OTHER = uuid(11);
const VENDOR_ROW = uuid(20);
const DEAD_ID = uuid(21);
const DATA_OBJECT = uuid(40);
const NOW = '2026-09-22T00:00:00.000Z';

let t: TestDb;

const rc = (): PromoteRunCtx => ({
  env: { ENV: 'preview' } as Env,
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

/** A curator's push of Revit carrying one NEW edge to Navisworks (no supabaseId). */
function curatorAdd(overrides: Record<string, unknown> = {}, reversed = false) {
  const revit = { ref: 'p1' };
  const navis = { supabaseId: NAVIS };
  return {
    vendors: [],
    product: { ref: 'p1', supabaseId: REVIT, name: 'Revit' },
    integrations: [
      {
        ref: 'i1',
        sourceProduct: reversed ? navis : revit,
        targetProduct: reversed ? revit : navis,
        name: 'Curated Revit to Navisworks',
        mechanismKind: 'api',
        builtByVendor: { supabaseId: OWNER },
        claims: [{ dataObject: 'rfis', direction: 'a_to_b' }],
        ...overrides,
      },
    ],
  };
}

const integrationRows = () => t.db.select().from(integrations);

function expectTwinSkip(response: PromoteResponse) {
  expect(response.skipped).toContainEqual({
    ref: 'i1',
    kind: 'integration',
    reason: VENDOR_OWNED_TWIN,
    existingId: VENDOR_ROW,
  });
  expect(response.integrations).toEqual([]);
}

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: OWNER, slug: 'autodesk', companyName: 'Autodesk', promotionStatus: 'promoted' },
    { id: OTHER, slug: 'si-co', companyName: 'SI Co', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(products).values([
    { id: REVIT, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: NAVIS, slug: 'navisworks', name: 'Navisworks', promotionStatus: 'promoted' },
    {
      id: AGAVE,
      slug: 'agave',
      name: 'Agave',
      promotionStatus: 'promoted',
      productRole: 'connector',
    },
  ]);
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DATA_OBJECT, slug: 'rfis', name: 'RFIs', displayOrder: 10 });
  // The vendor's own row, created in the portal: Revit → Navisworks, owned by OWNER.
  await t.db.insert(integrations).values({
    id: VENDOR_ROW,
    name: 'Vendor-listed',
    sourceProductId: REVIT,
    targetProductId: NAVIS,
    mechanismKind: 'native',
    builtByVendorId: OWNER,
    origin: 'vendor',
    claimedAt: NOW,
    maintainedBy: 'vendor',
    lastReviewedAt: NOW,
  });
});
afterEach(() => t.dispose());

describe('promote skips inserting a twin of a vendor-held integration', () => {
  it('skips a same-orientation twin, names the vendor row, and writes nothing about it', async () => {
    const before = await integrationRows();
    const { response, wrote } = await ingest(curatorAdd());
    expectTwinSkip(response);
    expect(await integrationRows()).toEqual(before);
    expect(await t.db.select().from(claims)).toEqual([]);
    const blocked = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'promote.blocked'));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ entityType: 'integration', entityId: VENDOR_ROW });
    expect(blocked[0]!.metadata).toMatchObject({ reason: VENDOR_OWNED_TWIN, ref: 'i1' });
    // The product row is still written, so this promote did write.
    expect(wrote).toBe(true);
  });

  it('skips a reverse-orientation twin (Navisworks → Revit)', async () => {
    const { response } = await ingest(curatorAdd({}, true));
    expectTwinSkip(response);
    expect(await integrationRows()).toHaveLength(1);
  });

  it('skips a twin of a RETIRED vendor row, so a re-add cannot undo the retire', async () => {
    await t.db.update(integrations).set({ retiredAt: NOW }).where(eq(integrations.id, VENDOR_ROW));
    const { response } = await ingest(curatorAdd());
    expectTwinSkip(response);
    const rows = await integrationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retiredAt).toBe(NOW);
  });

  it('skips a twin of a CLAIMED curated row too, in both orientations', async () => {
    await t.db.update(integrations).set({ origin: 'aeci' }).where(eq(integrations.id, VENDOR_ROW));
    expectTwinSkip((await ingest(curatorAdd())).response);
    expectTwinSkip((await ingest(curatorAdd({}, true))).response);
  });

  it('skips the AECI-568 stale-id fallback insert as well', async () => {
    const { response } = await ingest(curatorAdd({ supabaseId: DEAD_ID }));
    expectTwinSkip(response);
    expect(await integrationRows()).toHaveLength(1);
  });

  it('matches an unknown owner on the payload against any owner', async () => {
    const { response } = await ingest(curatorAdd({ builtByVendor: undefined }));
    expectTwinSkip(response);
  });

  it('matches a vendor row whose owner was later cleared (origin alone is vendor-held)', async () => {
    await t.db
      .update(integrations)
      .set({ claimedAt: null, builtByVendorId: null })
      .where(eq(integrations.id, VENDOR_ROW));
    expectTwinSkip((await ingest(curatorAdd())).response);
  });

  it('a replay returns the recorded skip and writes nothing new', async () => {
    const first = await ingest(curatorAdd(), { jobId: 'job-twin' });
    expectTwinSkip(first.response);
    const replay = await ingest(curatorAdd(), { jobId: 'job-twin' });
    expect(replay.response).toEqual(first.response);
    expect(await integrationRows()).toHaveLength(1);
    expect(await t.db.select().from(promoteJobs)).toHaveLength(1);
  });
});

describe('promote still inserts where the guard does not apply', () => {
  it('inserts when the only twin is AECi-curated and unclaimed', async () => {
    await t.db
      .update(integrations)
      .set({ origin: 'aeci', claimedAt: null })
      .where(eq(integrations.id, VENDOR_ROW));
    const { response } = await ingest(curatorAdd());
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(response.integrations).toHaveLength(1);
    expect(await integrationRows()).toHaveLength(2);
  });

  it('inserts when the payload names a DIFFERENT owner (two vendors can each offer one)', async () => {
    const { response } = await ingest(curatorAdd({ builtByVendor: { supabaseId: OTHER } }));
    expect(response.integrations).toHaveLength(1);
    expect(await integrationRows()).toHaveLength(2);
  });

  it('inserts a connector-delivered edge (different connector, different table)', async () => {
    const { response } = await ingest(
      curatorAdd({ mechanismKind: 'iPaaS', poweredByProduct: { supabaseId: AGAVE } }),
    );
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(response.integrations).toHaveLength(1);
  });
});

describe('the commit-time half', () => {
  it('aborts the whole promote when a vendor creates the twin between plan and commit', async () => {
    await t.db.delete(integrations).where(eq(integrations.id, VENDOR_ROW));
    let raced = false;
    const racing: DbFactory = (env, opts) => {
      const ctx = t.factory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db);
      (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
        if (raced) return batch(stmts);
        raced = true;
        t.raw
          .prepare(
            `INSERT INTO integrations (id, source_product_id, target_product_id, built_by_vendor_id, origin, claimed_at, maintained_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'vendor', ?, 'vendor', ?, ?)`,
          )
          .run(VENDOR_ROW, NAVIS, REVIT, OWNER, NOW, NOW, NOW);
        return batch(stmts);
      }) as typeof batch;
      return ctx;
    };
    await expect(ingest(curatorAdd(), { jobId: 'job-race', dbFor: racing })).rejects.toMatchObject({
      status: 409,
      code: 'VENDOR_OWNED_TWIN_CREATED_DURING_PROMOTE',
    });
    // Nothing from the promote committed: only the vendor's row, no ledger.
    const rows = await integrationRows();
    expect(rows.map((r) => r.id)).toEqual([VENDOR_ROW]);
    expect(await t.db.select().from(promoteJobs)).toEqual([]);

    // The re-push plans against the vendor row and skips the insert.
    expectTwinSkip((await ingest(curatorAdd(), { jobId: 'job-race-2' })).response);
  });
});
