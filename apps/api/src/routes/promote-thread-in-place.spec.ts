/**
 * Private threads close when a promote makes an `integrations` row connector-powered
 * IN PLACE (AECI-1541 / `STAGE_2_ATTESTATIONS_SPEC.md` §15.10).
 *
 * The AECI-1536 move closes threads `not_attestable` when an edge moves into
 * `connector_evidenced_pairs`. Two promote writes make the row connector-powered
 * without a move: an iPaaS / integrator `mechanism_kind`, and a self-referential
 * `powered_by_product_id` (the connector is one of the endpoints, so the edge stays in
 * `integrations`). The thread routes refuse every write on such an edge, so the thread
 * must close in the same batch. Driven through `runPromoteIngest` against real SQLite,
 * the way `promote-contest-move.spec.ts` is.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  claimThreadMessages,
  claimThreads,
  claims,
  connectorEvidencedPairs,
  integrations,
  products,
  promoteJobs,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { runPromoteIngest, type PromoteIngestDeps, type PromoteRunCtx } from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const REVIT = uuid(1);
const NAVIS = uuid(2);
const OWNER = uuid(10);
const SUBMITTER = uuid(11);
const EDGE = uuid(20);
const DO = uuid(80);
const CLAIM = uuid(81);
const THREAD = uuid(82);

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

/** The AECi claim the seeded edge carries, restated so the push keeps it. */
const KEEP_CLAIM = [
  { dataObject: 'rfis', direction: 'a_to_b', attestations: [{ source: 'aeci', asserted: true }] },
];

/** A push of product Revit restating edge EDGE (Revit → Navisworks). */
function push(overrides: Record<string, unknown> = {}) {
  return {
    vendors: [],
    product: { ref: 'p1', supabaseId: REVIT, name: 'Revit' },
    integrations: [
      {
        ref: 'i1',
        supabaseId: EDGE,
        sourceProduct: { ref: 'p1' },
        targetProduct: { supabaseId: NAVIS },
        name: 'Revit to Navisworks',
        claims: KEEP_CLAIM,
        ...overrides,
      },
    ],
  };
}

const auditFor = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));
const threadClosedNotices = async () =>
  (await auditFor(NOTIFICATION_SENT_ACTION)).filter(
    (r) => (r.metadata as { kind?: string } | null)?.kind === 'thread_closed',
  );
const thread = async () => (await t.db.select().from(claimThreads))[0]!;

/** An unclaimed, AECi-seeded `integrations` row with one claim, and (unless
 *  `withThread` is false) an open thread on it with one message. */
async function seedEdge(
  opts: { mechanismKind?: string; poweredByProductId?: string; withThread?: boolean } = {},
) {
  await t.db.insert(integrations).values({
    id: EDGE,
    name: 'Seeded',
    sourceProductId: REVIT,
    targetProductId: NAVIS,
    mechanismKind: opts.mechanismKind ?? 'api',
    ...(opts.poweredByProductId ? { poweredByProductId: opts.poweredByProductId } : {}),
  });
  await t.db.insert(taxonomyDataObjects).values({ id: DO, slug: 'rfis', name: 'RFIs' });
  await t.db
    .insert(claims)
    .values({ id: CLAIM, integrationId: EDGE, dataObjectId: DO, direction: 'a_to_b' });
  if (opts.withThread === false) return;
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

/** Opens a thread on `claimId` right before the first batch commits: the race. */
function racingFactory(threadId: string, claimId: string): DbFactory {
  return (env, opts) => {
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
          .run(threadId, claimId, SUBMITTER, OWNER, '2026-10-29T00:00:00.000Z');
      }
      return batch(stmts);
    }) as typeof batch;
    return ctx;
  };
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
  ]);
});
afterEach(() => t.dispose());

describe('promote makes an integrations row connector-powered in place (AECI-1541)', () => {
  it.each(['iPaaS', 'integrator'])(
    'mechanism_kind api → %s closes the open thread not_attestable, in place',
    async (kind) => {
      await seedEdge();
      await ingest(push({ mechanismKind: kind }));

      // Still the same `integrations` row, not a move.
      const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) });
      expect(row?.mechanismKind).toBe(kind);
      expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);

      const closed = await thread();
      expect(closed).toMatchObject({ claimId: CLAIM, closedReason: 'not_attestable' });
      expect(closed.closedAt).not.toBeNull();
      // Messages are kept (§15.10).
      expect(await t.db.select().from(claimThreadMessages)).toHaveLength(1);

      const rows = await auditFor('thread.closed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'system',
        entityType: 'claim_thread',
        entityId: THREAD,
        afterState: { closedAt: closed.closedAt, closedReason: 'not_attestable' },
        metadata: {
          integrationId: EDGE,
          cause: 'became_connector_powered',
          claimId: CLAIM,
          closedReason: 'not_attestable',
        },
      });
      // Both companies are told, in the same batch (§15.8, AECI-1548).
      const notices = await threadClosedNotices();
      expect(notices.map((n) => (n.metadata as { vendorId: string }).vendorId).sort()).toEqual(
        [OWNER, SUBMITTER].sort(),
      );
    },
  );

  it('a self-referential powered_by closes the open thread not_attestable', async () => {
    await seedEdge();
    // The connector is an endpoint, so the edge stays in `integrations` (Convention A).
    await ingest(push({ poweredByProduct: { supabaseId: NAVIS } }));

    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) });
    expect(row?.poweredByProductId).toBe(NAVIS);
    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);
    expect(await thread()).toMatchObject({ claimId: CLAIM, closedReason: 'not_attestable' });
    expect(await auditFor('thread.closed')).toHaveLength(1);
  });

  it('a kind change that leaves the row ordinary closes nothing', async () => {
    await seedEdge();
    await ingest(push({ mechanismKind: 'native' }));
    expect(await thread()).toMatchObject({ closedAt: null, closedReason: null });
    expect(await auditFor('thread.closed')).toHaveLength(0);
    expect(await threadClosedNotices()).toHaveLength(0);
  });

  it('a re-promote of a row that was already connector-powered closes nothing', async () => {
    // Not a flip: the row was connector-powered before this push. (A thread on it is
    // already refused writes by §15.2; this push did not change that.)
    await seedEdge({ mechanismKind: 'iPaaS' });
    await ingest(push({ name: 'Renamed' }));
    expect(await thread()).toMatchObject({ closedAt: null });
    expect(await auditFor('thread.closed')).toHaveLength(0);
  });

  it('an omitted mechanismKind and an unresolvable poweredByProduct close nothing (ADR 0030)', async () => {
    await seedEdge();
    await ingest(push({ poweredByProduct: { supabaseId: uuid(999) } }));
    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) });
    expect(row).toMatchObject({ mechanismKind: 'api', poweredByProductId: null });
    expect(await thread()).toMatchObject({ closedAt: null });
    expect(await auditFor('thread.closed')).toHaveLength(0);
  });

  it('closes once when the same push also deletes the closed thread’s claim', async () => {
    await seedEdge();
    // An empty `claims[]` drops AECi's claim, so the claim delete runs after the close.
    await ingest(push({ mechanismKind: 'iPaaS', claims: [] }));
    expect(await t.db.select().from(claims)).toHaveLength(0);
    expect(await thread()).toMatchObject({
      claimId: null,
      closedReason: 'not_attestable',
      anchorSnapshot: { anchorId: EDGE, dataObjectId: DO },
    });
    expect(await auditFor('thread.closed')).toHaveLength(1);
    expect(await threadClosedNotices()).toHaveLength(2);
  });

  it('writes nothing when a second thread opens on the row between plan and batch', async () => {
    await seedEdge();
    const LATE_CLAIM = uuid(84);
    await t.db
      .insert(claims)
      .values({ id: LATE_CLAIM, integrationId: EDGE, dataObjectId: DO, direction: 'both' });
    const keepBoth = [
      ...KEEP_CLAIM,
      { dataObject: 'rfis', direction: 'both', attestations: [{ source: 'aeci', asserted: true }] },
    ];

    await expect(
      ingest(push({ mechanismKind: 'iPaaS', claims: keepBoth }), {
        jobId: 'job-in-place-race',
        dbFor: racingFactory(uuid(85), LATE_CLAIM),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'THREAD_CHANGED_DURING_PROMOTE' });
    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) });
    expect(row?.mechanismKind).toBe('api');
    expect(await auditFor('thread.closed')).toHaveLength(0);
    expect(await t.db.select().from(promoteJobs)).toEqual([]);
  });

  // The AECI-1544 rule: the sentinel is planned on every flip, so a first post that
  // lands between a plan that read no thread and the batch still rolls it back.
  it('writes nothing when the first thread opens on the row between plan and batch', async () => {
    await seedEdge({ withThread: false });

    await expect(
      ingest(push({ mechanismKind: 'iPaaS' }), {
        jobId: 'job-in-place-first-race',
        dbFor: racingFactory(THREAD, CLAIM),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'THREAD_CHANGED_DURING_PROMOTE' });
    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) });
    expect(row?.mechanismKind).toBe('api');
    expect(await thread()).toMatchObject({ closedAt: null });
    expect(await t.db.select().from(promoteJobs)).toEqual([]);

    // The re-push plans against the thread and closes it.
    await ingest(push({ mechanismKind: 'iPaaS' }), { jobId: 'job-in-place-first-race-2' });
    expect(await thread()).toMatchObject({ claimId: CLAIM, closedReason: 'not_attestable' });
  });
});
