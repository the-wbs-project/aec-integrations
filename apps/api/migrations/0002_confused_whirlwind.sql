ALTER TABLE `reviews` ADD `anonymized_at` text;
--> statement-breakpoint
-- AECI-241 backfill: existing already-anonymized / synthetic-anonymous reviews
-- (`reviewer_id IS NULL`) predate the `anonymized_at` column. Stamp them from
-- `updated_at` (best available proxy) so the §23.1 data-quality check #5 doesn't
-- flag every legacy null-reviewer row — including the seeded anonymous demo
-- reviews — as a missing-timestamp defect on its first run.
UPDATE `reviews` SET `anonymized_at` = `updated_at` WHERE `reviewer_id` IS NULL AND `anonymized_at` IS NULL;
