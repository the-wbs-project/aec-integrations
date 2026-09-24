import type { PromoteConnectorPagePayload } from '@aeci/shared';
import { PromoteConnectorPagePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  connectorCatalogs,
  connectorCatalogSurfaces,
  connectorEvidencedPairs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  products,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { ApiError } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import { auditInsert, type BatchTuple } from './audit';
import {
  planConnectorCatalogPage,
  SKIP_CLAIM_DATA_OBJECT,
  SKIP_CLAIM_FOREIGN_PAIR,
  SKIP_CLAIM_IDENTITY_TAKEN,
  SKIP_CLAIM_MISSING_PAIR,
  SKIP_CLAIM_VENDOR_ORIGIN,
  SKIP_CONNECTOR_UNPROMOTED,
  SKIP_MAPPING_PRODUCT_UNPROMOTED,
  SKIP_MISSING_STUB,
} from './promote-connector-catalog';

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111';
const PROCORE_ID = '22222222-2222-4222-8222-222222222222';
const CATALOG_ID = 'rec76C362381D6CDF';
const STAMPS = { firstSeenAt: '2026-08-27T06:10:37.867Z', lastSeenAt: '2026-08-27T06:11:54.977Z' };

// ── AECI-891 reach-claim fixtures ───────────────────────────────────────────
const RFIS_ID = '33333333-3333-4333-8333-333333333333';
const SUBMITTALS_ID = '44444444-4444-4444-8444-444444444444';
const VENDOR_ID = '55555555-5555-4555-8555-555555555555';
const WORKATO_ID = '66666666-6666-4666-8666-666666666666';
/** Canonical order is `stubAId < stubBId`, which `connector_pairs_canonical_order` enforces. */
const STUB_A = 'recStubAcumati01';
const STUB_B = 'recStubProcore01';
const PAIR_ID = 'recPairProcAcu01';
const CLAIM_ID = 'recClaimRfis0001';

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

/** The closed `data_object` vocabulary, find-only. Two terms is enough to prove the
 *  resolver is consulted rather than the string being stored raw. */
async function seedDataObjects(t: TestDb) {
  await t.db.insert(taxonomyDataObjects).values([
    { id: RFIS_ID, slug: 'rfis', name: 'RFIs', aliases: ['Requests for Information'] },
    { id: SUBMITTALS_ID, slug: 'submittals', name: 'Submittals', aliases: null },
  ]);
}

/** A page carrying two stubs, the pair they form, and one claim on that pair — the
 *  self-sufficient shape, which is what a claim-bearing page will normally look like. */
function claimPage(overrides: Record<string, unknown> = {}): PromoteConnectorPagePayload {
  return makePage({
    stubs: [
      { id: STUB_B, slug: 'procore', label: 'Procore', ...STAMPS },
      { id: STUB_A, slug: 'acumatica', label: 'Acumatica', ...STAMPS },
    ],
    pairs: [{ id: PAIR_ID, stubAId: STUB_A, stubBId: STUB_B, ...STAMPS }],
    claims: [
      {
        id: CLAIM_ID,
        connectorPairId: PAIR_ID,
        dataObject: 'RFIs',
        direction: 'a_to_b',
        attestations: [{ source: 'aeci', asserted: true }],
      },
    ],
    ...overrides,
  });
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

    // AECI-891 extends the property to claims and to the `aeci` attestation hanging off
    // each one. Asserted HERE rather than in a parallel test, because the property is
    // about the whole page: a claim table that re-wrote its attestation on every sync
    // would make every one of these assertions pass and still deposit an `audit_log` row
    // per page per week into the one table nothing prunes.
    await seedDataObjects(t);
    await commit(t, await planConnectorCatalogPage(t.db, claimPage()));
    const [attestationBefore] = await t.db.select().from(attestations);

    const claimReplay = await planConnectorCatalogPage(t.db, claimPage());
    expect(claimReplay.statements).toHaveLength(0);
    expect(claimReplay.audits).toHaveLength(0);
    expect(claimReplay.wrote).toBe(false);
    expect(claimReplay.counts.claims).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    // `updated_at` would move if the attestation had been rewritten in place, and the id
    // would move if it had been churned. Neither may.
    const [attestationAfter] = await t.db.select().from(attestations);
    expect(attestationAfter?.id).toBe(attestationBefore?.id);
    expect(attestationAfter?.updatedAt).toBe(attestationBefore?.updatedAt);
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
    // The AECI-1084 `managed_by` sentinel, then the one stub that moved.
    expect(plan.statements).toHaveLength(2);
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
    // A catalogue can arrive for a connector with no products row. Zapier's did
    // until AECI-1064 promoted it on 2026-09-23 (reversing the AECI-700 park).
    // Reported, never fatal, and nothing is half-written.
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

describe('reach-tier claims on the connector arm (AECI-891)', () => {
  async function ready() {
    const t = await makeTestDb();
    await seedProducts(t);
    await seedDataObjects(t);
    return t;
  }

  it('lands a claim on connector_pair_id and nowhere else', async () => {
    const t = await ready();
    const plan = await planConnectorCatalogPage(t.db, claimPage());
    await commit(t, plan);

    expect(plan.skipped).toEqual([]);
    expect(plan.counts.claims.created).toBe(1);
    const [row] = await t.db.select().from(claims);
    // The REACH anchor, and only the reach anchor. `claims_anchor_check` sums the three
    // and demands exactly one, so a planner that filled two would fail the whole page —
    // and one that filled `integration_id` would assert DELIVERY, which a reached pair
    // does not support.
    expect(row).toMatchObject({
      id: CLAIM_ID,
      connectorPairId: PAIR_ID,
      integrationId: null,
      connectorEvidencedPairId: null,
      dataObjectId: RFIS_ID,
      direction: 'a_to_b',
      origin: 'aeci',
      createdByVendorId: null,
    });
    // The generated column resolves to the pair, so `claims_identity_key` guards this
    // claim the same way it guards a delivered one.
    expect(row?.anchorId).toBe(PAIR_ID);
    const [attestation] = await t.db.select().from(attestations);
    expect(attestation).toMatchObject({ claimId: CLAIM_ID, source: 'aeci', asserted: true });
    t.dispose();
  });

  it('resolves the data object find-only, by alias, and never mints a term', async () => {
    const t = await ready();
    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({
        claims: [
          {
            id: CLAIM_ID,
            connectorPairId: PAIR_ID,
            dataObject: 'Requests for Information',
            direction: 'both',
            attestations: [{ source: 'aeci', asserted: true }],
          },
        ],
      }),
    );
    await commit(t, plan);
    expect((await t.db.select().from(claims))[0]?.dataObjectId).toBe(RFIS_ID);
    expect(await t.db.select().from(taxonomyDataObjects)).toHaveLength(2);
    t.dispose();
  });

  it('reports an unresolvable data object and writes the rest of the page', async () => {
    const t = await ready();
    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({
        claims: [
          {
            id: CLAIM_ID,
            connectorPairId: PAIR_ID,
            dataObject: 'Punch lists',
            direction: 'a_to_b',
            attestations: [{ source: 'aeci', asserted: true }],
          },
        ],
      }),
    );
    await commit(t, plan);

    // The vocabulary is frozen and closed; adding a term is an AECi curation act that
    // promote may not perform, so the miss is reported rather than created or fatal.
    expect(plan.skipped).toEqual([
      {
        ref: CLAIM_ID,
        kind: 'claim',
        reason: `dataObject "Punch lists" ${SKIP_CLAIM_DATA_OBJECT}`,
      },
    ]);
    expect(plan.counts.claims.skipped).toBe(1);
    expect(await t.db.select().from(claims)).toHaveLength(0);
    expect(await t.db.select().from(taxonomyDataObjects)).toHaveLength(2);
    // The pair the claim named still landed — a dropped claim never drops its page.
    expect(await t.db.select().from(connectorPairs)).toHaveLength(1);
    t.dispose();
  });

  it('skips a claim whose pair rides a page not yet sent, then accepts it once it is', async () => {
    const t = await ready();
    const claimOnly = makePage({
      claims: [
        {
          id: CLAIM_ID,
          connectorPairId: PAIR_ID,
          dataObject: 'RFIs',
          direction: 'a_to_b',
          attestations: [{ source: 'aeci', asserted: true }],
        },
      ],
    });

    // §3a: references may dangle, and that is REPORTED rather than fatal. A stricter rule
    // would make the sender responsible for an ordering the protocol does not define.
    const first = await planConnectorCatalogPage(t.db, claimOnly);
    await commit(t, first);
    expect(first.skipped).toEqual([
      { ref: CLAIM_ID, kind: 'claim', reason: SKIP_CLAIM_MISSING_PAIR },
    ]);
    expect(await t.db.select().from(claims)).toHaveLength(0);

    // Self-heals with no operator action: send the pair, re-send the claim page.
    await commit(t, await planConnectorCatalogPage(t.db, claimPage({ claims: [] })));
    await commit(t, await planConnectorCatalogPage(t.db, claimOnly));
    expect(await t.db.select().from(claims)).toHaveLength(1);
    t.dispose();
  });

  it('skips a claim whose pair rode this page and was ITSELF skipped', async () => {
    const t = await ready();
    // The subtle one. The pair is present in the payload, so a planner checking only
    // "is it on the page?" would emit the claim — and its foreign key would fail and roll
    // back the WHOLE page, turning one unsendable claim into a silent no-op sync.
    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({ stubs: [{ id: STUB_B, slug: 'procore', ...STAMPS }] }),
    );
    await commit(t, plan);

    expect(plan.skipped).toEqual([
      { ref: PAIR_ID, kind: 'connector-pair', reason: SKIP_MISSING_STUB },
      { ref: CLAIM_ID, kind: 'claim', reason: SKIP_CLAIM_MISSING_PAIR },
    ]);
    expect(await t.db.select().from(claims)).toHaveLength(0);
    t.dispose();
  });

  it('refuses a claim on another catalogue s pair — the page scoping rule', async () => {
    const t = await ready();
    await commit(t, await planConnectorCatalogPage(t.db, claimPage({ claims: [] })));

    // A second catalogue needs a second connector platform — `connector_product_id` is
    // UNIQUE, one catalogue per iPaaS.
    await t.db
      .insert(products)
      .values({ id: WORKATO_ID, slug: 'workato', name: 'Workato', productRole: 'connector' });

    // Every other child row binds the PAGE s catalogue id, which is what makes "one page
    // writes one catalogue s rows" true — and what AECI-720 s vendor-managed freeze rests
    // on. A claim s only scope is the pair it names, so without this check a page for an
    // open catalogue could write claims onto a FROZEN one s pairs.
    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({
        catalog: { id: 'recOtherCatalog1', connectorProductId: WORKATO_ID },
        claims: [
          {
            id: 'recClaimForeign1',
            connectorPairId: PAIR_ID,
            dataObject: 'RFIs',
            direction: 'a_to_b',
            attestations: [{ source: 'aeci', asserted: true }],
          },
        ],
      }),
    );
    await commit(t, plan);
    expect(plan.skipped).toEqual([
      { ref: 'recClaimForeign1', kind: 'claim', reason: SKIP_CLAIM_FOREIGN_PAIR },
    ]);
    expect(await t.db.select().from(claims)).toHaveLength(0);
    t.dispose();
  });

  it('does NOT replace by absence — a page omitting a claim leaves it alone', async () => {
    const t = await ready();
    await commit(t, await planConnectorCatalogPage(t.db, claimPage()));

    // The whole reason this arm diverges from the product arm. The product promote carries
    // an integration s claims WHOLE, so absence means "AECi withdrew it". A connector page
    // is a SLICE of a catalogue, so absence means "it is on another page" — and replacing
    // by absence would let page 2 of a sync delete what page 1 committed.
    const plan = await planConnectorCatalogPage(t.db, claimPage({ claims: [] }));
    await commit(t, plan);
    expect(plan.counts.claims).toMatchObject({ deleted: 0, skipped: 0 });
    expect(await t.db.select().from(claims)).toHaveLength(1);
    t.dispose();
  });

  it('removes a claim only when the page says so, and cascades its attestation', async () => {
    const t = await ready();
    await commit(t, await planConnectorCatalogPage(t.db, claimPage()));
    expect(await t.db.select().from(attestations)).toHaveLength(1);

    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({ claims: [], deleted: { surfaces: [], mappings: [], claims: [CLAIM_ID] } }),
    );
    await commit(t, plan);
    expect(plan.counts.claims.deleted).toBe(1);
    expect(await t.db.select().from(claims)).toHaveLength(0);
    // `attestations.claim_id` is ON DELETE CASCADE, so there is no second statement.
    expect(await t.db.select().from(attestations)).toHaveLength(0);
    // The destructive act is NAMED in the summary row, not merely counted — `deleted: 1`
    // would leave an operator unable to say which claim went.
    expect(plan.audits[0]?.metadata).toMatchObject({ deletedClaimIds: [CLAIM_ID] });
    t.dispose();
  });

  it('re-sending a delete for an already-gone claim writes nothing at all', async () => {
    const t = await ready();
    await commit(t, await planConnectorCatalogPage(t.db, claimPage()));
    const deletePage = claimPage({
      claims: [],
      deleted: { surfaces: [], mappings: [], claims: [CLAIM_ID] },
    });
    await commit(t, await planConnectorCatalogPage(t.db, deletePage));
    const auditsAfterDelete = (await t.db.select().from(auditLog)).length;

    // Filtered against the pre-read rather than issued blind. A blind DELETE would emit a
    // statement for an id that matches nothing, and that statement alone would write an
    // `audit_log` row on every re-send of a page that changes nothing.
    const replay = await planConnectorCatalogPage(t.db, deletePage);
    expect(replay.statements).toHaveLength(0);
    expect(replay.audits).toHaveLength(0);
    expect(replay.wrote).toBe(false);
    expect((await t.db.select().from(auditLog)).length).toBe(auditsAfterDelete);
    t.dispose();
  });

  it('never deletes or overwrites a vendor-origin claim', async () => {
    const t = await ready();
    await commit(t, await planConnectorCatalogPage(t.db, claimPage()));
    await t.db.insert(vendors).values({ id: VENDOR_ID, slug: 'procore', companyName: 'Procore' });
    await t.db
      .update(claims)
      .set({ origin: 'vendor', createdByVendorId: VENDOR_ID })
      .where(eq(claims.id, CLAIM_ID));

    // Rule 2 of STAGE_2_ATTESTATIONS_SPEC.md §3, which AECI-604 had to learn the hard way
    // on the product arm: AECi keeps curating, the vendor s word survives. Unreachable
    // today — only this arm writes reach claims, and it writes `origin='aeci'` — which is
    // exactly the argument that was wrong last time.
    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({ deleted: { surfaces: [], mappings: [], claims: [CLAIM_ID] } }),
    );
    await commit(t, plan);
    expect(plan.skipped).toEqual([
      { ref: CLAIM_ID, kind: 'claim', reason: SKIP_CLAIM_VENDOR_ORIGIN },
      { ref: CLAIM_ID, kind: 'claim', reason: SKIP_CLAIM_VENDOR_ORIGIN },
    ]);
    const [row] = await t.db.select().from(claims);
    expect(row).toMatchObject({ origin: 'vendor', createdByVendorId: VENDOR_ID });
    t.dispose();
  });

  it('reports the loser when two records assert one identity, instead of failing the page', async () => {
    const t = await ready();
    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({
        claims: [
          {
            id: CLAIM_ID,
            connectorPairId: PAIR_ID,
            dataObject: 'RFIs',
            direction: 'a_to_b',
            attestations: [{ source: 'aeci', asserted: true }],
          },
          {
            id: 'recClaimRfisDup1',
            connectorPairId: PAIR_ID,
            // Same term by alias, same direction — a duplicate the WIRE cannot see,
            // because `dataObject` is resolved server-side.
            dataObject: 'Requests for Information',
            direction: 'a_to_b',
            attestations: [{ source: 'aeci', asserted: true }],
          },
        ],
      }),
    );
    await commit(t, plan);

    // `claims_identity_key` admits exactly one. Letting the second through would roll the
    // WHOLE page back at commit — 500 rows lost to one duplicate.
    expect(plan.skipped).toEqual([
      { ref: 'recClaimRfisDup1', kind: 'claim', reason: SKIP_CLAIM_IDENTITY_TAKEN },
    ]);
    expect(await t.db.select().from(claims)).toHaveLength(1);
    t.dispose();
  });

  it('lets a re-keyed claim take the identity of one the SAME page deletes', async () => {
    const t = await ready();
    await commit(t, await planConnectorCatalogPage(t.db, claimPage()));

    // The re-key shape: the review app hard-deletes record X and sends record Y on the
    // same (pair, dataObject, direction). The DELETE is spliced ahead of every upsert, so
    // the identity is free by commit time — rejecting Y with SKIP_CLAIM_IDENTITY_TAKEN
    // would report a TERMINAL, not-re-sendable conflict over data that is already right,
    // and only a second send of the identical page would land it.
    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({
        claims: [
          {
            id: 'recClaimRfisRekey',
            connectorPairId: PAIR_ID,
            dataObject: 'RFIs',
            direction: 'a_to_b',
            attestations: [{ source: 'aeci', asserted: true }],
          },
        ],
        deleted: { surfaces: [], mappings: [], claims: [CLAIM_ID] },
      }),
    );
    await commit(t, plan);

    expect(plan.skipped).toEqual([]);
    expect(plan.counts.claims).toMatchObject({ created: 1, deleted: 1, skipped: 0 });
    const rows = await t.db.select().from(claims);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'recClaimRfisRekey', anchorId: PAIR_ID });
    t.dispose();
  });

  it('keeps a claim s id when the review app re-anchors or re-terms it', async () => {
    const t = await ready();
    await commit(t, await planConnectorCatalogPage(t.db, claimPage()));

    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({
        claims: [
          {
            id: CLAIM_ID,
            connectorPairId: PAIR_ID,
            dataObject: 'Submittals',
            direction: 'b_to_a',
            attestations: [{ source: 'aeci', asserted: true }],
          },
        ],
      }),
    );
    await commit(t, plan);
    expect(plan.counts.claims).toMatchObject({ created: 0, updated: 1 });
    const rows = await t.db.select().from(claims);
    // The review record id is the key, so the row is edited rather than churned — and
    // `attestations.claim_id` keeps pointing at it.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: CLAIM_ID,
      dataObjectId: SUBMITTALS_ID,
      direction: 'b_to_a',
    });
    expect((await t.db.select().from(attestations))[0]?.claimId).toBe(CLAIM_ID);
    t.dispose();
  });

  it('updates the aeci attestation in place and counts the claim as moved', async () => {
    const t = await ready();
    await commit(t, await planConnectorCatalogPage(t.db, claimPage()));
    const [before] = await t.db.select().from(attestations);

    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({
        claims: [
          {
            id: CLAIM_ID,
            connectorPairId: PAIR_ID,
            dataObject: 'RFIs',
            direction: 'a_to_b',
            attestations: [
              {
                source: 'aeci',
                asserted: true,
                introducedAt: '2026-01-01',
                note: 'from the pair page',
              },
            ],
          },
        ],
      }),
    );
    await commit(t, plan);

    // The claim ROW did not move; its attestation did. Reporting `unchanged` here would
    // make the one number that proves a page was idempotent lie.
    expect(plan.counts.claims).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    const [after] = await t.db.select().from(attestations);
    // Updated in place, not delete-then-insert: the id is the anchor AECI-303 s version
    // diff needs to stay put.
    expect(after?.id).toBe(before?.id);
    expect(after).toMatchObject({ introducedAt: '2026-01-01', note: 'from the pair page' });
    t.dispose();
  });

  it('refuses to fill a vendor attestation slot, and says so', async () => {
    const t = await ready();
    const plan = await planConnectorCatalogPage(
      t.db,
      claimPage({
        claims: [
          {
            id: CLAIM_ID,
            connectorPairId: PAIR_ID,
            dataObject: 'RFIs',
            direction: 'a_to_b',
            attestations: [
              { source: 'vendor_a', asserted: true },
              { source: 'aeci', asserted: true },
            ],
          },
        ],
      }),
    );
    await commit(t, plan);

    // Permitted by the schema (one shared attestation shape) and refused here, exactly as
    // the product arm refuses it: inserting a vendor slot would collide with a live vendor
    // row on `attestations_slot_key` and 500 the whole page.
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({ ref: CLAIM_ID, kind: 'claim' });
    expect(plan.skipped[0]?.reason).toContain('vendor_a');
    const rows = await t.db.select().from(attestations);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('aeci');
    t.dispose();
  });

  it('survives a pre-AECI-891 page that carries no claims key at all', async () => {
    const t = await ready();
    // NOT a hypothetical. `runPromoteWorkflow` CASTS an inline params payload instead of
    // re-parsing it, and Workflows are at-least-once — so an instance created before this
    // shipped can replay days later with no `claims` key. Iterating it directly throws
    // `page.claims is not iterable` and kills an in-flight connector page.
    const legacy = makePage();
    delete (legacy as { claims?: unknown }).claims;

    const plan = await planConnectorCatalogPage(t.db, legacy);
    await commit(t, plan);
    expect(plan.counts.claims).toMatchObject({ created: 0, skipped: 0 });
    expect(await t.db.select().from(connectorStubs)).toHaveLength(1);
    t.dispose();
  });

  it('skips every claim when the connector platform is not promoted', async () => {
    const t = await makeTestDb();
    await seedDataObjects(t);
    const plan = await planConnectorCatalogPage(t.db, claimPage());
    expect(plan.statements).toHaveLength(0);
    expect(plan.counts.claims.skipped).toBe(1);
    expect(await t.db.select().from(claims)).toHaveLength(0);
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
    // The ordering case. Connectors stay unpromoted in practice (Make, n8n, Boomi; Zapier
    // and Workato until AECI-1064, 2026-09-23), so a
    // vendor-managed catalogue whose platform is unpromoted is a live combination —
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

/**
 * The reach-line purge set (AECI-892).
 *
 * `CACHE_STRATEGY.md` §3 rule 5 parked the connector lane's cache obligation on the
 * grounds that no cacheable route read these tables, and transferred it to the first
 * public reader. §13.7's reach line is that reader, so these rows now change what a
 * product page says and the page has to repaint.
 *
 * Two of these are regressions rather than coverage:
 *
 *  - a PAIR row moving must purge both its endpoints even though no mapping changed.
 *    AECI-890 wrote 669 pair rows and not one mapping, so a mapping-only collector
 *    would have purged nothing on the single largest reach change we have made;
 *  - the `preread` batch is unpacked by POSITION. Adding this read anywhere but last
 *    re-points every map below it, and the failure is silent in the worst direction:
 *    `existingPairs` keys on `undefined`, change detection reports every pair as new,
 *    and the "re-sent page writes nothing" property dies.
 */
describe('purgeProductIds — the reach-line cache set (AECI-892)', () => {
  const STUB_PROCORE = 'recStubProcore01';
  const STUB_ACUMATICA = 'recStubAcumati01';
  const ACUMATICA_ID = '77777777-7777-4777-8777-777777777777';

  async function seedThree(t: TestDb) {
    await seedProducts(t);
    await t.db.insert(products).values({ id: ACUMATICA_ID, slug: 'acumatica', name: 'Acumatica' });
  }

  const twoStubPage = (extra: Record<string, unknown> = {}) =>
    makePage({
      stubs: [
        { id: STUB_ACUMATICA, slug: 'acumatica', label: 'Acumatica', ...STAMPS },
        { id: STUB_PROCORE, slug: 'procore', label: 'Procore', ...STAMPS },
      ],
      ...extra,
    });

  it('is EMPTY for a page that changed nothing', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(t, await planConnectorCatalogPage(t.db, makePage()));

    const replay = await planConnectorCatalogPage(t.db, makePage());
    expect(replay.wrote).toBe(false);
    expect(replay.purgeProductIds).toEqual([]);
    t.dispose();
  });

  it('carries the catalogue connector on any page that wrote', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    const plan = await planConnectorCatalogPage(t.db, makePage());
    expect(plan.purgeProductIds).toContain(CONNECTOR_ID);
    t.dispose();
  });

  it('carries the product a new mapping names', async () => {
    const t = await makeTestDb();
    await seedProducts(t);
    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({
        mappings: [
          {
            id: 'recMapProcore001',
            stubId: STUB_PROCORE,
            productId: PROCORE_ID,
            status: 'mapped',
            decidedBy: 'chris',
          },
        ],
      }),
    );
    expect(plan.purgeProductIds).toContain(PROCORE_ID);
    t.dispose();
  });

  it('carries BOTH sides when a mapping is re-pointed to a different product', async () => {
    // Purging only the new one leaves the old page asserting reach it no longer has
    // — the same shape as Addendum B's re-pointed-connector gap.
    const t = await makeTestDb();
    await seedThree(t);
    const mapping = (productId: string) => ({
      id: 'recMapProcore001',
      stubId: STUB_PROCORE,
      productId,
      status: 'mapped' as const,
      decidedBy: 'chris',
    });
    await commit(
      t,
      await planConnectorCatalogPage(t.db, makePage({ mappings: [mapping(PROCORE_ID)] })),
    );

    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({ mappings: [mapping(ACUMATICA_ID)] }),
    );
    expect([...plan.purgeProductIds].sort()).toEqual(
      [CONNECTOR_ID, PROCORE_ID, ACUMATICA_ID].sort(),
    );
    t.dispose();
  });

  it('carries the deleted mapping’s product, read off the pre-read', async () => {
    // The row is gone by the time anything downstream could look, so the pre-read is
    // the only surviving copy of which product just lost reach.
    const t = await makeTestDb();
    await seedProducts(t);
    await commit(
      t,
      await planConnectorCatalogPage(
        t.db,
        makePage({
          mappings: [
            {
              id: 'recMapProcore001',
              stubId: STUB_PROCORE,
              productId: PROCORE_ID,
              status: 'mapped',
              decidedBy: 'chris',
            },
          ],
        }),
      ),
    );

    const plan = await planConnectorCatalogPage(
      t.db,
      makePage({ deleted: { mappings: ['recMapProcore001'] } }),
    );
    expect(plan.purgeProductIds).toContain(PROCORE_ID);
    t.dispose();
  });

  it('carries BOTH endpoints of a new pair, with no mapping on the page', async () => {
    // THE regression. AECI-890 materialised 669 pair rows for Kroo Connector and
    // Trimble AppXchange and touched not one mapping. A collector that only watched
    // mappings would have purged nothing on the largest reach change to date.
    const t = await makeTestDb();
    await seedThree(t);
    await commit(
      t,
      await planConnectorCatalogPage(
        t.db,
        twoStubPage({
          mappings: [
            {
              id: 'recMapProcore001',
              stubId: STUB_PROCORE,
              productId: PROCORE_ID,
              status: 'mapped',
              decidedBy: 'chris',
            },
            {
              id: 'recMapAcumatic1',
              stubId: STUB_ACUMATICA,
              productId: ACUMATICA_ID,
              status: 'mapped',
              decidedBy: 'chris',
            },
          ],
        }),
      ),
    );

    const plan = await planConnectorCatalogPage(
      t.db,
      twoStubPage({
        pairs: [
          {
            id: PAIR_ID,
            stubAId: STUB_ACUMATICA,
            stubBId: STUB_PROCORE,
            surface: 'derived',
            ...STAMPS,
          },
        ],
      }),
    );
    expect(plan.counts.pairs.created).toBe(1);
    expect(plan.counts.mappings.unchanged).toBe(0);
    expect([...plan.purgeProductIds].sort()).toEqual(
      [CONNECTOR_ID, PROCORE_ID, ACUMATICA_ID].sort(),
    );
    t.dispose();
  });

  it('carries both endpoints when a pair is TOMBSTONED', async () => {
    // A pair is retired with `removed_at`, not with a delete — there is no
    // `deleted.pairs` on the wire — so the retirement rides the upsert branch.
    const t = await makeTestDb();
    await seedThree(t);
    const pair = (over: Record<string, unknown> = {}) => ({
      id: PAIR_ID,
      stubAId: STUB_ACUMATICA,
      stubBId: STUB_PROCORE,
      surface: 'derived' as const,
      ...STAMPS,
      ...over,
    });
    const mappings = [
      {
        id: 'recMapProcore001',
        stubId: STUB_PROCORE,
        productId: PROCORE_ID,
        status: 'mapped' as const,
        decidedBy: 'chris',
      },
      {
        id: 'recMapAcumatic1',
        stubId: STUB_ACUMATICA,
        productId: ACUMATICA_ID,
        status: 'mapped' as const,
        decidedBy: 'chris',
      },
    ];
    await commit(
      t,
      await planConnectorCatalogPage(t.db, twoStubPage({ mappings, pairs: [pair()] })),
    );

    const plan = await planConnectorCatalogPage(
      t.db,
      twoStubPage({ mappings, pairs: [pair({ removedAt: '2026-09-13T00:00:00.000Z' })] }),
    );
    expect(plan.counts.pairs.updated).toBe(1);
    expect([...plan.purgeProductIds].sort()).toEqual(
      [CONNECTOR_ID, PROCORE_ID, ACUMATICA_ID].sort(),
    );
    t.dispose();
  });
});
