/**
 * Product proposals (AECI-1416, E6b.4; ADR 0042, `REVIEW_APP_PROMOTE_API.md` §4a), driven
 * through `runPromoteIngest` against the real-SQLite harness.
 *
 * A NEW product that would join a vendor that owns its record is not created. Promote
 * stores it in `product_proposals`, frozen as validated, with its
 * `product_proposal.created` audit row in the same batch, and reports a `skipped[]` entry
 * carrying `proposalId`. Integrations touching it are skipped, never stored (Q4). A ref is
 * sent once, ever (Q5): a re-send is refused whatever the first proposal's state. A racing
 * second send of the same ref trips the unique index and errors with
 * `PRODUCT_PROPOSED_DURING_PROMOTE`.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  integrations,
  productProposals,
  productVendors,
  products,
  promoteJobs,
  taxonomyCategories,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { racingFactory, wrappedFactory } from '../test/racing-factory';
import {
  ALREADY_PROPOSED_REASONS,
  PROPOSED_PRODUCT_INTEGRATION_REASON,
  PROPOSED_PRODUCT_REASON,
  runPromoteIngest,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const OWNED = uuid(10); // owns its record
const OWNED_TOO = uuid(13); // a second owned vendor
const FREE = uuid(11); // AECi owns it
const P_FREE = uuid(22); // joined to FREE
const P_OTHER = uuid(23); // joined to FREE
const DEAD = uuid(99); // names no product row
const OWNED_AT = '2026-10-01T00:00:00.000Z';
const REF = 'p:recOpenRoads01';

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

const proposals = () => t.db.select().from(productProposals);
const auditActions = async () => (await t.db.select().from(auditLog)).map((r) => r.action);

const newProductBody = (vendorList: Array<{ ref: string; supabaseId?: string; name: string }>) => ({
  vendors: vendorList.map((v) => ({ ref: v.ref, supabaseId: v.supabaseId, companyName: v.name })),
  product: {
    ref: REF,
    name: 'OpenRoads',
    description: 'Civil design.',
    categories: ['Civil Design'],
    trades: ['paving'],
  },
});

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: OWNED, slug: 'bentley', companyName: 'Bentley', ownedAt: OWNED_AT },
    { id: OWNED_TOO, slug: 'hexagon', companyName: 'Hexagon', ownedAt: OWNED_AT },
    { id: FREE, slug: 'autodesk', companyName: 'Autodesk' },
  ]);
  await t.db.insert(products).values([
    { id: P_FREE, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: P_OTHER, slug: 'navisworks', name: 'Navisworks', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_FREE, vendorId: FREE, isPrimary: true },
    { productId: P_OTHER, vendorId: FREE, isPrimary: true },
  ]);
});
afterEach(() => t.dispose());

describe('a new product for an owned vendor becomes a proposal', () => {
  it('stores the frozen payload and its audit row in one batch, and creates nothing', async () => {
    const body = newProductBody([{ ref: 'v1', supabaseId: OWNED, name: 'Bentley' }]);
    const productsBefore = await t.db.select().from(products);
    let batchSql: string[] = [];
    const spying = wrappedFactory(t.factory, (_attempt, run, stmts) => {
      batchSql = (stmts as unknown as Array<{ toSQL(): { sql: string } }>).map((s) =>
        s.toSQL().sql.toLowerCase(),
      );
      return run();
    });

    const { response, wrote } = await ingest(body, { jobId: 'job-propose', dbFor: spying });

    const rows = await proposals();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      vendorId: OWNED,
      ref: REF,
      promoteJobId: 'job-propose',
      decision: null,
      decidedAt: null,
      decidedBy: null,
      createdProductId: null,
    });
    // The product sub-object exactly as validated, defaults included.
    expect(row!.payload).toEqual(PromotePayloadSchema.parse(body).product);

    expect(response.product).toBeNull();
    expect(response.skipped.filter((s) => s.kind === 'product')).toEqual([
      { ref: REF, kind: 'product', reason: PROPOSED_PRODUCT_REASON, proposalId: row!.id },
    ]);
    // A proposal changes no catalog state: no product, no minted term, no refresh.
    expect(wrote).toBe(false);
    expect(await t.db.select().from(products)).toEqual(productsBefore);
    expect(await t.db.select().from(taxonomyCategories)).toEqual([]);
    expect(response.taxonomy.categories).toEqual([]);
    expect(response.taxonomy.trades).toEqual([]);

    // Ledger first, then the proposal, then its audit row: one batch.
    expect(batchSql[0]).toMatch(/insert into "promote_jobs"/);
    expect(batchSql.some((s) => /insert into "product_proposals"/.test(s))).toBe(true);
    expect(batchSql.some((s) => /insert into "audit_log"/.test(s))).toBe(true);

    const audit = (await t.db.select().from(auditLog)).find(
      (r) => r.action === 'product_proposal.created',
    );
    expect(audit).toMatchObject({
      actorType: 'system',
      entityType: 'product_proposal',
      entityId: row!.id,
      vendorId: OWNED,
    });
    expect(audit!.metadata).toMatchObject({
      ref: REF,
      vendorId: OWNED,
      promoteJobId: 'job-propose',
      source: 'review-app-promote',
    });
  });

  it('skips every integration touching the proposed product and stores none of them (Q4)', async () => {
    const { response } = await ingest({
      ...newProductBody([{ ref: 'v1', supabaseId: OWNED, name: 'Bentley' }]),
      // A dead pointer is a create, so it is proposed too.
      product: { ref: REF, supabaseId: DEAD, name: 'OpenRoads' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: REF }, targetProduct: { supabaseId: P_OTHER } },
        { ref: 'i2', sourceProduct: { supabaseId: P_FREE }, targetProduct: { supabaseId: DEAD } },
        // Unrelated: neither endpoint is the proposed product, so it writes.
        {
          ref: 'i3',
          sourceProduct: { supabaseId: P_FREE },
          targetProduct: { supabaseId: P_OTHER },
        },
      ],
    });
    expect(response.skipped.filter((s) => s.kind === 'integration')).toEqual([
      { ref: 'i1', kind: 'integration', reason: PROPOSED_PRODUCT_INTEGRATION_REASON },
      { ref: 'i2', kind: 'integration', reason: PROPOSED_PRODUCT_INTEGRATION_REASON },
    ]);
    expect(response.integrations.map((i) => i.ref)).toEqual(['i3']);
    const stored = await t.db.select().from(integrations);
    expect(stored.map((r) => [r.sourceProductId, r.targetProductId])).toEqual([[P_FREE, P_OTHER]]);
    expect(await proposals()).toHaveLength(1);
  });

  it('proposes a co-owned new product (owned + unowned) to the owned vendor, and still updates the unowned one', async () => {
    const { response } = await ingest(
      newProductBody([
        { ref: 'v1', supabaseId: FREE, name: 'Autodesk Inc' },
        { ref: 'v2', supabaseId: OWNED, name: 'Bentley' },
      ]),
    );
    const [row] = await proposals();
    expect(row?.vendorId).toBe(OWNED);
    expect(response.product).toBeNull();
    expect(response.vendors.map((v) => v.id)).toEqual([FREE]);
    const free = await t.db.query.vendors.findFirst({ where: eq(vendors.id, FREE) });
    expect(free?.companyName).toBe('Autodesk Inc');
  });

  it('proposes to the FIRST owned vendor in payload order when several are owned', async () => {
    await ingest(
      newProductBody([
        { ref: 'v1', supabaseId: FREE, name: 'Autodesk' },
        { ref: 'v2', supabaseId: OWNED_TOO, name: 'Hexagon' },
        { ref: 'v3', supabaseId: OWNED, name: 'Bentley' },
      ]),
    );
    const rows = await proposals();
    expect(rows.map((r) => r.vendorId)).toEqual([OWNED_TOO]);
  });

  it('still creates a new product under an unowned vendor, with no proposal', async () => {
    const { response, wrote } = await ingest(
      newProductBody([{ ref: 'v1', supabaseId: FREE, name: 'Autodesk' }]),
    );
    expect(wrote).toBe(true);
    expect(response.product?.operation).toBe('created');
    expect(response.skipped.filter((s) => s.kind === 'product')).toEqual([]);
    expect(await proposals()).toEqual([]);
    expect(await auditActions()).not.toContain('product_proposal.created');
  });
});

describe('one send per ref, ever (Q5)', () => {
  it.each([
    ['open', null],
    ['accepted', 'accepted'],
    ['declined', 'declined'],
  ] as const)(
    'refuses a re-send when the proposal is %s, writing nothing for it',
    async (state, decision) => {
      const PRIOR = uuid(60);
      const stored = { ref: REF, name: 'OpenRoads (first send)' };
      await t.db.insert(productProposals).values({
        id: PRIOR,
        vendorId: OWNED,
        ref: REF,
        payload: stored,
        proposedAt: OWNED_AT,
        decision,
        decidedAt: decision ? OWNED_AT : null,
      });

      const { response, wrote } = await ingest(
        {
          ...newProductBody([{ ref: 'v1', supabaseId: OWNED, name: 'Bentley' }]),
          integrations: [
            { ref: 'i1', sourceProduct: { ref: REF }, targetProduct: { supabaseId: P_OTHER } },
          ],
        },
        { jobId: `job-resend-${state}` },
      );

      expect(wrote).toBe(false);
      expect(response.product).toBeNull();
      expect(response.skipped).toEqual([
        { ref: 'v1', kind: 'vendor', reason: expect.any(String) },
        { ref: REF, kind: 'product', reason: ALREADY_PROPOSED_REASONS[state], proposalId: PRIOR },
        { ref: 'i1', kind: 'integration', reason: PROPOSED_PRODUCT_INTEGRATION_REASON },
      ]);
      // The stored proposal is untouched and no second one exists.
      const rows = await proposals();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: PRIOR, payload: stored, decision });
      expect(await t.db.select().from(integrations)).toEqual([]);
      expect(await auditActions()).not.toContain('product_proposal.created');
      const blocked = (await t.db.select().from(auditLog)).find(
        (r) => r.entityType === 'product_proposal',
      );
      expect(blocked).toMatchObject({ action: 'promote.blocked', entityId: PRIOR });
      expect(blocked!.metadata).toMatchObject({ cause: 'product-already-proposed', state });
    },
  );
});

describe('races and replays', () => {
  it('maps a racing send of the same ref to PRODUCT_PROPOSED_DURING_PROMOTE, writing nothing', async () => {
    const RACER = uuid(61);
    const racing = racingFactory(t.factory, () => {
      t.raw
        .prepare(
          `INSERT INTO product_proposals (id, vendor_id, ref, payload, proposed_at, created_at, updated_at)
           VALUES (?, ?, ?, '{}', ?, ?, ?)`,
        )
        .run(RACER, OWNED, REF, OWNED_AT, OWNED_AT, OWNED_AT);
    });
    const body = newProductBody([{ ref: 'v1', supabaseId: OWNED, name: 'Bentley' }]);
    await expect(ingest(body, { jobId: 'job-race', dbFor: racing })).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_PROPOSED_DURING_PROMOTE',
    });
    // The whole batch rolled back: the racer's row only, no audit row, no ledger row.
    expect((await proposals()).map((r) => r.id)).toEqual([RACER]);
    expect(await auditActions()).toEqual([]);
    expect(await t.db.select().from(promoteJobs)).toEqual([]);

    // A re-push under a new job id gets the plan-time refusal.
    const { response } = await ingest(body, { jobId: 'job-race-2' });
    expect(response.skipped).toContainEqual({
      ref: REF,
      kind: 'product',
      reason: ALREADY_PROPOSED_REASONS.open,
      proposalId: RACER,
    });
  });

  it('a replay of the same job id returns the recorded result and stores no second proposal', async () => {
    const body = newProductBody([{ ref: 'v1', supabaseId: OWNED, name: 'Bentley' }]);
    const first = await ingest(body, { jobId: 'job-replay' });
    const second = await ingest(body, { jobId: 'job-replay' });
    expect(second.response).toEqual(first.response);
    const rows = await proposals();
    expect(rows).toHaveLength(1);
    expect(second.response.skipped).toContainEqual(
      expect.objectContaining({ ref: REF, proposalId: rows[0]!.id }),
    );
    expect((await auditActions()).filter((a) => a === 'product_proposal.created')).toHaveLength(1);
  });
});
