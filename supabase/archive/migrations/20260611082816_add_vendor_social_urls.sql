-- Add `x_url`, `facebook_url`, `instagram_url`, `youtube_url` to `vendors`.
--
-- Part B2 of the vendor-page social-links work. LinkedIn (`linkedin_url`) and
-- GitHub (`github_org`) already ship; these four are the net-new platforms the
-- review app now captures in Airtable and forwards through `POST /api/promote`
-- (camelCase `xUrl` / `facebookUrl` / `instagramUrl` / `youtubeUrl`). Each stores
-- a full canonical https:// URL — mirroring the `linkedin_url` convention, NOT
-- the bare-handle `github_org` one — and the detail hero renders an icon only
-- when the value is present.
--
-- Forward-only per docs/migrations.md §3.1. Nullable so existing rows pass
-- without a backfill (values land on the next promote of each vendor).
-- `IF NOT EXISTS` keeps re-apply safe. The schema.prisma fields are
-- hand-mirrored (db:pull is unusable under P1012 multiSchema; see docs/prisma.md).

BEGIN;

ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "x_url" TEXT;
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "facebook_url" TEXT;
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "instagram_url" TEXT;
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "youtube_url" TEXT;

COMMIT;
