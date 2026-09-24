/**
 * The two connector-mapping writers can never write the same row (AECI-724).
 *
 * `planConnectorCatalogPage` (the review-app sync) refuses a `vendor`-managed catalogue
 * with `CATALOG_VENDOR_MANAGED` (AECI-720). The mapping edit refuses a `review`-managed
 * one with `CATALOG_REVIEW_MANAGED`. This spec drives BOTH writers over ONE database, in
 * both states of the flag, so the complement is tested as a pair rather than as two
 * unrelated refusals in two files. If either gate moves, one of these cells fails.
 *
 * The last two cells are the in-batch sentinels, one per lane. An edit planned while the
 * catalogue was `vendor`-managed must still refuse, and write nothing, if the flag flipped
 * back to `review` before its batch ran. A sync page planned while the catalogue was
 * `review`-managed must likewise write nothing if the flag flipped to `vendor` before its
 * batch ran (AECI-1084).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PromoteConnectorPagePayload } from '@aeci/shared';
import { PromoteConnectorPagePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client';
import {
  auditLog,
  connectorCatalogs,
  connectorStubMappings,
  connectorStubs,
  products,
  profiles,
  promoteJobs,
} from '../db/schema';
import type { Env } from '../env';
import type { PromoteRunCtx } from '../routes/promote';
import { runConnectorCatalogIngest } from '../routes/promote-connector';
import { makeTestDb, type TestDb } from '../test/d1';
import { auditInsert, type BatchTuple } from './audit';
import {
  applyMappingEdit,
  assertVendorManaged,
  loadMappingForEdit,
} from './connector-mapping-edit';
import { planConnectorCatalogPage } from './promote-connector-catalog';

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111';
const PROCORE_ID = '22222222-2222-4222-8222-222222222222';
const AUTODESK_ID = '33333333-3333-4333-8333-333333333333';
const CATALOG_ID = 'recCatAgave00001';
const STUB_ID = 'recStubProcore01';
const MAPPING_ID = 'recMapProcore001';
const STAMPS = { firstSeenAt: '2026-08-27T06:10:37.867Z', lastSeenAt: '2026-08-27T06:11:54.977Z' };

const ACTOR = {
  userId: '44444444-4444-4444-8444-444444444444',
  actorType: 'admin' as const,
  decidedBy: 'aeci-operator',
  auditSource: 'admin-connector-mapping',
};

/** A page that WOULD write if the lane were open: it re-states the mapping differently. */
const page = (decidedBy: string) =>
  PromoteConnectorPagePayloadSchema.parse({
    catalog: { id: CATALOG_ID, connectorProductId: CONNECTOR_ID },
    page: { index: 0, of: 1 },
    stubs: [{ id: STUB_ID, slug: 'procore', label: 'Procore', ...STAMPS }],
    mappings: [
      {
        id: MAPPING_ID,
        stubId: STUB_ID,
        productId: PROCORE_ID,
        status: 'mapped',
        confidence: 'high',
        decidedBy,
      },
    ],
  });

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ACTOR.userId, role: 'admin' });
  await t.db.insert(products).values([
    {
      id: CONNECTOR_ID,
      slug: 'agave',
      name: 'Agave',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
    { id: PROCORE_ID, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    {
      id: AUTODESK_ID,
      slug: 'autodesk-build',
      name: 'Autodesk Build',
      promotionStatus: 'promoted',
    },
  ]);
  // The review lane creates the catalogue and the row, as in production.
  const plan = await planConnectorCatalogPage(t.db, page('auto-name-match'));
  await t.db.batch([
    ...plan.statements,
    ...plan.audits.map((e) => auditInsert(t.db, e)),
  ] as BatchTuple);
});
afterEach(() => t.dispose());

const setManagedBy = (managedBy: 'review' | 'vendor') =>
  t.db.update(connectorCatalogs).set({ managedBy }).where(eq(connectorCatalogs.id, CATALOG_ID));

const readMapping = async () =>
  (
    await t.db.select().from(connectorStubMappings).where(eq(connectorStubMappings.id, MAPPING_ID))
  )[0];

describe('the promote lane and the edit lane are exact complements', () => {
  it('review-managed: the sync may write the row, the edit may not', async () => {
    expect((await readMapping())?.decidedBy).toBe('auto-name-match');

    const target = await loadMappingForEdit(t.db, MAPPING_ID);
    expect(() => assertVendorManaged(target!)).toThrow(
      expect.objectContaining({ status: 409, code: 'CATALOG_REVIEW_MANAGED' }),
    );

    // The sync still writes: a human decision re-stated upstream lands.
    const plan = await planConnectorCatalogPage(t.db, page('a-reviewer'));
    expect(plan.wrote).toBe(true);
    await t.db.batch(plan.statements as BatchTuple);
    expect((await readMapping())?.decidedBy).toBe('a-reviewer');
  });

  it('vendor-managed: the edit may write the row, the sync may not', async () => {
    await setManagedBy('vendor');

    const target = await loadMappingForEdit(t.db, MAPPING_ID);
    expect(() => assertVendorManaged(target!)).not.toThrow();
    const result = await applyMappingEdit(t.db, target!, { productId: AUTODESK_ID }, ACTOR);
    expect(result.response.changed).toBe(true);
    expect((await readMapping())?.productId).toBe(AUTODESK_ID);

    // The next sync page cannot reach the edited row at all.
    await expect(planConnectorCatalogPage(t.db, page('auto-name-match'))).rejects.toMatchObject({
      status: 409,
      code: 'CATALOG_VENDOR_MANAGED',
    });
    const row = await readMapping();
    expect(row?.productId).toBe(AUTODESK_ID);
    expect(row?.decidedBy).toBe('aeci-operator');
  });

  it('the in-batch sentinel refuses an edit whose lane flipped back after the read', async () => {
    await setManagedBy('vendor');
    const stale = await loadMappingForEdit(t.db, MAPPING_ID);
    // The operator reclaims the lane between the handler's read and its batch.
    await setManagedBy('review');
    const auditsBefore = (await t.db.select().from(auditLog)).length;

    await expect(
      applyMappingEdit(t.db, stale!, { productId: AUTODESK_ID }, ACTOR),
    ).rejects.toMatchObject({ status: 409, code: 'CATALOG_REVIEW_MANAGED' });

    // Rolled back whole: no row change, no audit row describing an edit that did not land.
    expect((await readMapping())?.productId).toBe(PROCORE_ID);
    expect((await t.db.select().from(auditLog)).length).toBe(auditsBefore);
    expect(await t.db.select().from(connectorStubs)).toHaveLength(1);
  });

  it('the in-batch sentinel refuses a sync page whose lane flipped to vendor after the plan (AECI-1084)', async () => {
    // Planned while the review lane is open, so the plan-time check passes and the page
    // would re-state the mapping.
    const plan = await planConnectorCatalogPage(t.db, page('a-reviewer'));
    expect(plan.wrote).toBe(true);

    // The operator hands the catalogue over, and a seat edits the row, before the page
    // commits.
    await setManagedBy('vendor');
    const target = await loadMappingForEdit(t.db, MAPPING_ID);
    await applyMappingEdit(t.db, target!, { productId: AUTODESK_ID }, ACTOR);
    const auditsBefore = (await t.db.select().from(auditLog)).length;

    // Committed exactly the way `runConnectorCatalogIngest` builds it: ledger first,
    // then the plan, then its audit row.
    await expect(
      t.db.batch([
        t.db.insert(promoteJobs).values({ jobId: 'job-planned-before-flip', result: {} }),
        ...plan.statements,
        ...plan.audits.map((e) => auditInsert(t.db, e)),
      ] as BatchTuple),
    ).rejects.toThrow(/malformed JSON/i);

    // The seat's edit survives, and nothing claims a write that did not land.
    const row = await readMapping();
    expect(row?.productId).toBe(AUTODESK_ID);
    expect(row?.decidedBy).toBe('aeci-operator');
    expect(await t.db.select().from(promoteJobs)).toHaveLength(0);
    expect((await t.db.select().from(auditLog)).length).toBe(auditsBefore);
  });

  it('a page that changes nothing carries no sentinel, so a no-op re-sync stays free', async () => {
    const plan = await planConnectorCatalogPage(t.db, page('auto-name-match'));
    expect(plan.wrote).toBe(false);
    expect(plan.statements).toHaveLength(0);
  });
});

describe('against seed/connector-fixtures.sql (the fx-cat-agave fixture)', () => {
  const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
  const QUICKBOOKS_ID = '00000000-0000-4000-8000-000000000804';

  async function fixtureDb(): Promise<TestDb> {
    const db = await makeTestDb();
    db.raw.exec(readFileSync(join(process.cwd(), 'seed', 'connector-fixtures.sql'), 'utf8'));
    await db.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
    return db;
  }

  it('edits a mapping on the vendor-managed fx-cat-agave', async () => {
    const f = await fixtureDb();
    const target = await loadMappingForEdit(f.db, 'fx-map-ag-3');
    expect(target?.managedBy).toBe('vendor');
    assertVendorManaged(target!);
    const result = await applyMappingEdit(
      f.db,
      target!,
      { productId: QUICKBOOKS_ID, confidence: 'low' },
      { ...ACTOR, userId: ADMIN_ID },
    );
    expect(result.response.changed).toBe(true);
    expect(result.response.mapping.product?.id).toBe(QUICKBOOKS_ID);
    // The auto proposal becomes publishable once an operator stands behind it.
    expect(result.response.mapping.publishable).toBe(true);
    f.dispose();
  });

  it('refuses a mapping on the review-managed fx-cat-mindcloud', async () => {
    const f = await fixtureDb();
    const target = await loadMappingForEdit(f.db, 'fx-map-mc-3');
    expect(target?.managedBy).toBe('review');
    expect(() => assertVendorManaged(target!)).toThrow(
      expect.objectContaining({ code: 'CATALOG_REVIEW_MANAGED' }),
    );
    f.dispose();
  });
});

/**
 * The AECI-1084 guard end to end, through `runConnectorCatalogIngest` and over the seeded
 * fixture: `fx-cat-mindcloud` is review-managed and `fx-cat-agave` is vendor-managed.
 */
describe('the sync page against seed/connector-fixtures.sql (AECI-1084)', () => {
  const AUTODESK_FX = '00000000-0000-4000-8000-000000000801';
  const JOB_ID = 'fx-connector-page-0001';

  async function fixtureDb(): Promise<TestDb> {
    const db = await makeTestDb();
    db.raw.exec(readFileSync(join(process.cwd(), 'seed', 'connector-fixtures.sql'), 'utf8'));
    return db;
  }

  /** One page that re-states one stored mapping with a different decider, so it writes. */
  const fixturePage = (
    catalogId: string,
    connectorProductId: string,
    mappingId: string,
    stubId: string,
  ): PromoteConnectorPagePayload =>
    PromoteConnectorPagePayloadSchema.parse({
      catalog: { id: catalogId, connectorProductId },
      page: { index: 0, of: 1 },
      mappings: [
        {
          id: mappingId,
          stubId,
          productId: AUTODESK_FX,
          status: 'mapped',
          confidence: 'high',
          decidedBy: 'a-reviewer',
        },
      ],
    });
  const mindcloudPage = () =>
    fixturePage(
      'fx-cat-mindcloud',
      '00000000-0000-4000-8000-000000000790',
      'fx-map-mc-3',
      'fx-stub-mc-autodesk-build',
    );
  const agavePage = () =>
    fixturePage(
      'fx-cat-agave',
      '00000000-0000-4000-8000-000000000791',
      'fx-map-ag-3',
      'fx-stub-ag-autodesk-build',
    );

  const runCtx = (): PromoteRunCtx => ({
    env: { ENV: 'preview' } as Env,
    request: new Request('https://api.test/api/promote/connector-catalog'),
    waitUntil: () => {},
    bookmark: () => null,
  });

  const mapping = async (f: TestDb, id: string) =>
    (await f.db.select().from(connectorStubMappings).where(eq(connectorStubMappings.id, id)))[0];
  const syncAudits = async (f: TestDb) =>
    (await f.db.select().from(auditLog)).filter((r) => r.action === 'connector_catalog.synced');

  it('review-managed fx-cat-mindcloud: the upsert writes, with its ledger and audit rows', async () => {
    const f = await fixtureDb();
    const before = (await syncAudits(f)).length;
    const result = await runConnectorCatalogIngest(
      runCtx(),
      mindcloudPage(),
      { dbFor: () => f.dbCtx },
      { jobId: JOB_ID },
    );
    expect(result.wrote).toBe(true);
    expect(result.response.counts.mappings.updated).toBe(1);
    expect((await mapping(f, 'fx-map-mc-3'))?.decidedBy).toBe('a-reviewer');
    expect(await f.db.select().from(promoteJobs)).toHaveLength(1);
    expect((await syncAudits(f)).length).toBe(before + 1);
    f.dispose();
  });

  it('vendor-managed fx-cat-agave: the upsert writes nothing', async () => {
    const f = await fixtureDb();
    const before = (await syncAudits(f)).length;
    await expect(
      runConnectorCatalogIngest(runCtx(), agavePage(), { dbFor: () => f.dbCtx }, { jobId: JOB_ID }),
    ).rejects.toMatchObject({ status: 409, code: 'CATALOG_VENDOR_MANAGED' });
    expect((await mapping(f, 'fx-map-ag-3'))?.decidedBy).toBe('auto-name-match');
    expect(await f.db.select().from(promoteJobs)).toHaveLength(0);
    expect((await syncAudits(f)).length).toBe(before);
    f.dispose();
  });

  it('a flip to vendor between plan and commit writes nothing and reports CATALOG_VENDOR_MANAGED', async () => {
    const f = await fixtureDb();
    const before = (await syncAudits(f)).length;

    // The ingest runs two batches: the planner's pre-read, then the commit. The operator's
    // flip lands between them, after the plan-time check has already passed.
    let batches = 0;
    const racing = new Proxy(f.db, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (stmts: BatchTuple) => {
            batches += 1;
            if (batches === 2) {
              await f.db
                .update(connectorCatalogs)
                .set({ managedBy: 'vendor' })
                .where(eq(connectorCatalogs.id, 'fx-cat-mindcloud'));
            }
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as Db;

    await expect(
      runConnectorCatalogIngest(
        runCtx(),
        mindcloudPage(),
        { dbFor: () => ({ db: racing, getBookmark: () => null }) },
        { jobId: JOB_ID },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'CATALOG_VENDOR_MANAGED' });
    expect(batches).toBe(2);

    // Zero mapping writes, no ledger row, and no audit row claiming a sync.
    const row = await mapping(f, 'fx-map-mc-3');
    expect(row?.decidedBy).toBe('auto-name-match');
    expect(row?.status).toBe('mapped');
    expect(await f.db.select().from(promoteJobs)).toHaveLength(0);
    expect((await syncAudits(f)).length).toBe(before);
    f.dispose();
  });
});
