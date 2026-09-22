-- AECI-1009: protest a declined integration contest to AECi
-- (`docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12).
--
-- HAND-AUTHORED BODY, ADDITIVE ONLY. Fifteen `ALTER TABLE ... ADD` statements and
-- one `CREATE INDEX`. `integration_field_challenges` is a cascade child of
-- `integrations` and is NEVER recreated here (docs/migrations.md §3.3a).
-- `src/test/migration-0047.spec.ts` is the tripwire.
--
-- drizzle-kit generated these same columns, but its `ADD ... REFERENCES` dropped
-- the `ON DELETE SET NULL` clause (docs/migrations.md §0), so each FK is written
-- in full here. `protest_status` and `protest_basis` carry COLUMN-level CHECKs by
-- hand: declaring them in `schema.ts` would make every later generate render a
-- table recreate. A NULL passes a CHECK, so every existing row is valid.
ALTER TABLE `integration_field_challenges` ADD `protest_status` text CONSTRAINT "integration_field_challenges_protest_status_check" CHECK ("protest_status" IN ('open', 'upheld', 'rejected', 'withdrawn'));--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_basis` text CONSTRAINT "integration_field_challenges_protest_basis_check" CHECK ("protest_basis" IN ('declined', 'silence'));--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_reason` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_evidence` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protested_by` text REFERENCES profiles(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protested_at` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_reply_due_at` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_reply` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_reply_evidence` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_replied_by` text REFERENCES profiles(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_replied_at` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_decision_note` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_decided_by` text REFERENCES profiles(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_decided_at` text;--> statement-breakpoint
ALTER TABLE `integration_field_challenges` ADD `protest_workflow_id` text REFERENCES workflow_instances(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `integration_field_challenges_protest_idx` ON `integration_field_challenges` (`protest_status`,`protested_at`) WHERE "protest_status" IS NOT NULL;
