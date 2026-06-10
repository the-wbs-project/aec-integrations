-- AECI-171 — Add `usefulness` jsonb to `products`.
--
-- Editorial "how teams use it" narrative grouped by audience and by project phase,
-- authored as a blob in Airtable. Stored shape mirrors the public ProductUsefulness
-- contract (API_CONTRACTS §5.1; DATABASE_SCHEMA §4.2):
--   { audiences: [{ slug, name, points[] }], phases: [{ slug, name, points[] }] }
-- Nullable; read whole, never filtered on, so NOT indexed. This issue adds storage
-- only — promote writes it (AECI-172), detail hydration reads it (AECI-173).
--
-- Forward-only per docs/migrations.md §3.1. Nullable so existing rows pass without a
-- backfill. `IF NOT EXISTS` keeps re-apply safe. The schema.prisma field is
-- hand-mirrored (db:pull is unusable under P1012 multiSchema; see docs/prisma.md).

BEGIN;

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "usefulness" JSONB;

COMMIT;
