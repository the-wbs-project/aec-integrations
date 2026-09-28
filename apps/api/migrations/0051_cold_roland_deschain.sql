-- AECI-1136: IndexNow sends once a day, highest-priority pages first.
-- `indexnow_queue` gains `priority` (tiers 1-4, the GSC recrawl tiers; ADR 0025
-- amendment 2026-09-28) and the composite index the daily drain reads through.
--
-- ADDITIVE ONLY. A plain ADD COLUMN with a constant NOT NULL DEFAULT, which SQLite
-- applies in place, so this is NOT a table recreate and fires no ON DELETE CASCADE
-- (docs/migrations.md §0, ADR 0018). Nothing references `indexnow_queue` anyway.
-- There is deliberately no CHECK on `priority`: adding or changing one is what
-- forces drizzle-kit into a recreate. Existing rows take the default 4, so a
-- backlog buffered before this migration sorts last rather than jumping the queue.
ALTER TABLE `indexnow_queue` ADD `priority` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
CREATE INDEX `indexnow_queue_priority_queued_at_idx` ON `indexnow_queue` (`priority`,`queued_at`);