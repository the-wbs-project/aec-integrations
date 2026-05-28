-- Add `logo_url` to `vendors`.
--
-- The Phase 2 API contract (`docs/API_CONTRACTS.md` §2; `VendorLink` /
-- `VendorListItem` in `packages/shared/src/api/{common,vendors}.ts`) has always
-- declared a nullable `logo_url` for vendors, and `apps/api/src/lib/prisma-helpers.ts`
-- selected `logoUrl` on the Vendor model. The baseline migration
-- (`20260515024116_baseline_schema.sql`) omitted the column, which the
-- previously-disabled E2E job surfaced as a 500 from `GET /api/products`:
--   `PrismaClientValidationError: Unknown field 'logoUrl' for select statement on model 'Vendor'`.
--
-- Forward-only fix per `docs/migrations.md` §3.1. Nullable so existing rows
-- pass without a backfill; Brandfetch / curator sync populates it later
-- (mirroring the products.logo_url convention from `docs/DATABASE_SCHEMA.md`
-- §4.2).

BEGIN;

ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "logo_url" TEXT;

COMMIT;
