/**
 * Contests survive a promote cross-table move (AECI-1110 / `REVIEW_APP_PROMOTE_API.md`
 * §3.4a and §4b / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.9).
 *
 * A move between `integrations` and `connector_evidenced_pairs` DELETEs the source row,
 * and `integration_field_challenges` is `ON DELETE CASCADE` off both tables. The move
 * now re-anchors every contest onto the destination row before the DELETE, in the same
 * batch, with an audit row each. Driven through `runPromoteIngest` against real SQLite,
 * the way `promote-claim-fence.spec.ts` is.
 */

import { ListVendorNotificationsResponseSchema, PromotePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  claimThreadMessages,
  claimThreads,
  claims,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  products,
  promoteJobs,
  taxonomyDataObjects,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { VENDOR_OWNED_TWIN } from '../lib/integration-twins';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  REFUSED_CLAIMED_INTEGRATION,
  runPromoteIngest,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';
import { CONTEST_REANCHORED_ACTION, MOVED_TO_CONNECTOR_TIER_REASON } from './promote-contests';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// The ids sort in this order, which is what decides the pair frame.
const REVIT = uuid(1);
const NAVIS = uuid(2);
const AGAVE = uuid(4); // a third-party connector product
const OWNER = uuid(10);
const SUBMITTER = uuid(11);
const EDGE = uuid(20);
const OPEN_NAME = uuid(50);
const CLOSED_NAME = uuid(51);
const OPEN_KIND = uuid(52);
const OPEN_DIRECTION = uuid(53);
const CLOSED_KIND = uuid(54);
const WORKFLOW = uuid(60);

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

/** A push of product Revit restating edge EDGE. `reversed` makes Navisworks the source,
 *  which sorts second, so the move crosses frames. */
function push(overrides: Record<string, unknown> = {}, reversed = false) {
  return {
    vendors: [],
    product: { ref: 'p1', supabaseId: REVIT, name: 'Revit' },
    integrations: [
      {
        ref: 'i1',
        supabaseId: EDGE,
        sourceProduct: reversed ? { supabaseId: NAVIS } : { ref: 'p1' },
        targetProduct: reversed ? { ref: 'p1' } : { supabaseId: NAVIS },
        name: 'Revit to Navisworks',
        claims: [],
        ...overrides,
      },
    ],
  };
}

const contests = () =>
  t.db.select().from(integrationFieldChallenges).orderBy(integrationFieldChallenges.id);
const contest = async (id: string) =>
  (await t.db.query.integrationFieldChallenges.findFirst({
    where: eq(integrationFieldChallenges.id, id),
  }))!;
const auditFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));
/** The contest `notification.sent` rows, the only kind a move writes (AECI-1120). */
const contestNotices = async () =>
  (await auditFor(NOTIFICATION_SENT_ACTION)).filter(
    (r) => (r.metadata as { kind?: string } | null)?.kind === 'contest',
  );

/** `GET /api/vendor/notifications` as a seat of `vendorId`. */
async function feedFor(vendorId: string) {
  const auth: AuthzVariables['auth'] = {
    userId: uuid(99),
    email: 'seat@vendor.test',
    role: 'vendor_admin',
    vendorId,
    entitlementTier: 'verified',
    entitlement: { status: 'active', periodEnd: null },
  };
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  const res = await a.request('/api/vendor/notifications', {}, TEST_ENV, fakeExecutionContext());
  return ListVendorNotificationsResponseSchema.parse(await res.json()).notifications;
}

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: OWNER, slug: 'bentley', companyName: 'Bentley', promotionStatus: 'promoted' },
    { id: SUBMITTER, slug: 'autodesk', companyName: 'Autodesk', promotionStatus: 'promoted' },
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
});
afterEach(() => t.dispose());

/** An unclaimed, AECi-seeded `integrations` row, source Navisworks → target Revit, with
 *  five contests: open and closed on a content field, open and closed on
 *  `mechanism_kind`, and an open `direction` contest. */
async function seedIntegrationEdge() {
  await t.db.insert(integrations).values({
    id: EDGE,
    name: 'Seeded',
    sourceProductId: NAVIS,
    targetProductId: REVIT,
    mechanismKind: 'api',
    direction: 'a_to_b',
  });
  await t.db.insert(workflowInstances).values({
    id: WORKFLOW,
    workflowType: 'correction_request',
    entityId: OPEN_KIND,
    currentState: 'open',
  });
  const base = {
    integrationId: EDGE,
    reason: 'r',
    submitterVendorId: SUBMITTER,
    routedTo: 'aeci',
  };
  await t.db.insert(integrationFieldChallenges).values([
    { ...base, id: OPEN_NAME, field: 'name', proposedValue: 'Better name' },
    {
      ...base,
      id: CLOSED_NAME,
      field: 'website',
      proposedValue: 'https://x.example',
      status: 'declined',
      decisionNote: 'no',
      decidedAt: '2026-09-20T00:00:00.000Z',
      protestStatus: 'rejected',
      protestReason: 'we disagree',
    },
    {
      ...base,
      id: OPEN_KIND,
      field: 'mechanism_kind',
      currentValue: 'api',
      proposedValue: 'iPaaS',
      workflowId: WORKFLOW,
    },
    {
      ...base,
      id: OPEN_DIRECTION,
      field: 'direction',
      currentValue: 'a_to_b',
      proposedValue: 'b_to_a',
    },
    {
      ...base,
      id: CLOSED_KIND,
      field: 'mechanism_kind',
      proposedValue: 'native',
      status: 'accepted',
      decidedAt: '2026-09-19T00:00:00.000Z',
    },
  ]);
}

/** An unclaimed, AECi-seeded evidenced pair (Revit, Navisworks via Agave) with an open
 *  and a closed contest, and an open `direction` contest in the pair's A/B frame. */
async function seedEvidencedEdge() {
  await t.db.insert(connectorEvidencedPairs).values({
    id: EDGE,
    name: 'Seeded pair',
    connectorProductId: AGAVE,
    productAId: REVIT,
    productBId: NAVIS,
    direction: 'a_to_b',
  });
  const base = {
    evidencedPairId: EDGE,
    reason: 'r',
    submitterVendorId: SUBMITTER,
    routedTo: 'aeci',
  };
  await t.db.insert(integrationFieldChallenges).values([
    { ...base, id: OPEN_NAME, field: 'name', proposedValue: 'Better name' },
    {
      ...base,
      id: CLOSED_NAME,
      field: 'website',
      proposedValue: 'https://x.example',
      status: 'withdrawn',
    },
    {
      ...base,
      id: OPEN_DIRECTION,
      field: 'direction',
      currentValue: 'a_to_b',
      proposedValue: 'both',
    },
  ]);
}

describe('promote move into connector_evidenced_pairs (AECI-1110)', () => {
  it('re-anchors every contest onto the pair, open and closed, and deletes none', async () => {
    await seedIntegrationEdge();
    const before = await contests();

    const { response } = await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }, true));

    expect(response.integrations.map((i) => i.id)).toEqual([EDGE]);
    expect(await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) })).toBe(
      undefined,
    );
    const after = await contests();
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    for (const row of after) {
      expect(row).toMatchObject({ integrationId: null, evidencedPairId: EDGE });
    }
    // History is intact on the closed rows: decision, protest and all.
    expect(await contest(CLOSED_NAME)).toMatchObject({
      status: 'declined',
      decisionNote: 'no',
      protestStatus: 'rejected',
      protestReason: 'we disagree',
    });
    expect(await contest(OPEN_NAME)).toMatchObject({ status: 'open', routedTo: 'aeci' });
    // A closed `mechanism_kind` contest keeps its decision and moves with the rest.
    expect(await contest(CLOSED_KIND)).toMatchObject({ status: 'accepted' });
  });

  it('closes an OPEN mechanism_kind contest as withdrawn, with its workflow and audit row', async () => {
    await seedIntegrationEdge();
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }));

    expect(await contest(OPEN_KIND)).toMatchObject({
      status: 'withdrawn',
      evidencedPairId: EDGE,
      integrationId: null,
    });
    const instance = await t.db.query.workflowInstances.findFirst({
      where: eq(workflowInstances.id, WORKFLOW),
    });
    expect(instance).toMatchObject({ currentState: 'withdrawn', finalOutcome: 'cancelled' });
    const transitions = await t.db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, WORKFLOW));
    expect(transitions).toEqual([
      expect.objectContaining({
        fromState: 'open',
        toState: 'withdrawn',
        reason: MOVED_TO_CONNECTOR_TIER_REASON,
      }),
    ]);
    const withdrawn = await auditFor('integration.contest.withdrawn');
    expect(withdrawn).toEqual([
      expect.objectContaining({
        entityType: 'integration_field_challenge',
        entityId: OPEN_KIND,
        actorType: 'system',
        metadata: expect.objectContaining({ reason: MOVED_TO_CONNECTOR_TIER_REASON }),
      }),
    ]);
    // The pair's open-contest rule holds: no open `mechanism_kind` contest on a pair.
    const openOnPair = (await contests()).filter(
      (c) => c.evidencedPairId === EDGE && c.status === 'open',
    );
    expect(openOnPair.map((c) => c.field).sort()).toEqual(['direction', 'name']);
  });

  it('tells the submitter why, with one closed_by_move notice in the move batch (AECI-1120)', async () => {
    await seedIntegrationEdge();
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }, true));

    // One notice: the open `mechanism_kind` contest. The closed one, the open content
    // and direction contests all move without a word.
    const notices = await contestNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      actorType: 'system',
      actorId: null,
      entityType: 'integration_field_challenge',
      entityId: OPEN_KIND,
      vendorId: SUBMITTER,
      metadata: {
        kind: 'contest',
        notificationId: 'portal-contest-closed-by-move',
        vendorId: SUBMITTER,
        contestId: OPEN_KIND,
        integrationId: EDGE,
        anchor: 'evidenced_pair',
        // The row's name as the submitter knew it, before the push renamed it.
        integrationName: 'Seeded',
        field: 'mechanism_kind',
        event: 'closed_by_move',
        pairSlugs: ['navisworks', 'revit'],
      },
    });

    // The submitter's feed shows it on the pair page; nobody else's does.
    const feed = await feedFor(SUBMITTER);
    expect(feed).toEqual([
      expect.objectContaining({
        kind: 'contest',
        event: 'closed_by_move',
        contest_id: OPEN_KIND,
        integration_id: EDGE,
        field: 'mechanism_kind',
        pair_path: '/products/navisworks/integrations/revit',
      }),
    ]);
    expect(feed[0]).not.toHaveProperty('retired_by');
    expect(await feedFor(OWNER)).toEqual([]);
  });

  it('writes no notice when the only mechanism_kind contest is already closed (AECI-1120)', async () => {
    await seedIntegrationEdge();
    await t.db
      .update(integrationFieldChallenges)
      .set({ status: 'withdrawn' })
      .where(eq(integrationFieldChallenges.id, OPEN_KIND));
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }));
    expect(await contestNotices()).toEqual([]);
  });

  it('writes one reanchored audit row per contest, in the move batch', async () => {
    await seedIntegrationEdge();
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }));

    const rows = await auditFor(CONTEST_REANCHORED_ACTION);
    expect(rows.map((r) => r.entityId).sort()).toEqual(
      [OPEN_NAME, CLOSED_NAME, OPEN_KIND, OPEN_DIRECTION, CLOSED_KIND].sort(),
    );
    const name = rows.find((r) => r.entityId === OPEN_NAME)!;
    expect(name).toMatchObject({
      actorType: 'system',
      entityType: 'integration_field_challenge',
      beforeState: { integrationId: EDGE, evidencedPairId: null, status: 'open' },
      afterState: { integrationId: null, evidencedPairId: EDGE, status: 'open' },
      metadata: expect.objectContaining({
        source: 'review-app-promote',
        fromAnchor: 'integration',
        toAnchor: 'evidenced_pair',
      }),
    });
  });

  it('re-frames a direction contest into the pair frame when the source sorts second', async () => {
    await seedIntegrationEdge();
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }, true));
    expect(await contest(OPEN_DIRECTION)).toMatchObject({
      currentValue: 'b_to_a',
      proposedValue: 'a_to_b',
    });
    const [row] = (await auditFor(CONTEST_REANCHORED_ACTION)).filter(
      (r) => r.entityId === OPEN_DIRECTION,
    );
    expect(row!.metadata).toMatchObject({ reframed: true });
  });

  it('leaves a direction contest as it is when the frames agree', async () => {
    await seedIntegrationEdge();
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }));
    expect(await contest(OPEN_DIRECTION)).toMatchObject({
      currentValue: 'a_to_b',
      proposedValue: 'b_to_a',
    });
  });
});

describe('promote move back into integrations (AECI-1110)', () => {
  it('re-anchors every contest onto the integrations row, open and closed', async () => {
    await seedEvidencedEdge();

    const { response } = await ingest(push({ poweredByProduct: null }));

    expect(response.integrations.map((i) => i.id)).toEqual([EDGE]);
    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);
    const after = await contests();
    expect(after.map((c) => c.id).sort()).toEqual([OPEN_NAME, CLOSED_NAME, OPEN_DIRECTION].sort());
    for (const row of after) {
      expect(row).toMatchObject({ integrationId: EDGE, evidencedPairId: null });
    }
    expect(await contest(OPEN_NAME)).toMatchObject({ status: 'open' });
    expect(await contest(CLOSED_NAME)).toMatchObject({ status: 'withdrawn' });
    expect((await auditFor(CONTEST_REANCHORED_ACTION)).map((r) => r.entityId).sort()).toEqual(
      [OPEN_NAME, CLOSED_NAME, OPEN_DIRECTION].sort(),
    );
    // Nothing is withdrawn on the way back: every pair field exists on `integrations`.
    expect(await auditFor('integration.contest.withdrawn')).toEqual([]);
    expect(await contestNotices()).toEqual([]);
  });

  it("re-frames a direction contest out of the pair frame into the row's own", async () => {
    await seedEvidencedEdge();
    await ingest(push({ poweredByProduct: null }, true));
    expect(await contest(OPEN_DIRECTION)).toMatchObject({
      currentValue: 'b_to_a',
      proposedValue: 'both',
    });
  });
});

describe('promote contest move: guards that must still hold (AECI-1110)', () => {
  it('writes nothing, and loses nothing, when a contest is filed between plan and batch', async () => {
    await seedIntegrationEdge();
    const before = await contests();
    const LATE = uuid(70);
    const racing: DbFactory = (env, opts) => {
      const ctx = t.factory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db);
      let fired = false;
      (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
        if (!fired) {
          fired = true;
          t.raw
            .prepare(
              `INSERT INTO integration_field_challenges (id, integration_id, field, reason, submitter_vendor_id, routed_to, status, created_at, updated_at) VALUES (?, ?, 'description', 'late', ?, 'aeci', 'open', ?, ?)`,
            )
            .run(LATE, EDGE, SUBMITTER, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
        }
        return batch(stmts);
      }) as typeof batch;
      return ctx;
    };

    await expect(
      ingest(push({ poweredByProduct: { supabaseId: AGAVE } }), {
        jobId: 'job-contest-race',
        dbFor: racing,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'CONTEST_CHANGED_DURING_PROMOTE' });

    // Rolled back whole: the row did not move, no contest was lost, no ledger row.
    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);
    expect(await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) })).toEqual(
      expect.objectContaining({ id: EDGE }),
    );
    expect((await contests()).map((c) => c.id).sort()).toEqual(
      [...before.map((c) => c.id), LATE].sort(),
    );
    expect(await t.db.select().from(promoteJobs)).toEqual([]);
    // AECI-1120: the notice rolled back with the close it announces.
    expect(await contestNotices()).toEqual([]);

    // The re-push plans against the late contest too, and carries it across.
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }), { jobId: 'job-contest-2' });
    expect(await contest(LATE)).toMatchObject({ integrationId: null, evidencedPairId: EDGE });
  });

  it('a concurrent replay still trips the promote_jobs primary key with the move planned', async () => {
    await seedIntegrationEdge();
    // A first attempt under the job id commits an in-place update: no move.
    const first = await ingest(push(), { jobId: 'job-replay' });
    const before = await contests();

    // The replay misses the short-circuit, so it plans in full, including a move with
    // contest statements. The PK on the ledger row, statement #1, must still absorb it.
    const findFirst = vi
      .spyOn(t.db.query.promoteJobs, 'findFirst')
      .mockReturnValueOnce(Promise.resolve(undefined) as never);
    const second = await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }), {
      jobId: 'job-replay',
    });

    expect(findFirst).toHaveBeenCalled();
    expect(second.response).toEqual(first.response);
    expect(await contests()).toEqual(before);
    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);
    expect(await auditFor(CONTEST_REANCHORED_ACTION)).toEqual([]);
  });

  it('the vendor-held fence still refuses the move, and the contests stay put', async () => {
    await seedIntegrationEdge();
    await t.db
      .update(integrations)
      .set({ claimedAt: '2026-09-20T00:00:00.000Z', builtByVendorId: OWNER })
      .where(eq(integrations.id, EDGE));
    const before = await contests();

    const { response } = await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }));

    expect(response.skipped).toContainEqual({
      ref: 'i1',
      kind: 'integration',
      reason: REFUSED_CLAIMED_INTEGRATION,
    });
    expect(await contests()).toEqual(before);
    expect(await auditFor(CONTEST_REANCHORED_ACTION)).toEqual([]);
  });

  it('the evidenced twin guard still skips a move onto a vendor-owned pair', async () => {
    await seedIntegrationEdge();
    const VENDOR_PAIR = uuid(80);
    await t.db.insert(connectorEvidencedPairs).values({
      id: VENDOR_PAIR,
      name: 'Vendor pair',
      connectorProductId: AGAVE,
      productAId: REVIT,
      productBId: NAVIS,
      origin: 'vendor',
      claimedAt: '2026-09-20T00:00:00.000Z',
      builtByVendorId: OWNER,
    });
    const before = await contests();

    const { response } = await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }));

    expect(response.skipped).toContainEqual({
      ref: 'i1',
      kind: 'integration',
      reason: VENDOR_OWNED_TWIN,
      existingId: VENDOR_PAIR,
    });
    expect(await contests()).toEqual(before);
    expect(await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) })).toEqual(
      expect.objectContaining({ id: EDGE }),
    );
    expect(await auditFor(CONTEST_REANCHORED_ACTION)).toEqual([]);
  });

  it('a move with no contests writes no contest statement', async () => {
    await t.db.insert(integrations).values({
      id: EDGE,
      name: 'Seeded',
      sourceProductId: REVIT,
      targetProductId: NAVIS,
    });
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }));
    expect(await t.db.select().from(connectorEvidencedPairs)).toHaveLength(1);
    expect(await auditFor(CONTEST_REANCHORED_ACTION)).toEqual([]);
  });
});

describe('promote never writes pricing_url, and a move carries it (AECI-1154)', () => {
  const PRICING = 'https://navisworks.example/pricing';

  it('carries it into connector_evidenced_pairs', async () => {
    await seedIntegrationEdge();
    await t.db.update(integrations).set({ pricingUrl: PRICING }).where(eq(integrations.id, EDGE));
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }, true));
    const pair = await t.db.query.connectorEvidencedPairs.findFirst({
      where: eq(connectorEvidencedPairs.id, EDGE),
    });
    expect(pair?.pricingUrl).toBe(PRICING);
  });

  it('carries it back into integrations', async () => {
    await seedEvidencedEdge();
    await t.db
      .update(connectorEvidencedPairs)
      .set({ pricingUrl: PRICING })
      .where(eq(connectorEvidencedPairs.id, EDGE));
    await ingest(push({ poweredByProduct: null }));
    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) });
    expect(row?.pricingUrl).toBe(PRICING);
  });

  it('leaves it alone on an ordinary re-promote, which has no field for it', async () => {
    await seedIntegrationEdge();
    await t.db.update(integrations).set({ pricingUrl: PRICING }).where(eq(integrations.id, EDGE));
    await ingest(push({ name: 'Renamed by curation' }, true));
    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) });
    expect(row?.name).toBe('Renamed by curation');
    expect(row?.pricingUrl).toBe(PRICING);
  });
});

describe('promote move into connector_evidenced_pairs closes private threads (AECI-1536)', () => {
  const DO = uuid(80);
  const CLAIM = uuid(81);
  const THREAD = uuid(82);

  /** The integration edge with one claim and an open thread with a live message. */
  async function seedThreadedEdge() {
    await t.db.insert(integrations).values({
      id: EDGE,
      name: 'Seeded',
      sourceProductId: REVIT,
      targetProductId: NAVIS,
      mechanismKind: 'api',
    });
    await t.db.insert(taxonomyDataObjects).values({ id: DO, slug: 'rfis', name: 'RFIs' });
    await t.db
      .insert(claims)
      .values({ id: CLAIM, integrationId: EDGE, dataObjectId: DO, direction: 'a_to_b' });
    await t.db
      .insert(claimThreads)
      .values({ id: THREAD, claimId: CLAIM, vendorAId: SUBMITTER, vendorBId: OWNER });
    await t.db.insert(claimThreadMessages).values({
      id: uuid(83),
      threadId: THREAD,
      authorVendorId: SUBMITTER,
      body: 'Is this right?',
    });
  }

  it('closes the open thread not_attestable, keeps its claim id, and audits the close', async () => {
    await seedThreadedEdge();
    await ingest(push({ poweredByProduct: { supabaseId: AGAVE } }));

    const [claim] = await t.db.select().from(claims);
    expect(claim).toMatchObject({ id: CLAIM, connectorEvidencedPairId: EDGE });
    const [thread] = await t.db.select().from(claimThreads);
    expect(thread).toMatchObject({ claimId: CLAIM, closedReason: 'not_attestable' });
    expect(thread!.closedAt).not.toBeNull();
    const rows = await auditFor('thread.closed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'system',
      entityType: 'claim_thread',
      entityId: THREAD,
      afterState: { closedAt: thread!.closedAt, closedReason: 'not_attestable' },
    });
  });

  it('closes nothing on a promote that leaves the edge in integrations', async () => {
    await seedThreadedEdge();
    await ingest(push({ name: 'Renamed' }));
    const [thread] = await t.db.select().from(claimThreads);
    expect(thread).toMatchObject({ closedAt: null, closedReason: null });
    expect(await auditFor('thread.closed')).toHaveLength(0);
  });

  it('writes nothing when a thread opens on the edge between plan and batch', async () => {
    await seedThreadedEdge();
    const LATE_CLAIM = uuid(84);
    await t.db
      .insert(claims)
      .values({ id: LATE_CLAIM, integrationId: EDGE, dataObjectId: DO, direction: 'both' });
    const racing: DbFactory = (env, opts) => {
      const ctx = t.factory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db);
      let fired = false;
      (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
        if (!fired) {
          fired = true;
          t.raw
            .prepare(
              `INSERT INTO claim_threads (id, claim_id, vendor_a_id, vendor_b_id, created_at) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(uuid(85), LATE_CLAIM, SUBMITTER, OWNER, '2026-10-29T00:00:00.000Z');
        }
        return batch(stmts);
      }) as typeof batch;
      return ctx;
    };

    await expect(
      ingest(push({ poweredByProduct: { supabaseId: AGAVE } }), {
        jobId: 'job-thread-race',
        dbFor: racing,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'THREAD_CHANGED_DURING_PROMOTE' });
    expect(
      await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) }),
    ).toBeDefined();
    expect(await auditFor('thread.closed')).toHaveLength(0);
  });
});
