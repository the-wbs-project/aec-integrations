/**
 * Tiny but FK-complete, PROMOTED catalog seeded via prepared statements (no
 * multi-statement SQL runner). Shared by the copy + reindex specs. Covers a
 * parent (vendor/product/taxonomy), a cross-table child (integration), a join
 * (product_categories/product_vendors), content (profile/review), and the
 * `vendor_requests` self-FK.
 *
 * `created_at`/`updated_at` are app-side defaults in the schema (Drizzle
 * `$defaultFn`, not a SQL DEFAULT), so raw inserts must supply them.
 */
import type Database from 'better-sqlite3';

const TS = '2026-01-01T00:00:00.000Z';

export interface SeedIds {
  categoryId: string;
  vendorId: string;
  productA: string;
  productB: string;
  tradeA: string;
  tradeB: string;
}

/**
 * Seed a promoted two-product catalog with one integration + a category, and
 * (AECI-545) two trades linked to `prod-1` ONLY — so a single run covers both
 * the tagged path and the sparse-by-design untagged path (`prod-2`). The two
 * trades share the alias `Curtain Wall`, which is what exercises the dedupe in
 * `flattenTradeAliases`.
 */
export function seedCatalog(raw: Database.Database): SeedIds {
  raw
    .prepare(
      "INSERT INTO taxonomy_categories (id, slug, name, created_at, updated_at) VALUES ('cat-1', 'bim-authoring', 'BIM Authoring', ?, ?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      "INSERT INTO vendors (id, slug, company_name, promotion_status, created_at, updated_at) VALUES ('ven-1', 'autodesk', 'Autodesk', 'promoted', ?, ?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      "INSERT INTO products (id, slug, name, promotion_status, integration_count, created_at, updated_at) VALUES ('prod-1', 'revit', 'Revit', 'promoted', 1, ?, ?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      "INSERT INTO products (id, slug, name, promotion_status, integration_count, created_at, updated_at) VALUES ('prod-2', 'autocad', 'AutoCAD', 'promoted', 1, ?, ?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      "INSERT INTO product_categories (product_id, category_id, created_at) VALUES ('prod-1', 'cat-1', ?)",
    )
    .run(TS);
  raw
    .prepare(
      "INSERT INTO product_vendors (product_id, vendor_id, is_primary, created_at) VALUES ('prod-1', 'ven-1', 1, ?)",
    )
    .run(TS);
  raw
    .prepare(
      "INSERT INTO integrations (id, name, source_product_id, target_product_id, mechanism_kind, direction, created_at, updated_at) VALUES ('int-1', 'Revit to AutoCAD', 'prod-1', 'prod-2', 'native', 'one-way', ?, ?)",
    )
    .run(TS, TS);
  // Trades (AECI-545). `description` is NOT NULL here (it diverges from the
  // other three taxonomy tables); `aliases` is a JSON-array TEXT column.
  raw
    .prepare(
      "INSERT INTO taxonomy_trades (id, slug, name, description, display_order, aliases, created_at, updated_at) VALUES ('trade-1', 'glazing-curtain-wall', 'Glazing & Curtain Wall', 'Glazing, curtain wall, and storefront systems.', 10, '[\"Curtain Wall\",\"Glazier\"]', ?, ?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      "INSERT INTO taxonomy_trades (id, slug, name, description, display_order, aliases, created_at, updated_at) VALUES ('trade-2', 'framing', 'Framing', 'Wood and light-gauge metal framing.', 20, '[\"Curtain Wall\",\"Carpentry\"]', ?, ?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      "INSERT INTO product_trades (product_id, trade_id, created_at) VALUES ('prod-1', ?, ?)",
    )
    .run('trade-1', TS);
  raw
    .prepare(
      "INSERT INTO product_trades (product_id, trade_id, created_at) VALUES ('prod-1', ?, ?)",
    )
    .run('trade-2', TS);
  return {
    categoryId: 'cat-1',
    vendorId: 'ven-1',
    productA: 'prod-1',
    productB: 'prod-2',
    tradeA: 'trade-1',
    tradeB: 'trade-2',
  };
}

/** Seed `n` promoted products (slugs `p-1`…`p-n`); returns their ids. Useful for
 * the seed-reviews engine, which needs several products to plan a meaningful set. */
export function seedProducts(raw: Database.Database, n: number): string[] {
  const stmt = raw.prepare(
    'INSERT INTO products (id, slug, name, promotion_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `prod-${i}`;
    stmt.run(id, `p-${i}`, `Product ${i}`, 'promoted', TS, TS);
    ids.push(id);
  }
  return ids;
}

/** Add a profile + one anonymous approved review for `productId`. */
export function seedProfileAndReview(raw: Database.Database, productId: string): void {
  raw
    .prepare(
      "INSERT INTO profiles (id, role, created_at, updated_at) VALUES ('prof-1', 'reviewer', ?, ?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      `INSERT INTO reviews (id, product_id, rating_overall, rating_onboarding, title, body, status, created_at, updated_at)
       VALUES ('rev-1', ?, 5, 4, 'Great', 'A solid body of review text.', 'approved', ?, ?)`,
    )
    .run(productId, TS, TS);
}

/** Add two vendor_requests where B is a duplicate of A (the self-FK path). */
export function seedSelfRefRequests(raw: Database.Database, targetId: string): void {
  raw
    .prepare(
      `INSERT INTO vendor_requests (id, kind, target_type, target_id, submitter_email, body, created_at)
       VALUES ('req-A', 'claim', 'product', ?, 'a@example.com', 'first request', ?)`,
    )
    .run(targetId, TS);
  raw
    .prepare(
      `INSERT INTO vendor_requests (id, kind, target_type, target_id, submitter_email, body, duplicate_of_request_id, created_at)
       VALUES ('req-B', 'claim', 'product', ?, 'b@example.com', 'duplicate', 'req-A', ?)`,
    )
    .run(targetId, TS);
}
