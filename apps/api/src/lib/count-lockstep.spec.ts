import { describe, expect, it } from 'vitest';

import { connectorEvidencedPairs, integrations, products, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { catalogTotals, claimCoverage } from './admin-catalog';
import { drizzleDriftCounter } from './algolia-drift-deps';
import { algoliaVendorConfig, type RawAlgoliaVendorRow } from './algolia-transforms';
import { vendorListConfig } from './drizzle-helpers';
import { computeIntegrationsAdded30d, computeTotalIntegrations } from './home-stats';
import { findProductCountDrift, recomputeProductCounts } from './recompute-counts';

/**
 * `integration_count` counts DELIVERED edges regardless of which table holds them
 * (`STAGE_1_5_SPEC.md` §13.5). AECI-721 splits that tier across `integrations` and
 * `connector_evidenced_pairs`, and §13.5 enumerates the sites that express the rule
 * — ten by name, fourteen in fact.
 *
 * ── WHY THIS FILE IS SHAPED THIS WAY ────────────────────────────────────────
 * Every case below seeds `connector_evidenced_pairs` and leaves `integrations`
 * UNTOUCHED. That is not a convenience; it is the whole point.
 *
 * The migration's safety argument is that it is count-neutral: it moves rows
 * between two tables that are already summed together, so no number can change.
 * On `stage-2` that is easy to believe, because PR-A ships before PR-B. But
 * `stage-2` is not the production line — both PRs reach prod D1 TOGETHER at the
 * `stage-2` → `main` promote, and at that boundary count-neutrality stops being a
 * deployment-order property and becomes a CODE property. These assertions are the
 * artifact that survives that promote: they prove each expression already reads
 * both tables, independently of when anything was deployed.
 *
 * A site that regresses to `count(integrations)` alone still passes its own
 * feature tests — the numbers only go wrong once rows exist on the other side.
 * That is exactly the failure this file exists to catch.
 */

const CONNECTOR = 'p-agave';
const ENDPOINT_A = 'p-procore';
const ENDPOINT_B = 'p-sage';
const BUILDER = 'v-agave';

/** Two endpoints, a connector, and a builder vendor — the shape of all 19 rows
 *  the migration moves in production (11 of them Agave's, built by Agave). */
async function seedCatalog(t: TestDb): Promise<void> {
  await t.db.insert(vendors).values({ id: BUILDER, slug: 'agave', companyName: 'Agave' });
  await t.db.insert(products).values([
    { id: ENDPOINT_A, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: ENDPOINT_B, slug: 'sage-intacct', name: 'Sage Intacct', promotionStatus: 'promoted' },
    {
      id: CONNECTOR,
      slug: 'agave-erp-sync',
      name: 'Agave ERP Sync',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
  ]);
}

async function seedEvidencedPair(t: TestDb, id = 'e1'): Promise<void> {
  // Canonical order is a CHECK, so sort rather than assume.
  const [a, b] = [ENDPOINT_A, ENDPOINT_B].sort();
  await t.db.insert(connectorEvidencedPairs).values({
    id,
    connectorProductId: CONNECTOR,
    productAId: a!,
    productBId: b!,
    direction: 'a_to_b',
    builtByVendorId: BUILDER,
    listingUrl: 'https://useagave.com/integrations/procore',
  });
}

describe('integration_count lockstep — the fourteen sites (AECI-721 / §13.5)', () => {
  it('site 1 — computeExpected counts endpoints AND the connector (§12.5 option B)', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t);

    await recomputeProductCounts(t.db, new Set([ENDPOINT_A, ENDPOINT_B, CONNECTOR]));
    const rows = await t.db.select().from(products);
    const byId = new Map(rows.map((r) => [r.id, r.integrationCount]));

    // Both endpoints: the edge counted for them BEFORE the migration too, because
    // the old rule had no table qualifier. Keeping that true is what makes moving
    // rows invisible to every product card and to `desc(integration_count)`.
    expect(byId.get(ENDPOINT_A)).toBe(1);
    expect(byId.get(ENDPOINT_B)).toBe(1);
    // The connector: this one MOVES on purpose. §12.5 was open until §13.5 resolved
    // it as option B. In production Agave goes 0 → 12 — a connector page rendering
    // twelve pairs while claiming zero integrations was the anomaly.
    expect(byId.get(CONNECTOR)).toBe(1);
    t.dispose();
  });

  it('sites 1–3 — the drift sweep sees no drift, which is the count-neutrality proof', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t);
    await recomputeProductCounts(t.db, new Set([ENDPOINT_A, ENDPOINT_B, CONNECTOR]));

    // `findProductCountDrift` shares `computeExpected` with the writer, so agreement
    // here proves the stored column and the canonical rule agree. The RAW-SQL twins
    // in `apps/api/scripts/reconcile-product-counts.ts` mirror the same expression
    // against remote D1 — if they fall behind, `reconcile-counts.yml` reports 100%
    // drift every morning and `--fix` SILENTLY REVERTS the new rule.
    expect(await findProductCountDrift(t.db)).toEqual([]);
    t.dispose();
  });

  it('site 6 + D — the vendor rule is a DIFFERENT rule and needs its own second table', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t);

    // Not downstream of `products.integration_count`: a correlated subquery on
    // `built_by_vendor_id`. Agave built 11 of the 19 edges that move, so a
    // single-table version reports 0 for Agave the day the migration lands.
    const [algoliaRow] = (await t.db.query.vendors.findMany({
      ...algoliaVendorConfig,
    })) as RawAlgoliaVendorRow[];
    expect(algoliaRow?.integrationCount).toBe(1);

    // …and the same expression again in `drizzle-helpers.vendorListConfig`, which
    // feeds the public vendor list and the admin list. §13.5 names only the two
    // Algolia copies; there are five.
    const [listRow] = await t.db.query.vendors.findMany({ ...vendorListConfig });
    expect(listRow?.integrationCount).toBe(1);
    t.dispose();
  });

  it('sites 8a/8b — the home headline and the 30-day window span both tables', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t);

    expect(await computeTotalIntegrations(t.db)).toBe(1);
    // The window reads the row's own `created_at`, which the migration CARRIES OVER
    // rather than stamping at move time — so reorganising storage can never read as
    // a burst of newly catalogued integrations.
    expect(await computeIntegrationsAdded30d(t.db, new Date())).toBe(1);
    t.dispose();
  });

  it('site 9 + B — both operator-console totals count the evidenced table', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t);

    // `catalogTotals` is keyed `integrations`, not `integrations_total`, which is how
    // §13.5's ten-item list missed it.
    expect((await catalogTotals(t.db)).integrations).toBe(1);
    // The claim-coverage denominator: if it fell by 19 on migration day the panel
    // would report a shrinking catalogue and a coverage ratio that improved for
    // no reason.
    expect((await claimCoverage(t.db, 0)).integrations_total).toBe(1);
    t.dispose();
  });

  it('site C — the Algolia drift guard counts the union, so it cannot alarm on itself', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t);

    // A live alarm surface comparing D1 to Algolia. It ships in PR-A precisely so
    // that during PR-B's migration-to-reindex window it is not reporting drift that
    // is an artifact of its own single-table definition.
    const counter = drizzleDriftCounter(t.db);
    const total = await counter.integration.count({
      where: {
        sourceProduct: { promotionStatus: 'promoted' },
        targetProduct: { promotionStatus: 'promoted' },
      },
    });
    expect(total).toBe(1);
    t.dispose();
  });

  it('counts an evidenced pair ONCE per product, even with several pairs and tables', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t, 'e1');
    // A direct edge between the same two endpoints — the mixed state production is
    // in for most of the catalogue, and the case a naive `UNION` (not `UNION ALL`)
    // or a join-based count would silently collapse.
    await t.db.insert(integrations).values({
      id: 'i1',
      sourceProductId: ENDPOINT_A,
      targetProductId: ENDPOINT_B,
      mechanismKind: 'native',
    });

    await recomputeProductCounts(t.db, new Set([ENDPOINT_A, ENDPOINT_B, CONNECTOR]));
    const rows = await t.db.select().from(products);
    const byId = new Map(rows.map((r) => [r.id, r.integrationCount]));
    expect(byId.get(ENDPOINT_A)).toBe(2);
    expect(byId.get(ENDPOINT_B)).toBe(2);
    // The connector is party to one of the two, not both.
    expect(byId.get(CONNECTOR)).toBe(1);
    expect(await computeTotalIntegrations(t.db)).toBe(2);
    t.dispose();
  });
});
