-- AECI-1154: the owner's pricing page link, `pricing_url`, on `integrations` and
-- `connector_evidenced_pairs` (STAGE_2_VENDOR_PORTAL_SPEC.md §6.17.11,
-- DATABASE_SCHEMA.md §4.3 / §9a.6).
--
-- ADDITIVE ONLY. Two plain ADD COLUMNs, nullable, no default, no CHECK. SQLite
-- applies them in place, so this is NOT a table recreate and fires no
-- ON DELETE CASCADE into claims, attestations, integration_field_challenges or
-- integration_vendor_links (docs/migrations.md §0, ADR 0018). The URL rule lives in
-- the app layer (`integrationEditValueProblem`). The column is not contestable, so
-- the contest CHECK `integration_field_challenges_field_check` does not change.
-- Promote never writes it; only the owner edit and the vendor create do.
ALTER TABLE `connector_evidenced_pairs` ADD `pricing_url` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `pricing_url` text;