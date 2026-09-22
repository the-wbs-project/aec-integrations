/**
 * The promote ownership fence (AECI-1005 / ADR 0035 / `REVIEW_APP_PROMOTE_API.md`
 * §4b): once an integration's owner has claimed it, the product promote arm writes
 * NOTHING to that row. Not its content, not its owner, not its endpoints, not its
 * table, not its claims or attestations.
 *
 * Kept out of the 5,000-line `promote.spec.ts` on purpose: it drives
 * `runPromoteIngest` directly against the real-SQLite harness, which is all a fence
 * test needs, and one file per invariant is easier to keep honest.
 */

import { PromotePayloadSchema, type PromoteResponse } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  connectorEvidencedPairs,
  integrationEndpointMoves,
  integrationFieldChallenges,
  integrations,
  products,
  promoteJobs,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  REFUSED_CLAIMED_INTEGRATION,
  runPromoteIngest,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const REVIT = uuid(1);
const NAVIS = uuid(2);
const PROCORE = uuid(3);
const AGAVE = uuid(4); // a third-party connector product
const OWNER = uuid(10);
const OTHER = uuid(11);
const EDGE = uuid(20);
const CLAIM = uuid(30);
const DATA_OBJECT = uuid(40);
const CLAIMED_AT = '2026-09-20T00:00:00.000Z';

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

const edge = async () =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) }))!;

/** The review app's push of the product Revit, restating edge EDGE with every
 *  field changed, the owner changed, and one AECi claim. */
function repush(overrides: Record<string, unknown> = {}) {
  return {
    vendors: [],
    product: { ref: 'p1', supabaseId: REVIT, name: 'Revit' },
    integrations: [
      {
        ref: 'i1',
        supabaseId: EDGE,
        sourceProduct: { ref: 'p1' },
        targetProduct: { supabaseId: NAVIS },
        name: 'Renamed upstream',
        description: 'Upstream description',
        listingUrl: 'https://upstream.example/listing',
        mechanismKind: 'api',
        builtByVendor: { supabaseId: OTHER },
        lastReviewedAt: '2026-09-21T00:00:00.000Z',
        claims: [],
        ...overrides,
      },
    ],
  };
}

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: OWNER, slug: 'bentley', companyName: 'Bentley', promotionStatus: 'promoted' },
    { id: OTHER, slug: 'si-co', companyName: 'SI Co', promotionStatus: 'promoted' },
  ]);
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
  ]);
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DATA_OBJECT, slug: 'rfis', name: 'RFIs', displayOrder: 10 });
  await t.db.insert(integrations).values({
    id: EDGE,
    name: 'Owner-edited name',
    sourceProductId: REVIT,
    targetProductId: NAVIS,
    mechanismKind: 'native',
    description: 'Owner description',
    listingUrl: 'https://owner.example/listing',
    builtByVendorId: OWNER,
    maintainedBy: 'vendor',
    lastReviewedAt: CLAIMED_AT,
    claimedAt: CLAIMED_AT,
  });
  // An AECi-seeded claim and its AECi attestation. A replace-by-origin promote with
  // `claims: []` would retire both on an unclaimed row.
  await t.db
    .insert(claims)
    .values({ id: CLAIM, integrationId: EDGE, dataObjectId: DATA_OBJECT, direction: 'a_to_b' });
  await t.db
    .insert(attestations)
    .values({ id: uuid(31), claimId: CLAIM, source: 'aeci', asserted: true });
  // A contest: a cascade child that a cross-table move's DELETE would take.
  await t.db.insert(integrationFieldChallenges).values({
    id: uuid(50),
    integrationId: EDGE,
    field: 'name',
    reason: 'r',
    submitterVendorId: OTHER,
    routedTo: 'owner',
    ownerVendorId: OWNER,
  });
});
afterEach(() => t.dispose());

async function snapshot() {
  return {
    edge: await edge(),
    claims: await t.db.select().from(claims),
    attestations: await t.db.select().from(attestations),
    contests: await t.db.select().from(integrationFieldChallenges),
    pairs: await t.db.select().from(connectorEvidencedPairs),
    moves: await t.db.select().from(integrationEndpointMoves),
  };
}

function expectFenced(response: PromoteResponse) {
  expect(response.skipped).toContainEqual({
    ref: 'i1',
    kind: 'integration',
    reason: REFUSED_CLAIMED_INTEGRATION,
  });
  expect(response.integrations.map((i) => i.id)).not.toContain(EDGE);
  // No second receipt for the same edge: the review-signal refusal is subsumed.
  expect(response.skipped.filter((s) => s.ref === 'i1')).toHaveLength(1);
}

describe('promote ownership fence (AECI-1005)', () => {
  it('writes no content column and no owner to a claimed row, and says so', async () => {
    const before = await snapshot();
    const { response } = await ingest(repush());
    expectFenced(response);
    expect(await snapshot()).toEqual(before);
    // `promote.blocked` is the same trail AECI-520 leaves for a blocked vendor.
    const blocked = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'promote.blocked'));
    expect(blocked).toEqual([
      expect.objectContaining({ entityType: 'integration', entityId: EDGE }),
    ]);
  });

  it('refuses an endpoint re-point, and records no endpoint move', async () => {
    const before = await snapshot();
    const { response } = await ingest(repush({ targetProduct: { supabaseId: PROCORE } }));
    expectFenced(response);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses the cross-table move that would DELETE the row and cascade its children', async () => {
    const before = await snapshot();
    const { response } = await ingest(repush({ poweredByProduct: { supabaseId: AGAVE } }));
    expectFenced(response);
    const after = await snapshot();
    expect(after).toEqual(before);
    // Spelled out, because this is the loss the fence exists to prevent.
    expect(after.pairs).toEqual([]);
    expect(after.claims).toHaveLength(1);
    expect(after.attestations).toHaveLength(1);
    expect(after.contests).toHaveLength(1);
  });

  it('leaves AECi-seeded claims and attestations alone, whatever the payload says', async () => {
    const before = await snapshot();
    const { response } = await ingest(
      repush({
        claims: [
          {
            dataObject: 'rfis',
            direction: 'both',
            attestations: [{ source: 'aeci', asserted: false }],
          },
        ],
      }),
    );
    expectFenced(response);
    expect(await snapshot()).toEqual(before);
  });

  it('still writes the same push to an UNCLAIMED row: the fence is on claimed_at, not maintained_by', async () => {
    // `maintained_by = 'vendor'` stays, which is decision 13: an attestation flips
    // that marker, and it is not ownership.
    await t.db.update(integrations).set({ claimedAt: null }).where(eq(integrations.id, EDGE));
    const { response } = await ingest(repush());
    expect(response.skipped.filter((s) => s.kind === 'integration')).toEqual([]);
    const after = await edge();
    expect(after).toMatchObject({
      name: 'Renamed upstream',
      builtByVendorId: OTHER,
      maintainedBy: 'vendor',
      claimedAt: null,
    });
  });

  it('never writes claimed_at, origin or retired_at, on create or on update', async () => {
    await t.db
      .update(integrations)
      .set({ claimedAt: null, retiredAt: '2026-09-19T00:00:00.000Z' })
      .where(eq(integrations.id, EDGE));
    const { response } = await ingest({
      ...repush(),
      integrations: [
        repush().integrations[0],
        {
          ref: 'i2',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: PROCORE },
          mechanismKind: 'native',
        },
      ],
    });
    const updated = await edge();
    expect(updated.claimedAt).toBeNull();
    expect(updated.origin).toBe('aeci');
    // Promote never un-retires (decision 7).
    expect(updated.retiredAt).toBe('2026-09-19T00:00:00.000Z');
    const createdId = response.integrations.find((i) => i.ref === 'i2')!.id;
    const created = await t.db.query.integrations.findFirst({
      where: eq(integrations.id, createdId),
    });
    expect(created).toMatchObject({ claimedAt: null, origin: 'aeci', retiredAt: null });
  });

  it('aborts the whole batch when the row is claimed between plan and commit', async () => {
    await t.db.update(integrations).set({ claimedAt: null }).where(eq(integrations.id, EDGE));
    const before = await snapshot();
    // Claim the row inside the batch call, i.e. after the plan read and before any
    // statement runs. That is the window the in-SQL sentinel exists for.
    const racing: DbFactory = (env, opts) => {
      const ctx = t.factory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db);
      (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
        t.raw.prepare(`UPDATE integrations SET claimed_at = ? WHERE id = ?`).run(CLAIMED_AT, EDGE);
        return batch(stmts);
      }) as typeof batch;
      return ctx;
    };
    await expect(ingest(repush(), { jobId: 'job-race', dbFor: racing })).rejects.toMatchObject({
      status: 409,
      code: 'INTEGRATION_CLAIMED_DURING_PROMOTE',
    });
    const after = await snapshot();
    expect({ ...after, edge: { ...after.edge, claimedAt: null } }).toEqual(before);
    // The ledger row rolled back too, so a re-push under a new job id is clean.
    expect(await t.db.select().from(promoteJobs)).toEqual([]);

    // …and the re-push plans against the claimed row and fences it.
    const { response } = await ingest(repush(), { jobId: 'job-race-2' });
    expectFenced(response);
  });

  it('a replay of a job that committed before the claim writes nothing', async () => {
    await t.db.update(integrations).set({ claimedAt: null }).where(eq(integrations.id, EDGE));
    const first = await ingest(repush(), { jobId: 'job-before-claim' });
    expect(first.response.integrations.map((i) => i.id)).toContain(EDGE);

    // The owner claims and edits after that commit.
    await t.db
      .update(integrations)
      .set({ claimedAt: CLAIMED_AT, name: 'Owner edit after claim' })
      .where(eq(integrations.id, EDGE));
    const before = await snapshot();

    const replay = await ingest(repush(), { jobId: 'job-before-claim' });
    expect(replay.response).toEqual(first.response);
    expect(await snapshot()).toEqual(before);
  });
});
