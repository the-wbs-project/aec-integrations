ALTER TABLE `mailing_list` ADD `unsubscribe_token` text;--> statement-breakpoint
ALTER TABLE `mailing_list` ADD `unsubscribed_at` text;--> statement-breakpoint
-- AECI-537 data backfill: give pre-existing subscribers an opaque unsubscribe
-- token. D1/SQLite has no UUID() SQL fn; hex(randomblob(16)) yields a unique
-- 32-char hex token per row. Run before the unique index below.
UPDATE `mailing_list` SET `unsubscribe_token` = lower(hex(randomblob(16))) WHERE `unsubscribe_token` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `mailing_list_unsubscribe_token_key` ON `mailing_list` (`unsubscribe_token`);