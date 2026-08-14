-- One-time backfill of products.promoted_at for rows created before the column
-- existed (AECI-581 / ADMIN_PANEL_SPEC.md §13 D6, migration 0011).
--
-- This backfill is EXACT, not an approximation, and §4's correction is why:
-- `POST /api/promote` is D1's only INSERT path into `products` and it sets
-- promotion_status='promoted' on both its insert and update branches; nothing in
-- the repo ever writes 'ready'/'pending'/'retracted'/'rejected' to D1; and
-- retraction is a hard delete (lib/retract-product.ts), not a status transition.
-- So `created_at` IS the first-promote timestamp for every row that exists, and
-- `promoted_at := created_at` loses nothing. (The v0.1 spec claim that a row
-- "sits at 'ready' before going live" describes the REVIEW APP's lifecycle, not
-- AECi's.)
--
-- Which is also why the column buys nothing today. It is future-proofing: the
-- moment a Tier-1 retract endpoint introduces a genuine un-promote → re-promote
-- cycle, `created_at` stops tracking go-live and the history cannot be
-- reconstructed retroactively. Adding the column now is cheap; adding it later is
-- lossy. Going forward promote maintains it set-once, via
-- COALESCE("promoted_at", ?) on its update branch — see routes/promote.ts.
--
-- Run once per environment AFTER migration 0011 is applied, e.g.:
--   pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production \
--     --env production --remote --file=../../scripts/ops/backfill-products-promoted-at.sql
-- Idempotent: only touches rows where promoted_at IS NULL, so a second run is a
-- no-op and a product promoted between runs keeps its real first-promote stamp.
--
-- Verify afterwards (both figures should match, and the mismatch count should be 0):
--   SELECT count(*) AS products,
--          sum(CASE WHEN promoted_at IS NOT NULL THEN 1 ELSE 0 END) AS stamped,
--          sum(CASE WHEN promoted_at IS NOT NULL AND promoted_at <> created_at
--                   THEN 1 ELSE 0 END) AS diverged
--   FROM products;
-- (`diverged` may legitimately be non-zero later, once a product has been
-- re-promoted after this ran — that is the column doing its job.)

UPDATE products
SET promoted_at = created_at
WHERE promoted_at IS NULL;
