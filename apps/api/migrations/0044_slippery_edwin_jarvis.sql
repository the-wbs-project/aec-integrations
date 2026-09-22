-- AECI-1005 / ADR 0035: integrations are vendor-owned; AECi seeds.
--
-- ADDITIVE ONLY. Three `ALTER TABLE ... ADD COLUMN` statements and nothing else.
-- `integrations` is NEVER recreated here: a recreate's DROP fires ON DELETE CASCADE
-- into `claims` -> `attestations` and into `integration_field_challenges`
-- (docs/migrations.md §3.3a). `src/test/migration-0044.spec.ts` is the tripwire.
--
-- `origin` carries a COLUMN-level CHECK written by hand. drizzle-kit generated the
-- bare column; declaring the CHECK in `schema.ts` instead would make every later
-- generate render a table recreate. SQLite verifies an added CHECK against existing
-- rows, and every existing row takes the 'aeci' default, so it cannot fail.
ALTER TABLE `integrations` ADD `claimed_at` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `origin` text DEFAULT 'aeci' NOT NULL CONSTRAINT "integrations_origin_check" CHECK ("origin" IN ('aeci', 'vendor'));--> statement-breakpoint
ALTER TABLE `integrations` ADD `retired_at` text;
