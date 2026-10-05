ALTER TABLE `gsc_recrawl_queue` ADD `last_changed_at` text;--> statement-breakpoint
ALTER TABLE `gsc_recrawl_queue` ADD `inspected_at` text;--> statement-breakpoint
ALTER TABLE `gsc_recrawl_queue` ADD `last_crawl_at` text;--> statement-breakpoint
ALTER TABLE `gsc_recrawl_queue` ADD `coverage_state` text;--> statement-breakpoint
ALTER TABLE `gsc_recrawl_queue` ADD `inspect_reason` text;--> statement-breakpoint
CREATE INDEX `gsc_recrawl_queue_inspected_at_idx` ON `gsc_recrawl_queue` (`inspected_at`);--> statement-breakpoint
-- AECI-1236: backfill with the time this migration runs, NOT queued_at. A row re-enqueued before
-- now kept its first queued_at, so queued_at can predate the page's real last change. Using it
-- would let the first inspection run close a row whose latest edit Google never saw. "Now" is
-- the earliest time we can vouch for: existing rows close only once Google crawls after it.
UPDATE `gsc_recrawl_queue` SET `last_changed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `last_changed_at` IS NULL;
