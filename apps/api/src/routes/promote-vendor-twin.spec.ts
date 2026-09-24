/**
 * Promote's `VENDOR_OWNED_TWIN` guard (AECI-1011 / AECI-1012 ruling 2026-09-22 /
 * `REVIEW_APP_PROMOTE_API.md` §4c).
 *
 * When promote would leave a curated row strongly matching a vendor-held row (the same
 * two products in either order, the same connector, the same `mechanism_kind`, an
 * owner that agrees or is unknown), promote skips the write and names the vendor's
 * row. Three writes are guarded: an INSERT (brand new, or the AECI-568 fallback for a
 * dead id), a DE-ROUTE out of `connector_evidenced_pairs`, and an UPDATE that changes
 * any key field of an unclaimed row (endpoints, connector, kind or owner). An UPDATE
 * that changes none of them is not asked, and an UPDATE is skipped only for a twin the
 * stored row did not already have. Live OR retired: this is what
 * keeps a curator's re-add from undoing an owner's retire in public (the AECI-1010
 * gap, ADR 0035).
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
  connectorEvidencedPairs,
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
import { racingFactory, wrappedFactory } from '../test/racing-factory';
import {
  REFUSED_CLAIMED_INTEGRATION,
  runPromoteIngest,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const REVIT = uuid(1);
const NAVIS = uuid(2);
const BIM360 = uuid(3);
const AGAVE = uuid(4);
const OWNER = uuid(10);
const OTHER = uuid(11);
const VENDOR_ROW = uuid(20);
const DEAD_ID = uuid(21);
const CURATED_ROW = uuid(22);
const EVIDENCED_ROW = uuid(23);
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
        // The vendor row's kind: since 2026-09-22 the kind is in promote's key.
        mechanismKind: 'native',
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
    { id: BIM360, slug: 'bim-360', name: 'BIM 360', promotionStatus: 'promoted' },
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

  it('skips the AECI-568 stale-id fallback insert as well, and still reports the dead id', async () => {
    const { response, staleSupabaseIds } = await ingest(curatorAdd({ supabaseId: DEAD_ID }));
    expectTwinSkip(response);
    expect(await integrationRows()).toHaveLength(1);
    expect(staleSupabaseIds).toEqual([{ kind: 'integration', ref: 'i1', supabaseId: DEAD_ID }]);
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

  it('inserts when the payload names a DIFFERENT mechanism kind (ruled 2026-09-22)', async () => {
    const { response } = await ingest(curatorAdd({ mechanismKind: 'marketplace-app' }));
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(response.integrations).toHaveLength(1);
    expect(await integrationRows()).toHaveLength(2);
  });

  it('inserts when the payload states no kind and the vendor row has one (NULL is not native)', async () => {
    const { response } = await ingest(curatorAdd({ mechanismKind: undefined }));
    expect(response.integrations).toHaveLength(1);
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
    const racing = racingFactory(t.factory, (attempt) => {
      if (attempt > 1) return;
      t.raw
        .prepare(
          `INSERT INTO integrations (id, source_product_id, target_product_id, mechanism_kind, built_by_vendor_id, origin, claimed_at, maintained_by, created_at, updated_at)
           VALUES (?, ?, ?, 'native', ?, 'vendor', ?, 'vendor', ?, ?)`,
        )
        .run(VENDOR_ROW, NAVIS, REVIT, OWNER, NOW, NOW, NOW);
    });
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

/** A curator's re-push of an EXISTING edge by its upstream id. */
function curatorUpdate(supabaseId: string, overrides: Record<string, unknown> = {}) {
  return curatorAdd({ supabaseId, ...overrides });
}

describe('the review probe: the two reported twin paths now skip', () => {
  // Both reproduce the independent review's scratch probe. Before the fix the guard
  // ran only `if (!located)`, so each of these wrote a live curated twin of the
  // vendor's row.

  it('an evidenced de-route: skips the move, leaves the evidenced row untouched', async () => {
    // Revit and Navisworks via Agave, in the evidenced tier (A < B by id).
    await t.db.insert(connectorEvidencedPairs).values({
      id: EVIDENCED_ROW,
      connectorProductId: AGAVE,
      productAId: REVIT,
      productBId: NAVIS,
      direction: 'a_to_b',
    });
    const before = await t.db.select().from(connectorEvidencedPairs);
    // An explicit null connector is the statement that moves the edge back out.
    const { response } = await ingest(curatorUpdate(EVIDENCED_ROW, { poweredByProduct: null }));
    expectTwinSkip(response);
    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual(before);
    expect((await integrationRows()).map((r) => r.id)).toEqual([VENDOR_ROW]);
    const [blocked] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'promote.blocked'));
    expect(blocked!.metadata).toMatchObject({ reason: VENDOR_OWNED_TWIN, write: 'de-route' });
  });

  it('a curated re-point: skips the whole UPDATE, with no partial write', async () => {
    await t.db.insert(integrations).values({
      id: CURATED_ROW,
      name: 'Curated Revit to BIM 360',
      sourceProductId: REVIT,
      targetProductId: BIM360,
      mechanismKind: 'native',
      builtByVendorId: OWNER,
      description: 'before',
    });
    const before = await t.db.query.integrations.findFirst({
      where: eq(integrations.id, CURATED_ROW),
    });
    // The curator re-points the row onto Navisworks, and edits a field on the way.
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { description: 'after' }));
    expectTwinSkip(response);
    expect(
      await t.db.query.integrations.findFirst({ where: eq(integrations.id, CURATED_ROW) }),
    ).toEqual(before);
    const [blocked] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'promote.blocked'));
    expect(blocked!.metadata).toMatchObject({ reason: VENDOR_OWNED_TWIN, write: 're-point' });
  });
});

/** A DbFactory that records the SQL of every statement the promote batch sends, after
 *  running `before` (the mid-promote race window). */
function capturingBatch(sent: string[], before: () => void = () => {}): DbFactory {
  return wrappedFactory(t.factory, (_attempt, run, stmts) => {
    for (const stmt of stmts as unknown as Array<{ toSQL(): { sql: string } }>) {
      sent.push(stmt.toSQL().sql);
    }
    before();
    return run();
  });
}

/** The claim-fence sentinels raise this token; the twin sentinels raise another. */
const CLAIM_SENTINEL = 'integration-claimed-during-promote';

describe('a twin-skipped edge carries no claim sentinel (AECI-1088 review)', () => {
  // Before the review fix the AECI-1005 claim sentinel was pushed before the twin guard,
  // so a skipped UPDATE still aborted the promote when its own row was claimed
  // mid-promote, and still counted as a catalog write.
  async function seedCuratedRepointable() {
    await t.db.insert(integrations).values({
      id: CURATED_ROW,
      name: 'Curated Revit to BIM 360',
      sourceProductId: REVIT,
      targetProductId: BIM360,
      mechanismKind: 'native',
      builtByVendorId: OWNER,
    });
  }

  it('does not abort when the skipped row is claimed between plan and commit', async () => {
    await seedCuratedRepointable();
    const sent: string[] = [];
    const racing = capturingBatch(sent, () => {
      t.raw.prepare(`UPDATE integrations SET claimed_at = ? WHERE id = ?`).run(NOW, CURATED_ROW);
    });
    const { response } = await ingest(curatorUpdate(CURATED_ROW), {
      jobId: 'job-skip-race',
      dbFor: racing,
    });
    expectTwinSkip(response);
    expect(sent.some((sql) => sql.includes(CLAIM_SENTINEL))).toBe(false);
  });

  it('adds nothing to the batch but its audit row, so it is not a catalog write', async () => {
    await seedCuratedRepointable();
    const skippedRun: string[] = [];
    await ingest(curatorUpdate(CURATED_ROW), {
      jobId: 'job-skip',
      dbFor: capturingBatch(skippedRun),
    });
    // No statement names an edge table, a claim or an attestation, and no sentinel
    // selects from one: the only rows this edge produced are its audit row.
    const edgeStatements = skippedRun.filter(
      (sql) =>
        !/insert into "(audit_log|promote_jobs)"/i.test(sql) &&
        /"(integrations|connector_evidenced_pairs|claims|attestations)"/i.test(sql),
    );
    expect(edgeStatements).toEqual([]);
  });
});

describe('the UPDATE guard', () => {
  async function seedCurated(values: Partial<typeof integrations.$inferInsert>) {
    await t.db.insert(integrations).values({
      id: CURATED_ROW,
      name: 'Curated',
      sourceProductId: REVIT,
      targetProductId: NAVIS,
      mechanismKind: 'native',
      builtByVendorId: OWNER,
      ...values,
    });
  }

  it('skips an UPDATE that clears a Convention-A connector onto a vendor twin', async () => {
    await seedCurated({ poweredByProductId: NAVIS });
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { poweredByProduct: null }));
    expectTwinSkip(response);
    const row = await t.db.query.integrations.findFirst({
      where: eq(integrations.id, CURATED_ROW),
    });
    expect(row!.poweredByProductId).toBe(NAVIS);
  });

  it('lets an UPDATE through when it re-points nothing, even beside a twin', async () => {
    // A pre-existing curated twin: re-pointing nothing cannot create a new match.
    await seedCurated({ description: 'before' });
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { description: 'after' }));
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(response.integrations).toEqual([
      expect.objectContaining({ id: CURATED_ROW, operation: 'updated' }),
    ]);
  });

  it('lets a direction swap through: a swap is not a re-point', async () => {
    await seedCurated({});
    const { response } = await ingest(curatorAdd({ supabaseId: CURATED_ROW }, true));
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(response.integrations).toHaveLength(1);
  });

  it('lets a re-point through when the kinds differ', async () => {
    await seedCurated({ targetProductId: BIM360, mechanismKind: 'api' });
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { mechanismKind: 'api' }));
    expect(response.integrations).toEqual([
      expect.objectContaining({ id: CURATED_ROW, operation: 'updated' }),
    ]);
  });
});

describe('the UPDATE guard: a kind or owner change is a key change too', () => {
  // The row sits on the vendor row's pair and connector already. Before this change
  // only a re-point was asked, so each of these wrote a live curated twin.
  async function seedCurated(values: Partial<typeof integrations.$inferInsert>) {
    await t.db.insert(integrations).values({
      id: CURATED_ROW,
      name: 'Curated',
      sourceProductId: REVIT,
      targetProductId: NAVIS,
      mechanismKind: 'native',
      builtByVendorId: OWNER,
      description: 'before',
      ...values,
    });
  }
  const curatedRow = () =>
    t.db.query.integrations.findFirst({ where: eq(integrations.id, CURATED_ROW) });

  async function expectUpdateSkip(response: PromoteResponse, before: unknown) {
    expectTwinSkip(response);
    expect(await curatedRow()).toEqual(before);
    const [blocked] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'promote.blocked'));
    expect(blocked!.metadata).toMatchObject({ reason: VENDOR_OWNED_TWIN, write: 'update' });
  }

  it('skips a kind-only change onto a vendor twin (api to native)', async () => {
    await seedCurated({ mechanismKind: 'api' });
    const before = await curatedRow();
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { description: 'after' }));
    await expectUpdateSkip(response, before);
  });

  it('skips an owner-only change to unknown, which matches any owner', async () => {
    await seedCurated({ builtByVendorId: OTHER });
    const before = await curatedRow();
    const { response } = await ingest(
      curatorUpdate(CURATED_ROW, { builtByVendor: null, description: 'after' }),
    );
    await expectUpdateSkip(response, before);
  });

  it("skips an owner-only change to the vendor's own id", async () => {
    await seedCurated({ builtByVendorId: OTHER });
    const before = await curatedRow();
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { description: 'after' }));
    await expectUpdateSkip(response, before);
  });

  it('skips a kind-only change onto a RETIRED vendor row', async () => {
    await t.db.update(integrations).set({ retiredAt: NOW }).where(eq(integrations.id, VENDOR_ROW));
    await seedCurated({ mechanismKind: 'api' });
    const before = await curatedRow();
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { description: 'after' }));
    await expectUpdateSkip(response, before);
    const vendorRow = await t.db.query.integrations.findFirst({
      where: eq(integrations.id, VENDOR_ROW),
    });
    expect(vendorRow!.retiredAt).toBe(NOW);
  });

  it('treats an explicit mechanismKind: null as a key change (none twins none)', async () => {
    await t.db
      .update(integrations)
      .set({ mechanismKind: null })
      .where(eq(integrations.id, VENDOR_ROW));
    await seedCurated({ mechanismKind: 'api' });
    const before = await curatedRow();
    const { response } = await ingest(
      curatorUpdate(CURATED_ROW, { mechanismKind: null, description: 'after' }),
    );
    await expectUpdateSkip(response, before);
  });

  it('does not treat an unresolvable builtByVendor as a key change', async () => {
    // Unresolvable means unstated: the stored owner stays, so the key is unchanged.
    await seedCurated({ builtByVendorId: OTHER });
    const { response } = await ingest(
      curatorUpdate(CURATED_ROW, {
        builtByVendor: { supabaseId: uuid(99) },
        description: 'after',
      }),
    );
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(await curatedRow()).toMatchObject({ builtByVendorId: OTHER, description: 'after' });
  });

  it('writes an owner backfill onto a row that ALREADY twinned the vendor row', async () => {
    // Unknown owner already matches the vendor row. Filling it in creates no NEW twin,
    // so the curator's update must land (ruled on AECI-1012).
    await seedCurated({ builtByVendorId: null });
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { description: 'after' }));
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(response.integrations).toEqual([
      expect.objectContaining({ id: CURATED_ROW, operation: 'updated' }),
    ]);
    expect(await curatedRow()).toMatchObject({ builtByVendorId: OWNER, description: 'after' });
  });

  it('still skips an already-twinned row whose update makes a twin of ANOTHER vendor row', async () => {
    const SECOND_VENDOR_ROW = uuid(24);
    await t.db.insert(integrations).values({
      id: SECOND_VENDOR_ROW,
      name: 'Vendor-listed API',
      sourceProductId: NAVIS,
      targetProductId: REVIT,
      mechanismKind: 'api',
      builtByVendorId: OWNER,
      origin: 'vendor',
      claimedAt: NOW,
      maintainedBy: 'vendor',
      lastReviewedAt: NOW,
    });
    // Twins VENDOR_ROW (native) today; the update moves it onto the api row.
    await seedCurated({});
    const before = await curatedRow();
    const { response } = await ingest(
      curatorUpdate(CURATED_ROW, { mechanismKind: 'api', description: 'after' }),
    );
    expect(response.skipped).toContainEqual({
      ref: 'i1',
      kind: 'integration',
      reason: VENDOR_OWNED_TWIN,
      existingId: SECOND_VENDOR_ROW,
    });
    expect(await curatedRow()).toEqual(before);
  });

  it('reports a mid-promote claim on the UPDATED row as the claim race, not a twin', async () => {
    // No vendor twin at all: the update clears the owner, which would match the row
    // itself once it is claimed. The row must never count as its own twin.
    await t.db.delete(integrations).where(eq(integrations.id, VENDOR_ROW));
    await seedCurated({ builtByVendorId: OTHER });
    const racing = racingFactory(t.factory, (attempt) => {
      if (attempt > 1) return;
      t.raw.prepare(`UPDATE integrations SET claimed_at = ? WHERE id = ?`).run(NOW, CURATED_ROW);
    });
    await expect(
      ingest(curatorUpdate(CURATED_ROW, { builtByVendor: null }), {
        jobId: 'job-claim-race',
        dbFor: racing,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'INTEGRATION_CLAIMED_DURING_PROMOTE' });
    expect(await curatedRow()).toMatchObject({ builtByVendorId: OTHER });
  });

  it('aborts when a vendor creates a NEW twin of an already-twinned row mid-promote', async () => {
    // R already twins V1 (unknown owner). The update fills the owner in. A vendor
    // creates V2 with R's post-write key between the plan read and the batch; V2 is
    // not in the plan-time already-twinned set, so the sentinel fires.
    const V2 = uuid(25);
    await seedCurated({ builtByVendorId: null });
    const racing = racingFactory(t.factory, (attempt) => {
      if (attempt > 1) return;
      t.raw
        .prepare(
          `INSERT INTO integrations (id, source_product_id, target_product_id, mechanism_kind, built_by_vendor_id, origin, claimed_at, maintained_by, created_at, updated_at)
           VALUES (?, ?, ?, 'native', ?, 'vendor', ?, 'vendor', ?, ?)`,
        )
        .run(V2, NAVIS, REVIT, OWNER, NOW, NOW, NOW);
    });
    await expect(
      ingest(curatorUpdate(CURATED_ROW, { description: 'after' }), {
        jobId: 'job-new-twin-race',
        dbFor: racing,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'VENDOR_OWNED_TWIN_CREATED_DURING_PROMOTE' });
    expect(await curatedRow()).toMatchObject({ builtByVendorId: null, description: 'before' });
    expect(await t.db.select().from(promoteJobs)).toEqual([]);

    // The stored row (unknown owner) already matched V2 too, so the re-push reads
    // V2 as already twinned and writes the row.
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { description: 'after' }), {
      jobId: 'job-new-twin-race-2',
    });
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(await curatedRow()).toMatchObject({ builtByVendorId: OWNER, description: 'after' });
  });

  it('lets a kind-only change through when the new kind twins nothing', async () => {
    await seedCurated({ mechanismKind: 'api' });
    const { response } = await ingest(
      curatorUpdate(CURATED_ROW, { mechanismKind: 'marketplace-app', description: 'after' }),
    );
    expect(response.skipped.filter((s) => s.reason === VENDOR_OWNED_TWIN)).toEqual([]);
    expect(response.integrations).toEqual([
      expect.objectContaining({ id: CURATED_ROW, operation: 'updated' }),
    ]);
    const row = await curatedRow();
    expect(row).toMatchObject({ mechanismKind: 'marketplace-app', description: 'after' });
  });
});

describe('the promote fence holds a vendor-created row without a claim', () => {
  it('refuses a write to a vendor-created row whose claim an AECi owner accept cleared', async () => {
    // AECI-1008 §11b.6: an owner accept reassigns the owner and clears claimed_at.
    await t.db
      .update(integrations)
      .set({ claimedAt: null, builtByVendorId: OTHER })
      .where(eq(integrations.id, VENDOR_ROW));
    const before = await integrationRows();
    const { response } = await ingest(curatorUpdate(VENDOR_ROW, { name: 'Overwritten' }));
    expect(response.skipped).toContainEqual({
      ref: 'i1',
      kind: 'integration',
      reason: REFUSED_CLAIMED_INTEGRATION,
    });
    expect(await integrationRows()).toEqual(before);
  });
});

describe('a twin-skipped vendor-maintained edge reports the twin skip alone (AECI-1101)', () => {
  // The AECI-981 review-signal receipt used to be pushed before the twin guard, so a
  // skipped edge on a vendor-maintained row reported both `VENDOR_OWNED_TWIN` and a
  // receipt for a date that was never considered. The skip writes nothing, so the
  // twin report is its only entry.
  const REVIEWED = '2026-09-24T00:00:00.000Z';

  async function seedVendorMaintainedCurated() {
    // Unclaimed and AECi-seeded, so the §4b fence does not hold it, but vendor-maintained.
    await t.db.insert(integrations).values({
      id: CURATED_ROW,
      name: 'Curated Revit to BIM 360',
      sourceProductId: REVIT,
      targetProductId: BIM360,
      mechanismKind: 'native',
      builtByVendorId: OWNER,
      maintainedBy: 'vendor',
      lastReviewedAt: NOW,
    });
  }

  it('reports VENDOR_OWNED_TWIN and no review-signal receipt', async () => {
    await seedVendorMaintainedCurated();
    // The re-point onto Navisworks twins the vendor row.
    const { response } = await ingest(curatorUpdate(CURATED_ROW, { lastReviewedAt: REVIEWED }));
    expect(response.skipped).toEqual([
      { ref: 'i1', kind: 'integration', reason: VENDOR_OWNED_TWIN, existingId: VENDOR_ROW },
    ]);
  });

  it('still reports the receipt on an edge that passes the twin guard', async () => {
    await seedVendorMaintainedCurated();
    // Same row, no re-point: it stays on BIM 360, so there is no twin and it writes.
    const { response } = await ingest(
      curatorUpdate(CURATED_ROW, {
        targetProduct: { supabaseId: BIM360 },
        lastReviewedAt: REVIEWED,
      }),
    );
    expect(response.integrations).toEqual([
      expect.objectContaining({ id: CURATED_ROW, operation: 'updated' }),
    ]);
    expect(response.skipped.filter((s) => s.ref === 'i1')).toEqual([
      expect.objectContaining({ ref: 'i1', kind: 'review-signal' }),
    ]);
    const row = await t.db.query.integrations.findFirst({
      where: eq(integrations.id, CURATED_ROW),
    });
    expect(row!.lastReviewedAt).toBe(NOW);
  });

  it('a replay returns the recorded twin skip unchanged', async () => {
    await seedVendorMaintainedCurated();
    const body = curatorUpdate(CURATED_ROW, { lastReviewedAt: REVIEWED });
    const first = await ingest(body, { jobId: 'job-1101' });
    const replay = await ingest(body, { jobId: 'job-1101' });
    expect(replay.response).toEqual(first.response);
    expect(replay.response.skipped.map((s) => s.reason)).toEqual([VENDOR_OWNED_TWIN]);
    expect(await t.db.select().from(promoteJobs)).toHaveLength(1);
  });
});
