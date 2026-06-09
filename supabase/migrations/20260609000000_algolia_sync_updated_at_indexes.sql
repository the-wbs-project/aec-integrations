-- Add `updated_at` indexes on `vendors` and `integrations` (AECI-139).
--
-- The Phase 3.6 daily incremental Algolia sync (`apps/api/src/scheduled.ts` →
-- `lib/algolia-sync.ts`) reads each entity's rows changed since a stored
-- watermark with `WHERE updated_at > $watermark AND updated_at <= $cutoff`. The
-- baseline migration (`20260515024116_baseline_schema.sql`) created
-- `products_updated_at_idx` but not the equivalents on `vendors` /
-- `integrations`, so those windowed scans would seq-scan. Cheap to add now and
-- it's the predicate the cron runs forever; matches the existing
-- `products_updated_at_idx` (DESC) shape.
--
-- Forward-only per `docs/migrations.md`. `IF NOT EXISTS` keeps re-apply safe.
-- The `schema.prisma` `@@index` lines are hand-mirrored (db:pull is unusable
-- under P1012 multiSchema; see `docs/prisma.md`).

BEGIN;

CREATE INDEX IF NOT EXISTS "vendors_updated_at_idx" ON "vendors"("updated_at" DESC);

CREATE INDEX IF NOT EXISTS "integrations_updated_at_idx" ON "integrations"("updated_at" DESC);

COMMIT;
