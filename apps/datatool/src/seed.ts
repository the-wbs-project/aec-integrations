/**
 * Seed-reviews engine — the Worker analog of the `db:seed-reviews` CLI. Reads the
 * target env's products over its D1 binding, runs the SHARED deterministic
 * generator (`@aeci/shared/seed-reviews`), and writes the reviews with bound
 * statements. Because both this and the CLI call `buildPlan`, the same `seed`
 * yields byte-identical review ids/content either way.
 *
 * The CLI renders a `.sql` file; here we run the same logical operations as bound
 * D1 statements: DELETE the seeded block, INSERT the plan (reusing REVIEW_COLUMNS
 * + reviewCells), recompute product aggregates, then touch `updated_at` on the
 * affected products (so the next Algolia incremental cron would pick them up — the
 * datatool also reindexes immediately afterward).
 */
import {
  buildPlan,
  DELETE_SEEDED,
  DISTRIBUTION,
  mulberry32,
  PRODUCTS_QUERY,
  RECOMPUTE_PRODUCTS,
  REVIEW_COLUMNS,
  reviewCells,
  Rng,
  touchSeededProducts,
  type Plan,
  type ProductInput,
} from '@aeci/shared/seed-reviews';

/** Matches the CLI default (`0x5eed`). */
export const DEFAULT_SEED = 0x5eed;
const BATCH_STATEMENTS = 50;

interface RawProductRow {
  id: string;
  slug: string;
  name: string;
  category_slugs: string | null;
}

/** Read the target catalog the planner needs (id, slug, name, category slugs). */
export async function readProducts(db: D1Database): Promise<ProductInput[]> {
  const { results } = await db.prepare(PRODUCTS_QUERY).all<RawProductRow>();
  return results.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    categorySlugs: r.category_slugs ? r.category_slugs.split(',') : [],
  }));
}

/** Deterministic plan for a product set + seed. */
export function planFor(products: ProductInput[], seed: number): Plan {
  return buildPlan(products, new Rng(mulberry32(seed)), Date.now());
}

export interface SeedSummary {
  products: number;
  totalReviews: number;
  /** Per-product count distribution (how many products land in each bucket). */
  buckets: { label: string; products: number }[];
  /** Overall-rating histogram (1–5). */
  ratingHistogram: { rating: number; count: number }[];
  verified: number;
  /** A few sample reviews so the operator can eyeball realism in the dry-run. */
  samples: { product: string; ratingOverall: number; ratingOnboarding: number; title: string }[];
}

/** The `printPlanSummary` data, as JSON for the dry-run response. */
export function summarizePlan(plan: Plan, products: ProductInput[]): SeedSummary {
  const counts = [...plan.perProduct.values()];
  const byName = new Map(products.map((p) => [p.id, p.name]));
  return {
    products: products.length,
    totalReviews: plan.reviews.length,
    buckets: DISTRIBUTION.map((b) => ({
      label: b.label,
      products: counts.filter((c) => c >= b.min && c <= b.max).length,
    })),
    ratingHistogram: [1, 2, 3, 4, 5].map((rating) => ({
      rating,
      count: plan.reviews.filter((r) => r.ratingOverall === rating).length,
    })),
    verified: plan.reviews.filter((r) => r.verifiedWorkEmail).length,
    samples: plan.reviews.slice(0, 5).map((r) => ({
      product: byName.get(r.productId) ?? r.productId,
      ratingOverall: r.ratingOverall,
      ratingOnboarding: r.ratingOnboarding,
      title: r.title,
    })),
  };
}

function reviewInsertStatements(db: D1Database, plan: Plan): D1PreparedStatement[] {
  const columnList = REVIEW_COLUMNS.map((c) => `"${c}"`).join(',');
  const placeholders = REVIEW_COLUMNS.map(() => '?').join(',');
  const sql = `INSERT INTO "reviews" (${columnList}) VALUES (${placeholders})`;
  return plan.reviews.map((rv) => db.prepare(sql).bind(...reviewCells(rv)));
}

async function runInBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_STATEMENTS) {
    await db.batch(statements.slice(i, i + BATCH_STATEMENTS));
  }
}

/** Apply a plan: clear the seeded block, insert, recompute aggregates, touch
 * affected products. Idempotent (the marker DELETE makes re-runs safe). */
export async function applySeed(db: D1Database, plan: Plan): Promise<{ inserted: number }> {
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare(DELETE_SEEDED),
    ...reviewInsertStatements(db, plan),
    db.prepare(RECOMPUTE_PRODUCTS),
    db.prepare(touchSeededProducts(nowIso)),
  ];
  await runInBatches(db, statements);
  return { inserted: plan.reviews.length };
}

/** Remove the seeded block + recompute. Touches `updated_at` BEFORE the delete
 * (while the seeded reviews still identify their products). */
export async function applyTeardown(db: D1Database): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.batch([
    db.prepare(touchSeededProducts(nowIso)),
    db.prepare(DELETE_SEEDED),
    db.prepare(RECOMPUTE_PRODUCTS),
  ]);
}
