/**
 * The promote ownership fence and twin guard on `connector_evidenced_pairs`
 * (AECI-1088, the AECI-1040 owner carve-out; `REVIEW_APP_PROMOTE_API.md` §4b, §4c).
 *
 * Migration 0048 gave the second anchor table `claimed_at`, `origin`, `retired_at` and
 * `retired_by`. From then on a vendor-held pair (claimed, or `origin = 'vendor'`) gets
 * everything a vendor-held `integrations` row gets from promote:
 *
 *   1. the whole-edge refusal, the de-route back into `integrations` included;
 *   2. the in-batch race sentinel;
 *   3. a `VENDOR_OWNED_TWIN` skip for a curated write onto its (connector, A, B) key,
 *      instead of a whole-promote failure on `connector_evidenced_pairs_pair_idx`;
 *   4. an edge whose id also names a vendor-held pair (a broken both-tables state) is
 *      fenced whole, and the duplicate-id safety DELETE in the `integrations` UPDATE
 *      branch spares a pair claimed after the plan read;
 *   5. promote never writes the four ownership columns.
 *
 * Same harness as `promote-claim-fence.spec.ts`: `runPromoteIngest` over real SQLite.
 */

import { PromotePayloadSchema, type PromoteResponse } from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
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
import {
  REFUSED_CLAIMED_INTEGRATION,
  runPromoteIngest,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// Canonical order is by id, so REVIT is endpoint A and NAVIS is endpoint B.
const REVIT = uuid(1);
const NAVIS = uuid(2);
const PROCORE = uuid(3);
const AGAVE = uuid(4); // a third-party connector product
const WORKATO = uuid(5); // a second connector product
const OWNER = uuid(10);
const PAIR = uuid(20);
const OTHER_PAIR = uuid(21);
const EDGE = uuid(22);
const CLAIM = uuid(30);
const DATA_OBJECT = uuid(40);
const CLAIMED_AT = '2026-09-23T00:00:00.000Z';

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

/** A DbFactory whose batch runs `before` first: after the plan read, before any
 *  statement. That is the window the in-SQL sentinels exist for. */
const racing =
  (before: () => void): DbFactory =>
  (env, opts) => {
    const ctx = t.factory(env, opts);
    const batch = ctx.db.batch.bind(ctx.db);
    (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
      before();
      return batch(stmts);
    }) as typeof batch;
    return ctx;
  };

/** A DbFactory that records the SQL of every statement the promote batch sends, after
 *  running `before` (the mid-promote race window). */
function capturingBatch(sent: string[], before: () => void = () => {}): DbFactory {
  return (env, opts) => {
    const ctx = t.factory(env, opts);
    const batch = ctx.db.batch.bind(ctx.db);
    (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
      for (const stmt of stmts as unknown as Array<{ toSQL(): { sql: string } }>) {
        sent.push(stmt.toSQL().sql);
      }
      before();
      return batch(stmts);
    }) as typeof batch;
    return ctx;
  };
}

/** The claim-fence sentinels raise this token; the twin sentinels raise another. */
const CLAIM_SENTINEL = 'integration-claimed-during-promote';

/** The review app's push of Revit, restating one edge via Agave. */
function push(edge: Record<string, unknown>) {
  return {
    vendors: [],
    product: { ref: 'p1', supabaseId: REVIT, name: 'Revit' },
    integrations: [
      {
        ref: 'i1',
        sourceProduct: { ref: 'p1' },
        targetProduct: { supabaseId: NAVIS },
        poweredByProduct: { supabaseId: AGAVE },
        name: 'Renamed upstream',
        description: 'Upstream description',
        builtByVendor: { supabaseId: OWNER },
        lastReviewedAt: '2026-09-22T00:00:00.000Z',
        claims: [],
        ...edge,
      },
    ],
  };
}

async function insertPair(
  id: string,
  values: Partial<typeof connectorEvidencedPairs.$inferInsert> = {},
) {
  await t.db.insert(connectorEvidencedPairs).values({
    id,
    connectorProductId: AGAVE,
    productAId: REVIT,
    productBId: NAVIS,
    name: 'Owner-edited name',
    description: 'Owner description',
    builtByVendorId: OWNER,
    direction: 'a_to_b',
    maintainedBy: 'vendor',
    lastReviewedAt: CLAIMED_AT,
    ...values,
  });
}

beforeEach(async () => {
  t = await makeTestDb();
  await t.db
    .insert(vendors)
    .values({ id: OWNER, slug: 'availent', companyName: 'Availent', promotionStatus: 'promoted' });
  await t.db.insert(products).values([
    { id: REVIT, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: NAVIS, slug: 'navisworks', name: 'Navisworks', promotionStatus: 'promoted' },
    { id: PROCORE, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    {
      id: AGAVE,
      slug: 'agave',
      name: 'Agave',
      promotionStatus: 'promoted',
      productRole: 'connector',
    },
    {
      id: WORKATO,
      slug: 'workato',
      name: 'Workato',
      promotionStatus: 'promoted',
      productRole: 'connector',
    },
  ]);
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DATA_OBJECT, slug: 'rfis', name: 'RFIs', displayOrder: 10 });
});
afterEach(() => t.dispose());

/** Seed PAIR as vendor-held, with an AECi claim and attestation hanging off it. */
async function seedHeldPair(held: { claimedAt?: string | null; origin?: string } = {}) {
  await insertPair(PAIR, { claimedAt: CLAIMED_AT, ...held });
  await t.db.insert(claims).values({
    id: CLAIM,
    connectorEvidencedPairId: PAIR,
    dataObjectId: DATA_OBJECT,
    direction: 'a_to_b',
  });
  await t.db
    .insert(attestations)
    .values({ id: uuid(31), claimId: CLAIM, source: 'aeci', asserted: true });
}

async function snapshot() {
  return {
    pairs: await t.db.select().from(connectorEvidencedPairs).orderBy(connectorEvidencedPairs.id),
    integrations: await t.db.select().from(integrations).orderBy(integrations.id),
    claims: await t.db.select().from(claims).orderBy(claims.id),
    attestations: await t.db.select().from(attestations).orderBy(attestations.id),
  };
}

function expectFenced(response: PromoteResponse, id: string) {
  expect(response.skipped).toContainEqual({
    ref: 'i1',
    kind: 'integration',
    reason: REFUSED_CLAIMED_INTEGRATION,
  });
  expect(response.integrations.map((i) => i.id)).not.toContain(id);
  expect(response.skipped.filter((s) => s.ref === 'i1')).toHaveLength(1);
}

function expectTwinSkip(response: PromoteResponse, existingId: string) {
  expect(response.skipped).toEqual([
    { ref: 'i1', kind: 'integration', reason: VENDOR_OWNED_TWIN, existingId },
  ]);
  expect(response.integrations).toEqual([]);
}

const blockedRows = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, 'promote.blocked'));

describe('the ownership fence on connector_evidenced_pairs (AECI-1088)', () => {
  it('writes nothing to a claimed pair, and says so', async () => {
    await seedHeldPair();
    const before = await snapshot();
    const { response } = await ingest(
      push({
        supabaseId: PAIR,
        claims: [{ dataObject: 'rfis', direction: 'both', attestations: [] }],
      }),
    );
    expectFenced(response, PAIR);
    expect(await snapshot()).toEqual(before);
    expect(await blockedRows()).toEqual([
      // The entity is the table the fenced row sits in (AECI-1088 review).
      expect.objectContaining({ entityType: 'connector_evidenced_pair', entityId: PAIR }),
    ]);
  });

  it('fences a vendor-created pair whose claim was cleared', async () => {
    await seedHeldPair({ claimedAt: null, origin: 'vendor' });
    const before = await snapshot();
    const { response } = await ingest(push({ supabaseId: PAIR }));
    expectFenced(response, PAIR);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses the de-route that would DELETE the pair and cascade its claims', async () => {
    await seedHeldPair();
    const before = await snapshot();
    const { response } = await ingest(push({ supabaseId: PAIR, poweredByProduct: null }));
    expectFenced(response, PAIR);
    const after = await snapshot();
    expect(after).toEqual(before);
    // Spelled out, because this is the loss the fence exists to prevent.
    expect(after.integrations).toEqual([]);
    expect(after.pairs.map((p) => p.id)).toEqual([PAIR]);
    expect(after.claims).toHaveLength(1);
    expect(after.attestations).toHaveLength(1);
  });

  it('refuses a connector or endpoint re-point of a claimed pair', async () => {
    await seedHeldPair();
    const before = await snapshot();
    const repointed = await ingest(
      push({ supabaseId: PAIR, poweredByProduct: { supabaseId: WORKATO } }),
    );
    expectFenced(repointed.response, PAIR);
    const moved = await ingest(push({ supabaseId: PAIR, targetProduct: { supabaseId: PROCORE } }));
    expectFenced(moved.response, PAIR);
    expect(await snapshot()).toEqual(before);
  });

  it('still writes an UNCLAIMED pair, and never writes the four ownership columns', async () => {
    // A retired, unclaimed pair cannot arise from a route, but it proves promote
    // neither clears `retired_at` nor stamps anything else.
    await insertPair(PAIR, { retiredAt: CLAIMED_AT, retiredBy: 'aeci' });
    const { response } = await ingest(push({ supabaseId: PAIR }));
    expect(response.skipped.filter((s) => s.kind === 'integration')).toEqual([]);
    const after = await t.db.query.connectorEvidencedPairs.findFirst({
      where: eq(connectorEvidencedPairs.id, PAIR),
    });
    expect(after).toMatchObject({
      name: 'Renamed upstream',
      claimedAt: null,
      origin: 'aeci',
      retiredAt: CLAIMED_AT,
      retiredBy: 'aeci',
    });
  });

  it('creates a pair and moves an integration in as AECi-seeded and unclaimed', async () => {
    await t.db.insert(integrations).values({
      id: EDGE,
      sourceProductId: REVIT,
      targetProductId: PROCORE,
      mechanismKind: 'api',
    });
    const { response } = await ingest({
      ...push({}),
      integrations: [
        push({}).integrations[0],
        {
          ref: 'i2',
          supabaseId: EDGE,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: PROCORE },
          poweredByProduct: { supabaseId: AGAVE },
          claims: [],
        },
      ],
    });
    expect(response.skipped).toEqual([]);
    const rows = await t.db.select().from(connectorEvidencedPairs);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ claimedAt: null, origin: 'aeci', retiredAt: null });
      expect(row.retiredBy).toBeNull();
    }
    expect(await t.db.select().from(integrations)).toEqual([]);
  });

  it('aborts the whole batch when the pair is claimed between plan and commit', async () => {
    await insertPair(PAIR);
    const before = await snapshot();
    const claimMidPromote = racing(() => {
      t.raw
        .prepare(`UPDATE connector_evidenced_pairs SET claimed_at = ? WHERE id = ?`)
        .run(CLAIMED_AT, PAIR);
    });
    await expect(
      ingest(push({ supabaseId: PAIR }), { jobId: 'job-race', dbFor: claimMidPromote }),
    ).rejects.toMatchObject({ status: 409, code: 'INTEGRATION_CLAIMED_DURING_PROMOTE' });
    const after = await snapshot();
    expect({
      ...after,
      pairs: after.pairs.map((p) => ({ ...p, claimedAt: null })),
    }).toEqual(before);
    expect(await t.db.select().from(promoteJobs)).toEqual([]);

    // The re-push plans against the claimed pair and fences it.
    const { response } = await ingest(push({ supabaseId: PAIR }), { jobId: 'job-race-2' });
    expectFenced(response, PAIR);
  });

  // A prior partial state left the same id in both tables. `locateEdge` finds the
  // `integrations` row first, so the UPDATE branch runs and its belt-and-braces DELETE
  // targets the pair. Before AECI-1088 it took the pair and, by cascade, the vendor's
  // claims and attestations.
  const seedBothTables = async () => {
    await t.db.insert(integrations).values({
      id: PAIR,
      sourceProductId: REVIT,
      targetProductId: NAVIS,
      mechanismKind: 'api',
    });
  };

  it('fences an edge whose id also names a vendor-held pair (plan time)', async () => {
    await seedBothTables();
    await seedHeldPair();
    const before = await snapshot();
    const { response } = await ingest(push({ supabaseId: PAIR, poweredByProduct: null }));
    // Claims key on the shared `anchor_id`, so planning this edge would rewrite the
    // vendor pair's claims. The whole edge is refused instead.
    expectFenced(response, PAIR);
    expect(await snapshot()).toEqual(before);
  });

  it('the plan-time fence names the pair as the blocked entity', async () => {
    await seedBothTables();
    await seedHeldPair();
    await ingest(push({ supabaseId: PAIR, poweredByProduct: null }));
    expect(await blockedRows()).toEqual([
      expect.objectContaining({ entityType: 'connector_evidenced_pair', entityId: PAIR }),
    ]);
  });

  it('aborts when the same-id pair is claimed mid-promote, and keeps its claims (commit time)', async () => {
    await seedBothTables();
    // AECi-seeded and unclaimed at plan time, with an AECi claim and attestation. The
    // payload's `claims: []` would retire that claim on the shared `anchor_id`, and
    // the UPDATE branch's safety DELETE targets the pair.
    await seedHeldPair({ claimedAt: null });
    const before = await snapshot();
    const claimMidPromote = racing(() => {
      t.raw
        .prepare(`UPDATE connector_evidenced_pairs SET claimed_at = ? WHERE id = ?`)
        .run(CLAIMED_AT, PAIR);
    });
    await expect(
      ingest(push({ supabaseId: PAIR, poweredByProduct: null }), {
        jobId: 'job-same-id-race',
        dbFor: claimMidPromote,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'INTEGRATION_CLAIMED_DURING_PROMOTE' });
    const after = await snapshot();
    // Nothing was written: the pair is intact apart from the racing claim itself, and
    // its claim and attestation are exactly as they were.
    expect(after.pairs).toEqual([{ ...before.pairs[0]!, claimedAt: CLAIMED_AT }]);
    expect(after.claims).toEqual(before.claims);
    expect(after.attestations).toEqual(before.attestations);
    expect(after.integrations).toEqual(before.integrations);
    expect(await t.db.select().from(promoteJobs)).toEqual([]);
  });

  it('the duplicate-id safety DELETE still removes an AECi-seeded pair', async () => {
    await seedBothTables();
    await insertPair(PAIR);
    await ingest(push({ supabaseId: PAIR, poweredByProduct: null }));
    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);
  });
});

describe('the evidenced VENDOR_OWNED_TWIN guard (AECI-1088)', () => {
  it('skips a curated INSERT onto a vendor-held key instead of failing on the unique index', async () => {
    await seedHeldPair();
    const before = await snapshot();
    // No supabaseId: a curator re-added the pair upstream.
    const { response } = await ingest(push({}));
    expectTwinSkip(response, PAIR);
    expect(await snapshot()).toEqual(before);
    expect(await blockedRows()).toEqual([
      expect.objectContaining({
        entityType: 'connector_evidenced_pair',
        entityId: PAIR,
        metadata: expect.objectContaining({ reason: VENDOR_OWNED_TWIN, ref: 'i1' }),
      }),
    ]);
  });

  it('skips it when the payload states the pair in the other orientation', async () => {
    await seedHeldPair();
    const { response } = await ingest({
      vendors: [],
      product: { ref: 'p2', supabaseId: NAVIS, name: 'Navisworks' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p2' },
          targetProduct: { supabaseId: REVIT },
          poweredByProduct: { supabaseId: AGAVE },
          claims: [],
        },
      ],
    });
    expectTwinSkip(response, PAIR);
  });

  it('skips it when the vendor-held pair is retired, and reports a dead supabaseId', async () => {
    await seedHeldPair();
    await t.db
      .update(connectorEvidencedPairs)
      .set({ retiredAt: CLAIMED_AT, retiredBy: 'owner' })
      .where(eq(connectorEvidencedPairs.id, PAIR));
    const dead = uuid(99);
    const { response, staleSupabaseIds } = await ingest(push({ supabaseId: dead }));
    expectTwinSkip(response, PAIR);
    expect(staleSupabaseIds).toEqual([{ kind: 'integration', ref: 'i1', supabaseId: dead }]);
  });

  it('skips a move in from integrations, and leaves the source row where it is', async () => {
    await seedHeldPair();
    await t.db.insert(integrations).values({
      id: EDGE,
      sourceProductId: REVIT,
      targetProductId: NAVIS,
      mechanismKind: 'api',
    });
    const before = await snapshot();
    const { response } = await ingest(push({ supabaseId: EDGE }));
    expectTwinSkip(response, PAIR);
    expect(await snapshot()).toEqual(before);
    const [blocked] = await blockedRows();
    expect(blocked!.metadata).toMatchObject({ write: 'route', supabaseId: EDGE });
  });

  it('skips an UPDATE that re-points an unclaimed pair onto a vendor-held key', async () => {
    await seedHeldPair();
    await insertPair(OTHER_PAIR, {
      connectorProductId: WORKATO,
      builtByVendorId: null,
      maintainedBy: 'aeci',
      name: 'Curated',
    });
    const before = await snapshot();
    // OTHER_PAIR runs via Workato; the push moves it onto Agave, which PAIR holds.
    const { response } = await ingest(push({ supabaseId: OTHER_PAIR }));
    expectTwinSkip(response, PAIR);
    expect(await snapshot()).toEqual(before);
    const [blocked] = await blockedRows();
    expect(blocked!.metadata).toMatchObject({ write: 're-point' });
  });

  it('writes an UPDATE that keeps its own key, and an insert with no vendor-held twin', async () => {
    await insertPair(PAIR, { claimedAt: null });
    const { response } = await ingest(push({ supabaseId: PAIR }));
    expect(response.skipped.filter((s) => s.kind === 'integration')).toEqual([]);
    const created = await ingest({
      ...push({}),
      integrations: [push({ targetProduct: { supabaseId: PROCORE } }).integrations[0]],
    });
    expect(created.response.skipped.filter((s) => s.kind === 'integration')).toEqual([]);
    expect(await t.db.select().from(connectorEvidencedPairs)).toHaveLength(2);
  });

  it('a twin-skipped edge does not abort on a claim of its own row mid-promote', async () => {
    // AECI-1088 review: the claim sentinel goes in only for an edge that writes. This
    // edge is skipped at plan time, so a claim landing on OTHER_PAIR mid-promote is
    // none of this promote's business.
    await seedHeldPair();
    await insertPair(OTHER_PAIR, {
      connectorProductId: WORKATO,
      builtByVendorId: null,
      maintainedBy: 'aeci',
    });
    const sent: string[] = [];
    const claimMidPromote = capturingBatch(sent, () => {
      t.raw
        .prepare(`UPDATE connector_evidenced_pairs SET claimed_at = ? WHERE id = ?`)
        .run(CLAIMED_AT, OTHER_PAIR);
    });
    const { response } = await ingest(push({ supabaseId: OTHER_PAIR }), {
      jobId: 'job-skip-race',
      dbFor: claimMidPromote,
    });
    expectTwinSkip(response, PAIR);
    // The promote committed, and it sent no sentinel for the skipped edge.
    expect(await t.db.select().from(promoteJobs)).toHaveLength(1);
    expect(sent.some((sql) => sql.includes(CLAIM_SENTINEL))).toBe(false);
  });

  it('a twin-skipped edge adds nothing to the batch but its audit row', async () => {
    // `catalogWrites` counts every statement before the audit rows, so a skipped edge
    // must add none. The payload's product upsert is the only catalog write here.
    await seedHeldPair();
    // A located row, so the pre-fix code would have pushed its claim sentinel.
    await insertPair(OTHER_PAIR, {
      connectorProductId: WORKATO,
      builtByVendorId: null,
      maintainedBy: 'aeci',
    });
    const skippedRun: string[] = [];
    const { response } = await ingest(push({ supabaseId: OTHER_PAIR }), {
      jobId: 'job-skip-only',
      dbFor: capturingBatch(skippedRun),
    });
    expectTwinSkip(response, PAIR);
    // No statement names an edge table, a claim or an attestation, and no sentinel
    // selects from one: the only rows this edge produced are its audit row.
    const edgeStatements = skippedRun.filter(
      (sql) =>
        !/insert into "(audit_log|promote_jobs)"/i.test(sql) &&
        /"(integrations|connector_evidenced_pairs|claims|attestations)"/i.test(sql),
    );
    expect(edgeStatements).toEqual([]);
  });

  it('aborts with the twin race code when the key holder is claimed mid-promote', async () => {
    // An AECi-seeded pair holds the key. A curated insert onto the same key would fail
    // on the unique index; if the pair is claimed first, the sentinel names why.
    await insertPair(PAIR);
    const claimMidPromote = racing(() => {
      t.raw
        .prepare(`UPDATE connector_evidenced_pairs SET claimed_at = ? WHERE id = ?`)
        .run(CLAIMED_AT, PAIR);
    });
    await expect(
      ingest(push({}), { jobId: 'job-twin-race', dbFor: claimMidPromote }),
    ).rejects.toMatchObject({ status: 409, code: 'VENDOR_OWNED_TWIN_CREATED_DURING_PROMOTE' });
    expect(await t.db.select().from(promoteJobs)).toEqual([]);
    const pairs = await t.db
      .select()
      .from(connectorEvidencedPairs)
      .where(and(eq(connectorEvidencedPairs.connectorProductId, AGAVE)));
    expect(pairs.map((p) => p.id)).toEqual([PAIR]);

    // The re-push sees the claimed holder and skips.
    const { response } = await ingest(push({}), { jobId: 'job-twin-race-2' });
    expectTwinSkip(response, PAIR);
  });
});
