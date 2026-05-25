-- AECI-53 / Phase 2 §6.4: enforce slug uniqueness on products and vendors.
--
-- The baseline migration (20260515024116_baseline_schema) already created
-- `vendors_slug_key` and `products_slug_key` unique indexes (lines 357, 372
-- of that file). Per §6.4, the "separate migration after backfill" is part of
-- the slug-strategy contract and is preserved here as an idempotent guard:
--   * Safe to re-apply (no-op against the current schema).
--   * Self-documents the contract so a future reader can find the unique
--     constraint by searching for AECI-53 / "slug_unique".
--   * Survives a fresh DB build that somehow skipped the baseline indexes.
--
-- `CREATE UNIQUE INDEX IF NOT EXISTS` is used in place of `ALTER TABLE … ADD
-- CONSTRAINT UNIQUE`. Postgres treats the two as interchangeable for the
-- uniqueness guarantee, and the `IF NOT EXISTS` form is the only one that is
-- idempotent without a DO block.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS "vendors_slug_key"  ON "vendors"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "products_slug_key" ON "products"("slug");

COMMIT;
