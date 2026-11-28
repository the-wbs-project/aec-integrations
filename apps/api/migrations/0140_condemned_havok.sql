-- AECI-2110: the owner reply, protest links and workflow rows on Sync Service pair
-- reports (`docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.5).
--
-- HAND-EDITED BODY, ADDITIVE ONLY. Eight `ALTER TABLE ... ADD` statements.
-- `sync_service_pair_contests` is a cascade child of both edge tables and is NEVER
-- recreated here (docs/migrations.md §0). drizzle-kit generated these columns but
-- dropped `ON DELETE SET NULL` from each `ADD ... REFERENCES`, so the three FKs are
-- written in full. `src/test/migration-0140.spec.ts` is the tripwire.
ALTER TABLE `sync_service_pair_contests` ADD `protest_evidence` text;--> statement-breakpoint
ALTER TABLE `sync_service_pair_contests` ADD `protest_reply_due_at` text;--> statement-breakpoint
ALTER TABLE `sync_service_pair_contests` ADD `protest_reply` text;--> statement-breakpoint
ALTER TABLE `sync_service_pair_contests` ADD `protest_reply_evidence` text;--> statement-breakpoint
ALTER TABLE `sync_service_pair_contests` ADD `protest_replied_by` text REFERENCES profiles(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_service_pair_contests` ADD `protest_replied_at` text;--> statement-breakpoint
ALTER TABLE `sync_service_pair_contests` ADD `workflow_id` text REFERENCES workflow_instances(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sync_service_pair_contests` ADD `protest_workflow_id` text REFERENCES workflow_instances(id) ON DELETE SET NULL;
