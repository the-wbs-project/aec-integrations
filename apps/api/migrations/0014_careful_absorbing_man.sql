-- AECI-585 (ADMIN_PANEL_SPEC.md §7.3 / §13 D7) — drop `page_views.user_id`,
-- `.session_id` and `.profile_role`. All three were declared at init and never
-- written; the decision was to drop rather than fill (no session identifier is
-- being introduced).
--
-- This is the repo's FIRST table-recreate migration — every ALTER before it is an
-- ADD. SQLite refuses `DROP COLUMN` on a column carrying an index or a FOREIGN KEY
-- clause, and `user_id` had both (`page_views_user_idx` + the FK to `profiles`, from
-- 0000_init.sql), so drizzle-kit emits the `__new_page_views` copy-and-rename below.
-- `session_id` and `profile_role` would each have been a plain DROP COLUMN; they ride
-- along in the same recreate for free.
--
-- ONE HAND EDIT to the generated output: drizzle-kit emits `PRAGMA foreign_keys=OFF`
-- / `=ON` around the swap, which is NOT the lever D1 supports. D1's migrations
-- documentation specifies `PRAGMA defer_foreign_keys = true` instead, which holds for
-- the duration of the surrounding transaction and resets itself on commit — so there
-- is no matching re-enable statement. Regenerating this file will reintroduce the
-- wrong pragma; re-apply this edit if that happens.
--
-- The copy lists `id` explicitly so the autoincrement PK survives: the admin Activity
-- feed paginates on `(created_at DESC, id DESC)` and would repeat or skip rows if the
-- ids were reassigned. Four indexes are recreated afterwards; `page_views_user_idx`
-- is deliberately not among them.
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_page_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`concrete_path` text,
	`product_id` text,
	`vendor_id` text,
	`taxonomy_kind` text,
	`taxonomy_id` text,
	`navigation` text,
	`referrer` text,
	`ref_source` text,
	`ref_token` text,
	`cf_country` text,
	`cf_colo` text,
	`cf_asn` integer,
	`cf_as_organization` text,
	`cf_bot_score` integer,
	`user_agent_hash` text,
	`locale` text,
	`is_bot` integer,
	`bot_name` text,
	`referrer_source` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_page_views`("id", "path", "concrete_path", "product_id", "vendor_id", "taxonomy_kind", "taxonomy_id", "navigation", "referrer", "ref_source", "ref_token", "cf_country", "cf_colo", "cf_asn", "cf_as_organization", "cf_bot_score", "user_agent_hash", "locale", "is_bot", "bot_name", "referrer_source", "created_at") SELECT "id", "path", "concrete_path", "product_id", "vendor_id", "taxonomy_kind", "taxonomy_id", "navigation", "referrer", "ref_source", "ref_token", "cf_country", "cf_colo", "cf_asn", "cf_as_organization", "cf_bot_score", "user_agent_hash", "locale", "is_bot", "bot_name", "referrer_source", "created_at" FROM `page_views`;--> statement-breakpoint
DROP TABLE `page_views`;--> statement-breakpoint
ALTER TABLE `__new_page_views` RENAME TO `page_views`;--> statement-breakpoint
CREATE INDEX `page_views_path_idx` ON `page_views` (`path`,`created_at`);--> statement-breakpoint
CREATE INDEX `page_views_country_idx` ON `page_views` (`cf_country`,`created_at`);--> statement-breakpoint
CREATE INDEX `page_views_product_idx` ON `page_views` (`product_id`,`created_at`) WHERE "product_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `page_views_bot_idx` ON `page_views` (`is_bot`,`created_at`);