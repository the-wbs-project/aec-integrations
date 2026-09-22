import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { INTEGRATION_IDS_SQL } from '../../scripts/reconcile-algolia-drift';
import { DRIFT_QUERY, RECOMPUTE_SQL } from '../../scripts/reconcile-product-counts';
import {
  claims,
  connectorEvidencedPairs,
  integrations,
  productCategories,
  products,
  taxonomyCategories,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { catalogTotals, claimCoverage } from './admin-catalog';
import { drizzleDriftCounter, drizzlePromotedIds } from './algolia-drift-deps';
import { buildIntegrationRequests } from './algolia-sync';
import { algoliaVendorConfig, type RawAlgoliaVendorRow } from './algolia-transforms';
import { categoryTermConfig, vendorListConfig } from './drizzle-helpers';
import { loadOwnedIntegrations } from './vendor-owned-integrations';
import {
  computeIntegrationsAdded30d,
  computeMostActiveCategory,
  computeRecentIntegrations,
  computeTotalIntegrations,
} from './home-stats';
import {
  findProductCountDrift,
  integrationCountRecomputeStmt,
  recomputeProductCounts,
} from './recompute-counts';

/**
 * `integration_count` counts DELIVERED edges regardless of which table holds them
 * (`STAGE_1_5_SPEC.md` §13.5). AECI-721 splits that tier across `integrations` and
 * `connector_evidenced_pairs`, and §13.5 enumerates the sites that express the rule.
 * The enumeration is no longer a comment: {@link LOCKSTEP_SITES} at the bottom of this
 * file is the list, and it is asserted (AECI-1010 found 27 to 28 expressions where
 * the comment said sixteen).
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

describe('integration_count lockstep — both tables (AECI-721, AECI-789 / §13.5)', () => {
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
    // feeds the public vendor list. §13.5 names only the two Algolia copies;
    // there are five. (The ADMIN vendor list no longer selects this extra — its
    // Integrations column was dropped — which is exactly why the lockstep is
    // asserted on the config rather than on any one of its readers.)
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

  /**
   * ── SITES E AND F: THE MEMBERSHIP RULE AS AN ID **SET** (AECI-789) ─────────
   *
   * Site C above counts. These two enumerate, and that difference is the whole
   * point: `sweepAlgoliaOrphans` DELETES every object in the `integrations` index
   * whose id is absent from this set. A single-table set does not report a wrong
   * number, it removes records — the 09:00 sweep deletes every evidenced pair and
   * the watermark-windowed 08:00 sync never puts them back (deleting an Algolia
   * object does not bump the D1 row's `updated_at`), so the loss is permanent and
   * the drift gauge reads `+19` every day until the index is rebuilt.
   *
   * Both cases therefore assert the set holds BOTH ids. A union, never a swap.
   */
  it("site E — the orphan sweep's Drizzle id set spans both tables", async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t, 'e1');
    await t.db.insert(integrations).values({
      id: 'i1',
      sourceProductId: ENDPOINT_A,
      targetProductId: ENDPOINT_B,
      mechanismKind: 'native',
    });

    const ids = await drizzlePromotedIds(t.db).integrationIds();
    expect([...ids].sort()).toEqual(['e1', 'i1']);
    t.dispose();
  });

  it('site E — an evidenced pair with an unpromoted endpoint stays OUT of the set', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    // `algolia-sync` emits a deleteObject for this pair, so the sweep must agree
    // it is not a member. This is the half that proves the rule still matches the
    // sync's delete arm rather than merely being a superset of it.
    await t.db
      .update(products)
      .set({ promotionStatus: 'ready' })
      .where(eq(products.id, ENDPOINT_B));
    await seedEvidencedPair(t, 'e1');

    const ids = await drizzlePromotedIds(t.db).integrationIds();
    expect(ids.has('e1')).toBe(false);
    t.dispose();
  });

  it("site F — the operator CLI's raw-SQL twin returns the same set", async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await seedEvidencedPair(t, 'e1');
    await t.db.insert(integrations).values({
      id: 'i1',
      sourceProductId: ENDPOINT_A,
      targetProductId: ENDPOINT_B,
      mechanismKind: 'native',
    });

    // The CLI cannot reach a deployed D1 through a Worker binding, so it re-expresses
    // the rule as raw SQL and runs it through `wrangler d1 execute`. That copy carries
    // `--apply` delete authority and — unlike the raw-SQL twins at sites 2 and 3 — it
    // is executed here rather than trusted to a comment.
    const rows = t.raw.prepare(INTEGRATION_IDS_SQL).all() as { id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual(['e1', 'i1']);
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

/**
 * The mirror of the rule above (AECI-892 / §13.5): **reachable NEVER counts.**
 *
 * The lockstep sites exist because a delivered edge must count from whichever table
 * holds it. This block exists because the reachable tier must count from neither.
 * §13.5 is categorical — "not in the heading, not in `integration_count`, not in a
 * facet, not in the home stats" — and the reason is scale rather than taste: the
 * `integration_count` facet buckets (`0 / 1–10 / 11–50 / 51+`) were calibrated
 * against a catalogue topping out near 52, and MindCloud's catalogue alone is
 * ~3,411 stubs. Letting reach into the count would not shift the numbers, it would
 * destroy the scale.
 *
 * Written as a source scan rather than a behavioural test on purpose. A behavioural
 * test can only prove the number did not move for the rows it happened to seed; the
 * thing worth preventing is someone adding `reachable_pair_count` to an expression
 * because it is on `ProductDetail` and looks like a sibling of `integration_count`.
 */
describe('reachable never counts — the §13.5 complement (AECI-892)', () => {
  it('appears in no count expression, and the scan is not vacuous', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const read = (rel: string) =>
      readFileSync(join(process.cwd(), rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    // The lockstep sites that live in this repo as source, plus the two Algolia
    // transform copies. Any of them gaining the reach scalar is the regression.
    const COUNT_SITES = [
      'src/lib/recompute-counts.ts',
      'src/lib/home-stats.ts',
      'src/lib/admin-catalog.ts',
      'src/lib/metrics-snapshot.ts',
      'src/lib/algolia-transforms.ts',
      'src/lib/algolia-drift-deps.ts',
      'src/routes/admin-overview.ts',
      'scripts/reconcile-product-counts.ts',
      'scripts/reconcile-algolia-drift.ts',
    ];
    for (const site of COUNT_SITES) {
      expect(read(site), site).not.toContain('reachable_pair_count');
      expect(read(site), site).not.toContain('reachablePartnerProductIds');
    }

    // Not vacuous: every one of those files does talk about the count it owns.
    expect(read('src/lib/recompute-counts.ts')).toContain('integrationCount');
    // And the scalar really does exist somewhere, so the assertion above is a
    // statement about placement rather than about a name nothing uses.
    expect(read('src/lib/drizzle-helpers.ts')).toContain('reachable_pair_count');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AECI-1010: a RETIRED integration counts nowhere and is in no id set.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Every expression of the delivered-edge count or membership rule, as an asserted list
 * (`STAGE_1_5_SPEC.md` §13.5). Each entry names the file and a marker string that
 * locates the expression in it.
 *
 * `proof`:
 *   - `executed` — a case below runs the expression against the test D1 and shows a
 *     retired row is excluded. The last case fails if an executed site has no proof.
 *   - `scan` — the expression cannot run here (another Worker package, plain `.mjs`, or
 *     a module-private function). The scan requires the live predicate within
 *     {@link SCAN_WINDOW} lines of the marker.
 *   - `excluded` — deliberately NOT filtered, with the reason. Only X8 is also scanned
 *     for the predicate's ABSENCE, because it is the one where adding the filter would
 *     break something. The others are held by their recorded reason.
 *
 * `deletes` marks the sites whose omission deletes Algolia records. Paths are relative
 * to `apps/api`, the directory this suite runs in.
 */
interface LockstepSite {
  id: string;
  file: string;
  marker: string;
  proof: 'executed' | 'scan' | 'excluded';
  deletes?: boolean;
  reason?: string;
}

export const LOCKSTEP_SITES: readonly LockstepSite[] = [
  {
    id: '1',
    file: 'src/lib/recompute-counts.ts',
    // One expression, two callers: `computeExpected` and the in-batch
    // `integrationCountRecomputeStmt` (the retire batch).
    marker: 'function integrationCountSql',
    proof: 'executed',
  },
  {
    id: '2',
    file: 'scripts/reconcile-product-counts.ts',
    marker: 'export const DRIFT_QUERY',
    proof: 'executed',
  },
  {
    id: '3',
    file: 'scripts/reconcile-product-counts.ts',
    marker: 'export const RECOMPUTE_SQL',
    proof: 'executed',
  },
  {
    id: '4',
    file: '../datatool/src/prune-integrations.ts',
    marker: 'UPDATE products SET integration_count',
    proof: 'scan',
  },
  {
    id: '5',
    file: 'src/lib/algolia-transforms.ts',
    marker: 'export const algoliaProductConfig',
    proof: 'excluded',
    reason: 'reads the stored products.integration_count, downstream of site 1',
  },
  {
    id: '6a',
    file: 'src/lib/algolia-transforms.ts',
    marker: 'export const algoliaVendorConfig',
    proof: 'executed',
  },
  {
    id: '6b',
    file: '../datatool/src/algolia-reindex.ts',
    marker: 'export async function buildVendorRecords',
    proof: 'scan',
  },
  {
    id: '7',
    file: '../datatool/src/algolia-reindex.ts',
    marker: 'export async function buildProductRecords',
    proof: 'excluded',
    reason: 'reads the stored products.integration_count, downstream of site 1',
  },
  {
    id: '8a',
    file: 'src/lib/home-stats.ts',
    marker: 'export async function computeTotalIntegrations',
    proof: 'executed',
  },
  {
    id: '8b',
    file: 'src/lib/home-stats.ts',
    marker: 'export async function computeIntegrationsAdded30d',
    proof: 'executed',
  },
  {
    id: '8c',
    file: 'src/lib/home-stats.ts',
    marker: 'export async function computeMostActiveCategory',
    proof: 'executed',
  },
  {
    id: '8d',
    file: 'src/lib/home-stats.ts',
    marker: 'export async function computeRecentIntegrations',
    proof: 'executed',
  },
  {
    id: '9',
    file: 'src/lib/admin-catalog.ts',
    marker: 'export async function claimCoverage',
    proof: 'executed',
  },
  {
    id: '10',
    file: 'src/lib/metrics-snapshot.ts',
    marker: "'catalog.integrations_total': async",
    proof: 'scan',
  },
  {
    id: '11',
    file: 'src/routes/admin-overview.ts',
    marker: 'async function catalogTotals',
    proof: 'scan',
  },
  {
    id: '12',
    file: 'src/lib/admin-catalog.ts',
    marker: 'export async function catalogTotals',
    proof: 'executed',
  },
  {
    id: '13',
    file: 'src/lib/algolia-drift-deps.ts',
    marker: 'export function drizzleDriftCounter',
    proof: 'executed',
  },
  {
    id: '14a',
    file: 'src/lib/drizzle-helpers.ts',
    marker: 'export const vendorListConfig',
    proof: 'executed',
  },
  {
    // The vendor-detail count and, since AECI-1041, the /admin/claims owner test.
    // Both read this one module, so the claim queue is not a site of its own.
    id: '14b',
    file: 'src/lib/vendor-owned-integrations.ts',
    marker: 'export function selectOwnedIntegrationGroups',
    proof: 'executed',
  },
  {
    id: '15',
    file: 'src/lib/algolia-drift-deps.ts',
    marker: 'export function drizzlePromotedIds',
    proof: 'executed',
    deletes: true,
  },
  {
    id: '16',
    file: 'scripts/reconcile-algolia-drift.ts',
    marker: 'export const INTEGRATION_IDS_SQL',
    proof: 'executed',
    deletes: true,
  },
  {
    id: 'X1',
    file: 'src/lib/algolia-sync.ts',
    marker: 'export async function buildIntegrationRequests',
    proof: 'executed',
    deletes: true,
  },
  {
    id: 'X2',
    file: '../datatool/src/algolia-reindex.ts',
    marker: 'export async function buildIntegrationRecords',
    proof: 'scan',
    deletes: true,
  },
  {
    id: 'X3',
    file: 'src/lib/drizzle-helpers.ts',
    marker: 'const integrationCountFor',
    proof: 'executed',
  },
  {
    id: 'X4',
    file: 'src/lib/admin-analytics.ts',
    marker: "'catalog.integrations_created': {",
    proof: 'scan',
  },
  {
    id: 'X5',
    file: '../../scripts/ops/2026-09-retraction-consumer/consume.mjs',
    // The DDL-probed filter, which the recount's UPDATE below interpolates.
    marker: "const liveFilter = ddlHasColumn(integrationsDdl, 'retired_at')",
    proof: 'scan',
  },
  {
    id: 'X6',
    file: '../agent/src/tools/count-integrations.ts',
    marker: 'const COUNT_SQL',
    proof: 'scan',
  },
  { id: 'X7', file: '../agent/src/lib/corpus.ts', marker: 'const EDGES_SQL', proof: 'scan' },
  {
    id: 'X8',
    file: 'src/lib/retract-vendor.ts',
    marker: 'export function buildVendorFootprintSql',
    proof: 'excluded',
    reason: 'a foreign-key blocker: a retired row still references the vendor and must block',
  },
  {
    id: 'X9',
    file: '../../scripts/ops/2026-09-polycam-retraction/retract.mjs',
    marker: 'FROM integrations i',
    proof: 'excluded',
    reason: 'spent one-off scripts (also procore-followup, dynamics-monday), never re-run',
  },
];

/** Lines after a marker the scan searches for the live predicate. */
const SCAN_WINDOW = 40;

/** Any spelling of the live predicate. `liveIntegrationSqlIf(` is the DDL-probed form
 *  the tools that run against a deployed database use (it degrades to `1 = 1` on a
 *  tier without migration 0044). */
const LIVE_PREDICATE =
  /liveIntegrationWhere|liveIntegrationSql\(|liveIntegrationSqlIf\(|retired_at IS NULL|liveIntegrationOn\(/;

const RETIRED_AT = '2026-09-20T00:00:00.000Z';

/** The catalogue plus a LIVE `i1` and a RETIRED `r1` between the same two promoted
 *  endpoints, both built by the same vendor. `r1` is claimed, as retire requires.
 *  Having a live row beside it is what catches an `eq(retired_at, null)` bug: that
 *  empties every set rather than dropping one member. */
async function seedLiveAndRetired(t: TestDb): Promise<void> {
  await seedCatalog(t);
  await t.db.insert(integrations).values([
    {
      id: 'i1',
      sourceProductId: ENDPOINT_A,
      targetProductId: ENDPOINT_B,
      mechanismKind: 'native',
      direction: 'a_to_b',
      builtByVendorId: BUILDER,
    },
    {
      id: 'r1',
      sourceProductId: ENDPOINT_B,
      targetProductId: ENDPOINT_A,
      mechanismKind: 'api',
      direction: 'a_to_b',
      builtByVendorId: BUILDER,
      claimedAt: RETIRED_AT,
      maintainedBy: 'vendor',
      retiredAt: RETIRED_AT,
    },
  ]);
}

async function readRaw(rel: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

function windowAfter(source: string, marker: string): string | null {
  const at = source.indexOf(marker);
  if (at === -1) return null;
  return source.slice(at).split('\n').slice(0, SCAN_WINDOW).join('\n');
}

describe('a retired integration counts nowhere (AECI-1010 / §13.5)', () => {
  /**
   * Every executed proof registers here at COLLECTION time, before any test runs, so
   * the completeness check below holds whatever order the tests run in, and under a
   * `-t` filter that runs it alone. Each case gets a fresh D1 seeded with a live and a
   * retired row.
   */
  const PROOF_CASES: { name: string; sites: readonly string[] }[] = [];
  function proves(name: string, sites: readonly string[], run: (t: TestDb) => Promise<void>): void {
    PROOF_CASES.push({ name, sites });
    it(name, async () => {
      const t = await makeTestDb();
      try {
        await seedLiveAndRetired(t);
        await run(t);
      } finally {
        t.dispose();
      }
    });
  }

  proves(
    'sites 1-3: the canonical count, the drift sweep and both raw-SQL twins drop it',
    ['1', '2', '3'],
    async (t) => {
      await recomputeProductCounts(t.db, new Set([ENDPOINT_A, ENDPOINT_B]));
      const byId = new Map(
        (await t.db.select().from(products)).map((r) => [r.id, r.integrationCount]),
      );
      expect(byId.get(ENDPOINT_A)).toBe(1);
      expect(byId.get(ENDPOINT_B)).toBe(1);
      expect(await findProductCountDrift(t.db)).toEqual([]);

      const drift = t.raw.prepare(DRIFT_QUERY).all() as {
        product_id: string;
        expected_integration_count: number;
      }[];
      expect(drift.find((r) => r.product_id === ENDPOINT_A)?.expected_integration_count).toBe(1);

      // `--fix`: overwrite with a wrong value, then let the raw recompute repair it.
      t.raw.prepare(`UPDATE products SET integration_count = 9`).run();
      t.raw.prepare(RECOMPUTE_SQL.replace('__IDS__', `'${ENDPOINT_A}','${ENDPOINT_B}'`)).run();
      const after = new Map(
        (await t.db.select().from(products)).map((r) => [r.id, r.integrationCount]),
      );
      expect(after.get(ENDPOINT_A)).toBe(1);
      expect(after.get(ENDPOINT_B)).toBe(1);

      // Site 1's second caller: the in-batch statement the retire writes.
      t.raw.prepare(`UPDATE products SET integration_count = 9`).run();
      await t.db.batch([
        integrationCountRecomputeStmt(t.db, ENDPOINT_A),
        integrationCountRecomputeStmt(t.db, ENDPOINT_B),
      ]);
      const inBatch = new Map(
        (await t.db.select().from(products)).map((r) => [r.id, r.integrationCount]),
      );
      expect(inBatch.get(ENDPOINT_A)).toBe(1);
      expect(inBatch.get(ENDPOINT_B)).toBe(1);
    },
  );

  proves('sites 6a and 14a: the vendor rule counts only the live row', ['6a', '14a'], async (t) => {
    const [algoliaRow] = (await t.db.query.vendors.findMany({
      ...algoliaVendorConfig,
    })) as RawAlgoliaVendorRow[];
    expect(algoliaRow?.integrationCount).toBe(1);
    const [listRow] = await t.db.query.vendors.findMany({ ...vendorListConfig });
    expect(listRow?.integrationCount).toBe(1);
  });

  proves(
    'site 14b: the owned-integration count drops it and still reads both tables',
    ['14b'],
    async (t) => {
      await seedEvidencedPair(t, 'e1');
      const owned = (await loadOwnedIntegrations(t.db, [BUILDER])).get(BUILDER);
      // i1 (live) counts, r1 (retired) does not, e1 counts from the other table.
      expect(owned).toEqual({ integrations: 1, connector_evidenced: 1, total: 2 });
    },
  );

  proves(
    'sites 8a-8d: the home totals, window, category tally and recent rail drop it',
    ['8a', '8b', '8c', '8d'],
    async (t) => {
      await t.db.insert(taxonomyCategories).values({ id: 'c1', slug: 'erp', name: 'ERP' });
      await t.db.insert(productCategories).values([
        { productId: ENDPOINT_A, categoryId: 'c1' },
        { productId: ENDPOINT_B, categoryId: 'c1' },
      ]);

      expect(await computeTotalIntegrations(t.db)).toBe(1);
      expect(await computeIntegrationsAdded30d(t.db, new Date())).toBe(1);
      const category = await computeMostActiveCategory(t.db);
      expect(category?.integration_count).toBe(1);
      const recent = await computeRecentIntegrations(t.db);
      expect(recent.map((r) => r.id)).toEqual(['i1']);
    },
  );

  proves(
    'sites 9 and 12: operator totals drop it, and claim coverage cannot go negative',
    ['9', '12'],
    async (t) => {
      await t.db.insert(taxonomyDataObjects).values({ id: 'd1', slug: 'invoice', name: 'Invoice' });
      // A claim on the RETIRED row only. It survives the retire by design, so the
      // numerator must not count its anchor while the denominator drops the row.
      await t.db
        .insert(claims)
        .values({ id: 'cl1', integrationId: 'r1', dataObjectId: 'd1', direction: 'a_to_b' });

      const coverage = await claimCoverage(t.db, 10);
      expect(coverage.integrations_total).toBe(1);
      expect(coverage.integrations_with_claims).toBe(0);
      expect(coverage.integrations_without_claims).toBe(1);
      expect(coverage.integrations_without_claims_sample.map((r) => r.id)).toEqual(['i1']);
      expect((await catalogTotals(t.db)).integrations).toBe(1);
    },
  );

  proves('site X3: a taxonomy term counts only the live row', ['X3'], async (t) => {
    await t.db.insert(taxonomyCategories).values({ id: 'c1', slug: 'erp', name: 'ERP' });
    await t.db.insert(productCategories).values({ productId: ENDPOINT_A, categoryId: 'c1' });
    const [term] = await t.db.query.taxonomyCategories.findMany({ ...categoryTermConfig });
    expect(term?.integrationCount).toBe(1);
  });

  /**
   * The Algolia membership rule, in all four places it lives, against the same seed.
   * The counter and the two id sets must agree with each other, and the sync's delete
   * arm must be the EXACT complement of its upsert arm. A mismatch here is either a
   * permanent deletion of live records or a sweep that refuses every pass.
   */
  proves(
    'sites 13, 15, 16 and X1: the drift count, both id sets and the sync agree',
    ['13', '15', '16', 'X1'],
    async (t) => {
      const counted = await drizzleDriftCounter(t.db).integration.count({
        where: {
          sourceProduct: { promotionStatus: 'promoted' },
          targetProduct: { promotionStatus: 'promoted' },
        },
      });
      expect(counted).toBe(1);

      const swept = await drizzlePromotedIds(t.db).integrationIds();
      // Exactly the live row: not empty (the `= NULL` failure) and not both.
      expect([...swept]).toEqual(['i1']);

      const cli = (t.raw.prepare(INTEGRATION_IDS_SQL).all() as { id: string }[]).map((r) => r.id);
      expect(cli).toEqual(['i1']);

      const { requests } = await buildIntegrationRequests(t.db, { type: 'ids', ids: ['i1', 'r1'] });
      const upserts = requests
        .filter((r) => r.action === 'updateObject')
        .map((r) => (r.body as { objectID: string }).objectID);
      const deletes = requests
        .filter((r) => r.action === 'deleteObject')
        .map((r) => (r.body as { objectID: string }).objectID);
      expect(upserts).toEqual(['i1']);
      expect(deletes).toEqual(['r1']);
      // The complement: every id lands in exactly one arm.
      expect(new Set([...upserts, ...deletes]).size).toBe(upserts.length + deletes.length);
    },
  );

  it('a restore puts the row back in every executed set', async () => {
    const t = await makeTestDb();
    await seedLiveAndRetired(t);
    await t.db.update(integrations).set({ retiredAt: null }).where(eq(integrations.id, 'r1'));

    expect([...(await drizzlePromotedIds(t.db).integrationIds())].sort()).toEqual(['i1', 'r1']);
    const { requests } = await buildIntegrationRequests(t.db, { type: 'ids', ids: ['r1'] });
    expect(requests.map((r) => r.action)).toEqual(['updateObject']);
    expect(await computeTotalIntegrations(t.db)).toBe(2);
    t.dispose();
  });

  it('every listed site exists, and every scan site carries the live predicate', async () => {
    for (const site of LOCKSTEP_SITES) {
      const source = await readRaw(site.file);
      const window = windowAfter(source, site.marker);
      expect(window, `${site.id}: marker not found in ${site.file}`).not.toBeNull();
      if (site.proof === 'scan') {
        expect(window, `${site.id}: no live predicate near ${site.marker}`).toMatch(LIVE_PREDICATE);
      }
      if (site.proof === 'excluded') {
        expect(site.reason, `${site.id}: an excluded site must say why`).toBeTruthy();
      }
    }
    // X8 must keep counting retired rows. It is a blocker, and a filter there would let
    // a vendor delete proceed into a foreign-key failure.
    const blocker = windowAfter(
      await readRaw('src/lib/retract-vendor.ts'),
      'export function buildVendorFootprintSql',
    );
    expect(blocker).not.toMatch(LIVE_PREDICATE);
  });

  it('the list is complete: every executed site has a proof, and the delete sites are the four', () => {
    const executed = LOCKSTEP_SITES.filter((s) => s.proof === 'executed').map((s) => s.id);
    const proved = new Set(PROOF_CASES.flatMap((c) => c.sites));
    expect(executed.filter((id) => !proved.has(id))).toEqual([]);
    // And no proof names a site the list does not have, or one it does not execute.
    expect([...proved].filter((id) => !executed.includes(id))).toEqual([]);
    expect(
      LOCKSTEP_SITES.filter((s) => s.deletes)
        .map((s) => s.id)
        .sort(),
    ).toEqual(['15', '16', 'X1', 'X2']);
  });
});
