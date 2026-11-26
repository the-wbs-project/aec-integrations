/**
 * The local seed chain against the scheduled data-quality checks (AECI-1788).
 *
 * Seed fixtures have gone red at cron time twice because nobody ran the job over
 * them. This spec applies the SQL files of `db:seed:local`, in its order, to the
 * in-memory D1 harness and runs `runDataQualityChecks` itself. It compares the run
 * without `connector-lists-fixtures.sql` with the run after it: the fixture may add
 * no finding at any severity. The two `grant-*` steps of the chain are node scripts
 * that need local env, so they are not applied; they touch profiles only.
 *
 * AECI-1920 adds the floor: the whole chain, fixture included, raises no error-severity
 * finding at all, and the only nonzero check is the expected `products_without_vendor`
 * warning, from fixtures that are vendorless on purpose. A new finding of any severity,
 * or a change to that count, fails here before it reaches the cron.
 *
 * The network checks stay skipped (no Algolia, review-app or browser deps), and the
 * logo probe gets a stub that answers 200, so the run is hermetic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildPlan,
  buildSeedSql,
  ID_MARKER,
  mulberry32,
  PRODUCTS_QUERY,
  Rng,
  type ProductInput,
} from '@aeci/shared/seed-reviews';

import { runDataQualityChecks, type DataQualityCheckResult } from '../lib/data-quality';
import { findProductCountDrift } from '../lib/recompute-counts';

import { makeTestDb, type TestDb } from './d1';

/** `db:seed:local` without the fixture under test, in the chain's order. */
const CHAIN = [
  'taxonomy.sql',
  'data-objects.sql',
  'trades.sql',
  'catalog.sql',
  'phase2-fixtures.sql',
  'auth-fixtures.sql',
  'connector-fixtures.sql',
  'sync-service-owner-fixtures.sql',
  'extension-fixtures.sql',
  'review-response-fixtures.sql',
  'review-update-fixtures.sql',
  'long-list-fixtures.sql',
];
const FIXTURE = 'connector-lists-fixtures.sql';

/** Apply one multi-statement seed file, as `applySeedFile` in d1.spec.ts does. */
function apply(t: TestDb, file: string): void {
  t.raw.exec(readFileSync(join(process.cwd(), 'seed', file), 'utf8'));
}

async function run(t: TestDb): Promise<DataQualityCheckResult[]> {
  return runDataQualityChecks({
    db: t.db,
    now: new Date('2026-11-18T00:00:00.000Z'),
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
  });
}

/** Finding count per check id, and the total per severity. */
function summarise(results: DataQualityCheckResult[]) {
  const byCheck = Object.fromEntries(results.map((r) => [r.id, r.count]));
  const bySeverity = { error: 0, warn: 0, info: 0 };
  for (const r of results) bySeverity[r.severity] += r.count;
  return { byCheck, bySeverity };
}

const FIXTURE_NAMES =
  /fixture-(hybrid-via|connector-hub|connector-lists)|Zz Fixture (Hybrid|Connector|Hub|Partner)/;

describe('seed chain: connector-lists-fixtures.sql adds no data-quality finding (AECI-1788)', () => {
  it('runs every check without an exception, and the fixture changes no count', async () => {
    const t = await makeTestDb();
    try {
      for (const file of CHAIN) apply(t, file);
      const before = await run(t);
      apply(t, FIXTURE);
      const after = await run(t);

      // A check that threw is not a clean zero.
      expect(after.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`)).toEqual([]);

      const b = summarise(before);
      const a = summarise(after);
      // Logged for the PR report: the counts by severity, with and without the fixture.
      console.info('data-quality by severity', JSON.stringify({ before: b, after: a }));
      expect(a.byCheck).toEqual(b.byCheck);
      expect(a.bySeverity).toEqual(b.bySeverity);
      // And no sample line names one of the fixture's rows.
      expect(after.flatMap((r) => r.sample).filter((l) => FIXTURE_NAMES.test(l))).toEqual([]);
    } finally {
      t.dispose();
    }
  });
});

/**
 * The vendorless products the seed keeps on purpose (AECI-1920). Each is a fixture whose
 * tests need no vendor: the connector-lane endpoints and platforms of
 * connector-fixtures.sql ("no vendor, no integrations" scaffolding), pyRevit in
 * extension-fixtures.sql (the extension tile with no vendor line), the long-list
 * product and its 14 partners (`products-long-list.spec.ts`), and
 * `fixture-acme-connector` (`logo-rule.spec.ts` needs it unclaimed).
 */
const VENDORLESS_ON_PURPOSE =
  /^(fx-[a-z0-9-]+|fixture-long-list(-partner-\d{2})?|fixture-acme-connector|pyrevit)$/;

/** Every nonzero check on a fresh seed, by id. Anything else is a new finding. */
const EXPECTED_FINDINGS = { products_without_vendor: 28 };

describe('seed chain: a fresh seed is clean (AECI-1920)', () => {
  it('raises no error-severity finding, and only the expected warnings', async () => {
    const t = await makeTestDb();
    try {
      for (const file of [...CHAIN, FIXTURE]) apply(t, file);
      const results = await run(t);
      expect(results.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`)).toEqual([]);

      const errors = results.filter((r) => r.severity === 'error' && r.count > 0);
      expect(errors.map((r) => `${r.id}: ${r.sample.join('; ')}`)).toEqual([]);

      const nonzero = Object.fromEntries(
        results.filter((r) => r.count > 0).map((r) => [r.id, r.count]),
      );
      expect(nonzero).toEqual(EXPECTED_FINDINGS);
      expect(summarise(results).bySeverity).toEqual({ error: 0, warn: 28, info: 0 });

      // The 28 are the fixtures named above, not a catalog row that lost its vendor.
      const vendorless = t.raw
        .prepare(
          'SELECT slug FROM products WHERE id NOT IN (SELECT product_id FROM product_vendors)',
        )
        .all() as Array<{ slug: string }>;
      expect(vendorless).toHaveLength(EXPECTED_FINDINGS.products_without_vendor);
      expect(vendorless.map((r) => r.slug).filter((s) => !VENDORLESS_ON_PURPOSE.test(s))).toEqual(
        [],
      );
    } finally {
      t.dispose();
    }
  });
});

/**
 * The by-hand review seeder (`db:seed-reviews`, AECI-1936) over the seeded catalog. It
 * builds the same plan and the same `.sql` file the CLI does and applies the file here,
 * in place of `wrangler d1 execute`. Its reviews have no reviewer, so before AECI-1936
 * every one of them tripped the error-severity `reviews_missing_anonymized_at` check.
 */
describe('review seeder: its rows raise no error-severity finding (AECI-1936)', () => {
  it('writes anonymous reviews that carry anonymized_at', async () => {
    const t = await makeTestDb();
    try {
      for (const file of [...CHAIN, FIXTURE]) apply(t, file);

      const rows = t.raw.prepare(PRODUCTS_QUERY).all() as Array<{
        id: string;
        slug: string;
        name: string;
        category_slugs: string | null;
      }>;
      const products: ProductInput[] = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        categorySlugs: r.category_slugs ? r.category_slugs.split(',') : [],
      }));
      const plan = buildPlan(
        products,
        new Rng(mulberry32(0x5eed)),
        Date.parse('2026-11-17T00:00:00.000Z'),
      );
      t.raw.exec(buildSeedSql(plan, { db: 'aeci-app-preview', seed: 0x5eed }));

      const seeded = t.raw
        .prepare(
          `SELECT count(*) AS n, sum(reviewer_id IS NULL AND anonymized_at IS NULL) AS bare FROM reviews WHERE id LIKE '${ID_MARKER}%'`,
        )
        .get() as { n: number; bare: number };
      expect(seeded.n).toBe(plan.reviews.length);
      expect(seeded.n).toBeGreaterThan(0);
      expect(seeded.bare).toBe(0);

      const results = await run(t);
      expect(results.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`)).toEqual([]);
      const errors = results.filter((r) => r.severity === 'error' && r.count > 0);
      expect(errors.map((r) => `${r.id}: ${r.sample.join('; ')}`)).toEqual([]);
    } finally {
      t.dispose();
    }
  });
});

/**
 * The stored `integration_count` on a fresh seed (QA pass on AECI-2035, 2026-11-24).
 * connector-fixtures.sql inserted its products at the column default, 0, and never
 * recomputed, so /products printed "Not yet connected" on three connectors whose pages
 * list pairs. Every seeded product's stored count must equal the canonical rule
 * (`findProductCountDrift`, the reconcile job's own comparison).
 */
describe('seed chain: stored integration counts follow the rule', () => {
  it('leaves no product with a drifted integration_count', async () => {
    const t = await makeTestDb();
    try {
      for (const file of [...CHAIN, FIXTURE]) apply(t, file);
      const drift = (await findProductCountDrift(t.db)).filter(
        (d) => d.field === 'integrationCount',
      );
      expect(drift).toEqual([]);
      // The three connectors the QA pass caught at zero (option B: pairs they deliver
      // or power count for them, and Agave's Convention-A row counts too).
      const counts = t.raw
        .prepare(
          "SELECT slug, integration_count AS n FROM products WHERE slug IN ('fx-agave','fx-aardvark-sync','fx-mindcloud') ORDER BY slug",
        )
        .all();
      expect(counts).toEqual([
        { slug: 'fx-aardvark-sync', n: 1 },
        { slug: 'fx-agave', n: 3 },
        { slug: 'fx-mindcloud', n: 2 },
      ]);
    } finally {
      t.dispose();
    }
  });
});
