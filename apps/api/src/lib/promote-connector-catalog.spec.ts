import type { PromoteConnectorPagePayload } from '@aeci/shared';
import { PromoteConnectorPagePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  auditLog,
  connectorCatalogs,
  connectorCatalogSurfaces,
  connectorEvidencedPairs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  products,
} from '../db/schema';
import { ApiError } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import { auditInsert, type BatchTuple } from './audit';
import {
  planConnectorCatalogPage,
  SKIP_CONNECTOR_UNPROMOTED,
  SKIP_MAPPING_PRODUCT_UNPROMOTED,
  SKIP_MISSING_STUB,
} from './promote-connector-catalog';

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111';
const PROCORE_ID = '22222222-2222-4222-8222-222222222222';
const CATALOG_ID = 'rec76C362381D6CDF';
const STAMPS = { firstSeenAt: '2026-08-27T06:10:37.867Z', lastSeenAt: '2026-08-27T06:11:54.977Z' };

/** Parse through the real schema so the specs exercise the wire defaults too. */
function makePage(overrides: Record<string, unknown> = {}): PromoteConnectorPagePayload {
  return PromoteConnectorPagePayloadSchema.parse({
    catalog: { id: CATALOG_ID, connectorProductId: CONNECTOR_ID },
    page: { index: 0, of: 1 },
    stubs: [{ id: 'recStubProcore01', slug: 'procore', label: 'Procore', ...STAMPS }],
    ...overrides,
  });
}

async function seedProducts(t: TestDb, opts: { procore?: boolean } = {}) {
  await t.db
    .insert(products)
    .values({ id: CONNECTOR_ID, slug: 'mindcloud', name: 'MindCloud', productRole: 'connector' });
  if (opts.procore !== false) {
    await t.db.insert(products).values({ id: PROCORE_ID, slug: 'procore', name: 'Procore' });
  }
}

/** Commit a plan the way the ingest will: statements + audit rows, one batch. */
async function commit(t: TestDb, plan: Awaited<ReturnType<typeof planConnectorCatalogPage>>) {
  const stmts = [...plan.statements, ...plan.audits.map((e) => auditInsert(t.db, e))];
  if (stmts.length) await t.db.batch(stmts as BatchTuple);
  return plan;
}

describe('planConnectorCatalogPage (AECI-714)', () => {
  it('creates the catalogue and its rows on a first page', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    const plan = await planConnectorCatalogPage(t.db, makePage());
    await commit(t, plan);

    expect(plan.wrote).toBe(true);
    expect(plan.counts.catalogs.created).toBe(1);
    expect(plan.counts.stubs.created).toBe(1);
    expect(plan.audits).toHaveLength(1);
    expect(plan.audits[0]?.action).toBe('connector_catalog.synced');
    expect((await t.db.select().from(connectorStubs)).length).toBe(1);
    t.dispose();
  });

  it('is a total no-op when the same page is re-sent — the headline property', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));

    // Pages are not atomic with each other, so re-sending one must be harmless.
    // "Harmless" here is stronger than "idempotent": ZERO statements, and therefore
    // no audit row — retention-prune's rule 4, applied to an ingest.
    const replay = await planConnectorCatalogPage(t.db, makePage());
    expect(replay.statements).toHaveLength(0);
    expect(replay.audits).toHaveLength(0);
    expect(replay.wrote).toBe(false);
    expect(replay.counts.catalogs.unchanged).toBe(1);
    expect(replay.counts.stubs.unchanged).toBe(1);
    t.dispose();
  });

  it('writes only the row that actually moved', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(
      t,
      await planConnectorCatalogPage(
        t.db,
        makePage({
          stubs: [
            { id: 'recStubProcore01', slug: 'procore', label: 'Procore', ...STAMPS },
            { id: 'recStubAcumati01', slug: 'acumatica', label: 'Acumatica', ...STAMPS },
          ],
        }),
      ),
    );

    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({
        stubs: [
          { id: 'recStubProcore01', slug: 'procore', label: 'Procore Platform', ...STAMPS },
          { id: 'recStubAcumati01', slug: 'acumatica', label: 'Acumatica', ...STAMPS },
        ],
      }),
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.counts.stubs).toMatchObject({ updated: 1, unchanged: 1, created: 0 });
    await commit(t, plan);
    const [row] = await t.db
      .select()
      .from(connectorStubs)
      .where(eq(connectorStubs.id, 'recStubProcore01'));
    expect(row?.label).toBe('Procore Platform');
    t.dispose();
  });

  it('skips the whole page when the connector platform is not promoted', async () => {
    const t = await makeTestDb();
    // Zapier and Workato are `promotion_status: on_hold` review-side (AECI-700), so
    // their catalogues arrive for a connector with no products row. Reported, never
    // fatal, and nothing is half-written.
    const plan = await planConnectorCatalogPage(t.db, makePage());
    expect(plan.statements).toHaveLength(0);
    expect(plan.wrote).toBe(false);
    expect(plan.skipped).toEqual([
      { ref: CATALOG_ID, kind: 'connector-catalog', reason: SKIP_CONNECTOR_UNPROMOTED },
    ]);
    expect(plan.counts.stubs.skipped).toBe(1);
    t.dispose();
  });

  it('skips a mapping whose product is not promoted and commits the rest of the page', async () => {
    const t = await makeTestDb();
    await seedProducts(t, { procore: false });
    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({
        mappings: [
          {
            id: 'recMapProcore001',
            stubId: 'recStubProcore01',
            productId: PROCORE_ID,
            status: 'mapped',
            decidedBy: 'chris',
          },
          { id: 'recMapParked0001', stubId: 'recStubProcore01', status: 'no_record' },
        ],
      }),
    );
    await commit(t, plan);

    expect(plan.skipped).toEqual([
      {
        ref: 'recMapProcore001',
        kind: 'connector-mapping',
        reason: SKIP_MAPPING_PRODUCT_UNPROMOTED,
      },
    ]);
    // The stub-level decision needs no product, so it lands.
    expect((await t.db.select().from(connectorStubMappings)).length).toBe(1);
    expect(plan.counts.stubs.created).toBe(1);
    t.dispose();
  });

  it('skips a pair whose stub is on a page not yet sent, then accepts it once it is', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    const pair = {
      id: 'recPairProcAcu01',
      stubAId: 'recStubAcumati01',
      stubBId: 'recStubProcore01',
      ...STAMPS,
    };

    // Pages are independent, so a pair can legitimately reference a stub a later
    // page carries. That must be reported, not fatal, and must NOT be an FK error.
    const first = await planConnectorCatalogPage(t.db, makePage({ pairs: [pair] }));
    await commit(t, first);
    expect(first.skipped).toEqual([
      { ref: pair.id, kind: 'connector-pair', reason: SKIP_MISSING_STUB },
    ]);
    expect((await t.db.select().from(connectorPairs)).length).toBe(0);

    // Send the missing stub, then re-send the pair page: it self-heals with no
    // operator action and no special ordering rule in the protocol.
    await commit(
      t,
      await planConnectorCatalogPage(
        t.db,
        makePage({ stubs: [{ id: 'recStubAcumati01', slug: 'acumatica', ...STAMPS }] }),
      ),
    );
    await commit(t, await planConnectorCatalogPage(t.db, makePage({ pairs: [pair] })));
    expect((await t.db.select().from(connectorPairs)).length).toBe(1);
    t.dispose();
  });

  it('accepts a stub and its own mappings on one page', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({
        mappings: [
          {
            id: 'recMapProcore001',
            stubId: 'recStubProcore01',
            productId: PROCORE_ID,
            status: 'mapped',
            decidedBy: 'chris',
          },
        ],
      }),
    );
    await commit(t, plan);
    expect(plan.skipped).toEqual([]);
    expect((await t.db.select().from(connectorStubMappings)).length).toBe(1);
    t.dispose();
  });

  it('orders deletes before upserts so a re-roled surface cannot trip its unique index', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(
      t,
      await planConnectorCatalogPage(
        t.db,
        makePage({
          surfaces: [
            { id: 'recSurfaceApps1', surfaceRole: 'apps' },
            { id: 'recSurfaceAll01', surfaceRole: 'all' },
          ],
        }),
      ),
    );

    // Retire the `all` surface and re-role `apps` onto `all` in ONE page. Upserts
    // first would collide on connector_catalog_surfaces_role_idx and roll the whole
    // page back; deletes first is why this commits.
    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({
        surfaces: [{ id: 'recSurfaceApps1', surfaceRole: 'all' }],
        deleted: { surfaces: ['recSurfaceAll01'], mappings: [] },
      }),
    );
    await commit(t, plan);
    const rows = await t.db.select().from(connectorCatalogSurfaces);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'recSurfaceApps1', surfaceRole: 'all' });
    t.dispose();
  });

  it('orders deletes before upserts so a moved stub-level decision cannot trip its partial index', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(
      t,
      await planConnectorCatalogPage(
        t.db,
        makePage({
          mappings: [{ id: 'recMapOld0000001', stubId: 'recStubProcore01', status: 'no_record' }],
        }),
      ),
    );

    // Same stub, same family, different row — connector_stub_mappings_decision_idx
    // permits exactly one, so the delete has to land first.
    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({
        mappings: [
          { id: 'recMapNew0000001', stubId: 'recStubProcore01', status: 'ambiguous_parked' },
        ],
        deleted: { surfaces: [], mappings: ['recMapOld0000001'] },
      }),
    );
    await commit(t, plan);
    const rows = await t.db.select().from(connectorStubMappings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'recMapNew0000001', status: 'ambiguous_parked' });
    t.dispose();
  });

  it('applies a removedAt tombstone as an ordinary update, never a delete', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));
    await commit(
      t,
      await planConnectorCatalogPage(
        t.db,
        makePage({
          stubs: [
            {
              id: 'recStubProcore01',
              slug: 'procore',
              label: 'Procore',
              ...STAMPS,
              removedAt: '2026-08-30T00:00:00.000Z',
            },
          ],
        }),
      ),
    );
    const [row] = await t.db.select().from(connectorStubs);
    // Promote has no delete semantics: retirement is a visible tombstone, and the
    // row and its mapping history survive.
    expect(row?.removedAt).toBe('2026-08-30T00:00:00.000Z');
    t.dispose();
  });

  it('never writes connector_evidenced_pairs — that tier is AECI-721 s', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({
        mappings: [
          {
            id: 'recMapProcore001',
            stubId: 'recStubProcore01',
            productId: PROCORE_ID,
            status: 'mapped',
            decidedBy: 'chris',
          },
        ],
      }),
    );
    await commit(t, plan);
    // §13.1: reachability is derived from mappings and is NEVER stored as delivered.
    // A mapping must not manufacture an evidenced pair, ever.
    const sql = plan.statements
      .map((stmt) => (stmt as unknown as { toSQL(): { sql: string } }).toSQL().sql)
      .join(' ');
    expect(sql).not.toContain('connector_evidenced_pairs');
    expect(sql).toContain('connector_stub_mappings');
    expect((await t.db.select().from(connectorEvidencedPairs)).length).toBe(0);
    t.dispose();
  });

  it('chunks its pre-read IN (…) lists below the D1 bound-parameter cap', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    // 200 stubs → the id read must split into three lists of ≤90, not one of 200.
    // better-sqlite3 accepts an over-cap list happily; D1 does not, and no spec
    // would catch it if the planner stopped chunking.
    const stubs = Array.from({ length: 200 }, (_, i) => ({
      id: `recStub${String(i).padStart(10, '0')}`,
      slug: `app-${i}`,
      ...STAMPS,
    }));
    const plan = await planConnectorCatalogPage(t.db, makePage({ stubs }));
    await commit(t, plan);
    expect(plan.counts.stubs.created).toBe(200);
    expect((await t.db.select().from(connectorStubs)).length).toBe(200);
    t.dispose();
  });

  it('leaves the catalogue row alone when only its children moved', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));
    const before = (await t.db.select().from(connectorCatalogs))[0];

    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({ stubs: [{ id: 'recStubAcumati01', slug: 'acumatica', ...STAMPS }] }),
    );
    await commit(t, plan);
    expect(plan.counts.catalogs.unchanged).toBe(1);
    const after = (await t.db.select().from(connectorCatalogs))[0];
    expect(after?.updatedAt).toBe(before?.updatedAt);
    t.dispose();
  });
});

describe('the per-iPaaS management cutoff (AECI-720)', () => {
  /** Freeze a catalogue the way the admin flip does, after it exists. */
  async function freeze(t: TestDb) {
    await t.db
      .update(connectorCatalogs)
      .set({ managedBy: 'vendor' })
      .where(eq(connectorCatalogs.id, CATALOG_ID));
  }

  it('refuses a page for a vendor-managed catalogue with CATALOG_VENDOR_MANAGED', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));
    await freeze(t);

    // A page that WOULD have written something if the lane were open — a new stub —
    // so the refusal is what stops the write, not the no-op change detection.
    const page = makePage({ stubs: [{ id: 'recStubAcumati01', slug: 'acumatica', ...STAMPS }] });
    await expect(planConnectorCatalogPage(t.db, page)).rejects.toThrow(ApiError);
    await expect(planConnectorCatalogPage(t.db, page)).rejects.toMatchObject({
      status: 409,
      code: 'CATALOG_VENDOR_MANAGED',
    });
    t.dispose();
  });

  it('writes NOTHING on a refusal — no rows, no audit row', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));
    await freeze(t);
    const auditsBefore = (await t.db.select().from(auditLog)).length;

    await expect(
      planConnectorCatalogPage(
        t.db,
        makePage({ stubs: [{ id: 'recStubAcumati01', slug: 'acumatica', ...STAMPS }] }),
      ),
    ).rejects.toThrow(ApiError);

    // The throw lands before a single statement is built, so there is nothing to roll
    // back: the new stub never appears and the refusal itself is not a domain-state
    // change, so it emits no `audit_log` row either.
    expect((await t.db.select().from(connectorStubs)).length).toBe(1);
    expect((await t.db.select().from(auditLog)).length).toBe(auditsBefore);
    t.dispose();
  });

  it('refuses BEFORE the unpromoted-connector skip, not after', async () => {
    // The ordering case. Zapier and Workato are `on_hold` review-side (AECI-700), so a
    // vendor-managed catalogue whose platform is unpromoted is the live combination —
    // and it must reject rather than come back as a re-sendable skip telling the caller
    // "try again later" when the answer is permanently no.
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));
    await freeze(t);

    await expect(
      planConnectorCatalogPage(t.db, makePage({ catalog: { id: CATALOG_ID } })),
    ).rejects.toMatchObject({ status: 409, code: 'CATALOG_VENDOR_MANAGED' });
    t.dispose();
  });

  it('is unmoved by the wire — a page claiming managedBy cannot flip the flag', async () => {
    // The defect AECI-720 closes: until the field left the schema, every page wrote
    // `managed_by` from the payload, so any re-sync silently un-froze a vendor-managed
    // catalogue. Zod strips the key, so the value never reaches `catalogValues`.
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));
    await freeze(t);

    await expect(
      planConnectorCatalogPage(
        t.db,
        makePage({
          catalog: { id: CATALOG_ID, connectorProductId: CONNECTOR_ID, managedBy: 'review' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VENDOR_MANAGED' });

    const row = (await t.db.select().from(connectorCatalogs))[0];
    expect(row?.managedBy).toBe('vendor');
    t.dispose();
  });

  it('lets a reclaimed lane commit again — the flag is reversible', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));
    await freeze(t);
    await t.db
      .update(connectorCatalogs)
      .set({ managedBy: 'review' })
      .where(eq(connectorCatalogs.id, CATALOG_ID));

    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({ stubs: [{ id: 'recStubAcumati01', slug: 'acumatica', ...STAMPS }] }),
    );
    await commit(t, plan);
    expect(plan.wrote).toBe(true);
    expect((await t.db.select().from(connectorStubs)).length).toBe(2);
    t.dispose();
  });

  it('never writes managed_by on a normal page — the column keeps its default', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));
    expect((await t.db.select().from(connectorCatalogs))[0]?.managedBy).toBe('review');
    t.dispose();
  });
});
